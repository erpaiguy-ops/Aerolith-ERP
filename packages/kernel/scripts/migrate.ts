/**
 * Applies migrations, then the RLS policies and grants.
 *
 * RLS is applied here rather than in a generated migration because the policy
 * set is derived from the table list in src/db/rls.ts — adding a tenant-scoped
 * table should not require remembering to hand-write four policies.
 *
 * Run with a role that OWNS the schema. The application connects as
 * `aerolith_app`, which does not, so that RLS actually applies to it.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import pg from 'pg';

import {
  APP_ROLE,
  PLATFORM_ROLE,
  buildGrantStatements,
  buildPlatformGrantStatements,
  buildRlsStatements,
} from '../src/db/rls';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const appPassword = process.env.APP_DB_PASSWORD ?? 'aerolith_app';
/**
 * Optional, unlike the app password. A deployment with no platform-operator
 * surface should not carry a credential that can read every tenant — so the
 * role is created only when a password is supplied, and its absence is the
 * normal case rather than a misconfiguration to warn about.
 */
const platformPassword = process.env.PLATFORM_DB_PASSWORD;

async function main() {
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool);

  try {
    console.log('→ applying schema migrations');
    // Migration bookkeeping lives in its own schema, not in `kernel` — the
    // generated migration creates `kernel` itself, and mixing the two means the
    // first run collides with it.
    await migrate(db, { migrationsFolder: './drizzle', migrationsSchema: 'drizzle' });

    console.log(`→ ensuring application role "${APP_ROLE}"`);
    // NOLOGIN roles cannot connect; the role is created with a password so the
    // app can use it, but it deliberately owns nothing.
    await db.execute(
      sql.raw(`
      do $$
      begin
        if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
          create role ${APP_ROLE} login password '${appPassword}';
        end if;
      end
      $$;
    `),
    );

    // Created ALWAYS, and without LOGIN unless a password is supplied.
    //
    // The role has to exist before the `platform_read` policies below, because
    // `CREATE POLICY ... TO <role>` on a role Postgres does not know is a hard
    // error, not a no-op — which would break every deployment that has no
    // operator surface, i.e. all of them today. A role that cannot log in is
    // inert: policies may name it, grants may target it, and nobody can
    // authenticate as it. Enabling the surface later is then only setting
    // PLATFORM_DB_PASSWORD, with no policy or grant changes at all.
    console.log(`→ ensuring platform read role "${PLATFORM_ROLE}"`);
    await db.execute(
      sql.raw(`
      do $$
      begin
        if not exists (select 1 from pg_roles where rolname = '${PLATFORM_ROLE}') then
          create role ${PLATFORM_ROLE} nologin;
        end if;
      end
      $$;
    `),
    );

    if (platformPassword) {
      console.log('  granting it login');
      await db.execute(
        sql.raw(`alter role ${PLATFORM_ROLE} login password '${platformPassword}';`),
      );
    }

    console.log('→ applying grants');
    for (const statement of buildGrantStatements()) {
      await db.execute(sql.raw(statement));
    }

    console.log('→ applying platform read grants');
    for (const statement of buildPlatformGrantStatements()) {
      await db.execute(sql.raw(statement));
    }

    console.log('→ applying row level security policies');
    const statements = buildRlsStatements();
    for (const statement of statements) {
      await db.execute(sql.raw(statement));
    }
    console.log(`  ${statements.length} statements applied`);

    console.log('✓ migration complete');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('✗ migration failed:', error);
  process.exit(1);
});

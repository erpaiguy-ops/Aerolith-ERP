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

import { APP_ROLE, buildGrantStatements, buildRlsStatements } from '../src/db/rls';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const appPassword = process.env.APP_DB_PASSWORD ?? 'aerolith_app';

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

    console.log('→ applying grants');
    for (const statement of buildGrantStatements()) {
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

/**
 * Migrates the `projects` schema, then applies its RLS policies and grants.
 *
 * Each module migrates itself — the kernel must not depend on any module. The
 * root `pnpm db:migrate` runs the kernel first, then every module.
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import { buildProjectsGrants, buildProjectsRls } from '../src/db/security';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

async function main() {
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool);

  try {
    console.log('→ migrating projects schema');
    await db.execute(sql`create schema if not exists drizzle_projects`);
    await migrate(db, {
      migrationsFolder: './drizzle',
      migrationsSchema: 'drizzle_projects',
    });

    console.log('→ applying grants and row level security');
    for (const statement of [...buildProjectsGrants(), ...buildProjectsRls()]) {
      await db.execute(sql.raw(statement));
    }

    console.log('✓ projects migration complete');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('✗ projects migration failed:', error);
  process.exit(1);
});

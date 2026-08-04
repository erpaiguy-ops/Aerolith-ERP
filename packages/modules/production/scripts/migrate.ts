/**
 * Migrates the `production` schema, then applies its RLS policies and grants.
 *
 * Each module migrates itself — the kernel must not depend on any module. The
 * root `pnpm db:migrate` runs the kernel first, then every module.
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import { buildProductionGrants, buildProductionPlatformGrants, buildProductionRls } from '../src/db/security';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

async function main() {
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool);

  try {
    console.log('→ migrating production schema');
    await db.execute(sql`create schema if not exists drizzle_production`);
    await migrate(db, {
      migrationsFolder: './drizzle',
      migrationsSchema: 'drizzle_production',
    });

    console.log('→ applying grants and row level security');
    // Platform grants alongside the app's. The kernel migration creates the
    // role (NOLOGIN unless configured), and it runs first, so it exists by now.
    for (const statement of [
      ...buildProductionGrants(),
      ...buildProductionPlatformGrants(),
      ...buildProductionRls(),
    ]) {
      await db.execute(sql.raw(statement));
    }

    console.log('✓ production migration complete');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('✗ production migration failed:', error);
  process.exit(1);
});

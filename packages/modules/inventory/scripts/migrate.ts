/**
 * Migrates the `inventory` schema, then applies its RLS policies and grants.
 *
 * Each module migrates itself. The kernel does not orchestrate it, because the
 * kernel must not depend on any module — see docs/02-architecture.md. The root
 * `pnpm db:migrate` runs the kernel first, then every module.
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import { buildInventoryGrants, buildInventoryRls } from '../src/db/security';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

async function main() {
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool);

  try {
    console.log('→ migrating inventory schema');
    // Its own migration bookkeeping table, so module migrations never collide
    // with the kernel's or with each other.
    await db.execute(sql`create schema if not exists drizzle_inventory`);
    await migrate(db, {
      migrationsFolder: './drizzle',
      migrationsSchema: 'drizzle_inventory',
    });

    console.log('→ applying grants and row level security');
    for (const statement of [...buildInventoryGrants(), ...buildInventoryRls()]) {
      await db.execute(sql.raw(statement));
    }

    console.log('✓ inventory migration complete');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('✗ inventory migration failed:', error);
  process.exit(1);
});

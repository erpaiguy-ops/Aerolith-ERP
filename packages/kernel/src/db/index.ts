/**
 * Database access.
 *
 * `withTenant()` is the only sanctioned way to run tenant data access: it opens
 * a transaction, sets the RLS guard, and runs the callback. Repositories that
 * bypass it will simply see zero rows, which is the correct failure mode.
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { requireTenantContext } from '../tenancy/context';
import * as schema from './schema';
import { setTenantGuard } from './rls';

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

let pool: pg.Pool | undefined;
let database: Database | undefined;

export interface DatabaseOptions {
  connectionString: string;
  maxConnections?: number;
  /** Log every statement. Development only — it is noisy and leaks data. */
  debug?: boolean;
}

export function createDatabase(options: DatabaseOptions): Database {
  pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Numerics must not silently become floats: money and quantities are read
    // as strings and handled with a decimal type at the edges.
    application_name: 'aerolith',
  });

  database = drizzle(pool, { schema, logger: options.debug ?? false });
  return database;
}

export function getDatabase(): Database {
  if (!database) {
    throw new Error('Database not initialised. Call createDatabase() during bootstrap.');
  }
  return database;
}

export async function closeDatabase(): Promise<void> {
  await pool?.end();
  pool = undefined;
  database = undefined;
}

/**
 * Runs `fn` in a transaction with the RLS tenant guard set from the ambient
 * tenant context.
 */
export async function withTenant<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const { tenantId } = requireTenantContext();
  return getDatabase().transaction(async (tx) => {
    await setTenantGuard(tx, tenantId);
    return fn(tx);
  });
}

/**
 * Like `withTenant`, but with the tenant passed explicitly.
 *
 * For paths that run BEFORE a tenant context exists — chiefly authentication,
 * which must read `membership` and `role` to build the context in the first
 * place. Those tables are tenant-scoped, so without a guard RLS correctly
 * returns nothing and login silently fails.
 */
export async function withTenantId<T>(
  tenantId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return getDatabase().transaction(async (tx) => {
    await setTenantGuard(tx, tenantId);
    return fn(tx);
  });
}

/**
 * Escape hatch for cross-tenant work: migrations, the outbox dispatcher, the
 * tenant provisioning flow and platform administration. Named to be greppable —
 * every call site should be reviewable.
 *
 * Reads of tenant-scoped tables through this will return NOTHING when the app
 * role is in use, because RLS is forced. That is the intended failure mode; use
 * `withTenantId` when you know the tenant.
 */
export async function withoutTenantGuard<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return getDatabase().transaction(fn);
}

export { schema };
export * from './rls';

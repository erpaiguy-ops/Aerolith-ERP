/**
 * Row Level Security.
 *
 * The application layer (CASL) answers "may this user do this". RLS answers
 * "may this connection see this row", and it answers it inside Postgres, where
 * an application bug cannot talk its way past. Both are required.
 *
 * Two things make this work, and both are easy to get wrong:
 *
 *  1. The app connects as a role that is NOT the table owner and NOT a
 *     superuser. Owners and superusers bypass RLS unless FORCE is set, so we
 *     also set FORCE — belt and braces, because a misconfigured connection
 *     string should degrade to "sees nothing", never "sees everything".
 *
 *  2. `app.tenant_id` is set with `set_config(..., true)` — the `true` makes it
 *     transaction-local, so a pooled connection cannot leak one request's tenant
 *     into the next.
 */
import { sql } from 'drizzle-orm';
import { type PgDatabase } from 'drizzle-orm/pg-core';

/** Tables carrying `tenant_id`, and therefore needing a policy. */
export const TENANT_SCOPED_TABLES = [
  'legal_entity',
  'tenant_module',
  'membership',
  'api_key',
  'role',
  'role_permission',
  'user_role',
  'audit_log',
  'number_series',
  'number_allocation',
  'folder',
  'document',
  'document_version',
  'document_link',
  'document_lock',
  'approval_workflow',
  'approval_workflow_version',
  'approval_instance',
  'approval_task',
  'approval_action',
  'approval_delegation',
  'authority_limit',
  'notification',
  'notification_template',
  'notification_delivery',
  'notification_preference',
  'custom_field_definition',
  'party',
  'party_contact',
  'unit_of_measure',
  'item',
  'item_category',
  'project',
  'cost_centre',
  'cost_code',
  'exchange_rate',
  'event_outbox',
  'event_consumption',
  'tenant_requirement',
  'tenant_tax_code',
  'tenant_rule_value',
  'tenant_holiday',
  'tenant_localisation',
] as const;

/**
 * Append-only tables: INSERT and SELECT, never UPDATE or DELETE. Enforced in the
 * database so that "immutable audit trail" is a fact rather than a convention.
 */
export const APPEND_ONLY_TABLES = new Set(['audit_log', 'approval_action']);

/**
 * `tenant` itself is special: a row is visible when its own id matches the
 * session tenant.
 */
const SELF_KEYED_TABLES: Record<string, string> = { tenant: 'id' };

export const APP_ROLE = 'aerolith_app';

export function buildRlsStatements(): string[] {
  const statements: string[] = [];

  for (const table of TENANT_SCOPED_TABLES) {
    const qualified = `kernel."${table}"`;
    const keyColumn = SELF_KEYED_TABLES[table] ?? 'tenant_id';
    // nullif(..., '') matters: a custom GUC that has been set transaction-locally
    // reverts to the EMPTY STRING at commit, not to NULL. Without this, the first
    // query on a recycled pooled connection fails with "invalid input syntax for
    // type uuid" instead of cleanly returning no rows.
    const predicate = `${keyColumn} = nullif(current_setting('app.tenant_id', true), '')::uuid`;

    statements.push(`ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY;`);
    statements.push(`ALTER TABLE ${qualified} FORCE ROW LEVEL SECURITY;`);
    statements.push(`DROP POLICY IF EXISTS tenant_isolation_select ON ${qualified};`);
    statements.push(
      `CREATE POLICY tenant_isolation_select ON ${qualified} FOR SELECT TO ${APP_ROLE} USING (${predicate});`,
    );
    statements.push(`DROP POLICY IF EXISTS tenant_isolation_insert ON ${qualified};`);
    statements.push(
      `CREATE POLICY tenant_isolation_insert ON ${qualified} FOR INSERT TO ${APP_ROLE} WITH CHECK (${predicate});`,
    );

    statements.push(`DROP POLICY IF EXISTS tenant_isolation_update ON ${qualified};`);
    statements.push(`DROP POLICY IF EXISTS tenant_isolation_delete ON ${qualified};`);

    if (!APPEND_ONLY_TABLES.has(table)) {
      statements.push(
        `CREATE POLICY tenant_isolation_update ON ${qualified} FOR UPDATE TO ${APP_ROLE} ` +
          `USING (${predicate}) WITH CHECK (${predicate});`,
      );
      statements.push(
        `CREATE POLICY tenant_isolation_delete ON ${qualified} FOR DELETE TO ${APP_ROLE} USING (${predicate});`,
      );
    }
  }

  return statements;
}

/** Grants for the non-owner application role. */
export function buildGrantStatements(): string[] {
  return [
    `GRANT USAGE ON SCHEMA kernel TO ${APP_ROLE};`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA kernel TO ${APP_ROLE};`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA kernel TO ${APP_ROLE};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA kernel GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE};`,
    // Audit and approval history are append-only even for the app role.
    ...[...APPEND_ONLY_TABLES].map(
      (table) => `REVOKE UPDATE, DELETE ON kernel."${table}" FROM ${APP_ROLE};`,
    ),
  ];
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Applies the tenant guard for the current transaction. */
export async function setTenantGuard(tx: PgDatabase<any, any, any>, tenantId: string) {
  await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
}

/**
 * Clears the guard so a pooled connection cannot carry a tenant into the next
 * transaction. Belt and braces: `set_config(..., true)` is already
 * transaction-scoped.
 */
export async function clearTenantGuard(tx: PgDatabase<any, any, any>) {
  await tx.execute(sql`select set_config('app.tenant_id', '', true)`);
}

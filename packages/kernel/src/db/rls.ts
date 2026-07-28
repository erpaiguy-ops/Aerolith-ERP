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

export const APP_ROLE = 'aerolith_app';

export interface RlsOptions {
  /** Postgres schema the tables live in. */
  schemaName: string;
  /** Tables carrying `tenant_id` (or a self-key, see `selfKeyed`). */
  tables: readonly string[];
  /** Tables that accept INSERT and SELECT only. */
  appendOnly?: ReadonlySet<string>;
  /** Tables keyed on something other than `tenant_id`, e.g. `tenant.id`. */
  selfKeyed?: Record<string, string>;
  /**
   * Tables a user may SELECT their own rows from, keyed by the column holding
   * the user id — regardless of the tenant guard.
   *
   * This exists for exactly one problem: authentication has to read
   * `kernel.membership` to discover which tenants a user belongs to, and it must
   * do that BEFORE a tenant is known. Tenant-scoping that read makes it return
   * nothing, so login fails for every user with the message that they belong to
   * no workspace. The tenant guard cannot be set, because finding the tenant is
   * the operation.
   *
   * The grant is deliberately narrow. It is SELECT only — a user must never be
   * able to write their own membership, which would be self-service escalation
   * into any tenant — and it applies only to the tables named here, so the rest
   * of the schema keeps pure tenant isolation.
   */
  selfReadableByUser?: Record<string, string>;
}

/**
 * Generates the isolation policies for one schema.
 *
 * Exported generically so a business module can secure its own schema with the
 * same policy shape as the kernel — one implementation, so `inventory` cannot
 * accidentally get weaker isolation than `kernel`.
 */
export function buildRlsStatementsFor(options: RlsOptions): string[] {
  const { schemaName, tables } = options;
  const appendOnly = options.appendOnly ?? new Set<string>();
  const selfKeyed = options.selfKeyed ?? {};
  const selfReadableByUser = options.selfReadableByUser ?? {};
  const statements: string[] = [];

  for (const table of tables) {
    const qualified = `${schemaName}."${table}"`;
    const keyColumn = selfKeyed[table] ?? 'tenant_id';
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

    if (!appendOnly.has(table)) {
      statements.push(
        `CREATE POLICY tenant_isolation_update ON ${qualified} FOR UPDATE TO ${APP_ROLE} ` +
          `USING (${predicate}) WITH CHECK (${predicate});`,
      );
      statements.push(
        `CREATE POLICY tenant_isolation_delete ON ${qualified} FOR DELETE TO ${APP_ROLE} USING (${predicate});`,
      );
    }

    // An ADDITIONAL permissive SELECT policy. Postgres ORs permissive policies
    // together, so this widens reads for this table only and leaves every write
    // policy above exactly as strict as it was.
    const userColumn = selfReadableByUser[table];
    statements.push(`DROP POLICY IF EXISTS self_read ON ${qualified};`);
    if (userColumn) {
      statements.push(
        `CREATE POLICY self_read ON ${qualified} FOR SELECT TO ${APP_ROLE} ` +
          `USING (${userColumn} = nullif(current_setting('app.user_id', true), '')::uuid);`,
      );
    }
  }

  return statements;
}

/** Grants for the non-owner application role, for one schema. */
export function buildGrantStatementsFor(options: RlsOptions): string[] {
  const { schemaName } = options;
  const appendOnly = options.appendOnly ?? new Set<string>();

  return [
    `GRANT USAGE ON SCHEMA ${schemaName} TO ${APP_ROLE};`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schemaName} TO ${APP_ROLE};`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schemaName} TO ${APP_ROLE};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schemaName} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE};`,
    ...[...appendOnly].map(
      (table) => `REVOKE UPDATE, DELETE ON ${schemaName}."${table}" FROM ${APP_ROLE};`,
    ),
  ];
}

const KERNEL_RLS: RlsOptions = {
  schemaName: 'kernel',
  tables: TENANT_SCOPED_TABLES,
  appendOnly: APPEND_ONLY_TABLES,
  // `tenant` itself is special: a row is visible when its own id matches the
  // session tenant.
  selfKeyed: { tenant: 'id' },
  // Authentication reads this before any tenant is known. See the field's note.
  selfReadableByUser: { membership: 'user_id' },
};

export function buildRlsStatements(): string[] {
  return buildRlsStatementsFor(KERNEL_RLS);
}

/** Grants for the non-owner application role. */
export function buildGrantStatements(): string[] {
  return buildGrantStatementsFor(KERNEL_RLS);
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Applies the tenant guard for the current transaction. */
export async function setTenantGuard(tx: PgDatabase<any, any, any>, tenantId: string) {
  await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
}

/**
 * Identifies the acting user for the current transaction.
 *
 * Only `kernel.membership` reads this, and only to let authentication discover
 * which tenants a user belongs to before a tenant guard can exist. Setting it
 * grants no write anywhere.
 */
export async function setUserGuard(tx: PgDatabase<any, any, any>, userId: string) {
  await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
}

/**
 * Clears the guard so a pooled connection cannot carry a tenant into the next
 * transaction. Belt and braces: `set_config(..., true)` is already
 * transaction-scoped.
 */
export async function clearTenantGuard(tx: PgDatabase<any, any, any>) {
  await tx.execute(sql`select set_config('app.tenant_id', '', true)`);
}

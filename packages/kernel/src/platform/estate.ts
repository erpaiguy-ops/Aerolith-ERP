/**
 * The vendor's view of its own estate.
 *
 * Every other read path in this system answers "what may THIS tenant see".
 * This one answers "what have we sold, to whom" — a question no tenant may ask
 * and no tenant-facing route can express. It is the only code in the kernel
 * that reads across tenants, and it does so through a role that holds SELECT
 * and nothing else (see `PLATFORM_ROLE` in ../db/rls).
 *
 * Deliberately read-only, and not merely by convention: the role's grants make
 * a write here fail in Postgres rather than in review. Provisioning, suspension
 * and entitlement changes are a separate stage with a separate credential —
 * see docs/07-platform-operations.md.
 *
 * Nothing here sets a tenant guard. There is no guard to set: the point is the
 * absence of one, and `platform_read` is `USING (true)` precisely so these
 * queries see every row. That makes this file the one place where the usual
 * reasoning about `withTenant` does not apply — which is why it is one file,
 * named for what it does, rather than a helper scattered through the kernel.
 */
import { asc, count, eq, isNull, sql } from 'drizzle-orm';

import { type Transaction } from '../db';
import { membership, tenant, tenantModule } from '../db/schema';

export interface EstateModuleRow {
  moduleKey: string;
  status: string;
  expiresOn: string | null;
  /** Seat or usage caps. The closest thing to a "plan" the schema holds today. */
  limits: Record<string, number>;
}

export interface EstateTenantRow {
  tenantId: string;
  slug: string;
  name: string;
  status: string;
  countryCode: string | null;
  currencyCode: string | null;
  createdAt: string;
  trialEndsAt: string | null;
  activeUsers: number;
  modules: EstateModuleRow[];
}

export interface EstateSummary {
  tenants: number;
  byStatus: Record<string, number>;
  /** Trials whose end date has passed, or is within `trialWarningDays`. */
  trialsExpiring: { tenantId: string; slug: string; name: string; trialEndsAt: string }[];
  /** Enabled/trial counts per module, across every tenant. */
  moduleTakeUp: { moduleKey: string; enabled: number; trialling: number }[];
}

const TRIAL_WARNING_DAYS = 14;

/**
 * Every tenant, with entitlements and user counts.
 *
 * One query per concern rather than one query with two joins: joining
 * `tenant_module` and `membership` together multiplies their rows against each
 * other, and a tenant with six modules and forty users would report 240 of
 * each. Three round trips against a table of customers is not a performance
 * problem worth a `distinct` that hides the mistake.
 */
export async function listEstate(tx: Transaction): Promise<EstateTenantRow[]> {
  const tenants = await tx
    .select({
      tenantId: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      status: tenant.status,
      countryCode: tenant.primaryCountryCode,
      currencyCode: tenant.baseCurrencyCode,
      createdAt: sql<string>`${tenant.createdAt}`,
      trialEndsAt: sql<string | null>`${tenant.trialEndsAt}`,
    })
    .from(tenant)
    .where(isNull(tenant.deletedAt))
    .orderBy(asc(tenant.name));

  if (tenants.length === 0) return [];

  const modules = await tx
    .select({
      tenantId: tenantModule.tenantId,
      moduleKey: tenantModule.moduleKey,
      status: tenantModule.status,
      expiresOn: tenantModule.expiresOn,
      limits: tenantModule.limits,
    })
    .from(tenantModule)
    .orderBy(asc(tenantModule.moduleKey));

  // Active only. A suspended or invited member is not someone using the
  // product, and counting them flatters every number built on this.
  const users = await tx
    .select({ tenantId: membership.tenantId, total: count() })
    .from(membership)
    .where(eq(membership.status, 'active'))
    .groupBy(membership.tenantId);

  const modulesByTenant = new Map<string, EstateModuleRow[]>();
  for (const row of modules) {
    const list = modulesByTenant.get(row.tenantId) ?? [];
    list.push({
      moduleKey: row.moduleKey,
      status: row.status,
      expiresOn: row.expiresOn,
      limits: row.limits ?? {},
    });
    modulesByTenant.set(row.tenantId, list);
  }

  const usersByTenant = new Map(users.map((row) => [row.tenantId, row.total]));

  return tenants.map((row) => ({
    ...row,
    activeUsers: usersByTenant.get(row.tenantId) ?? 0,
    modules: modulesByTenant.get(row.tenantId) ?? [],
  }));
}

/** One tenant in full, or null. */
export async function getEstateTenant(
  tx: Transaction,
  tenantId: string,
): Promise<EstateTenantRow | null> {
  const all = await listEstate(tx);
  return all.find((row) => row.tenantId === tenantId) ?? null;
}

/**
 * The numbers a vendor actually looks at.
 *
 * Derived from `listEstate` rather than from its own aggregate queries, so the
 * summary and the list can never disagree — a dashboard that reports eleven
 * customers above a table of ten is worse than no dashboard.
 */
export async function summariseEstate(
  tx: Transaction,
  options: { trialWarningDays?: number } = {},
): Promise<EstateSummary> {
  const rows = await listEstate(tx);
  const horizonDays = options.trialWarningDays ?? TRIAL_WARNING_DAYS;
  const horizon = new Date(Date.now() + horizonDays * 24 * 60 * 60 * 1000);

  const byStatus: Record<string, number> = {};
  const takeUp = new Map<string, { enabled: number; trialling: number }>();
  const trialsExpiring: EstateSummary['trialsExpiring'] = [];

  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;

    // Already lapsed counts too, and is the more urgent case — a trial that
    // ended last week is a customer nobody chased.
    if (row.trialEndsAt && new Date(row.trialEndsAt) <= horizon) {
      trialsExpiring.push({
        tenantId: row.tenantId,
        slug: row.slug,
        name: row.name,
        trialEndsAt: row.trialEndsAt,
      });
    }

    for (const module of row.modules) {
      const entry = takeUp.get(module.moduleKey) ?? { enabled: 0, trialling: 0 };
      if (module.status === 'enabled') entry.enabled += 1;
      if (module.status === 'trial') entry.trialling += 1;
      takeUp.set(module.moduleKey, entry);
    }
  }

  trialsExpiring.sort((a, b) => a.trialEndsAt.localeCompare(b.trialEndsAt));

  const moduleTakeUp = [...takeUp.entries()]
    .map(([moduleKey, counts]) => ({ moduleKey, ...counts }))
    .sort((a, b) => b.enabled - a.enabled || a.moduleKey.localeCompare(b.moduleKey));

  return { tenants: rows.length, byStatus, trialsExpiring, moduleTakeUp };
}

/**
 * Confirms the connection really is the read-only platform role.
 *
 * Cheap insurance against the worst configuration mistake available here:
 * pointing `DATABASE_PLATFORM_URL` at the application or owner credential.
 * That would appear to work — the reports would render — while handing a
 * surface designed to be incapable of writing a connection that is not. Better
 * to refuse at startup than to be trusted wrongly.
 */
export async function assertPlatformRole(tx: Transaction): Promise<void> {
  const result = await tx.execute(sql`
    select current_user as role,
           has_table_privilege('kernel.tenant', 'INSERT') as can_insert,
           has_table_privilege('kernel.tenant', 'UPDATE') as can_update,
           has_table_privilege('kernel.tenant', 'DELETE') as can_delete
  `);

  const row = (result.rows[0] ?? {}) as {
    role?: string;
    can_insert?: boolean;
    can_update?: boolean;
    can_delete?: boolean;
  };

  if (row.can_insert || row.can_update || row.can_delete) {
    throw new Error(
      `Refusing to read the estate as "${row.role}": that role can write to kernel.tenant. ` +
        'DATABASE_PLATFORM_URL must point at the SELECT-only platform role.',
    );
  }
}

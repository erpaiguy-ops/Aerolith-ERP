/**
 * Module entitlements — what this tenant has bought.
 *
 * `kernel.module.manage` was declared from the start and gated nothing, because
 * entitlements were rows a SQL script inserted. `/modules/catalogue` could list
 * what the deployment ships and `/me` could list what the tenant has, and
 * nothing could move a module from the first list to the second.
 *
 * Two things this file exists to get right, both of which were latent before it:
 *
 *  - **Enabling a module provisions its number series.** Every manifest declares
 *    `numberSeries`, and `provisionSeries` was written to consume that
 *    declaration with a comment saying "called when a tenant enables the
 *    module" — except nothing called it, so the series were only ever created
 *    by hand in the seed and in each test's `beforeAll`. That gap is recorded
 *    three times in the roadmap as "declaring a series in the manifest does not
 *    provision it". This is the caller it was waiting for.
 *  - **Disabling has to mean something.** `modulesForTenant` selected every
 *    `tenant_module` row regardless of `status`, so a row marked `disabled`
 *    still granted access and an `expired` entitlement never expired. Fixed in
 *    `bootstrap.ts`; without it, everything below would be a screen that
 *    appears to work and changes nothing.
 */
import {
  provisionSeries,
  recordAudit,
  schema,
  type Transaction,
} from '@aerolith/kernel';
import { and, eq } from 'drizzle-orm';

import { ACTIVE_MODULE_STATUSES, invalidateTenantModules, registry } from './bootstrap';

export class EntitlementError extends Error {
  override readonly name = 'EntitlementError';
}

export interface ModuleEntitlementRow {
  key: string;
  name: string;
  description: string | null;
  category: string;
  version: string;
  sellable: boolean;
  standalone: boolean;
  dependsOn: string[];
  /** Null when the tenant has no row for this module at all. */
  status: string | null;
  enabledAt: string | null;
  expiresOn: string | null;
  /** Enabled modules that would break if this one were turned off. */
  requiredBy: string[];
}

/**
 * The catalogue, annotated with what this tenant has.
 *
 * One list rather than two, because the question an admin is answering is "what
 * could we turn on" and a screen that separates owned from available makes them
 * hold both halves in their head.
 */
export async function listModuleEntitlements(
  tx: Transaction,
  tenantId: string,
): Promise<ModuleEntitlementRow[]> {
  const owned = await tx
    .select({
      moduleKey: schema.tenantModule.moduleKey,
      status: schema.tenantModule.status,
      enabledAt: schema.tenantModule.enabledAt,
      expiresOn: schema.tenantModule.expiresOn,
    })
    .from(schema.tenantModule)
    .where(eq(schema.tenantModule.tenantId, tenantId));

  const byKey = new Map(owned.map((row) => [row.moduleKey, row]));
  const activeKeys = new Set(
    owned
      .filter((row) => (ACTIVE_MODULE_STATUSES as readonly string[]).includes(row.status))
      .map((row) => row.moduleKey),
  );

  return registry.all().map((module) => {
    const row = byKey.get(module.key);
    return {
      key: module.key,
      name: module.name,
      description: module.description ?? null,
      category: module.category,
      version: module.version,
      sellable: module.sellable,
      standalone: module.standalone,
      dependsOn: module.dependsOn.filter((key) => key !== 'kernel'),
      status: row?.status ?? null,
      enabledAt: row ? new Date(row.enabledAt).toISOString() : null,
      expiresOn: row?.expiresOn ?? null,
      requiredBy: registry
        .all()
        .filter((other) => activeKeys.has(other.key) && other.dependsOn.includes(module.key))
        .map((other) => other.key),
    };
  });
}

/**
 * Enables a module for the tenant, with its dependencies and its number series.
 *
 * Dependencies are pulled in rather than refused. Refusing would be telling an
 * admin to go and enable three other things in the right order, which is a task
 * the machine already knows how to do — and `resolveForTenant` would silently
 * skip the module anyway if they got it wrong, leaving them with a module they
 * bought and cannot see.
 */
export async function enableModule(
  tx: Transaction,
  input: { tenantId: string; moduleKey: string },
): Promise<{ enabled: string[]; seriesCreated: number }> {
  const module = registry.all().find((m) => m.key === input.moduleKey);
  if (!module) {
    throw new EntitlementError(`"${input.moduleKey}" is not a module this deployment ships.`);
  }

  // Dependency order matters: a module's own series are provisioned after the
  // things it depends on exist, and `dependsOn` is a shallow list here because
  // every dependency is itself resolved the same way on the way down.
  const toEnable: string[] = [];
  const visit = (key: string, trail: string[]) => {
    if (trail.includes(key)) return; // cycles are rejected by registry.validate()
    const found = registry.all().find((m) => m.key === key);
    if (!found) return;
    for (const dependency of found.dependsOn) {
      if (dependency === 'kernel') continue;
      visit(dependency, [...trail, key]);
    }
    if (!toEnable.includes(key)) toEnable.push(key);
  };
  visit(input.moduleKey, []);

  const enabled: string[] = [];
  let seriesCreated = 0;

  for (const key of toEnable) {
    const manifest = registry.all().find((m) => m.key === key)!;

    const [row] = await tx
      .insert(schema.tenantModule)
      .values({
        tenantId: input.tenantId,
        moduleKey: key,
        status: 'enabled',
        version: manifest.version,
      })
      .onConflictDoUpdate({
        target: [schema.tenantModule.tenantId, schema.tenantModule.moduleKey],
        // Re-enabling a disabled module restores it rather than erroring: the
        // row already carries the tenant's settings and limits, and throwing
        // them away to re-add the same module would be a surprising way to
        // lose configuration.
        set: { status: 'enabled', version: manifest.version, updatedAt: new Date() },
      })
      .returning({ id: schema.tenantModule.id });

    if (row) enabled.push(key);

    // Idempotent, so re-enabling does not duplicate a series or reset a counter.
    seriesCreated += await provisionSeries(tx, {
      tenantId: input.tenantId,
      series: manifest.numberSeries ?? [],
    });

    /*
     * `create`/`update` rather than `enable`/`disable`: the audit action enum
     * is a kernel-wide type, and widening it would mean regenerating the
     * kernel migration that every module schema holds a foreign key into — a
     * disproportionate change to buy a nicer verb. The entity type, the label
     * and the reason already make the entry unambiguous, and filtering the
     * trail by `kernel.tenant_module` finds every one of these.
     */
    await recordAudit(tx, {
      moduleKey: 'kernel',
      entityType: 'kernel.tenant_module',
      entityId: row?.id,
      entityLabel: key,
      action: 'create',
      reason:
        key === input.moduleKey
          ? 'Module enabled.'
          : `Module enabled — required by "${input.moduleKey}".`,
    });
  }

  invalidateTenantModules(input.tenantId);
  return { enabled, seriesCreated };
}

/**
 * Disables a module, refusing if another enabled module needs it.
 *
 * The row is kept and marked `disabled` rather than deleted. A module's data
 * outlives its entitlement — a tenant who stops paying for Production still has
 * last year's work orders, and re-enabling should give them back rather than
 * present an empty module.
 */
export async function disableModule(
  tx: Transaction,
  input: { tenantId: string; moduleKey: string },
): Promise<void> {
  const [existing] = await tx
    .select({ id: schema.tenantModule.id, status: schema.tenantModule.status })
    .from(schema.tenantModule)
    .where(
      and(
        eq(schema.tenantModule.tenantId, input.tenantId),
        eq(schema.tenantModule.moduleKey, input.moduleKey),
      ),
    );

  if (!existing) throw new EntitlementError('This workspace does not have that module.');

  const active = await tx
    .select({ moduleKey: schema.tenantModule.moduleKey })
    .from(schema.tenantModule)
    .where(eq(schema.tenantModule.tenantId, input.tenantId));

  const activeKeys = new Set(
    active
      .filter((row) => row.moduleKey !== input.moduleKey)
      .map((row) => row.moduleKey),
  );

  /*
   * Named, not counted. `resolveForTenant` would quietly skip a module whose
   * dependency vanished, so without this an admin turning off Inventory would
   * find Procurement gone too and nothing would have said so.
   */
  const dependents = registry
    .all()
    .filter((m) => activeKeys.has(m.key) && m.dependsOn.includes(input.moduleKey))
    .map((m) => m.name);

  if (dependents.length > 0) {
    throw new EntitlementError(
      `${dependents.join(' and ')} ${dependents.length === 1 ? 'depends' : 'depend'} on this ` +
        'module. Disable it first, or it would stop working with nothing to say why.',
    );
  }

  await tx
    .update(schema.tenantModule)
    .set({ status: 'disabled', updatedAt: new Date() })
    .where(eq(schema.tenantModule.id, existing.id));

  await recordAudit(tx, {
    moduleKey: 'kernel',
    entityType: 'kernel.tenant_module',
    entityId: existing.id,
    entityLabel: input.moduleKey,
    action: 'update',
    reason: 'Module disabled.',
  });

  invalidateTenantModules(input.tenantId);
}

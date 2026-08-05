/**
 * Module bootstrap.
 *
 * Compiled-in modules declare themselves; this syncs those declarations into the
 * database (permissions, rule definitions) once at startup, and resolves the
 * per-tenant module set at request time.
 *
 * Note what is NOT here: no per-module deployment, no build-time switch. Which
 * modules a tenant sees is rows in `kernel.tenant_module`.
 */
import {
  KERNEL_MODULE_KEY,
  KERNEL_PERMISSIONS,
  ModuleRegistry,
  registerModuleRules,
  schema,
  withTenantId,
  withoutTenantGuard,
  type ModuleManifest,
  type ResolvedModules,
} from '@aerolith/kernel';
import { contractsModule } from '@aerolith/module-contracts';
import { inventoryModule } from '@aerolith/module-inventory';
import { estimationModule } from '@aerolith/module-estimation';
import { procurementModule } from '@aerolith/module-procurement';
import { productionModule } from '@aerolith/module-production';
import { projectsModule } from '@aerolith/module-projects';
import { and, eq, gte, inArray, isNull, or } from 'drizzle-orm';

/** Every module compiled into this binary. */
export const MODULES: ModuleManifest[] = [
  inventoryModule,
  procurementModule,
  productionModule,
  estimationModule,
  projectsModule,
  contractsModule,
];

export const registry = new ModuleRegistry().registerAll(MODULES);

/**
 * Validates the compiled module graph and syncs manifests to the database.
 * Runs once at startup; a bad manifest fails the process rather than the first
 * request that happens to touch it.
 */
export async function syncModules(): Promise<{ permissions: number; rules: number }> {
  registry.validate();

  let permissions = 0;
  let rules = 0;

  await withoutTenantGuard(async (tx) => {
    // The kernel's own permissions exist regardless of which modules a tenant
    // has bought, so they are synced first.
    for (const permission of KERNEL_PERMISSIONS) {
      await tx
        .insert(schema.permission)
        .values({
          key: permission.key,
          moduleKey: KERNEL_MODULE_KEY,
          resource: permission.resource,
          action: permission.action,
          label: permission.label,
          description: permission.description,
          category: permission.category,
          isDangerous: permission.isDangerous,
        })
        .onConflictDoUpdate({
          target: schema.permission.key,
          set: { label: permission.label, isDangerous: permission.isDangerous, updatedAt: new Date() },
        });
      permissions += 1;
    }

    for (const module of registry.all()) {
      /*
       * The heading a module's permissions group under.
       *
       * Its navigation label, not its `name`: the name is the product name a
       * module is SOLD as ("Aerolith Contract Administration"), which reads
       * badly as a heading to somebody already inside Aerolith, while the nav
       * label is the word they see in the sidebar. Matching the two means the
       * permission matrix is grouped the same way the application is.
       */
      const moduleCategory = module.nav?.[0]?.label ?? module.name;

      for (const permission of module.permissions) {
        await tx
          .insert(schema.permission)
          .values({
            key: permission.key,
            moduleKey: module.key,
            resource: permission.resource,
            action: permission.action,
            label: permission.label,
            description: permission.description,
            // Defaulted to the module's own name rather than left null.
            // `category` is the grouping the permission matrix renders, and a
            // module that forgets one drops its permissions into "Other" — which
            // is where 63 of 76 of them were sitting, because no module declared
            // any. The module name is the grouping a person wants for a module's
            // permissions anyway; the kernel's curated categories still win
            // where they are set.
            category: permission.category ?? moduleCategory,
            isDangerous: permission.isDangerous,
          })
          .onConflictDoUpdate({
            target: schema.permission.key,
            set: {
              label: permission.label,
              description: permission.description,
              // Included, or a manifest correcting a category never lands: the
              // row already exists on every boot after the first.
              category: permission.category ?? moduleCategory,
              isDangerous: permission.isDangerous,
              updatedAt: new Date(),
            },
          });
        permissions += 1;
      }

      rules += await registerModuleRules(tx, { moduleKey: module.key, rules: module.rules });
    }
  });

  return { permissions, rules };
}

/**
 * The modules this tenant actually gets.
 *
 * Cached per tenant — this runs on every request and the entitlement set
 * changes rarely. Invalidated explicitly when entitlements are edited.
 */
/**
 * Entitlement statuses that actually grant access.
 *
 * Lives here rather than beside the entitlement service because this is the
 * file that reads it on every request; the service imports it from here, which
 * also keeps the dependency pointing one way.
 */
export const ACTIVE_MODULE_STATUSES = ['enabled', 'trial'] as const;

const cache = new Map<string, ResolvedModules>();

export async function modulesForTenant(tenantId: string): Promise<ResolvedModules> {
  const cached = cache.get(tenantId);
  if (cached) return cached;

  // `withTenantId`, not `withoutTenantGuard`. `kernel.tenant_module` is
  // tenant-scoped, so under the application role an unguarded read returns
  // nothing — and "no entitlements" is indistinguishable from "bought nothing",
  // so every module answers 404 and the whole application looks unentitled. The
  // tenant is already known here, so no policy needs widening; the guard just
  // has to be set.
  /*
   * Status is part of the question, not decoration.
   *
   * This selected every row regardless of `status`, so a `disabled` entitlement
   * still granted access and an `expired` one never expired — the column existed
   * and nothing read it. Harmless while the only way to get a row was a SQL
   * script that always wrote 'enabled'; not harmless once a screen can disable
   * a module, which would otherwise appear to work and change nothing.
   */
  const entitlements = await withTenantId(tenantId, async (tx) =>
    tx
      .select({ moduleKey: schema.tenantModule.moduleKey })
      .from(schema.tenantModule)
      .where(
        and(
          eq(schema.tenantModule.tenantId, tenantId),
          inArray(schema.tenantModule.status, [...ACTIVE_MODULE_STATUSES]),
          // An entitlement with no end date never lapses; one with a date
          // lapses the day after it.
          or(
            isNull(schema.tenantModule.expiresOn),
            gte(schema.tenantModule.expiresOn, new Date().toISOString().slice(0, 10)),
          ),
        ),
      ),
  );

  const active = entitlements.map((e) => e.moduleKey);
  const resolved = registry.resolveForTenant(active);
  cache.set(tenantId, resolved);
  return resolved;
}

export function invalidateTenantModules(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

/**
 * The navigation a user sees: their tenant's modules, filtered by their
 * permissions. This is what makes a single-module tenant look like a focused
 * product rather than an ERP with most menus greyed out.
 */
export function navigationFor(
  modules: ResolvedModules,
  permissions: ReadonlySet<string>,
): ModuleManifest['nav'] {
  const visible = (items: ModuleManifest['nav']): ModuleManifest['nav'] =>
    items
      .filter((item) => !item.permission || permissions.has(item.permission))
      .map((item) => ({ ...item, children: item.children ? visible(item.children) : undefined }))
      .filter((item) => item.path || (item.children && item.children.length > 0))
      .sort((a, b) => a.order - b.order);

  // Sorted ACROSS modules, not only within each one. `modules.ordered` is
  // dependency order, which is the right order to boot modules in and the wrong
  // order to show a menu in — it put Contracts above Estimating, reversing the
  // workflow the whole product is arranged around. The `order` field on a
  // top-level nav item exists to express that intent; honouring it only inside
  // a module silently ignored it.
  return modules.ordered
    .flatMap((module) => visible(module.nav))
    .sort((a, b) => a.order - b.order);
}

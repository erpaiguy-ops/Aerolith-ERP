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
  withoutTenantGuard,
  type ModuleManifest,
  type ResolvedModules,
} from '@aerolith/kernel';
import { inventoryModule } from '@aerolith/module-inventory';
import { estimationModule } from '@aerolith/module-estimation';
import { productionModule } from '@aerolith/module-production';
import { eq } from 'drizzle-orm';

/** Every module compiled into this binary. */
export const MODULES: ModuleManifest[] = [inventoryModule, productionModule, estimationModule];

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
            category: permission.category,
            isDangerous: permission.isDangerous,
          })
          .onConflictDoUpdate({
            target: schema.permission.key,
            set: {
              label: permission.label,
              description: permission.description,
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
const cache = new Map<string, ResolvedModules>();

export async function modulesForTenant(tenantId: string): Promise<ResolvedModules> {
  const cached = cache.get(tenantId);
  if (cached) return cached;

  const entitlements = await withoutTenantGuard(async (tx) =>
    tx
      .select({ moduleKey: schema.tenantModule.moduleKey })
      .from(schema.tenantModule)
      .where(eq(schema.tenantModule.tenantId, tenantId)),
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

  return modules.ordered.flatMap((module) => visible(module.nav));
}

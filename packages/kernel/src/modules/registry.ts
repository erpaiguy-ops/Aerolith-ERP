/**
 * Module registry.
 *
 * Holds every module compiled into the binary, and resolves which of them a
 * given tenant actually gets. One deployment serves a customer who bought only
 * Inventory and a customer who bought the full ERP — the difference is rows in
 * `kernel.tenant_module`, not a different build.
 */
import { type ModuleManifest } from './manifest';

export interface ResolvedModules {
  /** Boot order: dependencies before dependants. */
  ordered: ModuleManifest[];
  enabled: Set<string>;
  /** Requested but unavailable, with the reason. Surfaced to tenant admins. */
  skipped: { key: string; reason: string }[];
}

export class ModuleRegistry {
  private readonly modules = new Map<string, ModuleManifest>();

  register(manifest: ModuleManifest): this {
    if (this.modules.has(manifest.key)) {
      throw new Error(`Module "${manifest.key}" is already registered.`);
    }
    for (const existing of this.modules.values()) {
      if (existing.dbSchema === manifest.dbSchema) {
        throw new Error(
          `Modules "${existing.key}" and "${manifest.key}" both claim the Postgres schema ` +
            `"${manifest.dbSchema}". A schema has exactly one owner.`,
        );
      }
    }
    this.modules.set(manifest.key, manifest);
    return this;
  }

  registerAll(manifests: ModuleManifest[]): this {
    for (const manifest of manifests) this.register(manifest);
    return this;
  }

  get(key: string): ModuleManifest | undefined {
    return this.modules.get(key);
  }

  all(): ModuleManifest[] {
    return [...this.modules.values()];
  }

  /** Modules that can be sold on their own. */
  standalone(): ModuleManifest[] {
    return this.all().filter((m) => m.standalone && m.sellable);
  }

  /**
   * Validates the whole compiled set: every hard dependency exists and there are
   * no cycles. Run at startup so a bad manifest fails fast rather than at the
   * first request that happens to touch it.
   */
  validate(): void {
    const problems: string[] = [];

    for (const module of this.modules.values()) {
      for (const dependency of module.dependsOn) {
        if (dependency !== 'kernel' && !this.modules.has(dependency)) {
          problems.push(`"${module.key}" depends on unknown module "${dependency}".`);
        }
      }
      for (const soft of module.integratesWith) {
        if (soft !== 'kernel' && !this.modules.has(soft)) {
          problems.push(
            `"${module.key}" declares an integration with unknown module "${soft}". ` +
              'Soft integrations must still name a real module.',
          );
        }
      }
    }

    const cycle = this.findCycle();
    if (cycle) {
      problems.push(
        `Dependency cycle: ${cycle.join(' -> ')}. Break it with an event rather than a ` +
          'direct dependency.',
      );
    }

    if (problems.length > 0) {
      throw new Error(`Module registry is invalid:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    }
  }

  /**
   * Resolves the module set for a tenant.
   *
   * Hard dependencies are pulled in automatically — entitling a tenant to
   * Production without Inventory would otherwise produce a module that cannot
   * function. Soft integrations are never pulled in; they light up only if the
   * tenant separately holds them.
   */
  resolveForTenant(entitlements: readonly string[]): ResolvedModules {
    const requested = new Set(entitlements);
    const enabled = new Set<string>();
    const skipped: { key: string; reason: string }[] = [];

    const include = (key: string, trail: string[]): boolean => {
      if (enabled.has(key)) return true;
      const module = this.modules.get(key);
      if (!module) {
        skipped.push({ key, reason: 'Module is not present in this deployment.' });
        return false;
      }
      if (trail.includes(key)) return true; // cycle already reported by validate()

      for (const dependency of module.dependsOn) {
        if (dependency === 'kernel') continue;
        if (!include(dependency, [...trail, key])) {
          skipped.push({
            key,
            reason: `Requires "${dependency}", which is unavailable.`,
          });
          return false;
        }
      }
      enabled.add(key);
      return true;
    };

    for (const key of requested) include(key, []);

    return { ordered: this.topologicalOrder(enabled), enabled, skipped };
  }

  private topologicalOrder(keys: ReadonlySet<string>): ModuleManifest[] {
    const ordered: ModuleManifest[] = [];
    const visited = new Set<string>();

    const visit = (key: string) => {
      if (visited.has(key)) return;
      visited.add(key);
      const module = this.modules.get(key);
      if (!module) return;
      for (const dependency of module.dependsOn) {
        if (keys.has(dependency)) visit(dependency);
      }
      ordered.push(module);
    };

    for (const key of [...keys].sort()) visit(key);
    return ordered;
  }

  private findCycle(): string[] | null {
    const visiting = new Set<string>();
    const done = new Set<string>();
    const trail: string[] = [];

    const walk = (key: string): string[] | null => {
      if (done.has(key)) return null;
      if (visiting.has(key)) return [...trail.slice(trail.indexOf(key)), key];

      visiting.add(key);
      trail.push(key);
      const module = this.modules.get(key);
      for (const dependency of module?.dependsOn ?? []) {
        if (dependency === 'kernel') continue;
        const found = walk(dependency);
        if (found) return found;
      }
      trail.pop();
      visiting.delete(key);
      done.add(key);
      return null;
    };

    for (const key of this.modules.keys()) {
      const found = walk(key);
      if (found) return found;
    }
    return null;
  }
}

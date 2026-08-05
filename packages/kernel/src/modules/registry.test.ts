import { describe, expect, it } from 'vitest';

import { defineModule } from './manifest';
import { ModuleRegistry } from './registry';

const module = (
  key: string,
  overrides: Partial<Parameters<typeof defineModule>[0]> = {},
) =>
  defineModule({
    key,
    name: key,
    version: '1.0.0',
    category: 'operations',
    dbSchema: key.replace(/-/g, '_'),
    ...overrides,
  });

describe('defineModule', () => {
  it('requires permissions to be namespaced under the module key', () => {
    expect(() =>
      module('inventory', {
        permissions: [
          { key: 'procurement.po.approve', resource: 'po', action: 'approve', label: 'Approve' },
        ],
      }),
    ).toThrow(/namespaced/);
  });

  it('requires emitted events to be namespaced under the module key', () => {
    expect(() =>
      module('inventory', { events: { emits: [{ type: 'accounts.posted' }], consumes: [] } }),
    ).toThrow(/namespaced/);
  });

  it('rejects a non-kebab-case key', () => {
    expect(() => module('Inventory_Module')).toThrow(/kebab-case/);
  });

  it('accepts a well-formed manifest and applies defaults', () => {
    const manifest = module('inventory', {
      nav: [{ key: 'stock', label: 'Stock', path: '/stock' }],
    });

    expect(manifest.standalone).toBe(false);
    expect(manifest.nav[0]?.order).toBe(100);
  });
});

describe('ModuleRegistry', () => {
  it('refuses two modules claiming the same Postgres schema', () => {
    const registry = new ModuleRegistry().register(module('inventory'));
    expect(() => registry.register(module('stores', { dbSchema: 'inventory' }))).toThrow(
      /both claim the Postgres schema/,
    );
  });

  it('refuses to register the same module twice', () => {
    const registry = new ModuleRegistry().register(module('inventory'));
    expect(() => registry.register(module('inventory'))).toThrow(/already registered/);
  });

  it('rejects a dependency on a module that is not compiled in', () => {
    const registry = new ModuleRegistry().register(
      module('production', { dependsOn: ['inventory'] }),
    );
    expect(() => registry.validate()).toThrow(/unknown module "inventory"/);
  });

  it('detects a dependency cycle', () => {
    const registry = new ModuleRegistry().registerAll([
      module('alpha', { dependsOn: ['beta'] }),
      module('beta', { dependsOn: ['alpha'] }),
    ]);
    expect(() => registry.validate()).toThrow(/cycle/);
  });

  it('accepts a valid graph', () => {
    const registry = new ModuleRegistry().registerAll([
      module('inventory'),
      module('production', { dependsOn: ['inventory'] }),
    ]);
    expect(() => registry.validate()).not.toThrow();
  });
});

describe('ModuleRegistry.resolveForTenant', () => {
  const registry = new ModuleRegistry().registerAll([
    module('inventory', { standalone: true }),
    module('procurement', { dependsOn: ['inventory'], integratesWith: ['accounts'] }),
    module('production', { dependsOn: ['inventory'], integratesWith: ['projects'] }),
    module('projects', { standalone: true }),
    module('accounts', { standalone: true }),
  ]);

  it('gives a single-module tenant only that module', () => {
    const resolved = registry.resolveForTenant(['inventory']);

    expect([...resolved.enabled]).toEqual(['inventory']);
    expect(resolved.skipped).toEqual([]);
  });

  it('pulls in hard dependencies automatically', () => {
    // Entitling Production without Inventory would produce a module that cannot
    // consume stock — so Inventory comes along.
    const resolved = registry.resolveForTenant(['production']);

    expect(resolved.enabled.has('inventory')).toBe(true);
    expect(resolved.enabled.has('production')).toBe(true);
  });

  it('does NOT pull in soft integrations', () => {
    // Procurement runs perfectly well without Accounts; it just does not post
    // to the GL. Pulling Accounts in would mean selling it by accident.
    const resolved = registry.resolveForTenant(['procurement']);

    expect(resolved.enabled.has('accounts')).toBe(false);
    expect(resolved.enabled.has('inventory')).toBe(true);
  });

  it('orders dependencies before dependants', () => {
    const resolved = registry.resolveForTenant(['production', 'procurement', 'inventory']);
    const order = resolved.ordered.map((m) => m.key);

    expect(order.indexOf('inventory')).toBeLessThan(order.indexOf('production'));
    expect(order.indexOf('inventory')).toBeLessThan(order.indexOf('procurement'));
  });

  it('reports an entitlement this deployment cannot serve', () => {
    const resolved = registry.resolveForTenant(['inventory', 'estimation']);

    expect(resolved.enabled.has('inventory')).toBe(true);
    expect(resolved.skipped).toContainEqual({
      key: 'estimation',
      reason: 'Module is not present in this deployment.',
    });
  });

  it('gives the full ERP when everything is entitled', () => {
    const resolved = registry.resolveForTenant(registry.all().map((m) => m.key));
    expect(resolved.enabled.size).toBe(5);
    expect(resolved.skipped).toEqual([]);
  });

  it('lists only modules marked sellable on their own', () => {
    expect(registry.standalone().map((m) => m.key).sort()).toEqual([
      'accounts',
      'inventory',
      'projects',
    ]);
  });
});

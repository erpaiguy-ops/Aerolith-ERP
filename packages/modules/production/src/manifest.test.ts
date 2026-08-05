import { describe, expect, it } from 'vitest';

import { productionModule } from './manifest';

describe('production manifest', () => {
  it('declares the number series the service allocates against', () => {
    // createWorkOrder() allocates 'production.work_order'. A missing series is
    // not a compile error and nothing else catches it — the first work order
    // simply fails at runtime.
    const declared = new Set(productionModule.numberSeries.map((s) => s.entityType));
    expect(declared).toContain('production.work_order');
    expect(declared).toContain('production.finishing_batch');
  });

  it('gives every series a sequence and a year token', () => {
    for (const series of productionModule.numberSeries) {
      expect(series.pattern, `${series.code} has no sequence`).toContain('{SEQ}');
      expect(series.pattern, `${series.code} has no year`).toMatch(/\{(YYYY|YY|FY)\}/);
    }
  });

  it('treats Inventory as a SOFT dependency, so it ships standalone', () => {
    // Production obviously needs stock, but making that a hard dependency would
    // mean it could never be sold on its own. Material issue is composed at the
    // application layer instead.
    expect(productionModule.dependsOn).toEqual(['kernel']);
    expect(productionModule.integratesWith).toContain('inventory');
    expect(productionModule.standalone).toBe(true);
  });

  it('owns exactly one Postgres schema, named after itself', () => {
    expect(productionModule.dbSchema).toBe('production');
  });

  it('namespaces every permission, event and rule under its own key', () => {
    for (const permission of productionModule.permissions) {
      expect(permission.key.startsWith('production.')).toBe(true);
    }
    for (const event of productionModule.events.emits) {
      expect(event.type.startsWith('production.')).toBe(true);
    }
    for (const rule of productionModule.rules) {
      expect(rule.key.startsWith('production.')).toBe(true);
    }
  });

  it('gates every navigation leaf on a permission it declares', () => {
    const declared = new Set(productionModule.permissions.map((p) => p.key));

    const walk = (items: typeof productionModule.nav) => {
      for (const item of items) {
        if (item.permission) {
          expect(declared, `nav "${item.key}" needs an undeclared permission`).toContain(
            item.permission,
          );
        }
        if (item.children) walk(item.children);
      }
    };

    walk(productionModule.nav);
  });

  it('marks release and sequence override as dangerous', () => {
    // Releasing commits material; overriding the sequence is how the edgebander
    // gets skipped. Both need to be visible in the permission matrix.
    const dangerous = productionModule.permissions.filter((p) => p.isDangerous).map((p) => p.key);
    expect(dangerous).toContain('production.work_order.release');
    expect(dangerous).toContain('production.scan.override');
  });
});

describe('menu placement', () => {
  it('sits between Estimating and Projects, matching the workflow', () => {
    // The top-level `order` is sorted ACROSS modules, so these values are a
    // shared namespace rather than a per-module preference. Production shared
    // 30 with Contracts until the web shell rendered them and the tie showed.
    expect(productionModule.nav[0]!.order).toBe(20);
  });
});

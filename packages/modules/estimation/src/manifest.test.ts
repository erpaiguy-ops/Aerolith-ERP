import { describe, expect, it } from 'vitest';

import { estimationModule } from './manifest';

describe('estimation manifest', () => {
  it('declares the number series the service allocates against', () => {
    const declared = new Set(estimationModule.numberSeries.map((s) => s.entityType));
    expect(declared).toContain('estimation.tender');
  });

  it('gives every series a sequence and a year token', () => {
    for (const series of estimationModule.numberSeries) {
      expect(series.pattern).toContain('{SEQ}');
      expect(series.pattern).toMatch(/\{(YYYY|YY|FY)\}/);
    }
  });

  it('ships standalone, integrating with Production rather than depending on it', () => {
    // A firm that only wants to price tenders should be able to buy just this.
    expect(estimationModule.dependsOn).toEqual(['kernel']);
    expect(estimationModule.integratesWith).toContain('production');
    expect(estimationModule.standalone).toBe(true);
  });

  it('owns exactly one Postgres schema, named after itself', () => {
    expect(estimationModule.dbSchema).toBe('estimation');
  });

  it('namespaces every permission, event and rule under its own key', () => {
    for (const permission of estimationModule.permissions) {
      expect(permission.key.startsWith('estimation.')).toBe(true);
    }
    for (const event of estimationModule.events.emits) {
      expect(event.type.startsWith('estimation.')).toBe(true);
    }
    for (const rule of estimationModule.rules) {
      expect(rule.key.startsWith('estimation.')).toBe(true);
    }
  });

  it('gates every navigation leaf on a permission it declares', () => {
    const declared = new Set(estimationModule.permissions.map((p) => p.key));

    const walk = (items: typeof estimationModule.nav) => {
      for (const item of items) {
        if (item.permission) expect(declared).toContain(item.permission);
        if (item.children) walk(item.children);
      }
    };

    walk(estimationModule.nav);
  });

  it('separates seeing an estimate from seeing its margin', () => {
    // Not everyone who reads a BOQ should see what the company makes on it.
    const keys = estimationModule.permissions.map((p) => p.key);
    expect(keys).toContain('estimation.estimate.read');
    expect(keys).toContain('estimation.margin.view');
  });

  it('marks submitting a price and editing the rate library as dangerous', () => {
    const dangerous = estimationModule.permissions.filter((p) => p.isDangerous).map((p) => p.key);
    expect(dangerous).toContain('estimation.estimate.submit');
    expect(dangerous).toContain('estimation.rate_library.manage');
  });
});

import { describe, expect, it } from 'vitest';

import { movementType } from './db/schema';
import { inventoryModule } from './manifest';

describe('inventory manifest', () => {
  it('declares a number series for every movement type it can post', () => {
    // postMovement() allocates against `inventory.${type}`. A missing series is
    // not a compile error and not caught by any other test — the posting simply
    // fails at runtime with "no active number series".
    const declared = new Set(inventoryModule.numberSeries.map((s) => s.entityType));

    for (const type of movementType.enumValues) {
      expect(declared, `no number series declared for ${type}`).toContain(`inventory.${type}`);
    }
  });

  it('gives every series a pattern that can produce unique numbers', () => {
    for (const series of inventoryModule.numberSeries) {
      expect(series.pattern, `${series.code} has no sequence token`).toContain('{SEQ}');
      // Every pattern here resets yearly, so it needs a year token or last
      // year's numbers are reissued.
      expect(series.pattern, `${series.code} has no year token`).toMatch(/\{(YYYY|YY|FY)\}/);
    }
  });

  it('uses a distinct code per series', () => {
    const codes = inventoryModule.numberSeries.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('is sellable on its own and depends only on the kernel', () => {
    // The moment this gains a hard dependency on another module it stops being
    // a standalone product.
    expect(inventoryModule.standalone).toBe(true);
    expect(inventoryModule.dependsOn).toEqual(['kernel']);
  });

  it('owns exactly one Postgres schema, named after itself', () => {
    expect(inventoryModule.dbSchema).toBe('inventory');
  });

  it('namespaces every permission, event and rule under its own key', () => {
    for (const permission of inventoryModule.permissions) {
      expect(permission.key.startsWith('inventory.')).toBe(true);
    }
    for (const event of inventoryModule.events.emits) {
      expect(event.type.startsWith('inventory.')).toBe(true);
    }
    for (const rule of inventoryModule.rules) {
      expect(rule.key.startsWith('inventory.')).toBe(true);
    }
  });

  it('gates every navigation leaf on a permission it declares', () => {
    const declared = new Set(inventoryModule.permissions.map((p) => p.key));

    const walk = (items: typeof inventoryModule.nav) => {
      for (const item of items) {
        if (item.permission) {
          expect(declared, `nav "${item.key}" needs an undeclared permission`).toContain(
            item.permission,
          );
        }
        if (item.children) walk(item.children);
      }
    };

    walk(inventoryModule.nav);
  });

  it('marks stock count reconciliation as dangerous', () => {
    // It is how stock loss gets written off, and therefore how it gets hidden.
    const reconcile = inventoryModule.permissions.find(
      (p) => p.key === 'inventory.stock_count.reconcile',
    );
    expect(reconcile?.isDangerous).toBe(true);
  });
});

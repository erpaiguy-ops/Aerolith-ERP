import { describe, expect, it } from 'vitest';

import { exceptionCode } from './db/schema';
import { procurementModule } from './manifest';
import type { ExceptionCode } from './domain/matching';

describe('procurement manifest', () => {
  it('declares the number series the service allocates against', () => {
    // Every one of these is passed to `allocateNumber` somewhere in
    // service/purchasing.ts. A missing series is a runtime failure on the first
    // document of that type, which is exactly the wrong moment to find out.
    const declared = new Set(procurementModule.numberSeries.map((s) => s.entityType));
    expect(declared).toContain('procurement.requisition');
    expect(declared).toContain('procurement.rfq');
    expect(declared).toContain('procurement.purchase_order');
    expect(declared).toContain('procurement.goods_receipt');
    expect(declared).toContain('procurement.supplier_invoice');
  });

  it('gives every series a sequence and a year token', () => {
    for (const series of procurementModule.numberSeries) {
      expect(series.pattern).toContain('{SEQ}');
      expect(series.pattern).toMatch(/\{(YYYY|YY|FY)\}/);
    }
  });

  it('depends on the kernel alone, so purchasing can be bought on its own', () => {
    // Stock movement and commitment accounting are composed at the application
    // layer. A hard dependency on Inventory would mean a firm that wants only
    // purchasing has to buy and run a warehouse module it will never open.
    expect(procurementModule.dependsOn).toEqual(['kernel']);
    expect(procurementModule.integratesWith).toContain('inventory');
    expect(procurementModule.integratesWith).toContain('projects');
    expect(procurementModule.standalone).toBe(true);
  });

  it('names only modules that exist in its soft integrations', () => {
    // The registry rejects an integration with an unknown module at boot. This
    // catches it at test time instead, where the message is clearer.
    const built = new Set(['kernel', 'inventory', 'production', 'estimation', 'projects', 'contracts']);
    for (const key of procurementModule.integratesWith) {
      expect(built).toContain(key);
    }
  });

  it('owns exactly one Postgres schema, named after itself', () => {
    expect(procurementModule.dbSchema).toBe('procurement');
  });

  it('namespaces every permission, event and rule under its own key', () => {
    for (const permission of procurementModule.permissions) {
      expect(permission.key.startsWith('procurement.')).toBe(true);
    }
    for (const event of procurementModule.events.emits) {
      expect(event.type.startsWith('procurement.')).toBe(true);
    }
    for (const rule of procurementModule.rules) {
      expect(rule.key.startsWith('procurement.')).toBe(true);
    }
  });

  it('gates every navigation leaf on a permission it declares', () => {
    const declared = new Set(procurementModule.permissions.map((p) => p.key));

    const walk = (items: typeof procurementModule.nav) => {
      for (const item of items) {
        if (item.permission) expect(declared).toContain(item.permission);
        if (item.children) walk(item.children);
      }
    };

    walk(procurementModule.nav);
  });

  it('does not redeclare the payment and tax rules the country packs already own', () => {
    // Payment terms and the standard tax rate are kernel rules populated per
    // country. A second copy here would drift, and the two would disagree on a
    // purchase order without anybody noticing which one was used.
    const keys = procurementModule.rules.map((r) => r.key);
    expect(keys).not.toContain('contract.payment_terms.default_days');
    expect(keys).not.toContain('tax.standard_rate_percent');
  });

  it('marks releasing a held invoice as dangerous', () => {
    // The single most abusable permission in the module: it defeats the control
    // that stops the company paying for goods it never received.
    const dangerous = procurementModule.permissions.filter((p) => p.isDangerous).map((p) => p.key);
    expect(dangerous).toContain('procurement.invoice.release');
    expect(dangerous).toContain('procurement.order.issue');
    expect(dangerous).toContain('procurement.requisition.approve');
    expect(dangerous).toContain('procurement.rfq.award');
  });

  it('emits a release as its own event, not as a match', () => {
    // An override that looked identical to a clean match in the event stream
    // would make the whole control decorative.
    const emitted = procurementModule.events.emits.map((e) => e.type);
    expect(emitted).toContain('procurement.invoice.matched');
    expect(emitted).toContain('procurement.invoice.held');
    expect(emitted).toContain('procurement.invoice.released');
  });

  it('emits what the other modules compose on', () => {
    const emitted = procurementModule.events.emits.map((e) => e.type);
    // Projects registers the commitment from this one.
    expect(emitted).toContain('procurement.order.issued');
    // Inventory takes stock and Projects accrues from this one.
    expect(emitted).toContain('procurement.goods.received');
  });

  it('exposes every matching tolerance as a country-variable rule', () => {
    // The three-part tolerance is a commercial judgement, not a constant. A
    // 5 AED floor is trivial in Dubai and not in a market with a weaker
    // currency, which is the whole reason it resolves through the country pack.
    const keys = new Set(procurementModule.rules.map((r) => r.key));
    expect(keys).toContain('procurement.match.price_tolerance_percent');
    expect(keys).toContain('procurement.match.minor_amount');
    expect(keys).toContain('procurement.match.max_amount');
    expect(keys).toContain('procurement.receipt.over_delivery_percent');
  });
});

describe('schema and domain agreement', () => {
  it('keeps the exception enum in step with the domain type', () => {
    // The database enum and `ExceptionCode` are two spellings of one list. A new
    // exception code added to the domain without a migration fails on INSERT, at
    // the moment an invoice is being matched — the worst time to discover it.
    // This assertion turns that into a compile-and-test failure instead.
    const inDatabase = [...exceptionCode.enumValues].sort();
    const inDomain: ExceptionCode[] = [
      'over_invoiced_quantity',
      'no_receipt',
      'price_variance',
      'unmatched_line',
      'over_receipt',
    ];

    expect(inDatabase).toEqual([...inDomain].sort());
  });
});

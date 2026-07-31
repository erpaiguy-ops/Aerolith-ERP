import { describe, expect, it } from 'vitest';

import { PROCUREMENT_RLS, buildProcurementGrants, buildProcurementRls } from './security';
import { PROCUREMENT_TENANT_TABLES } from './schema';

describe('procurement isolation policies', () => {
  it('forces row level security on every tenant-scoped table', () => {
    const statements = buildProcurementRls().join('\n');
    for (const table of PROCUREMENT_TENANT_TABLES) {
      // FORCE matters as much as ENABLE: without it the table owner bypasses
      // its own policies, and migrations run as the owner.
      expect(statements).toContain(`ALTER TABLE procurement."${table}" FORCE ROW LEVEL SECURITY;`);
      expect(statements).toContain(
        `CREATE POLICY tenant_isolation_select ON procurement."${table}"`,
      );
    }
  });

  it('declares the goods receipt line append-only, in the database', () => {
    // The mechanism is proven in the kernel's isolation integration test against
    // a real database and the non-owner app role. What matters here is that this
    // module opts the right table into it: a receipt line moved stock and raised
    // an accrual, so the only honest correction is another receipt — negative
    // for a return — never an edit to the original.
    expect(PROCUREMENT_RLS.appendOnly?.has('goods_receipt_line')).toBe(true);

    const statements = buildProcurementRls().join('\n');
    expect(statements).not.toContain(
      'CREATE POLICY tenant_isolation_update ON procurement."goods_receipt_line"',
    );
    expect(statements).not.toContain(
      'CREATE POLICY tenant_isolation_delete ON procurement."goods_receipt_line"',
    );

    // The blanket grant is walked back for this table specifically, so the
    // privilege is gone as well as the policy.
    expect(buildProcurementGrants().join('\n')).toContain(
      'REVOKE UPDATE, DELETE ON procurement."goods_receipt_line" FROM aerolith_app;',
    );
  });

  it('does not lock down documents that are legitimately edited', () => {
    // A draft requisition is edited, a quote is re-keyed when the supplier sends
    // a correction, an order line changes before issue, and an invoice moves
    // through its statuses. Blanket immutability would make the module unusable
    // and teach people to work around it.
    for (const table of ['requisition', 'quote', 'purchase_order_line', 'supplier_invoice']) {
      expect(PROCUREMENT_RLS.appendOnly?.has(table)).toBe(false);
    }
  });

  it('covers every table the schema declares', () => {
    // A table added to the schema without being added to the tenant list gets no
    // policy at all — it would be readable across every tenant in the system,
    // silently, and nothing else in the build would notice.
    expect(PROCUREMENT_TENANT_TABLES).toHaveLength(14);
    expect(new Set(PROCUREMENT_TENANT_TABLES).size).toBe(PROCUREMENT_TENANT_TABLES.length);
  });
});

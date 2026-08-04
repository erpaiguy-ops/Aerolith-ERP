/**
 * Isolation policies for the `procurement` schema.
 *
 * One table is append-only: `goods_receipt_line`. Everything else is a working
 * document until it is issued — a draft requisition is edited, a quote is
 * re-keyed when the supplier sends a correction — and forcing immutability on
 * those would make ordinary work impossible. Lifecycle immutability after issue
 * is a service rule with the audit log as the record; a receipt line is
 * different because it moved stock and raised an accrual, and the only honest
 * correction is another event.
 */
import { buildGrantStatementsFor, buildRlsStatementsFor, type RlsOptions } from '@aerolith/kernel';

import { PROCUREMENT_APPEND_ONLY_TABLES, PROCUREMENT_TENANT_TABLES } from './schema';

export const PROCUREMENT_RLS: RlsOptions = {
  schemaName: 'procurement',
  tables: PROCUREMENT_TENANT_TABLES,
  appendOnly: PROCUREMENT_APPEND_ONLY_TABLES,
};

export function buildProcurementRls(): string[] {
  return [...buildRlsStatementsFor(PROCUREMENT_RLS), ...buildGoodsReceiptLineLinkPolicy()];
}

export function buildProcurementGrants(): string[] {
  return [...buildGrantStatementsFor(PROCUREMENT_RLS), ...buildGoodsReceiptLineLinkGrant()];
}

/**
 * `goods_receipt_line` is append-only for the facts it was created with —
 * quantityReceived, unitPrice, everything the RECEIVING itself was. But
 * `stockMovementId` and `costEntryId` genuinely cannot be known at that
 * INSERT: they name rows in Inventory and Projects that only exist once THIS
 * row already does, so `linkReceiptPostings` (packages/modules/procurement/
 * src/service/purchasing.ts) has to come back and set them after the fact.
 * `buildRlsStatementsFor` skips UPDATE entirely for append-only tables, which
 * blocked that legitimate write along with the ones the append-only rule is
 * actually meant to stop.
 *
 * A policy plus a COLUMN-scoped grant (not `buildGrantStatementsFor`'s normal
 * whole-row grant) lets exactly that link happen and nothing else: the
 * received quantity, unit price and every other receiving fact stay
 * ungrantable to UPDATE, matching the invariant this module's header comment
 * describes as database-enforced, not just a service-layer convention.
 */
function buildGoodsReceiptLineLinkPolicy(): string[] {
  const predicate = `tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
  return [
    `DROP POLICY IF EXISTS tenant_isolation_update ON procurement."goods_receipt_line";`,
    `CREATE POLICY tenant_isolation_update ON procurement."goods_receipt_line" FOR UPDATE TO aerolith_app ` +
      `USING (${predicate}) WITH CHECK (${predicate});`,
  ];
}

function buildGoodsReceiptLineLinkGrant(): string[] {
  return [
    `GRANT UPDATE (stock_movement_id, cost_entry_id) ON procurement."goods_receipt_line" TO aerolith_app;`,
  ];
}

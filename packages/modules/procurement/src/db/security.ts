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
  return buildRlsStatementsFor(PROCUREMENT_RLS);
}

export function buildProcurementGrants(): string[] {
  return buildGrantStatementsFor(PROCUREMENT_RLS);
}

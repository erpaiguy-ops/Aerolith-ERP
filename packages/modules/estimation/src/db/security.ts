/**
 * Isolation policies for the `estimation` schema.
 *
 * Tender pricing is the most commercially sensitive data in the system — a
 * competitor seeing a margin would be catastrophic — so it gets exactly the same
 * enforced policy shape as everything else, from the kernel's one implementation.
 */
import { buildGrantStatementsFor, buildRlsStatementsFor, type RlsOptions } from '@aerolith/kernel';

import { ESTIMATION_TENANT_TABLES } from './schema';

export const ESTIMATION_RLS: RlsOptions = {
  schemaName: 'estimation',
  tables: ESTIMATION_TENANT_TABLES,
  appendOnly: new Set<string>(),
};

export function buildEstimationRls(): string[] {
  return buildRlsStatementsFor(ESTIMATION_RLS);
}

export function buildEstimationGrants(): string[] {
  return buildGrantStatementsFor(ESTIMATION_RLS);
}

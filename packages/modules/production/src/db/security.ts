/**
 * Isolation policies for the `production` schema.
 *
 * Uses the kernel's generic builder, so this module gets exactly the policy
 * shape the kernel does — there is one implementation of tenant isolation in the
 * system and no module can accidentally end up weaker than it.
 */
import { buildGrantStatementsFor, buildRlsStatementsFor, type RlsOptions } from '@aerolith/kernel';

import { PRODUCTION_APPEND_ONLY_TABLES, PRODUCTION_TENANT_TABLES } from './schema';

export const PRODUCTION_RLS: RlsOptions = {
  schemaName: 'production',
  tables: PRODUCTION_TENANT_TABLES,
  // Scans are the source of truth for WIP, labour cost and productivity.
  // Enforced append-only in the database, not merely by convention.
  appendOnly: PRODUCTION_APPEND_ONLY_TABLES,
};

export function buildProductionRls(): string[] {
  return buildRlsStatementsFor(PRODUCTION_RLS);
}

export function buildProductionGrants(): string[] {
  return buildGrantStatementsFor(PRODUCTION_RLS);
}

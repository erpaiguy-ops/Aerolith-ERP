/**
 * Isolation policies for the `inventory` schema.
 *
 * Uses the kernel's generic builder rather than hand-written SQL, so this module
 * cannot accidentally end up with weaker isolation than the kernel — there is
 * one policy shape in the system, and every schema gets it.
 */
import { buildGrantStatementsFor,
  buildPlatformGrantStatementsFor, buildRlsStatementsFor, type RlsOptions } from '@aerolith/kernel';

import { INVENTORY_TENANT_TABLES } from './schema';

export const INVENTORY_RLS: RlsOptions = {
  schemaName: 'inventory',
  tables: INVENTORY_TENANT_TABLES,
  // Nothing here is append-only. Movements are reversed rather than edited, but
  // that is a domain rule enforced in the service layer, not a table grant —
  // a draft movement is legitimately editable before it is posted.
  appendOnly: new Set<string>(),
};

export function buildInventoryRls(): string[] {
  return buildRlsStatementsFor(INVENTORY_RLS);
}

export function buildInventoryGrants(): string[] {
  return buildGrantStatementsFor(INVENTORY_RLS);
}

/** SELECT-only grants for the platform read role. See kernel rls.ts. */
export function buildInventoryPlatformGrants(): string[] {
  return buildPlatformGrantStatementsFor(INVENTORY_RLS);
}

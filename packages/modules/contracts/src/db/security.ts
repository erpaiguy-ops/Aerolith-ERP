/**
 * Isolation policies for the `contracts` schema.
 *
 * Nothing here is append-only at the database level: an application is a working
 * document until it is submitted, and forcing immutability on a draft would make
 * ordinary editing impossible. Immutability after submission is a lifecycle rule
 * enforced in the service, with the audit log as the record.
 */
import { buildGrantStatementsFor,
  buildPlatformGrantStatementsFor, buildRlsStatementsFor, type RlsOptions } from '@aerolith/kernel';

import { CONTRACTS_TENANT_TABLES } from './schema';

export const CONTRACTS_RLS: RlsOptions = {
  schemaName: 'contracts',
  tables: CONTRACTS_TENANT_TABLES,
  appendOnly: new Set<string>(),
};

export function buildContractsRls(): string[] {
  return buildRlsStatementsFor(CONTRACTS_RLS);
}

export function buildContractsGrants(): string[] {
  return buildGrantStatementsFor(CONTRACTS_RLS);
}

/** SELECT-only grants for the platform read role. See kernel rls.ts. */
export function buildContractsPlatformGrants(): string[] {
  return buildPlatformGrantStatementsFor(CONTRACTS_RLS);
}

/**
 * Isolation policies for the `projects` schema.
 *
 * The cost ledger is registered append-only, so the database itself refuses an
 * UPDATE or DELETE on `cost_entry` — not the service layer, which can be
 * bypassed by anything holding a connection. A job cost report that can be
 * quietly edited is worth nothing in the dispute it exists for.
 */
import { buildGrantStatementsFor, buildRlsStatementsFor, type RlsOptions } from '@aerolith/kernel';

import { PROJECTS_APPEND_ONLY_TABLES, PROJECTS_TENANT_TABLES } from './schema';

export const PROJECTS_RLS: RlsOptions = {
  schemaName: 'projects',
  tables: PROJECTS_TENANT_TABLES,
  appendOnly: PROJECTS_APPEND_ONLY_TABLES,
};

export function buildProjectsRls(): string[] {
  return buildRlsStatementsFor(PROJECTS_RLS);
}

export function buildProjectsGrants(): string[] {
  return buildGrantStatementsFor(PROJECTS_RLS);
}

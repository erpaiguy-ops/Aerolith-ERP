import { describe, expect, it } from 'vitest';

import { PROJECTS_RLS, buildProjectsGrants, buildProjectsRls } from './security';
import { PROJECTS_TENANT_TABLES } from './schema';

describe('projects isolation policies', () => {
  it('forces row level security on every tenant-scoped table', () => {
    const statements = buildProjectsRls().join('\n');
    for (const table of PROJECTS_TENANT_TABLES) {
      // FORCE matters as much as ENABLE: without it the table owner bypasses
      // its own policies, and migrations run as the owner.
      expect(statements).toContain(`ALTER TABLE projects."${table}" FORCE ROW LEVEL SECURITY;`);
      expect(statements).toContain(`CREATE POLICY tenant_isolation_select ON projects."${table}"`);
    }
  });

  it('declares the cost ledger append-only, in the database', () => {
    // The mechanism itself is proven in the kernel's isolation integration test
    // against a real database and the non-owner app role. What matters here is
    // that this module opts `cost_entry` into it — a job cost report that can be
    // quietly edited is worthless in the dispute it exists for.
    expect(PROJECTS_RLS.appendOnly?.has('cost_entry')).toBe(true);

    const statements = buildProjectsRls().join('\n');
    expect(statements).not.toContain(
      'CREATE POLICY tenant_isolation_update ON projects."cost_entry"',
    );
    expect(statements).not.toContain(
      'CREATE POLICY tenant_isolation_delete ON projects."cost_entry"',
    );

    // The blanket grant is walked back for this table specifically, so the
    // privilege is gone as well as the policy.
    expect(buildProjectsGrants().join('\n')).toContain(
      'REVOKE UPDATE, DELETE ON projects."cost_entry" FROM aerolith_app;',
    );
  });

  it('does not lock down tables that are legitimately edited', () => {
    // A budget in draft, a snag being worked, a WBS being restructured: all
    // ordinary edits. Blanket immutability would make the module unusable.
    for (const table of ['budget', 'snag', 'wbs_node', 'progress_entry']) {
      expect(PROJECTS_RLS.appendOnly?.has(table)).toBe(false);
    }
  });
});

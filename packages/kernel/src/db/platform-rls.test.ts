import { describe, expect, it } from 'vitest';

import {
  APP_ROLE,
  PLATFORM_ROLE,
  TENANT_SCOPED_TABLES,
  buildGrantStatements,
  buildPlatformGrantStatements,
  buildRlsStatements,
} from './rls';

/**
 * The platform read role is the one credential in this system that can see
 * every customer at once. These are the properties that make that defensible,
 * asserted rather than assumed — each one is a single edit away from being
 * silently untrue, and none of them fails loudly when it stops holding.
 */
describe('platform read role', () => {
  const rls = buildRlsStatements().join('\n');
  const grants = buildPlatformGrantStatements().join('\n');

  it('gets a read policy on every tenant-scoped table', () => {
    // Generated in the same loop as tenant isolation, so a table cannot be
    // remembered by one and forgotten by the other. A table missing here is a
    // reporting hole that shows up as under-counting, not as an error.
    for (const table of TENANT_SCOPED_TABLES) {
      expect(rls).toContain(
        `CREATE POLICY platform_read ON kernel."${table}" FOR SELECT TO ${PLATFORM_ROLE} USING (true);`,
      );
    }
  });

  it('never grants the platform role a write policy', () => {
    // `USING (true)` is only safe because it can never pair with a WITH CHECK.
    // Any INSERT/UPDATE/DELETE policy naming this role would be a way to write
    // across every tenant at once.
    for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'ALL']) {
      expect(rls).not.toContain(`FOR ${verb} TO ${PLATFORM_ROLE}`);
    }
  });

  it('grants the platform role SELECT and nothing else', () => {
    expect(grants).toContain(`GRANT SELECT ON ALL TABLES IN SCHEMA kernel TO ${PLATFORM_ROLE};`);
    expect(grants).toContain(
      `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA kernel FROM ${PLATFORM_ROLE};`,
    );

    // The privilege grant is the only thing between `USING (true)` and every
    // tenant's data, so it must not quietly widen. Checked against the
    // PRIVILEGE CLAUSE — the part between GRANT and ON — rather than the whole
    // statement: a naive scan for "ALL" matches "ON ALL TABLES" and passes a
    // test that never had a chance of failing.
    const privilegeClauses = buildPlatformGrantStatements()
      .map((statement) => /\bGRANT\s+(.+?)\s+ON\b/i.exec(statement)?.[1])
      .filter((clause): clause is string => clause !== undefined);

    expect(privilegeClauses.length).toBeGreaterThan(0);
    for (const clause of privilegeClauses) {
      expect(clause).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALL)\b/i);
    }
  });

  it('covers tables added by a later migration', () => {
    // Without default privileges a new table is readable by the app role and
    // invisible to this one, and the estate report under-reports rather than
    // failing — the quietest kind of wrong.
    expect(grants).toContain(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA kernel GRANT SELECT ON TABLES TO ${PLATFORM_ROLE};`,
    );
  });

  it('does not touch what the application role may do', () => {
    // The platform role is additive. If adding it had narrowed the app role,
    // every tenant would lose access to their own data.
    const appGrants = buildGrantStatements().join('\n');
    expect(appGrants).toContain(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA kernel TO ${APP_ROLE};`,
    );
    expect(rls).toContain(`CREATE POLICY tenant_isolation_select ON kernel."membership"`);
  });
});

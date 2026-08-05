import { describe, expect, it } from 'vitest';

import { APP_ROLE, PLATFORM_ROLE } from '../db/rls';
import { buildPlatformSchemaGrants } from './security';

/**
 * The realm split, asserted.
 *
 * Every property here is one an ordinary-looking edit could undo without any
 * test failing — widening a grant to a whole table, adding a table to the
 * writable list, granting the app role "just read access for a dashboard".
 * None of those would break a feature. All of them would break the reason this
 * schema exists.
 */
describe('platform schema privileges', () => {
  const grants = buildPlatformSchemaGrants();
  const sql = grants.join('\n');

  it('gives the tenant application no access at all', () => {
    // Not "limited access" — none. A bug in the tenant application must not be
    // able to name these tables, let alone read a password hash or mint a
    // session.
    expect(sql).toContain(`REVOKE ALL ON SCHEMA platform FROM ${APP_ROLE};`);
    expect(sql).toContain(`REVOKE ALL ON ALL TABLES IN SCHEMA platform FROM ${APP_ROLE};`);
    expect(sql).not.toMatch(new RegExp(`GRANT[^;]*TO ${APP_ROLE}`));
  });

  it('lets the platform role write only its own session and trail tables', () => {
    expect(sql).toContain(
      `GRANT INSERT, UPDATE, DELETE ON platform."operator_session" TO ${PLATFORM_ROLE};`,
    );
    expect(sql).toContain(
      `GRANT INSERT, UPDATE, DELETE ON platform."operator_action" TO ${PLATFORM_ROLE};`,
    );

    // And never the operator table wholesale. This is the line between "can
    // sign in" and "can mint another operator".
    expect(sql).not.toContain(`GRANT INSERT, UPDATE, DELETE ON platform."operator" TO`);
    expect(sql).not.toMatch(/GRANT[^;(]*\bINSERT\b[^;(]*ON platform\."operator"/);
    expect(sql).not.toMatch(/GRANT[^;(]*\bDELETE\b[^;(]*ON platform\."operator"/);
  });

  it('limits the operator-row update to sign-in bookkeeping', () => {
    // Column-scoped, and the columns matter: everything that decides WHO an
    // operator is, or what proves it, has to be absent — otherwise a
    // compromised session can rotate its own credential or re-enrol a second
    // factor onto a device it controls.
    const update = grants.find((statement) =>
      /GRANT UPDATE \(/.test(statement) && statement.includes('"operator"'),
    );
    expect(update).toBeDefined();

    const columns = /GRANT UPDATE \(([^)]+)\)/.exec(update!)![1]!;
    expect(columns).toContain('last_login_at');
    expect(columns).toContain('failed_login_count');
    expect(columns).toContain('locked_until');

    for (const forbidden of [
      'password_hash',
      'totp_secret',
      'totp_confirmed_at',
      'email',
      'is_active',
    ]) {
      expect(columns).not.toContain(forbidden);
    }
  });

  it('keeps the operator trail append-only', () => {
    // Same mechanism kernel.audit_log uses, so "the trail cannot be edited" is
    // a database fact rather than a convention. Ordering matters: the REVOKE
    // has to come after the GRANT that included this table.
    const grantIndex = grants.findIndex((s) =>
      s.startsWith('GRANT INSERT, UPDATE, DELETE ON platform."operator_action"'),
    );
    const revokeIndex = grants.findIndex((s) =>
      s.startsWith('REVOKE UPDATE, DELETE ON platform."operator_action"'),
    );

    expect(grantIndex).toBeGreaterThanOrEqual(0);
    expect(revokeIndex).toBeGreaterThan(grantIndex);
  });
});

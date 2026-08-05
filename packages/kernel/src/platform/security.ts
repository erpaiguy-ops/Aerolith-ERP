/**
 * Privileges on the `platform` schema.
 *
 * Two roles matter here and neither gets what it might seem to need.
 *
 * `aerolith_app` — the tenant application — gets NOTHING. Not `USAGE` on the
 * schema, not a grant on a single table. That is the realm split made
 * mechanical: no bug in the tenant application can read an operator's password
 * hash, mint an operator session, or forge an entry in the operator trail,
 * because its credential has no way to name these tables at all.
 *
 * `aerolith_platform` — SELECT-only across every tenant schema, per Stage 1 —
 * needs a narrow exception here, because a read-only surface still has to
 * record that somebody signed in and what they looked at. So it may write
 * exactly two tables in its own schema, and the operator table it authenticates
 * against stays read-only to it: a compromised operator session cannot create a
 * second operator, change a password, or enrol a new second factor. Those are
 * deliberately left to a credential nobody carries around — see
 * `scripts/operator.ts`, which runs as the owner.
 */
import {
  PLATFORM_APPEND_ONLY_TABLES,
  PLATFORM_WRITABLE_TABLES,
} from '../db/schema/platform';
import { APP_ROLE, PLATFORM_ROLE } from '../db/rls';

const SCHEMA = 'platform';

export function buildPlatformSchemaGrants(): string[] {
  const statements = [
    `GRANT USAGE ON SCHEMA ${SCHEMA} TO ${PLATFORM_ROLE};`,
    // Read everything in its own schema: it has to look up the operator to
    // check a password, and read the trail to show it.
    `GRANT SELECT ON ALL TABLES IN SCHEMA ${SCHEMA} TO ${PLATFORM_ROLE};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${SCHEMA} GRANT SELECT ON TABLES TO ${PLATFORM_ROLE};`,
    // Then the narrow exception, table by table rather than schema-wide, so
    // adding a table to this schema does not silently make it writable.
    ...PLATFORM_WRITABLE_TABLES.map(
      (table) =>
        `GRANT INSERT, UPDATE, DELETE ON ${SCHEMA}."${table}" TO ${PLATFORM_ROLE};`,
    ),
    /*
     * Sign-in bookkeeping on the operator row, and nothing else on it.
     *
     * A COLUMN-scoped grant rather than a table one, because the login path has
     * to record a failed attempt, apply a lockout and stamp `last_login_at` —
     * and lockout is a control worth keeping, not an optional nicety. What it
     * must NOT be able to touch is everything that decides who this operator is
     * or what proves it: `password_hash`, `totp_secret`, `totp_confirmed_at`,
     * `email` and `is_active` are all absent from this list, so a compromised
     * operator session cannot rotate its own credential, re-enrol a second
     * factor onto a device it controls, or reactivate an account somebody
     * disabled. Those need the owner credential and `scripts/operator.ts`.
     *
     * Found by running the login flow as the platform role and watching it fail
     * with `permission denied for table operator` — the design was right and
     * the grants had not caught up with it.
     */
    `GRANT UPDATE (last_login_at, failed_login_count, locked_until, updated_at) ` +
      `ON ${SCHEMA}."operator" TO ${PLATFORM_ROLE};`,
    // Sequences are not used (uuid defaults), but the grant is cheap and its
    // absence would be a confusing failure if a serial column ever appears.
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${SCHEMA} TO ${PLATFORM_ROLE};`,
    // Append-only, enforced the same way kernel.audit_log is: the privilege is
    // removed, so "the trail cannot be edited" is a database fact. Applied after
    // the grants above, which deliberately included this table.
    ...PLATFORM_APPEND_ONLY_TABLES.map(
      (table) =>
        `REVOKE UPDATE, DELETE ON ${SCHEMA}."${table}" FROM ${PLATFORM_ROLE};`,
    ),
  ];

  // Said out loud rather than left implicit. `REVOKE` on a privilege that was
  // never granted is a no-op, so this costs nothing and documents the intent
  // where somebody widening the app role's grants would see it.
  statements.push(
    `REVOKE ALL ON ALL TABLES IN SCHEMA ${SCHEMA} FROM ${APP_ROLE};`,
    `REVOKE ALL ON SCHEMA ${SCHEMA} FROM ${APP_ROLE};`,
  );

  return statements;
}

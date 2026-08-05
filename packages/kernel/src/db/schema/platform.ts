/**
 * The vendor's own identity realm.
 *
 * A platform operator is not a tenant user with an extra permission. It is a
 * different principal in a different realm, and this file is where that
 * separation stops being an intention and becomes a schema.
 *
 * **Why its own Postgres schema, and not `kernel`.** Grants are per-schema:
 * `buildGrantStatementsFor` hands `aerolith_app` SELECT/INSERT/UPDATE/DELETE on
 * ALL TABLES IN SCHEMA kernel. Putting `operator` there would mean the tenant
 * application could create an operator account — the exact escalation the realm
 * split exists to prevent, handed over by a blanket grant nobody would think to
 * re-read. In `platform`, the application role has no privileges at all, and
 * gaining them would take a visible, deliberate GRANT.
 *
 * No RLS here, and none needed: nothing in this schema is tenant-scoped. The
 * isolation that matters is which ROLE can reach it, not which tenant.
 *
 * See docs/07-platform-operations.md.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  inet,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const platform = pgSchema('platform');

/**
 * Somebody who works for the vendor.
 *
 * Deliberately not a row in `kernel.app_user` with a flag. A shared table would
 * mean one password-reset bug, one session-fixation bug or one mistaken join
 * reaches across both realms, and the tenant login path would be operating on
 * rows it should never be able to see.
 */
export const operator = platform.table(
  'operator',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),

    /**
     * Base32, as the authenticator apps expect. Required, not optional: this is
     * the surface where a stolen credential is worst, so a second factor is
     * enrolled at creation rather than retrofitted once the account is busy and
     * turning it on has become disruptive.
     */
    totpSecret: text('totp_secret').notNull(),
    /**
     * Null until the operator has proved they can generate a code. An account
     * that has never confirmed cannot sign in — otherwise a mistyped secret
     * during enrolment produces an account with a second factor nobody holds,
     * discovered at the worst moment.
     */
    totpConfirmedAt: timestamp('totp_confirmed_at', { withTimezone: true }),

    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('operator_email_idx').on(t.email)],
);

/**
 * An operator's signed-in session.
 *
 * Absolute expiry only — `expiresAt` is set once at sign-in and never extended.
 * A sliding session on this surface means a browser left open on an unlocked
 * laptop stays authenticated to every customer's data indefinitely, which is
 * not a trade worth the convenience of not signing in again.
 */
export const operatorSession = platform.table(
  'operator_session',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('operator_session_operator_idx').on(t.operatorId),
    index('operator_session_expiry_idx').on(t.expiresAt),
  ],
);

/**
 * What the vendor did, and what the vendor LOOKED AT.
 *
 * `kernel.audit_log` is tenant-scoped and append-only, which is right for
 * tenant activity and useless here: an operator action spans tenants, or
 * targets one without acting inside it.
 *
 * Reads are recorded, not just writes. In an ordinary application auditing
 * reads is overkill; in one where an employee can open any customer's
 * commercial position, "who looked at what" is the entire point — and it is
 * what makes an honest answer possible when a customer asks whether anyone at
 * the vendor has been in their data.
 *
 * Append-only is enforced by REVOKE in the grants, the same mechanism
 * `kernel.audit_log` uses, so it is a fact rather than a convention.
 */
export const operatorAction = platform.table(
  'operator_action',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Not a foreign key, deliberately. The trail has to outlive the account:
     * deleting an operator must never delete the record of what they did.
     */
    operatorId: uuid('operator_id').notNull(),
    operatorEmail: text('operator_email').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),

    /** `estate.read`, `tenant.read`, `tenant.provision`, `auth.login`, … */
    action: varchar('action', { length: 64 }).notNull(),
    /** The tenant this concerned, when it concerned exactly one. */
    tenantId: uuid('tenant_id'),
    tenantSlug: text('tenant_slug'),
    /** How many tenants a read touched — the number that makes a bulk read visible. */
    tenantCount: integer('tenant_count'),

    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
  },
  (t) => [
    index('operator_action_operator_idx').on(t.operatorId, t.occurredAt),
    index('operator_action_tenant_idx').on(t.tenantId, t.occurredAt),
    index('operator_action_time_idx').on(t.occurredAt),
  ],
);

/** Tables the platform role may write, and the only ones it may. */
export const PLATFORM_WRITABLE_TABLES = ['operator_session', 'operator_action'] as const;

/** Append-only within the platform schema. */
export const PLATFORM_APPEND_ONLY_TABLES = ['operator_action'] as const;

/**
 * Identity: users, sessions, tenant membership.
 *
 * A user is global (one login, one email) and belongs to one or more tenants
 * through `membership`. That matters for consultants and group companies, and
 * it is painful to retrofit.
 */
import {
  boolean,
  index,
  inet,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { kernel, softDelete, tenantColumn, timestamps } from '../columns';

export const membershipStatus = kernel.enum('membership_status', [
  'invited',
  'active',
  'suspended',
  'removed',
]);

export const appUser = kernel.table(
  'app_user',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 320 }).notNull().unique(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    /** Argon2id. Null for SSO-only users. */
    passwordHash: text('password_hash'),
    name: text('name').notNull(),
    avatarUrl: text('avatar_url'),
    phone: varchar('phone', { length: 32 }),
    locale: varchar('locale', { length: 10 }).notNull().default('en'),
    timezone: text('timezone'),

    totpSecret: text('totp_secret'),
    totpEnabledAt: timestamp('totp_enabled_at', { withTimezone: true }),
    /** Hashed single-use recovery codes. */
    recoveryCodes: text('recovery_codes').array(),

    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    isSystem: boolean('is_system').notNull().default(false),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [index('app_user_email_idx').on(t.email)],
);

export const membership = kernel.table(
  'membership',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    status: membershipStatus('status').notNull().default('invited'),
    /** Set once the HR module exists — links a login to an employee record. */
    employeeId: uuid('employee_id'),
    /** Restricts the user to one operating entity. Null = all entities. */
    legalEntityId: uuid('legal_entity_id'),
    isOwner: boolean('is_owner').notNull().default(false),
    invitedBy: uuid('invited_by'),
    invitedAt: timestamp('invited_at', { withTimezone: true }),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('membership_uq').on(t.tenantId, t.userId),
    index('membership_user_idx').on(t.userId),
  ],
);

export const session = kernel.table(
  'session',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    /** The tenant this session is currently acting in. */
    tenantId: uuid('tenant_id'),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    mfaSatisfiedAt: timestamp('mfa_satisfied_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [index('session_user_idx').on(t.userId), index('session_expiry_idx').on(t.expiresAt)],
);

/** Machine-to-machine access for integrations and the public API. */
export const apiKey = kernel.table(
  'api_key',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull().unique(),
    prefix: varchar('prefix', { length: 12 }).notNull(),
    scopes: text('scopes').array().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [index('api_key_tenant_idx').on(t.tenantId)],
);

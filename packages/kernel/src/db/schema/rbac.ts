/**
 * Authorisation.
 *
 * Permissions are declared by modules in their manifest and synced into
 * `permission` at boot. Roles are tenant-owned data, so a customer can invent
 * "Assistant Storekeeper" without a deployment.
 *
 * This is the "may this user do this" layer. It sits on top of Postgres RLS,
 * which independently answers "may this connection see this row" — see
 * src/db/rls.ts. Both are required; neither is sufficient.
 */
import {
  boolean,
  index,
  jsonb,
  text,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { kernel, tenantColumn, timestamps } from '../columns';

export const permissionEffect = kernel.enum('permission_effect', ['allow', 'deny']);

/** Global catalogue, populated from module manifests. Not tenant-scoped. */
export const permission = kernel.table(
  'permission',
  {
    key: varchar('key', { length: 128 }).primaryKey(), // inventory.stock_transfer.approve
    moduleKey: varchar('module_key', { length: 64 }).notNull(),
    resource: varchar('resource', { length: 64 }).notNull(),
    action: varchar('action', { length: 32 }).notNull(),
    label: text('label').notNull(),
    description: text('description'),
    /** Grouping for the permission matrix UI. */
    category: varchar('category', { length: 64 }),
    isDangerous: boolean('is_dangerous').notNull().default(false),
    ...timestamps(),
  },
  (t) => [index('permission_module_idx').on(t.moduleKey)],
);

export const role = kernel.table(
  'role',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    code: varchar('code', { length: 64 }).notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Seeded roles a tenant may extend but not delete. */
    isSystem: boolean('is_system').notNull().default(false),
    /** Approval steps can target a role rather than a named person. */
    isApprovalTarget: boolean('is_approval_target').notNull().default(false),
    ...timestamps(),
  },
  (t) => [unique('role_uq').on(t.tenantId, t.code)],
);

export const rolePermission = kernel.table(
  'role_permission',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => role.id, { onDelete: 'cascade' }),
    permissionKey: varchar('permission_key', { length: 128 }).notNull(),
    effect: permissionEffect('effect').notNull().default('allow'),
    /**
     * CASL conditions, e.g. { legalEntityId: '$user.legalEntityId' } or
     * { amount: { $lte: 50000 } }. Evaluated against the subject at check time.
     */
    conditions: jsonb('conditions').$type<Record<string, unknown>>(),
    /** Column-level restriction — hide salary from a general HR user. */
    fields: text('fields').array(),
    ...timestamps(),
  },
  (t) => [
    unique('role_permission_uq').on(t.roleId, t.permissionKey),
    index('role_permission_tenant_idx').on(t.tenantId),
  ],
);

export const userRole = kernel.table(
  'user_role',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    userId: uuid('user_id').notNull(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => role.id, { onDelete: 'cascade' }),
    /** Scope a role to one entity, project or warehouse. */
    scopeType: varchar('scope_type', { length: 32 }),
    scopeId: uuid('scope_id'),
    grantedBy: uuid('granted_by'),
    ...timestamps(),
  },
  (t) => [
    unique('user_role_uq').on(t.tenantId, t.userId, t.roleId, t.scopeType, t.scopeId),
    index('user_role_user_idx').on(t.tenantId, t.userId),
  ],
);

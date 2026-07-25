/**
 * Immutable audit trail.
 *
 * Append-only: there is no update or delete path, and the RLS policy grants
 * INSERT and SELECT only. Financial and HR data auditing is a compliance
 * requirement in every market this targets.
 */
import {
  index,
  inet,
  jsonb,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { kernel, tenantColumn } from '../columns';

export const auditAction = kernel.enum('audit_action', [
  'create',
  'update',
  'delete',
  'read',
  'approve',
  'reject',
  'submit',
  'cancel',
  'post',
  'reverse',
  'login',
  'logout',
  'export',
  'permission_change',
]);

export const auditLog = kernel.table(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),

    actorId: uuid('actor_id'),
    actorLabel: text('actor_label'),
    /** 'user' | 'api_key' | 'system' | 'job' */
    actorType: varchar('actor_type', { length: 16 }).notNull().default('user'),
    onBehalfOfId: uuid('on_behalf_of_id'),

    moduleKey: varchar('module_key', { length: 64 }),
    entityType: varchar('entity_type', { length: 96 }).notNull(),
    entityId: uuid('entity_id'),
    entityLabel: text('entity_label'),
    action: auditAction('action').notNull(),

    /** Changed fields only — { field: { from, to } }. Never the whole row. */
    changes: jsonb('changes').$type<Record<string, { from: unknown; to: unknown }>>(),
    /** Fields redacted before writing (salary, passport, bank). */
    redactedFields: text('redacted_fields').array(),

    requestId: uuid('request_id'),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    reason: text('reason'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index('audit_log_entity_idx').on(t.tenantId, t.entityType, t.entityId, t.occurredAt),
    index('audit_log_actor_idx').on(t.tenantId, t.actorId, t.occurredAt),
    index('audit_log_time_idx').on(t.tenantId, t.occurredAt),
  ],
);

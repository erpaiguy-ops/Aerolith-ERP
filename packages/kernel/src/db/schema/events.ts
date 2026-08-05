/**
 * Event bus persistence — the transactional outbox.
 *
 * A module writes its own tables AND an outbox row in the SAME transaction, so
 * an event can never be published for work that rolled back, and work can never
 * commit without its event. A dispatcher then delivers to subscribers.
 *
 * Today the dispatcher is an in-process loop. The day a module is extracted into
 * its own service, the dispatcher is swapped for NATS or logical replication and
 * no module code changes. That is the entire reason this table exists rather
 * than a direct function call.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { kernel, tenantColumn, timestamps } from '../columns';

export const outboxStatus = kernel.enum('outbox_status', [
  'pending',
  'processing',
  'delivered',
  'failed',
  'dead',
]);

export const eventOutbox = kernel.table(
  'event_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    /** 'procurement.goods_receipt.posted' */
    eventType: varchar('event_type', { length: 128 }).notNull(),
    eventVersion: integer('event_version').notNull().default(1),
    sourceModule: varchar('source_module', { length: 64 }).notNull(),

    aggregateType: varchar('aggregate_type', { length: 96 }).notNull(),
    aggregateId: uuid('aggregate_id').notNull(),

    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** Actor, request id, correlation id — carried across module boundaries. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    correlationId: uuid('correlation_id'),
    causationId: uuid('causation_id'),

    status: outboxStatus('status').notNull().default('pending'),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('event_outbox_dispatch_idx').on(t.status, t.availableAt),
    index('event_outbox_aggregate_idx').on(t.tenantId, t.aggregateType, t.aggregateId),
    index('event_outbox_type_idx').on(t.tenantId, t.eventType, t.occurredAt),
  ],
);

/**
 * Consumer checkpoint. Subscribers must be idempotent; this table is what makes
 * "exactly once" achievable in practice — delivery is at-least-once, and the
 * unique constraint makes the second delivery a no-op.
 */
export const eventConsumption = kernel.table(
  'event_consumption',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id').notNull(),
    consumerKey: varchar('consumer_key', { length: 128 }).notNull(),
    tenantId: tenantColumn(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }).notNull().defaultNow(),
    durationMs: integer('duration_ms'),
  },
  (t) => [unique('event_consumption_uq').on(t.eventId, t.consumerKey)],
);

/** Background jobs the kernel schedules — expiry alerts, SLA escalation, reports. */
export const scheduledJob = kernel.table(
  'scheduled_job',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id'),
    jobKey: varchar('job_key', { length: 128 }).notNull(),
    moduleKey: varchar('module_key', { length: 64 }),
    cron: varchar('cron', { length: 64 }),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastStatus: varchar('last_status', { length: 16 }),
    lastError: text('last_error'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [index('scheduled_job_next_idx').on(t.nextRunAt)],
);

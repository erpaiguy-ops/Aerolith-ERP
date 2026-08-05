/**
 * Notification centre.
 *
 * Templates are per-tenant and per-locale, so an Arabic-preferring approver gets
 * Arabic without any module knowing that languages exist.
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

export const notificationChannel = kernel.enum('notification_channel', [
  'in_app',
  'email',
  'telegram',
  'whatsapp',
  'sms',
  'webhook',
]);

export const deliveryStatus = kernel.enum('delivery_status', [
  'queued',
  'sent',
  'delivered',
  'failed',
  'suppressed',
]);

/** Catalogue of notifiable situations, registered by modules. */
export const notificationType = kernel.table(
  'notification_type',
  {
    key: varchar('key', { length: 128 }).primaryKey(),
    moduleKey: varchar('module_key', { length: 64 }).notNull(),
    label: text('label').notNull(),
    description: text('description'),
    /**
     * `text[]` rather than an enum array on purpose: Postgres enum arrays are
     * awkward to extend, and the channel list will grow (Teams, push, ...).
     * Values are validated against `notificationChannel` at the application
     * boundary.
     */
    defaultChannels: text('default_channels').array().notNull(),
    /** Users may not opt out of statutory or approval notifications. */
    isMandatory: boolean('is_mandatory').notNull().default(false),
    ...timestamps(),
  },
  (t) => [index('notification_type_module_idx').on(t.moduleKey)],
);

export const notificationTemplate = kernel.table(
  'notification_template',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    typeKey: varchar('type_key', { length: 128 }).notNull(),
    channel: notificationChannel('channel').notNull(),
    locale: varchar('locale', { length: 10 }).notNull().default('en'),
    subject: text('subject'),
    /** Handlebars-style; variables declared by the notification type. */
    body: text('body').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [unique('notification_template_uq').on(t.tenantId, t.typeKey, t.channel, t.locale)],
);

export const notification = kernel.table(
  'notification',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    recipientId: uuid('recipient_id').notNull(),
    typeKey: varchar('type_key', { length: 128 }).notNull(),
    title: text('title').notNull(),
    body: text('body'),
    /** Deep link into the entity that caused it. */
    entityType: varchar('entity_type', { length: 96 }),
    entityId: uuid('entity_id'),
    actionUrl: text('action_url'),
    priority: integer('priority').notNull().default(0),
    readAt: timestamp('read_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [
    index('notification_inbox_idx').on(t.tenantId, t.recipientId, t.readAt, t.createdAt),
  ],
);

export const notificationDelivery = kernel.table(
  'notification_delivery',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notification.id, { onDelete: 'cascade' }),
    channel: notificationChannel('channel').notNull(),
    destination: text('destination').notNull(),
    status: deliveryStatus('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    providerMessageId: text('provider_message_id'),
    error: text('error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [index('notification_delivery_status_idx').on(t.status, t.createdAt)],
);

export const notificationPreference = kernel.table(
  'notification_preference',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    userId: uuid('user_id').notNull(),
    typeKey: varchar('type_key', { length: 128 }).notNull(),
    /** See the note on `notificationType.defaultChannels`. */
    channels: text('channels').array().notNull(),
    /** Quiet hours in the user's timezone; approvals override. */
    quietHoursStart: varchar('quiet_hours_start', { length: 5 }),
    quietHoursEnd: varchar('quiet_hours_end', { length: 5 }),
    ...timestamps(),
  },
  (t) => [unique('notification_preference_uq').on(t.tenantId, t.userId, t.typeKey)],
);

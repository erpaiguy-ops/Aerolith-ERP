/**
 * Tenant-defined fields.
 *
 * Every ERP customer wants three fields nobody anticipated. Values live in a
 * JSONB `custom_fields` column on the owning table (see `party`, `item`,
 * `project`) rather than an EAV table, so they are queryable with a GIN index
 * and returned in the same row as everything else.
 *
 * This table is the schema for those values, and drives both the form renderer
 * and write-time validation.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  text,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { kernel, tenantColumn, timestamps } from '../columns';

export const customFieldType = kernel.enum('custom_field_type', [
  'text',
  'textarea',
  'number',
  'decimal',
  'boolean',
  'date',
  'datetime',
  'select',
  'multiselect',
  'user',
  'party',
  'item',
  'project',
  'document',
  'url',
]);

export const customFieldDefinition = kernel.table(
  'custom_field_definition',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    entityType: varchar('entity_type', { length: 96 }).notNull(),
    moduleKey: varchar('module_key', { length: 64 }),
    /** Becomes the JSONB key. Immutable once data exists. */
    key: varchar('key', { length: 64 }).notNull(),
    label: text('label').notNull(),
    labelNative: text('label_native'),
    helpText: text('help_text'),
    type: customFieldType('type').notNull(),

    isRequired: boolean('is_required').notNull().default(false),
    isSearchable: boolean('is_searchable').notNull().default(false),
    /** Show in list views and exports by default. */
    showInList: boolean('show_in_list').notNull().default(false),
    defaultValue: jsonb('default_value'),
    options: jsonb('options')
      .$type<{ value: string; label: string; colour?: string }[]>()
      .notNull()
      .default([]),
    /** min / max / regex / step, applied client and server side. */
    validation: jsonb('validation').$type<Record<string, unknown>>().notNull().default({}),
    /** Only render when another field has a given value. */
    visibleWhen: jsonb('visible_when').$type<Record<string, unknown>>(),

    /** Grouping and ordering in the form. */
    section: varchar('section', { length: 64 }),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('custom_field_definition_uq').on(t.tenantId, t.entityType, t.key),
    index('custom_field_definition_entity_idx').on(t.tenantId, t.entityType, t.isActive),
  ],
);

/**
 * Document numbering series.
 *
 * Every ERP document needs a human-readable, gapless-per-tenant identifier, and
 * every customer has an opinion about its shape. Series are data.
 *
 * Concurrency: `nextValue` is incremented with `SELECT ... FOR UPDATE` inside
 * the caller's transaction. That serialises allocation per series, which is
 * exactly what statutory gapless numbering (tax invoices) requires — do not be
 * tempted to replace it with a Postgres sequence, which loses numbers on
 * rollback.
 */
import {
  boolean,
  index,
  integer,
  smallint,
  text,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { kernel, tenantColumn, timestamps } from '../columns';

export const resetFrequency = kernel.enum('reset_frequency', [
  'never',
  'yearly',
  'monthly',
  'fiscal_year',
]);

export const numberSeries = kernel.table(
  'number_series',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    /** 'procurement.purchase_order', 'contracts.invoice'. */
    entityType: varchar('entity_type', { length: 96 }).notNull(),
    code: varchar('code', { length: 64 }).notNull(),
    name: text('name').notNull(),

    /**
     * Tokens: {PREFIX} {YY} {YYYY} {MM} {ENTITY} {PROJECT} {SEQ}
     * e.g. 'INV-{YYYY}-{SEQ}' -> INV-2026-000123
     */
    pattern: text('pattern').notNull(),
    prefix: varchar('prefix', { length: 16 }),
    suffix: varchar('suffix', { length: 16 }),
    padding: smallint('padding').notNull().default(5),
    startValue: integer('start_value').notNull().default(1),
    increment: integer('increment').notNull().default(1),
    nextValue: integer('next_value').notNull().default(1),
    resetFrequency: resetFrequency('reset_frequency').notNull().default('yearly'),
    lastResetPeriod: varchar('last_reset_period', { length: 16 }),

    /** Scope a series to one entity or project. */
    legalEntityId: uuid('legal_entity_id'),
    /**
     * Statutory documents must never have gaps; a cancelled tax invoice is
     * reversed, not deleted. Enforced by the allocation service.
     */
    isGapless: boolean('is_gapless').notNull().default(false),
    isDefault: boolean('is_default').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('number_series_uq').on(t.tenantId, t.code),
    index('number_series_entity_idx').on(t.tenantId, t.entityType, t.isActive),
  ],
);

/** Allocation log — proves a gapless series really is gapless during an audit. */
export const numberAllocation = kernel.table(
  'number_allocation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    seriesId: uuid('series_id')
      .notNull()
      .references(() => numberSeries.id, { onDelete: 'cascade' }),
    /**
     * The reset period the value belongs to ('2026', '2026-07', 'FY2026', 'ALL').
     * Part of the key: a yearly series reissues value 1 every January, so
     * (series, value) alone is not unique — and the gapless proof is per period
     * anyway, since that is the unit an auditor asks about.
     */
    period: varchar('period', { length: 16 }).notNull(),
    value: integer('value').notNull(),
    formatted: text('formatted').notNull(),
    entityId: uuid('entity_id'),
    /** True when the document was voided — the number stays consumed. */
    isVoided: boolean('is_voided').notNull().default(false),
    voidReason: text('void_reason'),
    allocatedBy: uuid('allocated_by'),
    ...timestamps(),
  },
  (t) => [
    unique('number_allocation_uq').on(t.seriesId, t.period, t.value),
    index('number_allocation_entity_idx').on(t.tenantId, t.entityId),
    index('number_allocation_period_idx').on(t.seriesId, t.period, t.value),
  ],
);

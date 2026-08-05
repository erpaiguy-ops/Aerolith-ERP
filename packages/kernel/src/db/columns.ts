import { pgSchema, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Every kernel table lives in the `kernel` Postgres schema. Business modules own
 * their own schema (`inventory`, `production`, ...) and may only reference kernel
 * tables — never each other's. See docs/02-architecture.md.
 */
export const kernel = pgSchema('kernel');

/**
 * Present on every tenant-scoped table. Row Level Security keys off this column,
 * and every index must lead with it.
 */
export const tenantColumn = () => uuid('tenant_id').notNull();

export const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Who did it. Nullable because seeds, migrations and system jobs act without a
 * user; the audit log records the actor in those cases.
 */
export const actorColumns = () => ({
  createdBy: uuid('created_by'),
  updatedBy: uuid('updated_by'),
});

/**
 * Soft delete. Used only where a record must remain referenceable after removal
 * (master data, documents). Transactional records are never soft-deleted — they
 * are reversed.
 */
export const softDelete = () => ({
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: uuid('deleted_by'),
});

/** Validity window for anything that changes over time (rates, rules, prices). */
export const effectivity = () => ({
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
  effectiveTo: timestamp('effective_to', { withTimezone: true }),
});

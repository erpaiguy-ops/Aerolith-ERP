/**
 * Tenancy and module entitlement.
 *
 * `tenantModule` is the mechanism behind requirement 19: the same binary serves
 * a customer who bought only Inventory and a customer who bought the whole ERP.
 * Which modules boot — routes, navigation, permissions, jobs, event subscribers
 * — is decided by rows in this table, not by build configuration.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { kernel, softDelete, tenantColumn, timestamps } from '../columns';

export const tenantStatus = kernel.enum('tenant_status', [
  'trial',
  'active',
  'past_due',
  'suspended',
  'cancelled',
]);

export const moduleStatus = kernel.enum('module_status', [
  'enabled',
  'trial',
  'disabled',
  'expired',
]);

export const tenant = kernel.table(
  'tenant',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Subdomain: {slug}.aerolith.app */
    slug: varchar('slug', { length: 63 }).notNull().unique(),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    status: tenantStatus('status').notNull().default('trial'),

    /** Denormalised from tenantLocalisation for fast request-time resolution. */
    primaryCountryCode: varchar('primary_country_code', { length: 2 }),
    baseCurrencyCode: varchar('base_currency_code', { length: 3 }),
    timezone: text('timezone').notNull().default('UTC'),
    defaultLocale: varchar('default_locale', { length: 10 }).notNull().default('en'),

    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [index('tenant_status_idx').on(t.status)],
);

/**
 * One operating entity within a tenant — a UAE LLC and a Qatar WLL under one
 * group. Each points at a country, which is how a single tenant runs two
 * different statutory regimes without any code knowing about either.
 */
export const legalEntity = kernel.table(
  'legal_entity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    code: varchar('code', { length: 16 }).notNull(),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    countryCode: varchar('country_code', { length: 2 }).notNull(),
    adminDivisionCode: varchar('admin_division_code', { length: 16 }),
    baseCurrencyCode: varchar('base_currency_code', { length: 3 }).notNull(),

    /** Statutory identifiers, validated against this country's requirements. */
    registrations: jsonb('registrations')
      .$type<{ requirementCode: string; number: string; expiresOn?: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    taxRegistrationNumber: varchar('tax_registration_number', { length: 64 }),

    address: jsonb('address').$type<Record<string, string>>().notNull().default({}),
    fiscalYearStartMonth: integer('fiscal_year_start_month').notNull().default(1),
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('legal_entity_uq').on(t.tenantId, t.code),
    index('legal_entity_country_idx').on(t.tenantId, t.countryCode),
  ],
);

/**
 * The module entitlement table. One row per module a tenant may use.
 *
 * A tenant with only `inventory` sees a focused, standalone product. A tenant
 * with every row sees the unified ERP. Upselling is an INSERT.
 */
export const tenantModule = kernel.table(
  'tenant_module',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    moduleKey: varchar('module_key', { length: 64 }).notNull(),
    status: moduleStatus('status').notNull().default('enabled'),
    /** Version pinning, so one tenant can stay on an older module contract. */
    version: varchar('version', { length: 32 }),
    enabledAt: timestamp('enabled_at', { withTimezone: true }).notNull().defaultNow(),
    expiresOn: date('expires_on'),
    /** Seat or usage caps for the commercial plan. */
    limits: jsonb('limits').$type<Record<string, number>>().notNull().default({}),
    /** Per-tenant module configuration, validated against the module manifest. */
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [
    unique('tenant_module_uq').on(t.tenantId, t.moduleKey),
    index('tenant_module_status_idx').on(t.tenantId, t.status),
  ],
);

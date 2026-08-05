/**
 * Shared master data.
 *
 * These are the entities several modules must agree on. They live in the kernel
 * precisely so that modules can reference them without referencing each other —
 * a foreign key to `kernel.party` is allowed; a foreign key to
 * `procurement.supplier` from the Inventory module is not.
 *
 * `party` is deliberately one table with role flags rather than separate
 * customer / supplier / employee tables: in this industry the same company is
 * routinely a client on one project and a subcontractor on another, and
 * splitting them guarantees duplicate records and reconciliation pain.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  text,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { kernel, softDelete, tenantColumn, timestamps } from '../columns';

export const partyType = kernel.enum('party_type', ['organisation', 'individual']);

export const itemType = kernel.enum('item_type', [
  'raw_material',
  'panel', // sheet goods — tracked by dimension, not just count
  'hardware',
  'consumable',
  'finished_good',
  'sub_assembly',
  'service',
  'asset',
]);

// ---------------------------------------------------------------------------

export const party = kernel.table(
  'party',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    code: varchar('code', { length: 32 }).notNull(),
    type: partyType('type').notNull().default('organisation'),
    name: text('name').notNull(),
    nativeName: text('native_name'),
    legalName: text('legal_name'),

    /** A party may hold several roles at once. */
    isCustomer: boolean('is_customer').notNull().default(false),
    isSupplier: boolean('is_supplier').notNull().default(false),
    isSubcontractor: boolean('is_subcontractor').notNull().default(false),
    isConsultant: boolean('is_consultant').notNull().default(false),
    isEmployee: boolean('is_employee').notNull().default(false),

    countryCode: varchar('country_code', { length: 2 }),
    adminDivisionCode: varchar('admin_division_code', { length: 16 }),
    address: jsonb('address').$type<Record<string, string>>().notNull().default({}),
    email: varchar('email', { length: 320 }),
    phone: varchar('phone', { length: 32 }),
    website: text('website'),

    taxRegistrationNumber: varchar('tax_registration_number', { length: 64 }),
    /**
     * Statutory registrations held by this party, validated against the
     * requirement definitions for its country. Trade licence, establishment
     * card, chamber of commerce — none of which are named in code.
     */
    registrations: jsonb('registrations')
      .$type<{ requirementCode: string; number: string; expiresOn?: string; documentId?: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    currencyCode: varchar('currency_code', { length: 3 }),
    paymentTermDays: integer('payment_term_days'),
    creditLimit: numeric('credit_limit', { precision: 18, scale: 2 }),
    isBlocked: boolean('is_blocked').notNull().default(false),
    blockReason: text('block_reason'),

    customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    unique('party_code_uq').on(t.tenantId, t.code),
    index('party_name_idx').on(t.tenantId, t.name),
    index('party_role_idx').on(t.tenantId, t.isCustomer, t.isSupplier, t.isSubcontractor),
  ],
);

export const partyContact = kernel.table(
  'party_contact',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    partyId: uuid('party_id')
      .notNull()
      .references(() => party.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    jobTitle: text('job_title'),
    email: varchar('email', { length: 320 }),
    phone: varchar('phone', { length: 32 }),
    isPrimary: boolean('is_primary').notNull().default(false),
    notes: text('notes'),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [index('party_contact_party_idx').on(t.tenantId, t.partyId)],
);

// ---------------------------------------------------------------------------

export const unitOfMeasure = kernel.table(
  'unit_of_measure',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    code: varchar('code', { length: 16 }).notNull(),
    name: text('name').notNull(),
    /** 'length' | 'area' | 'volume' | 'mass' | 'count' | 'time' */
    dimension: varchar('dimension', { length: 16 }).notNull(),
    /** Factor to the tenant's base unit for this dimension. */
    conversionFactor: numeric('conversion_factor', { precision: 18, scale: 8 })
      .notNull()
      .default('1'),
    isBase: boolean('is_base').notNull().default(false),
    decimalPlaces: integer('decimal_places').notNull().default(2),
    ...timestamps(),
  },
  (t) => [unique('unit_of_measure_uq').on(t.tenantId, t.code)],
);

export const item = kernel.table(
  'item',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    code: varchar('code', { length: 48 }).notNull(),
    name: text('name').notNull(),
    nativeName: text('native_name'),
    description: text('description'),
    type: itemType('type').notNull(),
    categoryId: uuid('category_id'),

    stockUomId: uuid('stock_uom_id'),
    purchaseUomId: uuid('purchase_uom_id'),

    /**
     * Panel dimensions. Sheet goods are the heart of joinery costing: the same
     * board is bought per sheet, consumed per square metre, and cut to a part
     * list — so the dimensions belong on the item, not in a module.
     */
    lengthMm: numeric('length_mm', { precision: 12, scale: 2 }),
    widthMm: numeric('width_mm', { precision: 12, scale: 2 }),
    thicknessMm: numeric('thickness_mm', { precision: 12, scale: 2 }),
    /** Grain direction constrains how the cutlist optimiser may rotate a part. */
    hasGrainDirection: boolean('has_grain_direction').notNull().default(false),
    finishCode: varchar('finish_code', { length: 32 }),
    colourCode: varchar('colour_code', { length: 32 }),

    isStocked: boolean('is_stocked').notNull().default(true),
    isBatchTracked: boolean('is_batch_tracked').notNull().default(false),
    isSerialTracked: boolean('is_serial_tracked').notNull().default(false),
    barcode: varchar('barcode', { length: 64 }),

    defaultTaxCodeId: uuid('default_tax_code_id'),
    standardCost: numeric('standard_cost', { precision: 18, scale: 4 }),
    /** Cutting and machining waste allowance, applied by estimation. */
    wastagePercent: numeric('wastage_percent', { precision: 5, scale: 2 })
      .notNull()
      .default('0'),

    customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    unique('item_code_uq').on(t.tenantId, t.code),
    index('item_type_idx').on(t.tenantId, t.type, t.isActive),
    index('item_barcode_idx').on(t.tenantId, t.barcode),
  ],
);

export const itemCategory = kernel.table(
  'item_category',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    parentId: uuid('parent_id'),
    code: varchar('code', { length: 32 }).notNull(),
    name: text('name').notNull(),
    path: text('path').notNull(),
    ...timestamps(),
  },
  (t) => [unique('item_category_uq').on(t.tenantId, t.code)],
);

// ---------------------------------------------------------------------------

/**
 * The job/project every cost ultimately lands against. Owned by the kernel
 * because Production, Procurement, HR, Logistics and Accounts all need it and
 * none of them may depend on the Projects module.
 */
export const project = kernel.table(
  'project',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    legalEntityId: uuid('legal_entity_id'),
    code: varchar('code', { length: 32 }).notNull(),
    name: text('name').notNull(),
    clientPartyId: uuid('client_party_id'),
    /** 'lead' | 'tender' | 'awarded' | 'in_progress' | 'dlp' | 'closed' */
    status: varchar('status', { length: 24 }).notNull().default('lead'),
    currencyCode: varchar('currency_code', { length: 3 }),
    contractValue: numeric('contract_value', { precision: 18, scale: 2 }),
    startDate: date('start_date'),
    endDate: date('end_date'),
    countryCode: varchar('country_code', { length: 2 }),
    siteAddress: jsonb('site_address').$type<Record<string, string>>().notNull().default({}),
    customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    unique('project_code_uq').on(t.tenantId, t.code),
    index('project_status_idx').on(t.tenantId, t.status),
  ],
);

export const costCentre = kernel.table(
  'cost_centre',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    legalEntityId: uuid('legal_entity_id'),
    parentId: uuid('parent_id'),
    code: varchar('code', { length: 32 }).notNull(),
    name: text('name').notNull(),
    ownerId: uuid('owner_id'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [unique('cost_centre_uq').on(t.tenantId, t.code)],
);

/**
 * Cost breakdown structure. Every cost — material, labour, machine, subcontract,
 * logistics — is booked to one of these, which is what makes budget-vs-actual by
 * job possible across modules.
 */
export const costCode = kernel.table(
  'cost_code',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    parentId: uuid('parent_id'),
    code: varchar('code', { length: 32 }).notNull(),
    name: text('name').notNull(),
    /** 'material' | 'labour' | 'machine' | 'subcontract' | 'overhead' | 'other' */
    costType: varchar('cost_type', { length: 16 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [unique('cost_code_uq').on(t.tenantId, t.code)],
);

export const currency = kernel.table(
  'currency',
  {
    code: varchar('code', { length: 3 }).primaryKey(),
    name: text('name').notNull(),
    symbol: varchar('symbol', { length: 8 }),
    decimalPlaces: integer('decimal_places').notNull().default(2),
    isActive: boolean('is_active').notNull().default(true),
  },
);

export const exchangeRate = kernel.table(
  'exchange_rate',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    fromCurrency: varchar('from_currency', { length: 3 }).notNull(),
    toCurrency: varchar('to_currency', { length: 3 }).notNull(),
    rate: numeric('rate', { precision: 18, scale: 8 }).notNull(),
    validOn: date('valid_on').notNull(),
    source: varchar('source', { length: 32 }),
    ...timestamps(),
  },
  (t) => [
    unique('exchange_rate_uq').on(t.tenantId, t.fromCurrency, t.toCurrency, t.validOn),
    index('exchange_rate_lookup_idx').on(t.tenantId, t.fromCurrency, t.toCurrency, t.validOn),
  ],
);

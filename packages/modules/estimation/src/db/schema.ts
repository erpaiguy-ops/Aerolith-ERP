/**
 * Estimation & Tendering — owns the `estimation` Postgres schema.
 *
 * Foreign keys point at `kernel.*` only. Converting a won tender into a project
 * and work orders is composed at the application layer, which may depend on
 * Production; this module must not.
 *
 * The thing that makes this module worth building rather than buying:
 *
 *  - The RATE LIBRARY is versioned and fed by job actuals. Every job finished
 *    makes the next estimate more accurate. That compounds, and nobody else in
 *    this market does it.
 *  - A TENDER is not a sales opportunity. Prequalification, bid/no-bid, bonds,
 *    addenda and submission deadlines are a different lifecycle from a product
 *    pipeline, and modelling them as one loses information that costs jobs.
 *  - An ESTIMATE is a SCENARIO. One tender carries several priced versions, so
 *    "what do we bid if we want the job" is a query rather than a spreadsheet
 *    rebuild.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const estimation = pgSchema('estimation');

const tenantColumn = () => uuid('tenant_id').notNull();
const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/** The tender lifecycle — deliberately not a sales pipeline. */
export const tenderStatus = estimation.enum('tender_status', [
  'identified',
  'prequalifying',
  'bid_no_bid',
  'estimating',
  'submitted',
  'clarifying',
  'won',
  'lost',
  'abandoned',
  'cancelled',
]);

export const estimateStatus = estimation.enum('estimate_status', [
  'draft',
  'pending_approval',
  'approved',
  'superseded',
]);

export const componentType = estimation.enum('component_type', [
  'material',
  'labour',
  'machine',
  'finishing',
  'hardware',
  'subcontract',
  'transport',
  'other',
]);

/** How a BOQ line is treated commercially. */
export const lineKind = estimation.enum('line_kind', [
  'measured',
  'provisional_sum',
  'prime_cost',
  'dayworks',
  'preliminaries',
  'optional',
]);

// ---------------------------------------------------------------------------
// Rate library
// ---------------------------------------------------------------------------

/**
 * A versioned set of rates.
 *
 * Versioned rather than edited in place so last year's tender can still be
 * explained. Re-pricing an old bid with today's rates and getting a different
 * number is the fastest way to lose an argument with a client.
 */
export const rateLibrary = estimation.table(
  'rate_library',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    code: varchar('code', { length: 32 }).notNull(),
    name: text('name').notNull(),
    version: integer('version').notNull().default(1),
    currencyCode: varchar('currency_code', { length: 3 }),
    /** Only one library is current; the rest are history. */
    isCurrent: boolean('is_current').notNull().default(false),
    effectiveFrom: date('effective_from'),
    notes: text('notes'),
    ...timestamps(),
  },
  (t) => [
    unique('rate_library_uq').on(t.tenantId, t.code, t.version),
    index('rate_library_current_idx').on(t.tenantId, t.isCurrent),
  ],
);

export const rateItem = estimation.table(
  'rate_item',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => rateLibrary.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 48 }).notNull(),
    description: text('description').notNull(),
    /** kernel.unit_of_measure */
    uomId: uuid('uom_id'),
    uomCode: varchar('uom_code', { length: 16 }),

    /** Computed from the build-up, cached so a BOQ can be priced in one query. */
    directCost: numeric('direct_cost', { precision: 18, scale: 4 }).notNull().default('0'),
    unitRate: numeric('unit_rate', { precision: 18, scale: 4 }).notNull().default('0'),
    overheadPercent: numeric('overhead_percent', { precision: 6, scale: 3 }),
    marginPercent: numeric('margin_percent', { precision: 6, scale: 3 }),

    /** Feedback from completed jobs. Suggestions, never applied automatically. */
    lastActualCost: numeric('last_actual_cost', { precision: 18, scale: 4 }),
    actualSampleSize: integer('actual_sample_size').notNull().default(0),
    lastActualAt: timestamp('last_actual_at', { withTimezone: true }),

    category: varchar('category', { length: 64 }),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('rate_item_uq').on(t.libraryId, t.code),
    index('rate_item_category_idx').on(t.tenantId, t.category, t.isActive),
  ],
);

/** One line of a rate's build-up: board, tape, labour, spray, hardware. */
export const rateComponent = estimation.table(
  'rate_component',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    rateItemId: uuid('rate_item_id')
      .notNull()
      .references(() => rateItem.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    type: componentType('type').notNull(),
    description: text('description'),
    /** kernel.item — links the build-up to real stock, so a BOM can be exploded. */
    itemId: uuid('item_id'),

    quantityPerUnit: numeric('quantity_per_unit', { precision: 18, scale: 6 }).notNull(),
    unitRate: numeric('unit_rate', { precision: 18, scale: 6 }).notNull(),
    /** Applied to this component only — wastage on labour is usually an error. */
    wastagePercent: numeric('wastage_percent', { precision: 6, scale: 3 }),
    ...timestamps(),
  },
  (t) => [
    unique('rate_component_uq').on(t.rateItemId, t.sequence),
    index('rate_component_item_idx').on(t.tenantId, t.itemId),
  ],
);

// ---------------------------------------------------------------------------
// Tenders
// ---------------------------------------------------------------------------

export const tender = estimation.table(
  'tender',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    number: varchar('number', { length: 48 }),
    numberPeriod: varchar('number_period', { length: 16 }),
    numberValue: integer('number_value'),

    name: text('name').notNull(),
    status: tenderStatus('status').notNull().default('identified'),

    /** kernel.party — who is asking, and who specified us. */
    clientPartyId: uuid('client_party_id'),
    consultantPartyId: uuid('consultant_party_id'),
    mainContractorPartyId: uuid('main_contractor_party_id'),

    /** kernel.project, once won. */
    projectId: uuid('project_id'),
    siteAddress: jsonb('site_address').$type<Record<string, string>>().notNull().default({}),
    currencyCode: varchar('currency_code', { length: 3 }),

    /** Missing this is how tenders are lost before they are priced. */
    submissionDueAt: timestamp('submission_due_at', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    validityDays: integer('validity_days'),

    /** Bid/no-bid is a decision with a reason, not a status change. */
    bidDecision: varchar('bid_decision', { length: 16 }),
    bidDecisionReason: text('bid_decision_reason'),
    bidDecidedBy: uuid('bid_decided_by'),
    bidDecidedAt: timestamp('bid_decided_at', { withTimezone: true }),

    /** Bonds and guarantees, with expiry — tracked or they lapse unnoticed. */
    bonds: jsonb('bonds')
      .$type<{ type: string; amount: number; expiresOn?: string; reference?: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    outcomeValue: numeric('outcome_value', { precision: 18, scale: 2 }),
    lostToPartyId: uuid('lost_to_party_id'),
    lostReason: text('lost_reason'),
    /** What the winner bid, when it can be found out. Feeds win-rate analysis. */
    winningValue: numeric('winning_value', { precision: 18, scale: 2 }),

    ownerId: uuid('owner_id'),
    notes: text('notes'),
    createdBy: uuid('created_by'),
    ...timestamps(),
  },
  (t) => [
    unique('tender_number_uq').on(t.tenantId, t.number),
    index('tender_status_idx').on(t.tenantId, t.status, t.submissionDueAt),
    index('tender_client_idx').on(t.tenantId, t.clientPartyId),
  ],
);

/** Addenda and clarifications — each can change the price after submission. */
export const tenderAddendum = estimation.table(
  'tender_addendum',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    tenderId: uuid('tender_id')
      .notNull()
      .references(() => tender.id, { onDelete: 'cascade' }),
    reference: varchar('reference', { length: 64 }).notNull(),
    issuedOn: date('issued_on'),
    receivedOn: date('received_on'),
    description: text('description'),
    /** False until an estimator has confirmed the impact on the price. */
    isPriced: boolean('is_priced').notNull().default(false),
    priceImpact: numeric('price_impact', { precision: 18, scale: 2 }),
    ...timestamps(),
  },
  (t) => [unique('tender_addendum_uq').on(t.tenderId, t.reference)],
);

// ---------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------

/**
 * A priced scenario for a tender.
 *
 * Several per tender by design — a base bid, an aggressive one, one with an
 * alternate specification. Comparing them is a query, not a spreadsheet rebuild.
 */
export const estimate = estimation.table(
  'estimate',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    tenderId: uuid('tender_id')
      .notNull()
      .references(() => tender.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    label: text('label').notNull(),
    status: estimateStatus('status').notNull().default('draft'),

    /** Pinned, so the estimate can be reproduced after the library moves on. */
    rateLibraryId: uuid('rate_library_id').references(() => rateLibrary.id),

    overheadPercent: numeric('overhead_percent', { precision: 6, scale: 3 }),
    marginPercent: numeric('margin_percent', { precision: 6, scale: 3 }),

    /** Cached roll-up, recomputed when a line changes. */
    totalCost: numeric('total_cost', { precision: 18, scale: 2 }).notNull().default('0'),
    totalValue: numeric('total_value', { precision: 18, scale: 2 }).notNull().default('0'),
    provisionalTotal: numeric('provisional_total', { precision: 18, scale: 2 }).notNull().default('0'),
    optionalTotal: numeric('optional_total', { precision: 18, scale: 2 }).notNull().default('0'),

    /** True for the scenario actually submitted. At most one per tender. */
    isSubmitted: boolean('is_submitted').notNull().default(false),
    approvalInstanceId: uuid('approval_instance_id'),
    notes: text('notes'),
    createdBy: uuid('created_by'),
    ...timestamps(),
  },
  (t) => [
    unique('estimate_uq').on(t.tenderId, t.version),
    index('estimate_status_idx').on(t.tenantId, t.status),
  ],
);

/** BOQ structure — sections and sub-sections as the client issued them. */
export const estimateSection = estimation.table(
  'estimate_section',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    estimateId: uuid('estimate_id')
      .notNull()
      .references(() => estimate.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id'),
    /** The client's own reference — never renumber it, they will notice. */
    reference: varchar('reference', { length: 32 }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps(),
  },
  (t) => [index('estimate_section_idx').on(t.tenantId, t.estimateId, t.sortOrder)],
);

export const estimateLine = estimation.table(
  'estimate_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    estimateId: uuid('estimate_id')
      .notNull()
      .references(() => estimate.id, { onDelete: 'cascade' }),
    sectionId: uuid('section_id').references(() => estimateSection.id, { onDelete: 'set null' }),
    lineNumber: integer('line_number').notNull(),
    /** The BOQ's own item reference, preserved exactly. */
    reference: varchar('reference', { length: 32 }),
    description: text('description').notNull(),

    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull().default('0'),
    uomCode: varchar('uom_code', { length: 16 }),
    kind: lineKind('kind').notNull().default('measured'),

    /** Where the rate came from. Null for a one-off priced by hand. */
    rateItemId: uuid('rate_item_id').references(() => rateItem.id),
    /** Snapshotted from the rate item, so a library change cannot alter a bid. */
    unitCost: numeric('unit_cost', { precision: 18, scale: 4 }).notNull().default('0'),
    unitRate: numeric('unit_rate', { precision: 18, scale: 4 }).notNull().default('0'),
    lineCost: numeric('line_cost', { precision: 18, scale: 2 }).notNull().default('0'),
    lineValue: numeric('line_value', { precision: 18, scale: 2 }).notNull().default('0'),

    /** Line-level override of the estimate's margin. */
    marginPercent: numeric('margin_percent', { precision: 6, scale: 3 }),
    notes: text('notes'),
    ...timestamps(),
  },
  (t) => [
    unique('estimate_line_uq').on(t.estimateId, t.lineNumber),
    index('estimate_line_section_idx').on(t.tenantId, t.sectionId),
  ],
);

/**
 * The build-up behind one estimate line, snapshotted from the rate library.
 *
 * Copied rather than referenced so the bid is reproducible: the library moves
 * on, the submitted price must not.
 */
export const estimateLineComponent = estimation.table(
  'estimate_line_component',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    lineId: uuid('line_id')
      .notNull()
      .references(() => estimateLine.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    type: componentType('type').notNull(),
    description: text('description'),
    /** kernel.item — what makes BOM explosion possible when the tender is won. */
    itemId: uuid('item_id'),
    quantityPerUnit: numeric('quantity_per_unit', { precision: 18, scale: 6 }).notNull(),
    unitRate: numeric('unit_rate', { precision: 18, scale: 6 }).notNull(),
    wastagePercent: numeric('wastage_percent', { precision: 6, scale: 3 }),
    ...timestamps(),
  },
  (t) => [unique('estimate_line_component_uq').on(t.lineId, t.sequence)],
);

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

export const ESTIMATION_TENANT_TABLES = [
  'rate_library',
  'rate_item',
  'rate_component',
  'tender',
  'tender_addendum',
  'estimate',
  'estimate_section',
  'estimate_line',
  'estimate_line_component',
] as const;

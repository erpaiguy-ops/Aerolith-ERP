/**
 * Projects — owns the `projects` Postgres schema.
 *
 * The project itself lives in `kernel.project`, not here. That is deliberate:
 * Production, Inventory, Procurement, HR and Accounts all need to cost against a
 * job, and none of them may depend on this module. So the kernel owns the
 * identity of a project and this module owns everything about *running* one.
 *
 * Three ideas carry the design:
 *
 *  - The WBS is the spine. Budget, progress, cost and commitment all hang off
 *    the same node, which is the only way a cost report and a progress report
 *    can be made to reconcile.
 *  - The COST LEDGER is append-only and written by other modules through a
 *    service, never by direct insert. A job cost that can be edited is a job
 *    cost nobody trusts, and the first thing an argument with a client attacks.
 *  - The BUDGET is versioned and snapshotted from the winning estimate. When a
 *    variation is approved the budget is revised, not overwritten — otherwise
 *    the overrun quietly becomes the new plan and the loss disappears.
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

export const projects = pgSchema('projects');

const tenantColumn = () => uuid('tenant_id').notNull();
const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/** How a node's percentage complete is allowed to be established. */
export const ruleOfCredit = projects.enum('rule_of_credit', [
  'binary',
  'started_finished',
  'units',
  'milestone',
  'manual',
]);

export const budgetStatus = projects.enum('budget_status', [
  'draft',
  'pending_approval',
  'approved',
  'superseded',
]);

/**
 * Cost categories. Aligned with the estimating module's component types so a
 * budget derived from a build-up lands in comparable buckets — the comparison
 * between what was priced and what was spent is the whole reason for the module.
 * `preliminaries` and `contingency` exist here and not there because they are
 * project-level costs rather than components of a rate.
 */
export const costCategory = projects.enum('cost_category', [
  'material',
  'labour',
  'machine',
  'finishing',
  'hardware',
  'subcontract',
  'transport',
  'preliminaries',
  'contingency',
  'other',
]);

export const commitmentStatus = projects.enum('commitment_status', ['open', 'closed', 'cancelled']);

export const snagStatus = projects.enum('snag_status', [
  'open',
  'in_progress',
  'ready_for_inspection',
  'closed',
  'rejected',
]);

export const milestoneType = projects.enum('milestone_type', ['contractual', 'internal']);

// ---------------------------------------------------------------------------
// Project detail
// ---------------------------------------------------------------------------

/**
 * What this module adds to `kernel.project`.
 *
 * A one-to-one extension rather than columns on the kernel table, so a tenant
 * without the Projects module does not carry project-management fields it has no
 * screens for — and so this module can evolve without a kernel migration.
 */
export const projectDetail = projects.table(
  'project_detail',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    /** kernel.project */
    projectId: uuid('project_id').notNull(),

    projectManagerId: uuid('project_manager_id'),
    quantitySurveyorId: uuid('quantity_surveyor_id'),

    /** The baseline, frozen when the project starts. Never edited in place. */
    baselineStartDate: date('baseline_start_date'),
    baselineEndDate: date('baseline_end_date'),
    /** The current view. The gap between this and the baseline is the delay. */
    forecastEndDate: date('forecast_end_date'),

    practicalCompletionDate: date('practical_completion_date'),
    /** Derived from PC plus the DLP rule at the time. Drives retention release. */
    defectsLiabilityEndsOn: date('defects_liability_ends_on'),

    /** 'green' | 'amber' | 'red' — set by the PM, evidenced by the metrics. */
    healthStatus: varchar('health_status', { length: 16 }).notNull().default('green'),
    healthNote: text('health_note'),

    /** Cached from the estimate at award, so drift from tender is visible. */
    tenderMarginPercent: numeric('tender_margin_percent', { precision: 6, scale: 3 }),
    /** estimation.tender / estimation.estimate — traceability back to the bid. */
    sourceTenderId: uuid('source_tender_id'),
    sourceEstimateId: uuid('source_estimate_id'),

    ...timestamps(),
  },
  (t) => [unique('project_detail_uq').on(t.tenantId, t.projectId)],
);

// ---------------------------------------------------------------------------
// Work breakdown structure
// ---------------------------------------------------------------------------

export const wbsNode = projects.table(
  'wbs_node',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    projectId: uuid('project_id').notNull(),
    parentId: uuid('parent_id'),

    code: varchar('code', { length: 48 }).notNull(),
    name: text('name').notNull(),
    /** Materialised path, so "everything under 2.3" is one indexed query. */
    path: text('path').notNull(),
    depth: integer('depth').notNull().default(0),
    sortOrder: integer('sort_order').notNull().default(0),

    ruleOfCredit: ruleOfCredit('rule_of_credit').notNull().default('manual'),
    unitsPlanned: numeric('units_planned', { precision: 18, scale: 4 }),
    uomCode: varchar('uom_code', { length: 16 }),
    /** Weighted milestones for `milestone` credit. Weights must total 100. */
    creditMilestones: jsonb('credit_milestones')
      .$type<{ key: string; label?: string; weightPercent: number }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    /**
     * Cached roll-ups of the approved budget for this node only, excluding
     * children. Recomputed whenever a budget is approved — a cache, never the
     * source of truth, which is `budget_line`.
     */
    budgetCost: numeric('budget_cost', { precision: 18, scale: 2 }).notNull().default('0'),
    budgetValue: numeric('budget_value', { precision: 18, scale: 2 }).notNull().default('0'),

    /** Latest measured progress for this node alone. From `progress_entry`. */
    percentComplete: numeric('percent_complete', { precision: 6, scale: 3 }).notNull().default('0'),
    lastMeasuredOn: date('last_measured_on'),

    /** production.work_order — set when this node is made in the factory. */
    workOrderId: uuid('work_order_id'),

    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('wbs_node_uq').on(t.projectId, t.code),
    index('wbs_node_parent_idx').on(t.tenantId, t.projectId, t.parentId, t.sortOrder),
    index('wbs_node_path_idx').on(t.tenantId, t.projectId, t.path),
  ],
);

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/**
 * A versioned cost budget.
 *
 * Version 1 is snapshotted from the winning estimate at award. Every approved
 * variation produces a new version. Superseded versions are kept so "what did we
 * think this job would cost before the client changed the ironmongery" always
 * has an answer.
 */
export const budget = projects.table(
  'budget',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    projectId: uuid('project_id').notNull(),
    version: integer('version').notNull().default(1),
    status: budgetStatus('status').notNull().default('draft'),

    /** 'estimate' | 'manual' | 'variation' — where this version came from. */
    source: varchar('source', { length: 24 }).notNull().default('manual'),
    /** estimation.estimate, when the source is a won bid. */
    sourceEstimateId: uuid('source_estimate_id'),
    /** contracts.variation, when the source is an approved change. */
    sourceVariationId: uuid('source_variation_id'),

    totalCost: numeric('total_cost', { precision: 18, scale: 2 }).notNull().default('0'),
    totalValue: numeric('total_value', { precision: 18, scale: 2 }).notNull().default('0'),
    /**
     * Held centrally rather than spread across lines. Spreading it means every
     * line looks affordable and the contingency is spent before anyone notices
     * it was drawn on.
     */
    contingencyAmount: numeric('contingency_amount', { precision: 18, scale: 2 })
      .notNull()
      .default('0'),
    contingencyDrawn: numeric('contingency_drawn', { precision: 18, scale: 2 })
      .notNull()
      .default('0'),

    approvalInstanceId: uuid('approval_instance_id'),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    note: text('note'),
    createdBy: uuid('created_by'),
    ...timestamps(),
  },
  (t) => [
    unique('budget_uq').on(t.projectId, t.version),
    index('budget_status_idx').on(t.tenantId, t.projectId, t.status),
  ],
);

export const budgetLine = projects.table(
  'budget_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    budgetId: uuid('budget_id')
      .notNull()
      .references(() => budget.id, { onDelete: 'cascade' }),
    wbsNodeId: uuid('wbs_node_id').references(() => wbsNode.id, { onDelete: 'set null' }),

    /** estimation.estimate_line — the thread back to the priced bid. */
    sourceEstimateLineId: uuid('source_estimate_line_id'),
    /** kernel.item, where the budget line is a specific material. */
    itemId: uuid('item_id'),

    category: costCategory('category').notNull(),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull().default('0'),
    uomCode: varchar('uom_code', { length: 16 }),
    unitCost: numeric('unit_cost', { precision: 18, scale: 4 }).notNull().default('0'),
    lineCost: numeric('line_cost', { precision: 18, scale: 2 }).notNull().default('0'),
    /** Revenue side — what the client is paying for this scope. */
    lineValue: numeric('line_value', { precision: 18, scale: 2 }).notNull().default('0'),
    ...timestamps(),
  },
  (t) => [
    index('budget_line_budget_idx').on(t.tenantId, t.budgetId),
    index('budget_line_wbs_idx').on(t.tenantId, t.wbsNodeId),
  ],
);

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/**
 * One measurement of one node at one period end.
 *
 * The rule of credit and the evidence are snapshotted onto the row. Changing a
 * node's rule from `manual` to `units` later must not retroactively rewrite what
 * was claimed and certified last month.
 *
 * Not append-only: a period is re-measured in place, because two rows for the
 * same node and period have no defensible ordering and every report would have
 * to guess. The audit log carries the before-and-after, so the history survives
 * without the ambiguity.
 */
export const progressEntry = projects.table(
  'progress_entry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    projectId: uuid('project_id').notNull(),
    wbsNodeId: uuid('wbs_node_id')
      .notNull()
      .references(() => wbsNode.id, { onDelete: 'cascade' }),

    periodEnd: date('period_end').notNull(),
    ruleOfCredit: ruleOfCredit('rule_of_credit').notNull(),

    unitsComplete: numeric('units_complete', { precision: 18, scale: 4 }),
    unitsPlanned: numeric('units_planned', { precision: 18, scale: 4 }),
    started: boolean('started').notNull().default(false),
    finished: boolean('finished').notNull().default(false),
    milestonesAchieved: jsonb('milestones_achieved')
      .$type<{ key: string; weightPercent: number; achieved: boolean }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    manualPercent: numeric('manual_percent', { precision: 6, scale: 3 }),

    /** The result of applying the rule. Stored, not recomputed on read. */
    percentComplete: numeric('percent_complete', { precision: 6, scale: 3 }).notNull(),
    earnedValue: numeric('earned_value', { precision: 18, scale: 2 }).notNull().default('0'),

    /** kernel.document — the site photo or signed sheet behind the claim. */
    evidenceDocumentId: uuid('evidence_document_id'),
    measuredBy: uuid('measured_by'),
    note: text('note'),
    ...timestamps(),
  },
  (t) => [
    unique('progress_entry_uq').on(t.wbsNodeId, t.periodEnd),
    index('progress_entry_period_idx').on(t.tenantId, t.projectId, t.periodEnd),
  ],
);

// ---------------------------------------------------------------------------
// Cost ledger and commitments
// ---------------------------------------------------------------------------

/**
 * The job cost ledger. Append-only, written only through `postCost`.
 *
 * Every module that spends money on a job posts here: a material issue from
 * Inventory, a timesheet from HR, a subcontractor invoice from Procurement. The
 * source module and entity are recorded on every row so any number in a cost
 * report can be traced to the transaction that caused it. Corrections are
 * reversing entries, never edits.
 */
export const costEntry = projects.table(
  'cost_entry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    projectId: uuid('project_id').notNull(),
    wbsNodeId: uuid('wbs_node_id').references(() => wbsNode.id, { onDelete: 'set null' }),

    postedOn: date('posted_on').notNull(),
    category: costCategory('category').notNull(),
    description: text('description').notNull(),

    /** Which module caused this cost, and the entity inside it. */
    sourceModule: varchar('source_module', { length: 32 }).notNull(),
    sourceEntityType: varchar('source_entity_type', { length: 64 }),
    sourceEntityId: uuid('source_entity_id'),

    amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
    currencyCode: varchar('currency_code', { length: 3 }),
    quantity: numeric('quantity', { precision: 18, scale: 4 }),
    uomCode: varchar('uom_code', { length: 16 }),

    /**
     * True for costs incurred but not yet invoiced — goods received against an
     * unbilled PO, hours worked before payroll runs. Excluded from the ledger's
     * cash view, included in the cost view. Without the distinction a job looks
     * profitable for exactly as long as its invoices are late.
     */
    isAccrual: boolean('is_accrual').notNull().default(false),
    /** Set on a reversal, pointing at the entry it cancels. */
    reversesEntryId: uuid('reverses_entry_id'),

    postedBy: uuid('posted_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('cost_entry_project_idx').on(t.tenantId, t.projectId, t.postedOn),
    index('cost_entry_wbs_idx').on(t.tenantId, t.wbsNodeId, t.category),
    index('cost_entry_source_idx').on(t.tenantId, t.sourceModule, t.sourceEntityId),
  ],
);

/**
 * Money promised but not yet spent — open purchase orders and subcontracts.
 *
 * Kept separate from the cost ledger because it is a different kind of fact: a
 * commitment is a future certainty, not a past event. Ignoring it is how a job
 * reports 12% margin in month four and 2% at handover.
 */
export const commitment = projects.table(
  'commitment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    projectId: uuid('project_id').notNull(),
    wbsNodeId: uuid('wbs_node_id').references(() => wbsNode.id, { onDelete: 'set null' }),

    /** 'purchase_order' | 'subcontract' | 'other' */
    type: varchar('type', { length: 24 }).notNull(),
    reference: varchar('reference', { length: 64 }).notNull(),
    /** kernel.party */
    partyId: uuid('party_id'),
    description: text('description'),
    category: costCategory('category').notNull(),

    committedAmount: numeric('committed_amount', { precision: 18, scale: 2 }).notNull(),
    /** Raised as the commitment converts into actual cost. */
    invoicedAmount: numeric('invoiced_amount', { precision: 18, scale: 2 }).notNull().default('0'),
    currencyCode: varchar('currency_code', { length: 3 }),
    status: commitmentStatus('status').notNull().default('open'),

    sourceModule: varchar('source_module', { length: 32 }).notNull(),
    sourceEntityId: uuid('source_entity_id'),
    expectedOn: date('expected_on'),
    ...timestamps(),
  },
  (t) => [
    unique('commitment_uq').on(t.tenantId, t.sourceModule, t.reference),
    index('commitment_project_idx').on(t.tenantId, t.projectId, t.status),
  ],
);

// ---------------------------------------------------------------------------
// Milestones and defects
// ---------------------------------------------------------------------------

export const milestone = projects.table(
  'milestone',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    projectId: uuid('project_id').notNull(),
    wbsNodeId: uuid('wbs_node_id').references(() => wbsNode.id, { onDelete: 'set null' }),

    name: text('name').notNull(),
    type: milestoneType('type').notNull().default('internal'),
    baselineDate: date('baseline_date'),
    forecastDate: date('forecast_date'),
    actualDate: date('actual_date'),

    /** A contractual date with damages attached. Drives the LD exposure figure. */
    liquidatedDamagesApply: boolean('liquidated_damages_apply').notNull().default(false),
    /** Extensions of time granted against this date, in days. */
    extensionDays: integer('extension_days').notNull().default(0),

    note: text('note'),
    ...timestamps(),
  },
  (t) => [index('milestone_project_idx').on(t.tenantId, t.projectId, t.forecastDate)],
);

/**
 * Snags and defects.
 *
 * In joinery this is where the last 5% of a contract's money sits: retention is
 * not released while snags are open, so an untracked snag list is an untracked
 * receivable. Kept here rather than in a Quality module because it is inseparable
 * from handover and retention release; QA-QC inspections are a different thing
 * and will live in their own module.
 */
export const snag = projects.table(
  'snag',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    projectId: uuid('project_id').notNull(),
    wbsNodeId: uuid('wbs_node_id').references(() => wbsNode.id, { onDelete: 'set null' }),

    reference: varchar('reference', { length: 32 }).notNull(),
    location: text('location'),
    description: text('description').notNull(),
    /** 'minor' | 'major' | 'critical' — critical blocks handover. */
    severity: varchar('severity', { length: 16 }).notNull().default('minor'),
    status: snagStatus('status').notNull().default('open'),

    raisedBy: uuid('raised_by'),
    raisedOn: date('raised_on').notNull(),
    /** Who owns the fix — may be an internal user or a subcontractor party. */
    assignedToUserId: uuid('assigned_to_user_id'),
    assignedToPartyId: uuid('assigned_to_party_id'),
    targetDate: date('target_date'),
    closedOn: date('closed_on'),
    closedBy: uuid('closed_by'),

    /** kernel.document ids — before and after photographs. */
    documentIds: jsonb('document_ids').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Recharged to a subcontractor. Feeds the contracts back-charge register. */
    backChargeAmount: numeric('back_charge_amount', { precision: 18, scale: 2 }),
    ...timestamps(),
  },
  (t) => [
    unique('snag_uq').on(t.projectId, t.reference),
    index('snag_status_idx').on(t.tenantId, t.projectId, t.status, t.severity),
  ],
);

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

export const PROJECTS_TENANT_TABLES = [
  'project_detail',
  'wbs_node',
  'budget',
  'budget_line',
  'progress_entry',
  'cost_entry',
  'commitment',
  'milestone',
  'snag',
] as const;

/**
 * The cost ledger is the record a client's QS will attack in a dispute. If it
 * can be edited it is worthless, so the database refuses.
 */
export const PROJECTS_APPEND_ONLY_TABLES = new Set(['cost_entry']);

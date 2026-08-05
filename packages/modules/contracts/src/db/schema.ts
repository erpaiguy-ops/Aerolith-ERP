/**
 * Contract Administration — owns the `contracts` Postgres schema.
 *
 * Foreign keys point at `kernel.*` only. The project lives in `kernel.project`,
 * so this module works with or without the Projects module: a fit-out
 * subcontractor who wants nothing but a variation register and payment
 * applications gets exactly that.
 *
 * The design commitments:
 *
 *  - **An application and a certificate are different documents.** What you
 *    asked for and what the client agreed to pay are separate rows, deliberately,
 *    because the gap between them is the most useful commercial fact on the job
 *    and every spreadsheet destroys it by typing one over the other.
 *  - **Everything is cumulative.** Valuations, retention, advance recovery and
 *    back charges are all to-date figures; the certificate is the difference.
 *    See `domain/payment.ts` for why.
 *  - **Only approved variations move the contract sum.** Instructed-but-
 *    unapproved work is tracked as exposure and reported separately, because it
 *    is real money spent with no agreement behind it.
 *  - **Retention and payment terms come from the country pack**, resolved
 *    tenant → country → default, and are then SNAPSHOTTED onto the contract.
 *    A contract signed under last year's terms is not renegotiated by an admin
 *    editing a default.
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

export const contracts = pgSchema('contracts');

const tenantColumn = () => uuid('tenant_id').notNull();
const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/**
 * Which side of the contract we are on.
 *
 * The same table serves both: a joinery firm is a subcontractor to a main
 * contractor and a main contractor to its own installers, often on one job, and
 * the arithmetic is identical in both directions. Only the sign of the cash
 * flow differs.
 */
export const contractSide = contracts.enum('contract_side', ['receivable', 'payable']);

export const contractStatus = contracts.enum('contract_status', [
  'draft',
  'active',
  'suspended',
  'practical_completion',
  'defects_liability',
  'closed',
  'terminated',
]);

export const variationStatus = contracts.enum('variation_status', [
  'identified',
  'instructed',
  'quoted',
  'submitted',
  'approved',
  'rejected',
  'withdrawn',
]);

export const valuationBasis = contracts.enum('valuation_basis', [
  'contract_rates',
  'pro_rata',
  'star_rate',
  'dayworks',
  'lump_sum',
]);

export const applicationStatus = contracts.enum('application_status', [
  'draft',
  'pending_approval',
  'submitted',
  'certified',
  'disputed',
  'paid',
  'cancelled',
]);

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export const contract = contracts.table(
  'contract',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    number: varchar('number', { length: 48 }),
    numberPeriod: varchar('number_period', { length: 16 }),
    numberValue: integer('number_value'),

    /** kernel.project — the job this contract belongs to. */
    projectId: uuid('project_id'),
    /** kernel.party — the client, or the subcontractor on a payable contract. */
    counterpartyId: uuid('counterparty_id'),

    side: contractSide('side').notNull().default('receivable'),
    name: text('name').notNull(),
    /** The client's own contract reference. Quoted on every certificate. */
    externalReference: varchar('external_reference', { length: 64 }),
    status: contractStatus('status').notNull().default('draft'),
    /** 'fidic_red' | 'fidic_yellow' | 'bespoke' | 'purchase_order' | 'jct' ... */
    form: varchar('form', { length: 32 }),

    currencyCode: varchar('currency_code', { length: 3 }),
    originalSum: numeric('original_sum', { precision: 18, scale: 2 }).notNull().default('0'),
    /** Cached: original plus approved variations. Recomputed on approval. */
    currentSum: numeric('current_sum', { precision: 18, scale: 2 }).notNull().default('0'),

    /**
     * Commercial terms, SNAPSHOTTED at signature from the resolved rules
     * (tenant → country → default). Editing a default must never restate a
     * contract that has already been signed and part-certified.
     */
    retentionPercent: numeric('retention_percent', { precision: 6, scale: 3 }),
    retentionCapPercent: numeric('retention_cap_percent', { precision: 6, scale: 3 }),
    retentionReleaseSchedule: jsonb('retention_release_schedule')
      .$type<{ practicalCompletion: number; endOfDlp: number }>()
      .notNull()
      .default({ practicalCompletion: 50, endOfDlp: 50 }),
    paymentTermDays: integer('payment_term_days'),
    defectsLiabilityMonths: integer('defects_liability_months'),
    /** Days allowed to notify a claim or variation. Drives the time-bar warning. */
    noticePeriodDays: integer('notice_period_days'),
    taxPercent: numeric('tax_percent', { precision: 6, scale: 3 }),

    advanceAmount: numeric('advance_amount', { precision: 18, scale: 2 }).notNull().default('0'),
    advanceRecoveryStartPercent: numeric('advance_recovery_start_percent', {
      precision: 6,
      scale: 3,
    }),
    advanceRecoveryEndPercent: numeric('advance_recovery_end_percent', {
      precision: 6,
      scale: 3,
    }),

    /** Liquidated damages: a rate per day and the cap the contract puts on it. */
    ldPerDay: numeric('ld_per_day', { precision: 18, scale: 2 }),
    ldCapPercent: numeric('ld_cap_percent', { precision: 6, scale: 3 }),

    /** Bonds and guarantees with expiry dates — they lapse silently otherwise. */
    securities: jsonb('securities')
      .$type<{ type: string; amount: number; expiresOn?: string; reference?: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    awardedOn: date('awarded_on'),
    commencedOn: date('commenced_on'),
    contractCompletionDate: date('contract_completion_date'),
    practicalCompletionOn: date('practical_completion_on'),
    defectsLiabilityEndsOn: date('defects_liability_ends_on'),

    /** estimation.tender / estimation.estimate — the thread back to the bid. */
    sourceTenderId: uuid('source_tender_id'),
    sourceEstimateId: uuid('source_estimate_id'),

    notes: text('notes'),
    createdBy: uuid('created_by'),
    ...timestamps(),
  },
  (t) => [
    unique('contract_number_uq').on(t.tenantId, t.number),
    index('contract_project_idx').on(t.tenantId, t.projectId, t.side),
    index('contract_status_idx').on(t.tenantId, t.status),
  ],
);

/**
 * The contract BOQ — the priced scope as signed.
 *
 * Snapshotted from the winning estimate, not referenced. The estimate is a
 * pricing document that may be revised; the contract BOQ is what was agreed, and
 * it must never move underneath a valuation.
 */
export const contractLine = contracts.table(
  'contract_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    contractId: uuid('contract_id')
      .notNull()
      .references(() => contract.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    /** The client's BOQ reference, preserved exactly as issued. */
    reference: varchar('reference', { length: 32 }),
    sectionName: text('section_name'),
    description: text('description').notNull(),

    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull().default('0'),
    uomCode: varchar('uom_code', { length: 16 }),
    unitRate: numeric('unit_rate', { precision: 18, scale: 4 }).notNull().default('0'),
    lineValue: numeric('line_value', { precision: 18, scale: 2 }).notNull().default('0'),

    /** 'measured' | 'provisional_sum' | 'prime_cost' | 'dayworks' | 'preliminaries' */
    kind: varchar('kind', { length: 24 }).notNull().default('measured'),
    /** estimation.estimate_line, and projects.wbs_node once the job is running. */
    sourceEstimateLineId: uuid('source_estimate_line_id'),
    wbsNodeId: uuid('wbs_node_id'),

    /** Cumulative quantity certified. The basis of the next valuation. */
    quantityCertified: numeric('quantity_certified', { precision: 18, scale: 4 })
      .notNull()
      .default('0'),
    ...timestamps(),
  },
  (t) => [
    unique('contract_line_uq').on(t.contractId, t.lineNumber),
    index('contract_line_wbs_idx').on(t.tenantId, t.wbsNodeId),
  ],
);

// ---------------------------------------------------------------------------
// Variations
// ---------------------------------------------------------------------------

export const variation = contracts.table(
  'variation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    contractId: uuid('contract_id')
      .notNull()
      .references(() => contract.id, { onDelete: 'cascade' }),
    number: varchar('number', { length: 48 }),
    numberPeriod: varchar('number_period', { length: 16 }),
    numberValue: integer('number_value'),

    title: text('title').notNull(),
    description: text('description'),
    status: variationStatus('status').notNull().default('identified'),
    basis: valuationBasis('basis').notNull().default('contract_rates'),

    /** The instruction that started the work. Often a site email, so recorded. */
    instructionReference: varchar('instruction_reference', { length: 64 }),
    instructedOn: date('instructed_on'),
    instructedBy: text('instructed_by'),
    /** kernel.document — the instruction itself. The evidence, not a memory. */
    instructionDocumentId: uuid('instruction_document_id'),

    /** Notice given against the contract's time bar. Absence is the risk. */
    noticeGivenOn: date('notice_given_on'),
    noticeReference: varchar('notice_reference', { length: 64 }),

    quotedValue: numeric('quoted_value', { precision: 18, scale: 2 }),
    quotedCost: numeric('quoted_cost', { precision: 18, scale: 2 }),
    submittedOn: date('submitted_on'),
    /** What the client agreed. Differs from quoted more often than not. */
    approvedValue: numeric('approved_value', { precision: 18, scale: 2 }),
    approvedOn: date('approved_on'),
    approvedReference: varchar('approved_reference', { length: 64 }),
    rejectedReason: text('rejected_reason'),

    /** Weights the exposure figure: instructed work not yet done is not spent. */
    percentExecuted: numeric('percent_executed', { precision: 6, scale: 3 })
      .notNull()
      .default('0'),

    /** Extension of time claimed and granted with this variation, in days. */
    eotClaimedDays: integer('eot_claimed_days'),
    eotGrantedDays: integer('eot_granted_days'),

    /** Dayworks resource records, when the basis is dayworks. */
    dayworks: jsonb('dayworks')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    ohpPercent: numeric('ohp_percent', { precision: 6, scale: 3 }),

    approvalInstanceId: uuid('approval_instance_id'),
    createdBy: uuid('created_by'),
    ...timestamps(),
  },
  (t) => [
    unique('variation_number_uq').on(t.tenantId, t.number),
    index('variation_contract_idx').on(t.tenantId, t.contractId, t.status),
    index('variation_instructed_idx').on(t.tenantId, t.instructedOn),
  ],
);

export const variationLine = contracts.table(
  'variation_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    variationId: uuid('variation_id')
      .notNull()
      .references(() => variation.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    description: text('description').notNull(),
    /** Negative for omitted work — omissions are variations too. */
    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull().default('0'),
    uomCode: varchar('uom_code', { length: 16 }),
    unitRate: numeric('unit_rate', { precision: 18, scale: 4 }).notNull().default('0'),
    unitCost: numeric('unit_cost', { precision: 18, scale: 4 }),
    lineValue: numeric('line_value', { precision: 18, scale: 2 }).notNull().default('0'),
    /** The contract line this rate was taken from, on a contract-rates basis. */
    sourceContractLineId: uuid('source_contract_line_id').references(() => contractLine.id, {
      onDelete: 'set null',
    }),
    wbsNodeId: uuid('wbs_node_id'),
    ...timestamps(),
  },
  (t) => [unique('variation_line_uq').on(t.variationId, t.lineNumber)],
);

// ---------------------------------------------------------------------------
// Payment applications
// ---------------------------------------------------------------------------

/**
 * An interim payment application, and the certificate that answers it.
 *
 * All the "ToDate" columns are cumulative; `netThisApplication` is the
 * difference against the previous application. Storing both means a report never
 * has to re-derive a valuation from a chain of increments, and a corrected
 * valuation flows through as a smaller certificate instead of vanishing.
 */
export const paymentApplication = contracts.table(
  'payment_application',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    contractId: uuid('contract_id')
      .notNull()
      .references(() => contract.id, { onDelete: 'cascade' }),
    number: varchar('number', { length: 48 }),
    numberPeriod: varchar('number_period', { length: 16 }),
    numberValue: integer('number_value'),
    /** IPC 1, 2, 3 … The client's own sequence. */
    sequence: integer('sequence').notNull(),
    status: applicationStatus('status').notNull().default('draft'),

    periodFrom: date('period_from'),
    periodTo: date('period_to').notNull(),
    /** Contract sum at the time. Snapshotted: caps must not move retroactively. */
    contractSumAtValuation: numeric('contract_sum_at_valuation', { precision: 18, scale: 2 })
      .notNull()
      .default('0'),

    // --- Cumulative valuation ---
    workDoneToDate: numeric('work_done_to_date', { precision: 18, scale: 2 })
      .notNull()
      .default('0'),
    variationsToDate: numeric('variations_to_date', { precision: 18, scale: 2 })
      .notNull()
      .default('0'),
    materialsOnSite: numeric('materials_on_site', { precision: 18, scale: 2 })
      .notNull()
      .default('0'),
    materialsOnSitePercent: numeric('materials_on_site_percent', { precision: 6, scale: 3 }),
    grossValuationToDate: numeric('gross_valuation_to_date', { precision: 18, scale: 2 })
      .notNull()
      .default('0'),

    // --- Cumulative deductions ---
    retentionHeldToDate: numeric('retention_held_to_date', { precision: 18, scale: 2 })
      .notNull()
      .default('0'),
    retentionReleased: numeric('retention_released', { precision: 18, scale: 2 })
      .notNull()
      .default('0'),
    advanceRecoveredToDate: numeric('advance_recovered_to_date', { precision: 18, scale: 2 })
      .notNull()
      .default('0'),
    backChargesToDate: numeric('back_charges_to_date', { precision: 18, scale: 2 })
      .notNull()
      .default('0'),
    liquidatedDamagesToDate: numeric('liquidated_damages_to_date', { precision: 18, scale: 2 })
      .notNull()
      .default('0'),

    netValuationToDate: numeric('net_valuation_to_date', { precision: 18, scale: 2 })
      .notNull()
      .default('0'),
    previouslyCertifiedNet: numeric('previously_certified_net', { precision: 18, scale: 2 })
      .notNull()
      .default('0'),
    netThisApplication: numeric('net_this_application', { precision: 18, scale: 2 })
      .notNull()
      .default('0'),
    taxAmount: numeric('tax_amount', { precision: 18, scale: 2 }).notNull().default('0'),
    totalApplied: numeric('total_applied', { precision: 18, scale: 2 }).notNull().default('0'),

    // --- What the client actually certified ---
    /**
     * Null until certification. Kept beside the application rather than
     * overwriting it: the difference is the disallowance, and a client who
     * certifies 85% of everything is a pattern nobody sees if it is overwritten.
     */
    certifiedNet: numeric('certified_net', { precision: 18, scale: 2 }),
    certifiedTax: numeric('certified_tax', { precision: 18, scale: 2 }),
    certifiedTotal: numeric('certified_total', { precision: 18, scale: 2 }),
    certifiedOn: date('certified_on'),
    certificateReference: varchar('certificate_reference', { length: 64 }),
    disallowedReason: text('disallowed_reason'),

    dueOn: date('due_on'),
    paidOn: date('paid_on'),
    paidAmount: numeric('paid_amount', { precision: 18, scale: 2 }),

    submittedOn: date('submitted_on'),
    approvalInstanceId: uuid('approval_instance_id'),
    /** kernel.document — the signed application pack. */
    documentId: uuid('document_id'),
    notes: text('notes'),
    createdBy: uuid('created_by'),
    ...timestamps(),
  },
  (t) => [
    unique('payment_application_uq').on(t.contractId, t.sequence),
    unique('payment_application_number_uq').on(t.tenantId, t.number),
    index('payment_application_status_idx').on(t.tenantId, t.status, t.dueOn),
  ],
);

/**
 * The measured detail behind an application.
 *
 * Cumulative quantities, like everything else. `quantityPrevious` is stored
 * rather than joined from the previous application so a line added mid-contract
 * does not have to invent a history it never had.
 */
export const paymentApplicationLine = contracts.table(
  'payment_application_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => paymentApplication.id, { onDelete: 'cascade' }),
    contractLineId: uuid('contract_line_id').references(() => contractLine.id, {
      onDelete: 'set null',
    }),
    /** Set instead of `contractLineId` when the line values a variation. */
    variationId: uuid('variation_id').references(() => variation.id, { onDelete: 'set null' }),

    description: text('description').notNull(),
    uomCode: varchar('uom_code', { length: 16 }),
    unitRate: numeric('unit_rate', { precision: 18, scale: 4 }).notNull().default('0'),

    quantityContract: numeric('quantity_contract', { precision: 18, scale: 4 }),
    quantityToDate: numeric('quantity_to_date', { precision: 18, scale: 4 })
      .notNull()
      .default('0'),
    quantityPrevious: numeric('quantity_previous', { precision: 18, scale: 4 })
      .notNull()
      .default('0'),
    valueToDate: numeric('value_to_date', { precision: 18, scale: 2 }).notNull().default('0'),
    valueThisPeriod: numeric('value_this_period', { precision: 18, scale: 2 })
      .notNull()
      .default('0'),

    /** What the client certified on this line, when they certify line by line. */
    quantityCertified: numeric('quantity_certified', { precision: 18, scale: 4 }),
    valueCertified: numeric('value_certified', { precision: 18, scale: 2 }),
    ...timestamps(),
  },
  (t) => [
    index('payment_application_line_idx').on(t.tenantId, t.applicationId),
    index('payment_application_line_contract_idx').on(t.tenantId, t.contractLineId),
  ],
);

/**
 * Retention released, as separate events.
 *
 * Its own table because releases happen out of band — months after the last
 * certificate, on their own trigger, sometimes in tranches. Folding them into
 * applications would mean raising a nil application to release retention, which
 * is how retention gets forgotten entirely.
 */
export const retentionRelease = contracts.table(
  'retention_release',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    contractId: uuid('contract_id')
      .notNull()
      .references(() => contract.id, { onDelete: 'cascade' }),
    /** 'practical_completion' | 'end_of_dlp' | 'negotiated' */
    trigger: varchar('trigger', { length: 32 }).notNull(),
    amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
    dueOn: date('due_on'),
    releasedOn: date('released_on'),
    /** Set against the application that actually paid it, when one did. */
    applicationId: uuid('application_id').references(() => paymentApplication.id, {
      onDelete: 'set null',
    }),
    note: text('note'),
    ...timestamps(),
  },
  (t) => [index('retention_release_idx').on(t.tenantId, t.contractId, t.dueOn)],
);

/**
 * Back charges and contra charges.
 *
 * Money you are entitled to recover from the other side: a subcontractor's
 * damage to your work, attendance you provided, a snag you fixed for them. Its
 * own register because these are argued individually and each needs its own
 * evidence trail, and because unrecovered back charges are the quietest leak on
 * a joinery job.
 */
export const backCharge = contracts.table(
  'back_charge',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    contractId: uuid('contract_id')
      .notNull()
      .references(() => contract.id, { onDelete: 'cascade' }),
    reference: varchar('reference', { length: 48 }).notNull(),
    description: text('description').notNull(),
    /** 'damage' | 'attendance' | 'rectification' | 'materials' | 'other' */
    category: varchar('category', { length: 24 }).notNull().default('other'),
    amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
    incurredOn: date('incurred_on').notNull(),
    /** 'raised' | 'notified' | 'agreed' | 'disputed' | 'recovered' | 'written_off' */
    status: varchar('status', { length: 24 }).notNull().default('raised'),
    notifiedOn: date('notified_on'),
    agreedAmount: numeric('agreed_amount', { precision: 18, scale: 2 }),
    /** projects.snag, when the charge came from a defect. */
    sourceSnagId: uuid('source_snag_id'),
    documentIds: jsonb('document_ids').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    ...timestamps(),
  },
  (t) => [
    unique('back_charge_uq').on(t.contractId, t.reference),
    index('back_charge_status_idx').on(t.tenantId, t.contractId, t.status),
  ],
);

/**
 * Correspondence that carries a deadline: RFIs, notices, EOT claims, NCRs.
 *
 * A small table that earns its place entirely through `responseDueOn`. Nearly
 * every entitlement lost on a construction contract is lost to a date nobody was
 * watching, and a register that can be queried for "what is due this week" is
 * worth more than most reporting.
 */
export const correspondence = contracts.table(
  'correspondence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    contractId: uuid('contract_id')
      .notNull()
      .references(() => contract.id, { onDelete: 'cascade' }),
    /** 'rfi' | 'notice' | 'eot_claim' | 'ncr' | 'instruction' | 'letter' */
    type: varchar('type', { length: 24 }).notNull(),
    reference: varchar('reference', { length: 64 }).notNull(),
    subject: text('subject').notNull(),
    direction: varchar('direction', { length: 16 }).notNull().default('outgoing'),

    issuedOn: date('issued_on').notNull(),
    responseDueOn: date('response_due_on'),
    respondedOn: date('responded_on'),
    /** 'open' | 'responded' | 'closed' | 'overdue' */
    status: varchar('status', { length: 16 }).notNull().default('open'),

    /** Set when this became a variation, so the paper trail is continuous. */
    variationId: uuid('variation_id').references(() => variation.id, { onDelete: 'set null' }),
    documentId: uuid('document_id'),
    /** True where missing the response deadline creates a contractual right. */
    isContractual: boolean('is_contractual').notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    unique('correspondence_uq').on(t.contractId, t.type, t.reference),
    index('correspondence_due_idx').on(t.tenantId, t.status, t.responseDueOn),
  ],
);

/**
 * The fit-out approval clock: a shop drawing, sample or method statement
 * submitted for review, and the cycle it goes through until the consultant
 * signs it off.
 *
 * Split into a register row and a revision history for the same reason a
 * payment application is split from its certificate: "approved" is an answer
 * to a specific submission, and a rejected drawing resubmitted as a new
 * revision is a different event from the same drawing being edited in place.
 * `submittal` carries where the ball sits NOW; `submittalRevision` carries
 * every cycle it took to get there.
 */
export const submittal = contracts.table(
  'submittal',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    contractId: uuid('contract_id')
      .notNull()
      .references(() => contract.id, { onDelete: 'cascade' }),
    number: varchar('number', { length: 48 }),
    numberPeriod: varchar('number_period', { length: 16 }),
    numberValue: integer('number_value'),
    title: text('title').notNull(),
    /** 'shop_drawing' | 'material_sample' | 'method_statement' | 'product_data' | 'mock_up' | 'other' */
    submittalType: varchar('submittal_type', { length: 24 }).notNull(),
    /** The spec section this answers, e.g. "09 40 00" — free text, not enforced. */
    specSection: varchar('spec_section', { length: 32 }),
    /** 'draft' | 'submitted' | 'under_review' | 'approved' | 'approved_as_noted' | 'revise_resubmit' | 'rejected' */
    status: varchar('status', { length: 24 }).notNull().default('draft'),
    /**
     * 'contractor' | 'consultant' — whose turn it is to act. The single fact
     * that makes this a register and not a folder of PDFs: it answers "what
     * is sitting on someone's desk right now" without opening a single row.
     */
    ballInCourt: varchar('ball_in_court', { length: 16 }).notNull().default('contractor'),
    currentRevision: integer('current_revision').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    unique('submittal_number_uq').on(t.tenantId, t.number),
    index('submittal_status_idx').on(t.tenantId, t.status, t.ballInCourt),
  ],
);

export const submittalRevision = contracts.table(
  'submittal_revision',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    submittalId: uuid('submittal_id')
      .notNull()
      .references(() => submittal.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    /** The actual file, in the kernel document register. Optional: a method
     *  statement submitted as prose in the comments needs no attachment. */
    documentId: uuid('document_id'),
    submittedOn: date('submitted_on').notNull(),
    /** When a decision is due on THIS revision — a fresh clock every resubmission. */
    dueOn: date('due_on'),
    reviewedOn: date('reviewed_on'),
    /** 'approved' | 'approved_as_noted' | 'revise_resubmit' | 'rejected'. Null until reviewed. */
    decision: varchar('decision', { length: 24 }),
    reviewComments: text('review_comments'),
    ...timestamps(),
  },
  (t) => [unique('submittal_revision_uq').on(t.submittalId, t.revision)],
);

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

export const CONTRACTS_TENANT_TABLES = [
  'contract',
  'contract_line',
  'variation',
  'variation_line',
  'payment_application',
  'payment_application_line',
  'retention_release',
  'back_charge',
  'correspondence',
  'submittal',
  'submittal_revision',
] as const;

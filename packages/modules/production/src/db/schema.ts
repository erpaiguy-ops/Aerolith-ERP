/**
 * Production — owns the `production` Postgres schema.
 *
 * Foreign keys point at `kernel.*` only. Production must NOT reference
 * Inventory's tables even though it obviously needs stock: material issue is
 * composed at the application layer, which may depend on both. That is the rule
 * that keeps either module sellable on its own, and it is checked in CI.
 *
 * Three things here are joinery-specific rather than generic MRP:
 *
 *  - The cutting plan is a first-class record, not a transient calculation. It
 *    is what the saw operator works from and what the offcut register was
 *    updated against, so it has to be reproducible months later.
 *  - FINISHING IS A BATCH PROCESS, not a unit process. Spray booth capacity and
 *    cure time are scheduling constraints; generic MRP models this badly and it
 *    is where joinery jobs actually lose days.
 *  - Every scan is kept. WIP position, machine utilisation, operator
 *    productivity and real labour cost are all derived from one barcode scan at
 *    each station rather than from anybody filling in a timesheet.
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

export const production = pgSchema('production');

const tenantColumn = () => uuid('tenant_id').notNull();
const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/** The stations a joinery part passes through, in rough order. */
export const workCentreType = production.enum('work_centre_type', [
  'beam_saw',
  'cnc',
  'edgebander',
  'drilling',
  'sanding',
  'spray_booth',
  'assembly',
  'quality',
  'packing',
  'other',
]);

export const workOrderStatus = production.enum('work_order_status', [
  'draft',
  'planned',
  'released',
  'in_progress',
  'on_hold',
  'completed',
  'cancelled',
]);

export const operationStatus = production.enum('operation_status', [
  'pending',
  'ready',
  'in_progress',
  'paused',
  'completed',
  'skipped',
]);

export const scanType = production.enum('scan_type', [
  'start',
  'complete',
  'pause',
  'resume',
  'reject',
  'rework',
]);

export const finishingStatus = production.enum('finishing_status', [
  'queued',
  'spraying',
  'curing',
  'completed',
  'rejected',
]);

// ---------------------------------------------------------------------------
// Work centres and routings
// ---------------------------------------------------------------------------

export const workCentre = production.table(
  'work_centre',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    code: varchar('code', { length: 16 }).notNull(),
    name: text('name').notNull(),
    type: workCentreType('type').notNull(),
    /** kernel.asset — the machine, once Asset Management exists. */
    assetId: uuid('asset_id'),

    /** Parallel stations of the same kind, e.g. two edgebanders. */
    capacityUnits: integer('capacity_units').notNull().default(1),
    /** Minutes lost changing over between jobs. Dominates small batches. */
    setupMinutes: numeric('setup_minutes', { precision: 8, scale: 2 }).notNull().default('0'),
    /** Minutes per unit once running. */
    runMinutesPerUnit: numeric('run_minutes_per_unit', { precision: 8, scale: 4 })
      .notNull()
      .default('0'),
    /** Machine + operator cost, for job costing. */
    costPerHour: numeric('cost_per_hour', { precision: 12, scale: 4 }),

    /** Shift pattern; drives finite-capacity scheduling. */
    workingMinutesPerDay: integer('working_minutes_per_day').notNull().default(480),
    /**
     * A batch station processes a whole load at once — a spray booth takes 40
     * doors in the time it takes one. Unit stations scale with quantity.
     */
    isBatchProcess: boolean('is_batch_process').notNull().default(false),
    batchCapacityUnits: integer('batch_capacity_units'),

    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('work_centre_code_uq').on(t.tenantId, t.code),
    index('work_centre_type_idx').on(t.tenantId, t.type, t.isActive),
  ],
);

/** A reusable sequence of operations — the standard route for a product type. */
export const routing = production.table(
  'routing',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    code: varchar('code', { length: 32 }).notNull(),
    name: text('name').notNull(),
    /** kernel.item — the product this route makes. Null for a generic route. */
    itemId: uuid('item_id'),
    description: text('description'),
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [unique('routing_code_uq').on(t.tenantId, t.code)],
);

export const routingOperation = production.table(
  'routing_operation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    routingId: uuid('routing_id')
      .notNull()
      .references(() => routing.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    name: text('name').notNull(),
    workCentreId: uuid('work_centre_id')
      .notNull()
      .references(() => workCentre.id, { onDelete: 'restrict' }),

    /** Overrides the work centre defaults when this operation is unusual. */
    setupMinutes: numeric('setup_minutes', { precision: 8, scale: 2 }),
    runMinutesPerUnit: numeric('run_minutes_per_unit', { precision: 8, scale: 4 }),
    /** Idle time the job must wait AFTER this operation — paint curing. */
    cureMinutes: integer('cure_minutes').notNull().default(0),

    /** A QC gate blocks the next operation until it passes. */
    isQualityGate: boolean('is_quality_gate').notNull().default(false),
    /** Operations sharing a sequence may run in any order. */
    instructions: text('instructions'),
    ...timestamps(),
  },
  (t) => [
    unique('routing_operation_uq').on(t.routingId, t.sequence),
    index('routing_operation_centre_idx').on(t.tenantId, t.workCentreId),
  ],
);

// ---------------------------------------------------------------------------
// Work orders
// ---------------------------------------------------------------------------

export const workOrder = production.table(
  'work_order',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    number: varchar('number', { length: 48 }),
    numberPeriod: varchar('number_period', { length: 16 }),
    numberValue: integer('number_value'),

    /** kernel.project — what job this is for. Drives job costing. */
    projectId: uuid('project_id'),
    /** kernel.item — what is being made. */
    itemId: uuid('item_id'),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull().default('1'),

    routingId: uuid('routing_id').references(() => routing.id),
    status: workOrderStatus('status').notNull().default('draft'),
    /** Lower runs first when work centres are contended. */
    priority: integer('priority').notNull().default(100),

    plannedStartDate: date('planned_start_date'),
    plannedEndDate: date('planned_end_date'),
    /** Derived from the first and last scan. */
    actualStartAt: timestamp('actual_start_at', { withTimezone: true }),
    actualEndAt: timestamp('actual_end_at', { withTimezone: true }),

    /**
     * Reference to a document in ANOTHER module (a sales order, a project
     * package). Deliberately not a foreign key — Production must work when
     * neither of those modules is installed.
     */
    sourceModule: varchar('source_module', { length: 64 }),
    sourceEntityType: varchar('source_entity_type', { length: 96 }),
    sourceEntityId: uuid('source_entity_id'),

    approvalInstanceId: uuid('approval_instance_id'),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releasedBy: uuid('released_by'),
    holdReason: text('hold_reason'),
    notes: text('notes'),
    createdBy: uuid('created_by'),
    ...timestamps(),
  },
  (t) => [
    unique('work_order_number_uq').on(t.tenantId, t.number),
    index('work_order_status_idx').on(t.tenantId, t.status, t.priority),
    index('work_order_project_idx').on(t.tenantId, t.projectId),
  ],
);

/**
 * A part the work order must produce — one row of the cutting list.
 *
 * This is what gets a barcode label, and what is scanned at each station.
 */
export const workOrderPart = production.table(
  'work_order_part',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    workOrderId: uuid('work_order_id')
      .notNull()
      .references(() => workOrder.id, { onDelete: 'cascade' }),
    partNumber: integer('part_number').notNull(),
    label: text('label').notNull(),
    /** kernel.item — the material to cut it from. */
    materialItemId: uuid('material_item_id').notNull(),

    lengthMm: numeric('length_mm', { precision: 12, scale: 2 }).notNull(),
    widthMm: numeric('width_mm', { precision: 12, scale: 2 }).notNull(),
    thicknessMm: numeric('thickness_mm', { precision: 12, scale: 2 }),
    quantity: integer('quantity').notNull().default(1),

    /** Which of the part's dimensions the grain must run along. */
    grainAlong: varchar('grain_along', { length: 8 }),
    /** Edge banding per edge, and the tape. Drives the edgebander schedule. */
    edgeBanding: jsonb('edge_banding').$type<Record<string, unknown>>(),
    /** Finish specification — colour, sheen, number of coats. */
    finishSpec: jsonb('finish_spec').$type<Record<string, unknown>>(),

    /** Scannable label stuck on the part at the saw. */
    barcode: varchar('barcode', { length: 64 }),
    /** Quantity completed, derived from scans at the final operation. */
    completedQuantity: integer('completed_quantity').notNull().default(0),
    rejectedQuantity: integer('rejected_quantity').notNull().default(0),
    notes: text('notes'),
    ...timestamps(),
  },
  (t) => [
    unique('work_order_part_uq').on(t.workOrderId, t.partNumber),
    unique('work_order_part_barcode_uq').on(t.tenantId, t.barcode),
    index('work_order_part_material_idx').on(t.tenantId, t.materialItemId),
  ],
);

/** The routing, instantiated for one work order. */
export const workOrderOperation = production.table(
  'work_order_operation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    workOrderId: uuid('work_order_id')
      .notNull()
      .references(() => workOrder.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    name: text('name').notNull(),
    workCentreId: uuid('work_centre_id')
      .notNull()
      .references(() => workCentre.id, { onDelete: 'restrict' }),

    status: operationStatus('status').notNull().default('pending'),
    /** Snapshotted from the routing so a later edit does not rewrite history. */
    setupMinutes: numeric('setup_minutes', { precision: 8, scale: 2 }).notNull().default('0'),
    runMinutesPerUnit: numeric('run_minutes_per_unit', { precision: 8, scale: 4 })
      .notNull()
      .default('0'),
    cureMinutes: integer('cure_minutes').notNull().default(0),
    isQualityGate: boolean('is_quality_gate').notNull().default(false),

    plannedMinutes: numeric('planned_minutes', { precision: 10, scale: 2 }),
    /** Summed from scans — the real labour and machine time. */
    actualMinutes: numeric('actual_minutes', { precision: 10, scale: 2 }).notNull().default('0'),
    completedQuantity: integer('completed_quantity').notNull().default(0),
    rejectedQuantity: integer('rejected_quantity').notNull().default(0),

    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    instructions: text('instructions'),
    ...timestamps(),
  },
  (t) => [
    unique('work_order_operation_uq').on(t.workOrderId, t.sequence),
    index('work_order_operation_queue_idx').on(t.tenantId, t.workCentreId, t.status),
  ],
);

/**
 * A barcode scan on the shop floor.
 *
 * Append-only and never edited: this is the source of truth for WIP position,
 * machine utilisation, operator productivity and real labour cost. Correcting a
 * mis-scan means adding a compensating scan, exactly as a ledger is corrected by
 * reversal rather than by rubbing out.
 */
export const productionScan = production.table(
  'production_scan',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    workOrderId: uuid('work_order_id')
      .notNull()
      .references(() => workOrder.id, { onDelete: 'cascade' }),
    operationId: uuid('operation_id')
      .notNull()
      .references(() => workOrderOperation.id, { onDelete: 'cascade' }),
    /** Null when the whole order is scanned rather than an individual part. */
    partId: uuid('part_id').references(() => workOrderPart.id, { onDelete: 'set null' }),

    type: scanType('type').notNull(),
    quantity: integer('quantity').notNull().default(1),
    /** kernel.app_user — who was at the station. */
    operatorId: uuid('operator_id'),
    workCentreId: uuid('work_centre_id').notNull(),

    scannedAt: timestamp('scanned_at', { withTimezone: true }).notNull().defaultNow(),
    /** Minutes attributed to this scan, computed from the preceding start. */
    durationMinutes: numeric('duration_minutes', { precision: 10, scale: 2 }),

    /** Set on reject and rework — why, so the QA report means something. */
    reasonCode: varchar('reason_code', { length: 32 }),
    notes: text('notes'),
    /** Scanned offline on the shop floor and replayed later. */
    isOffline: boolean('is_offline').notNull().default(false),
    deviceId: varchar('device_id', { length: 64 }),
  },
  (t) => [
    index('production_scan_operation_idx').on(t.tenantId, t.operationId, t.scannedAt),
    index('production_scan_operator_idx').on(t.tenantId, t.operatorId, t.scannedAt),
    index('production_scan_part_idx').on(t.tenantId, t.partId),
  ],
);

// ---------------------------------------------------------------------------
// Cutting plans
// ---------------------------------------------------------------------------

/**
 * A persisted cutlist result.
 *
 * Kept rather than recomputed because the optimiser plans against the offcut
 * rack AS IT WAS: rerun it tomorrow and it produces a different plan, having
 * consumed different remnants. The saw operator's drawing and the stock that was
 * committed must still agree months later.
 */
export const cuttingPlan = production.table(
  'cutting_plan',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    workOrderId: uuid('work_order_id')
      .notNull()
      .references(() => workOrder.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),

    /** The full plan as the engine returned it: boards, placements, remnants. */
    plan: jsonb('plan').$type<Record<string, unknown>>().notNull(),
    /** Options it was produced under, so it can be reproduced exactly. */
    options: jsonb('options').$type<Record<string, unknown>>().notNull().default({}),

    sheetsUsed: integer('sheets_used').notNull().default(0),
    offcutsUsed: integer('offcuts_used').notNull().default(0),
    grossYieldPercent: numeric('gross_yield_percent', { precision: 6, scale: 2 }),
    netYieldPercent: numeric('net_yield_percent', { precision: 6, scale: 2 }),
    materialCost: numeric('material_cost', { precision: 18, scale: 4 }),

    /** Offcut ids the plan committed. Recorded for traceability. */
    consumedOffcutIds: uuid('consumed_offcut_ids').array().default(sql`'{}'::uuid[]`),
    /** True once material has actually been issued against this plan. */
    isCommitted: boolean('is_committed').notNull().default(false),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    generatedBy: uuid('generated_by'),
    ...timestamps(),
  },
  (t) => [
    unique('cutting_plan_uq').on(t.workOrderId, t.version),
    index('cutting_plan_order_idx').on(t.tenantId, t.workOrderId),
  ],
);

// ---------------------------------------------------------------------------
// Finishing — the batch process generic MRP gets wrong
// ---------------------------------------------------------------------------

/**
 * A spray booth load.
 *
 * Finishing is a BATCH process: the booth takes a load of doors and the cure
 * clock then runs regardless of how many are in it. Scheduling it per unit — as
 * generic MRP does — either wildly over-estimates the time or ignores the cure
 * entirely, and cure time is where joinery jobs lose days.
 */
export const finishingBatch = production.table(
  'finishing_batch',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    number: varchar('number', { length: 48 }),
    workCentreId: uuid('work_centre_id')
      .notNull()
      .references(() => workCentre.id, { onDelete: 'restrict' }),
    status: finishingStatus('status').notNull().default('queued'),

    /** Everything in one load must share a finish — that is why it is a batch. */
    colourCode: varchar('colour_code', { length: 32 }),
    sheenCode: varchar('sheen_code', { length: 32 }),
    coatNumber: integer('coat_number').notNull().default(1),
    totalCoats: integer('total_coats').notNull().default(1),

    /** Cure is a scheduling constraint, not idle time to be optimised away. */
    cureMinutes: integer('cure_minutes').notNull().default(0),
    sprayedAt: timestamp('sprayed_at', { withTimezone: true }),
    cureCompletesAt: timestamp('cure_completes_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),

    /** Humidity or temperature outside spec forces a hold. */
    isOnHold: boolean('is_on_hold').notNull().default(false),
    holdReason: text('hold_reason'),
    conditions: jsonb('conditions').$type<Record<string, unknown>>().notNull().default({}),
    operatorId: uuid('operator_id'),
    notes: text('notes'),
    ...timestamps(),
  },
  (t) => [
    unique('finishing_batch_number_uq').on(t.tenantId, t.number),
    index('finishing_batch_status_idx').on(t.tenantId, t.status, t.cureCompletesAt),
  ],
);

/** Which parts are in a spray load. */
export const finishingBatchPart = production.table(
  'finishing_batch_part',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => finishingBatch.id, { onDelete: 'cascade' }),
    partId: uuid('part_id')
      .notNull()
      .references(() => workOrderPart.id, { onDelete: 'cascade' }),
    quantity: integer('quantity').notNull().default(1),
    /** Rework goes back through the booth; the count matters for costing. */
    isRework: boolean('is_rework').notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    unique('finishing_batch_part_uq').on(t.batchId, t.partId),
    index('finishing_batch_part_part_idx').on(t.tenantId, t.partId),
  ],
);

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

/** Every table in this schema is tenant-scoped. Used to build the RLS policies. */
export const PRODUCTION_TENANT_TABLES = [
  'work_centre',
  'routing',
  'routing_operation',
  'work_order',
  'work_order_part',
  'work_order_operation',
  'production_scan',
  'cutting_plan',
  'finishing_batch',
  'finishing_batch_part',
] as const;

/** Scans are never edited — corrections are compensating scans. */
export const PRODUCTION_APPEND_ONLY_TABLES = new Set(['production_scan']);

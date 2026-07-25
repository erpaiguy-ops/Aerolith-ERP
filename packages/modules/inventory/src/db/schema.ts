/**
 * Inventory — owns the `inventory` Postgres schema.
 *
 * Foreign keys point at `kernel.*` (item, party, project) and never at another
 * module. That is the rule that keeps this module extractable, and it is checked
 * in CI.
 *
 * Two things here are joinery-specific rather than generic ERP:
 *
 *  - Sheet goods are tracked by DIMENSION, not only by count. The same board is
 *    bought per sheet, consumed per square metre and cut to a part list.
 *  - The OFFCUT REGISTER. Usable remnants go back into stock with their real
 *    dimensions so the cutlist optimiser can consume them. In a joinery factory
 *    that is recovered money, and no generic ERP models it.
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

export const inventory = pgSchema('inventory');

const tenantColumn = () => uuid('tenant_id').notNull();
const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export const warehouseType = inventory.enum('warehouse_type', [
  'factory',
  'site',
  'yard',
  'transit',
  'virtual',
]);

export const movementType = inventory.enum('movement_type', [
  'receipt', // goods in from a supplier
  'issue', // out to a job
  'transfer', // between locations
  'adjustment', // stock count variance
  'return', // back from a job or to a supplier
  'scrap', // written off
  'production_output', // finished goods from a work order
]);

export const movementStatus = inventory.enum('movement_status', [
  'draft',
  'pending_approval',
  'posted',
  'cancelled',
]);

export const offcutStatus = inventory.enum('offcut_status', [
  'available',
  'reserved',
  'consumed',
  'scrapped',
]);

export const countStatus = inventory.enum('count_status', [
  'draft',
  'counting',
  'pending_approval',
  'posted',
  'cancelled',
]);

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export const warehouse = inventory.table(
  'warehouse',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    /** kernel.legal_entity — which operating company owns this stock. */
    legalEntityId: uuid('legal_entity_id'),
    code: varchar('code', { length: 16 }).notNull(),
    name: text('name').notNull(),
    type: warehouseType('type').notNull().default('factory'),
    /** Site stores belong to a project; factory stores do not. */
    projectId: uuid('project_id'),
    address: jsonb('address').$type<Record<string, string>>().notNull().default({}),
    managerId: uuid('manager_id'),
    /** Blocks issues without blocking receipts — used when closing a site. */
    isIssueBlocked: boolean('is_issue_blocked').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('warehouse_code_uq').on(t.tenantId, t.code),
    index('warehouse_active_idx').on(t.tenantId, t.isActive),
  ],
);

export const storageBin = inventory.table(
  'storage_bin',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouse.id, { onDelete: 'restrict' }),
    parentId: uuid('parent_id'),
    code: varchar('code', { length: 32 }).notNull(),
    name: text('name'),
    /** Printed on the shelf label and scanned on every movement. */
    barcode: varchar('barcode', { length: 64 }),
    /** Racking for boards is dimension-limited, not weight-limited. */
    maxLengthMm: numeric('max_length_mm', { precision: 12, scale: 2 }),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('storage_bin_uq').on(t.tenantId, t.warehouseId, t.code),
    index('storage_bin_barcode_idx').on(t.tenantId, t.barcode),
  ],
);

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

/**
 * A delivery of material that must stay together.
 *
 * Grain and colour are the reason this matters in joinery: veneer and laminate
 * vary between production batches, and a run finished from two batches is a
 * visible defect and a rejected installation.
 */
export const batch = inventory.table(
  'batch',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    /** kernel.item */
    itemId: uuid('item_id').notNull(),
    code: varchar('code', { length: 48 }).notNull(),
    supplierBatchRef: varchar('supplier_batch_ref', { length: 64 }),
    /** kernel.party */
    supplierId: uuid('supplier_id'),
    grainCode: varchar('grain_code', { length: 32 }),
    colourCode: varchar('colour_code', { length: 32 }),
    receivedOn: date('received_on'),
    expiresOn: date('expires_on'),
    notes: text('notes'),
    ...timestamps(),
  },
  (t) => [
    unique('batch_code_uq').on(t.tenantId, t.itemId, t.code),
    index('batch_item_idx').on(t.tenantId, t.itemId),
  ],
);

// ---------------------------------------------------------------------------
// Stock levels
// ---------------------------------------------------------------------------

/**
 * Quantity on hand at one location.
 *
 * `availableQuantity` is generated, not maintained: computing it in the database
 * makes "available" impossible to get out of step with quantity and reservation,
 * which is a classic source of overselling.
 *
 * `averageCost` is the moving-average unit cost. See domain/costing.ts.
 */
export const stockLevel = inventory.table(
  'stock_level',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    itemId: uuid('item_id').notNull(),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouse.id, { onDelete: 'restrict' }),
    binId: uuid('bin_id').references(() => storageBin.id, { onDelete: 'set null' }),
    batchId: uuid('batch_id').references(() => batch.id, { onDelete: 'restrict' }),

    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull().default('0'),
    reservedQuantity: numeric('reserved_quantity', { precision: 18, scale: 4 })
      .notNull()
      .default('0'),
    availableQuantity: numeric('available_quantity', { precision: 18, scale: 4 }).generatedAlwaysAs(
      sql`quantity - reserved_quantity`,
    ),

    averageCost: numeric('average_cost', { precision: 18, scale: 6 }).notNull().default('0'),
    lastMovementAt: timestamp('last_movement_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    // NULLS NOT DISTINCT is essential here: bin and batch are nullable, and by
    // default Postgres treats NULL as distinct from NULL, so the plain unique
    // constraint would happily allow two "no bin, no batch" rows for the same
    // item — silently splitting the stock figure in two.
    unique('stock_level_uq')
      .on(t.tenantId, t.itemId, t.warehouseId, t.binId, t.batchId)
      .nullsNotDistinct(),
    index('stock_level_item_idx').on(t.tenantId, t.itemId),
    index('stock_level_warehouse_idx').on(t.tenantId, t.warehouseId),
  ],
);

// ---------------------------------------------------------------------------
// Movements
// ---------------------------------------------------------------------------

export const stockMovement = inventory.table(
  'stock_movement',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    /** Allocated from a kernel number series when the movement is posted. */
    number: varchar('number', { length: 48 }),
    numberPeriod: varchar('number_period', { length: 16 }),
    numberValue: integer('number_value'),

    type: movementType('type').notNull(),
    status: movementStatus('status').notNull().default('draft'),
    movementDate: date('movement_date').notNull(),

    /** kernel.project — what the material was issued to. */
    projectId: uuid('project_id'),
    /** kernel.party — supplier on a receipt, customer on a return. */
    partyId: uuid('party_id'),
    /** kernel.cost_code — where the cost lands for job costing. */
    costCodeId: uuid('cost_code_id'),

    /**
     * Free reference to a document in ANOTHER module (a purchase order, a work
     * order). Deliberately not a foreign key: Inventory must not depend on
     * Procurement or Production, and must work when neither is installed.
     */
    sourceModule: varchar('source_module', { length: 64 }),
    sourceEntityType: varchar('source_entity_type', { length: 96 }),
    sourceEntityId: uuid('source_entity_id'),
    reference: varchar('reference', { length: 96 }),

    notes: text('notes'),
    /** kernel.approval_instance, set when the movement needs sign-off. */
    approvalInstanceId: uuid('approval_instance_id'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by'),
    /** Set on the reversal, pointing at what it reverses. */
    reversesMovementId: uuid('reverses_movement_id'),
    cancelledReason: text('cancelled_reason'),

    createdBy: uuid('created_by'),
    ...timestamps(),
  },
  (t) => [
    unique('stock_movement_number_uq').on(t.tenantId, t.number),
    index('stock_movement_status_idx').on(t.tenantId, t.status, t.movementDate),
    index('stock_movement_project_idx').on(t.tenantId, t.projectId),
    index('stock_movement_source_idx').on(t.tenantId, t.sourceEntityType, t.sourceEntityId),
  ],
);

export const stockMovementLine = inventory.table(
  'stock_movement_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    movementId: uuid('movement_id')
      .notNull()
      .references(() => stockMovement.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),

    itemId: uuid('item_id').notNull(),
    batchId: uuid('batch_id').references(() => batch.id, { onDelete: 'restrict' }),

    fromWarehouseId: uuid('from_warehouse_id').references(() => warehouse.id),
    fromBinId: uuid('from_bin_id').references(() => storageBin.id),
    toWarehouseId: uuid('to_warehouse_id').references(() => warehouse.id),
    toBinId: uuid('to_bin_id').references(() => storageBin.id),

    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull(),
    /** kernel.unit_of_measure — the UoM the line was entered in. */
    uomId: uuid('uom_id'),
    /** Quantity converted to the item's stock UoM. What actually moves. */
    stockQuantity: numeric('stock_quantity', { precision: 18, scale: 4 }).notNull(),

    unitCost: numeric('unit_cost', { precision: 18, scale: 6 }),
    totalCost: numeric('total_cost', { precision: 18, scale: 4 }),

    /** Set when this line consumed an offcut rather than a full sheet. */
    offcutId: uuid('offcut_id'),
    notes: text('notes'),
    ...timestamps(),
  },
  (t) => [
    unique('stock_movement_line_uq').on(t.movementId, t.lineNumber),
    index('stock_movement_line_item_idx').on(t.tenantId, t.itemId),
  ],
);

// ---------------------------------------------------------------------------
// Offcut register — the joinery-specific piece
// ---------------------------------------------------------------------------

/**
 * A usable remnant of sheet material.
 *
 * Tracked by real dimensions rather than as a quantity of the parent item,
 * because "0.4 sheets of 18mm MDF" cannot be cut from and is worthless to the
 * optimiser, whereas "a 1200 x 600 piece with the grain running long" can be
 * matched against a required part.
 *
 * `areaSqm` is generated so it cannot drift from the dimensions.
 */
export const offcut = inventory.table(
  'offcut',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    /** The parent sheet item this was cut from — kernel.item. */
    itemId: uuid('item_id').notNull(),
    batchId: uuid('batch_id').references(() => batch.id, { onDelete: 'set null' }),
    /** Scannable label stuck on the piece when it leaves the saw. */
    barcode: varchar('barcode', { length: 64 }).notNull(),

    lengthMm: numeric('length_mm', { precision: 12, scale: 2 }).notNull(),
    widthMm: numeric('width_mm', { precision: 12, scale: 2 }).notNull(),
    thicknessMm: numeric('thickness_mm', { precision: 12, scale: 2 }),
    areaSqm: numeric('area_sqm', { precision: 12, scale: 4 }).generatedAlwaysAs(
      sql`round((length_mm * width_mm) / 1000000.0, 4)`,
    ),

    /**
     * Which dimension the grain runs along. A part needing long grain cannot be
     * cut across it, so the optimiser must know.
     */
    grainDirection: varchar('grain_direction', { length: 8 }), // 'length' | 'width' | null
    grainCode: varchar('grain_code', { length: 32 }),
    colourCode: varchar('colour_code', { length: 32 }),
    /** Edges already banded, so the optimiser does not re-band them. */
    finishedEdges: integer('finished_edges').notNull().default(0),

    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouse.id, { onDelete: 'restrict' }),
    binId: uuid('bin_id').references(() => storageBin.id, { onDelete: 'set null' }),

    status: offcutStatus('status').notNull().default('available'),
    /** Cost carried over from the parent sheet, apportioned by area. */
    unitCost: numeric('unit_cost', { precision: 18, scale: 6 }),

    /** Where it came from, and what consumed it. */
    sourceMovementId: uuid('source_movement_id').references(() => stockMovement.id),
    sourceProjectId: uuid('source_project_id'),
    consumedByMovementId: uuid('consumed_by_movement_id').references(() => stockMovement.id),
    reservedForProjectId: uuid('reserved_for_project_id'),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    scrappedReason: text('scrapped_reason'),
    ...timestamps(),
  },
  (t) => [
    unique('offcut_barcode_uq').on(t.tenantId, t.barcode),
    // The optimiser's lookup: available pieces of this material, largest first.
    index('offcut_search_idx').on(t.tenantId, t.itemId, t.status, t.areaSqm),
    index('offcut_warehouse_idx').on(t.tenantId, t.warehouseId, t.status),
  ],
);

// ---------------------------------------------------------------------------
// Stock counts
// ---------------------------------------------------------------------------

export const stockCount = inventory.table(
  'stock_count',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    number: varchar('number', { length: 48 }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouse.id, { onDelete: 'restrict' }),
    status: countStatus('status').notNull().default('draft'),
    countDate: date('count_date').notNull(),
    /** Null for a full count; set for a cycle count of one category. */
    itemCategoryId: uuid('item_category_id'),
    countedBy: uuid('counted_by'),
    approvalInstanceId: uuid('approval_instance_id'),
    /** The adjustment raised when the count was posted. */
    adjustmentMovementId: uuid('adjustment_movement_id').references(() => stockMovement.id),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    notes: text('notes'),
    ...timestamps(),
  },
  (t) => [
    unique('stock_count_number_uq').on(t.tenantId, t.number),
    index('stock_count_status_idx').on(t.tenantId, t.status, t.countDate),
  ],
);

export const stockCountLine = inventory.table(
  'stock_count_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    countId: uuid('count_id')
      .notNull()
      .references(() => stockCount.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id').notNull(),
    binId: uuid('bin_id').references(() => storageBin.id),
    batchId: uuid('batch_id').references(() => batch.id),

    /** Frozen when the count sheet was generated, so the variance is meaningful. */
    systemQuantity: numeric('system_quantity', { precision: 18, scale: 4 }).notNull(),
    countedQuantity: numeric('counted_quantity', { precision: 18, scale: 4 }),
    variance: numeric('variance', { precision: 18, scale: 4 }).generatedAlwaysAs(
      sql`counted_quantity - system_quantity`,
    ),
    varianceReason: text('variance_reason'),
    countedAt: timestamp('counted_at', { withTimezone: true }),
    countedBy: uuid('counted_by'),
    ...timestamps(),
  },
  (t) => [
    unique('stock_count_line_uq')
      .on(t.countId, t.itemId, t.binId, t.batchId)
      .nullsNotDistinct(),
    index('stock_count_line_count_idx').on(t.tenantId, t.countId),
  ],
);

// ---------------------------------------------------------------------------
// Replenishment
// ---------------------------------------------------------------------------

/**
 * Reorder levels. Breaching one emits an event; if Procurement is installed it
 * raises a requisition, and if it is not, nothing breaks.
 */
export const reorderRule = inventory.table(
  'reorder_rule',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    itemId: uuid('item_id').notNull(),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouse.id, { onDelete: 'cascade' }),
    minimumQuantity: numeric('minimum_quantity', { precision: 18, scale: 4 }).notNull(),
    reorderQuantity: numeric('reorder_quantity', { precision: 18, scale: 4 }).notNull(),
    maximumQuantity: numeric('maximum_quantity', { precision: 18, scale: 4 }),
    leadTimeDays: integer('lead_time_days').notNull().default(14),
    preferredSupplierId: uuid('preferred_supplier_id'),
    /** Debounces the alert so one item does not notify on every issue. */
    lastTriggeredAt: timestamp('last_triggered_at', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('reorder_rule_uq').on(t.tenantId, t.itemId, t.warehouseId),
    index('reorder_rule_active_idx').on(t.tenantId, t.isActive),
  ],
);

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

/** Every table in this schema is tenant-scoped. Used to build the RLS policies. */
export const INVENTORY_TENANT_TABLES = [
  'warehouse',
  'storage_bin',
  'batch',
  'stock_level',
  'stock_movement',
  'stock_movement_line',
  'offcut',
  'stock_count',
  'stock_count_line',
  'reorder_rule',
] as const;

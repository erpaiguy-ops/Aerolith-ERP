/**
 * Procurement — owns the `procurement` Postgres schema.
 *
 * Foreign keys point at `kernel.*` only: the supplier is a `kernel.party`, the
 * material is a `kernel.item`, the job is a `kernel.project`. So this module
 * runs on its own — a firm that wants nothing but requisitions, quote
 * comparison and three-way matching gets exactly that — and composes with
 * Inventory and Projects at the application layer when those are entitled.
 *
 * The design commitments, each of which is a thing that goes wrong when it is
 * done the obvious way instead:
 *
 *  - **Cumulative quantities live on the order line.** `quantity_received` and
 *    `quantity_invoiced` are caches maintained on `purchase_order_line`, not
 *    re-derived from receipts and invoices on every match. Three-way matching
 *    reads them on the hot path, and the correctness argument for the cache is
 *    that both writers sit in the same transaction as the row they update.
 *
 *  - **The awarded quote is snapshotted onto the order.** Unit price, currency
 *    and the exchange rate USED FOR THE DECISION are copied to the PO line. A
 *    supplier who revises their quote next month must not silently restate an
 *    order that has already been placed and part-received — the same discipline
 *    as contract terms, rate build-ups and approval workflow versions.
 *
 *  - **The comparison is stored, not just the winner.** `quote.landed_cost` and
 *    the rate behind it are persisted so an award can be explained a year later
 *    to somebody who asks why the dearer supplier won. An award with no
 *    recorded reasoning is indistinguishable from a favour.
 *
 *  - **Exceptions are rows, not a boolean.** `match_exception` records what was
 *    held, how much was at stake, who released it and why. "Invoice on hold" as
 *    a flag loses the only part anybody later needs.
 *
 *  - **Receipt lines are append-only.** A goods receipt is a physical event that
 *    moved stock. Correcting one is a return or a credit, never an edit, and the
 *    database enforces that rather than trusting everyone to remember.
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

export const procurement = pgSchema('procurement');

const tenantColumn = () => uuid('tenant_id').notNull();
const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export const requisitionStatus = procurement.enum('requisition_status', [
  'draft',
  'pending_approval',
  'approved',
  'sourcing',
  'ordered',
  'cancelled',
  'rejected',
]);

export const rfqStatus = procurement.enum('rfq_status', [
  'draft',
  'issued',
  'closed',
  'awarded',
  'cancelled',
]);

export const quoteStatus = procurement.enum('quote_status', [
  'awaited',
  'received',
  'declined',
  'shortlisted',
  'awarded',
  'lost',
  'expired',
]);

export const purchaseOrderStatus = procurement.enum('purchase_order_status', [
  'draft',
  'pending_approval',
  'approved',
  'issued',
  'partially_received',
  'received',
  'closed',
  'cancelled',
]);

export const invoiceStatus = procurement.enum('supplier_invoice_status', [
  'received',
  'matched',
  'on_hold',
  'approved',
  'posted',
  'paid',
  'disputed',
  'cancelled',
]);

/** Mirrors `ExceptionCode` in domain/matching.ts. Kept in step by a test. */
export const exceptionCode = procurement.enum('match_exception_code', [
  'over_invoiced_quantity',
  'no_receipt',
  'price_variance',
  'unmatched_line',
  'over_receipt',
]);

// ---------------------------------------------------------------------------
// Requisition — internal demand
// ---------------------------------------------------------------------------

/**
 * A request to buy something, raised by whoever needs it.
 *
 * Deliberately separate from the purchase order: the person who needs 40 sheets
 * of MDF is not the person who decides which supplier gets the work, and
 * collapsing the two is how a business ends up with fourteen people each holding
 * a supplier relationship. It also gives the approval a natural home — the spend
 * is approved before anyone is committed to it, which is the only moment
 * approval is worth anything.
 */
export const requisition = procurement.table(
  'requisition',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    number: varchar('number', { length: 48 }),
    numberPeriod: varchar('number_period', { length: 16 }),
    numberValue: integer('number_value'),

    title: text('title').notNull(),
    status: requisitionStatus('status').notNull().default('draft'),
    /** kernel.project — what the spend is for. Null for overheads and stock. */
    projectId: uuid('project_id'),
    /** kernel.cost_centre, for spend that belongs to a department not a job. */
    costCentreId: uuid('cost_centre_id'),

    /** When the site actually needs it, as opposed to when it was asked for. */
    requiredBy: date('required_by'),
    /** 'routine' | 'urgent' | 'emergency' — drives who has to approve it. */
    priority: varchar('priority', { length: 16 }).notNull().default('routine'),
    justification: text('justification'),

    /** Cached line total in the tenant's base currency. Drives the threshold. */
    estimatedValue: numeric('estimated_value', { precision: 18, scale: 2 })
      .notNull()
      .default('0'),

    /**
     * estimation.estimate — where a BOM-driven requisition came from.
     * Closes the loop the Estimation module opens: a priced build-up produces a
     * material demand, and this is its consumer.
     */
    sourceEstimateId: uuid('source_estimate_id'),
    sourceWorkOrderId: uuid('source_work_order_id'),

    approvalInstanceId: uuid('approval_instance_id'),
    requestedBy: uuid('requested_by'),
    approvedBy: uuid('approved_by'),
    approvedOn: timestamp('approved_on', { withTimezone: true }),
    rejectedReason: text('rejected_reason'),
    ...timestamps(),
  },
  (t) => [
    unique('requisition_number_uq').on(t.tenantId, t.number),
    index('requisition_status_idx').on(t.tenantId, t.status, t.requiredBy),
    index('requisition_project_idx').on(t.tenantId, t.projectId),
  ],
);

export const requisitionLine = procurement.table(
  'requisition_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    requisitionId: uuid('requisition_id')
      .notNull()
      .references(() => requisition.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),

    /** kernel.item. Null for a free-text request — which is most of them. */
    itemId: uuid('item_id'),
    description: text('description').notNull(),
    specification: text('specification'),
    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull(),
    uomCode: varchar('uom_code', { length: 16 }),
    /** The requester's guess, or the last price paid. Not a commitment. */
    estimatedUnitPrice: numeric('estimated_unit_price', { precision: 18, scale: 4 }),

    /** projects.wbs_node — which part of the job the cost lands on. */
    wbsNodeId: uuid('wbs_node_id'),
    /** Cumulative quantity placed on purchase orders. Guards double-ordering. */
    quantityOrdered: numeric('quantity_ordered', { precision: 18, scale: 4 })
      .notNull()
      .default('0'),
    ...timestamps(),
  },
  (t) => [
    unique('requisition_line_uq').on(t.requisitionId, t.lineNumber),
    index('requisition_line_item_idx').on(t.tenantId, t.itemId),
  ],
);

// ---------------------------------------------------------------------------
// RFQ and quotes
// ---------------------------------------------------------------------------

export const rfq = procurement.table(
  'rfq',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    number: varchar('number', { length: 48 }),
    numberPeriod: varchar('number_period', { length: 16 }),
    numberValue: integer('number_value'),

    title: text('title').notNull(),
    status: rfqStatus('status').notNull().default('draft'),
    projectId: uuid('project_id'),

    issuedOn: date('issued_on'),
    /** After this, a quote is late. Recorded because it is usually ignored. */
    responseDueOn: date('response_due_on'),
    /** Base currency the comparison is expressed in. */
    currencyCode: varchar('currency_code', { length: 3 }),

    /**
     * Whether surplus forced by a minimum order quantity retains value.
     *
     * A buyer-supplied fact the comparison cannot infer: the same 60 spare
     * sheets are an asset in 18mm MDF and a write-off in a bespoke colour.
     */
    surplusIsStock: boolean('surplus_is_stock').notNull().default(true),
    /** Snapshotted from the rule so an old comparison still reproduces. */
    costOfCapitalPercent: numeric('cost_of_capital_percent', { precision: 6, scale: 3 }),

    /** Why the winner won, in the buyer's words. Required to award off-lowest. */
    awardRationale: text('award_rationale'),
    awardedOn: date('awarded_on'),
    createdBy: uuid('created_by'),
    ...timestamps(),
  },
  (t) => [
    unique('rfq_number_uq').on(t.tenantId, t.number),
    index('rfq_status_idx').on(t.tenantId, t.status, t.responseDueOn),
  ],
);

/**
 * The consolidated demand being quoted.
 *
 * Its own table rather than a view over requisition lines: an RFQ routinely
 * merges the same material from four jobs into one line to get a better price,
 * and it must keep the link back to every requisition line it covers.
 */
export const rfqLine = procurement.table(
  'rfq_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    rfqId: uuid('rfq_id')
      .notNull()
      .references(() => rfq.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),

    itemId: uuid('item_id'),
    description: text('description').notNull(),
    specification: text('specification'),
    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull(),
    uomCode: varchar('uom_code', { length: 16 }),

    /** Requisition lines rolled into this one. */
    requisitionLineIds: jsonb('requisition_line_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    ...timestamps(),
  },
  (t) => [unique('rfq_line_uq').on(t.rfqId, t.lineNumber)],
);

/**
 * A supplier's response, priced and comparable.
 *
 * The landed-cost figures are STORED rather than recomputed on demand, together
 * with the exchange rate and cost of capital that produced them. Recomputing
 * would silently restate a past award every time a rate moved, which turns the
 * audit trail into fiction.
 */
export const quote = procurement.table(
  'quote',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    rfqId: uuid('rfq_id')
      .notNull()
      .references(() => rfq.id, { onDelete: 'cascade' }),
    /** kernel.party — the supplier. */
    supplierId: uuid('supplier_id').notNull(),
    status: quoteStatus('status').notNull().default('awaited'),

    /** The supplier's own quotation reference, quoted back on the order. */
    reference: varchar('reference', { length: 64 }),
    receivedOn: date('received_on'),
    validUntil: date('valid_until'),
    declinedReason: text('declined_reason'),

    currencyCode: varchar('currency_code', { length: 3 }),
    /** The rate used FOR THIS DECISION. Not a lookup — a record. */
    exchangeRate: numeric('exchange_rate', { precision: 18, scale: 8 })
      .notNull()
      .default('1'),

    freight: numeric('freight', { precision: 18, scale: 2 }).notNull().default('0'),
    dutyPercent: numeric('duty_percent', { precision: 6, scale: 3 }).notNull().default('0'),
    otherCharges: numeric('other_charges', { precision: 18, scale: 2 }).notNull().default('0'),
    paymentTermDays: integer('payment_term_days').notNull().default(0),
    earlyPaymentDiscountPercent: numeric('early_payment_discount_percent', {
      precision: 6,
      scale: 3,
    }),
    earlyPaymentDays: integer('early_payment_days'),
    leadTimeDays: integer('lead_time_days'),

    /** Comparison output, in base currency. Explains the award after the fact. */
    landedCost: numeric('landed_cost', { precision: 18, scale: 2 }),
    effectiveUnitCost: numeric('effective_unit_cost', { precision: 18, scale: 4 }),
    /** Zero for the cheapest. What an off-lowest award actually cost. */
    premiumOverBest: numeric('premium_over_best', { precision: 18, scale: 2 }),
    comparedAt: timestamp('compared_at', { withTimezone: true }),

    notes: text('notes'),
    /** kernel.document — the supplier's PDF, as received. */
    documentId: uuid('document_id'),
    ...timestamps(),
  },
  (t) => [
    unique('quote_supplier_uq').on(t.rfqId, t.supplierId),
    index('quote_status_idx').on(t.tenantId, t.status),
    index('quote_supplier_idx').on(t.tenantId, t.supplierId),
  ],
);

export const quoteLine = procurement.table(
  'quote_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    quoteId: uuid('quote_id')
      .notNull()
      .references(() => quote.id, { onDelete: 'cascade' }),
    rfqLineId: uuid('rfq_line_id').references(() => rfqLine.id, { onDelete: 'set null' }),
    lineNumber: integer('line_number').notNull(),

    description: text('description').notNull(),
    /** What the supplier will actually supply, when it is not what was asked. */
    offeredAlternative: text('offered_alternative'),
    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull(),
    uomCode: varchar('uom_code', { length: 16 }),
    unitPrice: numeric('unit_price', { precision: 18, scale: 4 }).notNull(),

    minimumOrderQuantity: numeric('minimum_order_quantity', { precision: 18, scale: 4 }),
    orderIncrement: numeric('order_increment', { precision: 18, scale: 4 }),
    leadTimeDays: integer('lead_time_days'),
    ...timestamps(),
  },
  (t) => [unique('quote_line_uq').on(t.quoteId, t.lineNumber)],
);

// ---------------------------------------------------------------------------
// Purchase order
// ---------------------------------------------------------------------------

export const purchaseOrder = procurement.table(
  'purchase_order',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    number: varchar('number', { length: 48 }),
    numberPeriod: varchar('number_period', { length: 16 }),
    numberValue: integer('number_value'),

    supplierId: uuid('supplier_id').notNull(),
    status: purchaseOrderStatus('status').notNull().default('draft'),
    projectId: uuid('project_id'),
    costCentreId: uuid('cost_centre_id'),

    /** The quote this order was awarded from. The thread back to the decision. */
    sourceQuoteId: uuid('source_quote_id').references(() => quote.id, { onDelete: 'set null' }),
    sourceRfqId: uuid('source_rfq_id').references(() => rfq.id, { onDelete: 'set null' }),

    currencyCode: varchar('currency_code', { length: 3 }),
    /** Snapshotted at award. The order does not re-rate itself later. */
    exchangeRate: numeric('exchange_rate', { precision: 18, scale: 8 }).notNull().default('1'),

    /** Goods only, in order currency. Charges are separate so tax can differ. */
    netValue: numeric('net_value', { precision: 18, scale: 2 }).notNull().default('0'),
    freight: numeric('freight', { precision: 18, scale: 2 }).notNull().default('0'),
    otherCharges: numeric('other_charges', { precision: 18, scale: 2 }).notNull().default('0'),
    taxAmount: numeric('tax_amount', { precision: 18, scale: 2 }).notNull().default('0'),
    grossValue: numeric('gross_value', { precision: 18, scale: 2 }).notNull().default('0'),
    /** Gross in base currency. What Projects holds as the commitment. */
    baseValue: numeric('base_value', { precision: 18, scale: 2 }).notNull().default('0'),

    paymentTermDays: integer('payment_term_days'),
    /** Snapshotted from the country pack, like every other commercial term. */
    taxCode: varchar('tax_code', { length: 32 }),
    incoterm: varchar('incoterm', { length: 16 }),
    deliveryAddress: text('delivery_address'),
    promisedDeliveryDate: date('promised_delivery_date'),

    /**
     * projects.commitment — set when the order was registered against a budget.
     * Null when there is no project or Projects is not entitled, which is what
     * lets this module stand alone.
     */
    commitmentId: uuid('commitment_id'),

    issuedOn: date('issued_on'),
    closedOn: date('closed_on'),
    cancelledReason: text('cancelled_reason'),
    approvalInstanceId: uuid('approval_instance_id'),
    documentId: uuid('document_id'),
    notes: text('notes'),
    createdBy: uuid('created_by'),
    ...timestamps(),
  },
  (t) => [
    unique('purchase_order_number_uq').on(t.tenantId, t.number),
    index('purchase_order_supplier_idx').on(t.tenantId, t.supplierId, t.status),
    index('purchase_order_project_idx').on(t.tenantId, t.projectId),
    index('purchase_order_status_idx').on(t.tenantId, t.status, t.promisedDeliveryDate),
  ],
);

/**
 * An ordered line, and the running totals three-way matching depends on.
 *
 * `quantityReceived` and `quantityInvoiced` are cumulative across every receipt
 * and every matched invoice. They are the entire defence against a supplier
 * billing the same delivery twice: an invoice is checked against received minus
 * invoiced, so the second copy of the same invoice has nothing left to bill.
 */
export const purchaseOrderLine = procurement.table(
  'purchase_order_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references(() => purchaseOrder.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),

    itemId: uuid('item_id'),
    description: text('description').notNull(),
    specification: text('specification'),
    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull(),
    uomCode: varchar('uom_code', { length: 16 }),
    unitPrice: numeric('unit_price', { precision: 18, scale: 4 }).notNull(),
    lineValue: numeric('line_value', { precision: 18, scale: 2 }).notNull().default('0'),
    taxPercent: numeric('tax_percent', { precision: 6, scale: 3 }),

    /** Cumulative. See the note above — these two do the real work. */
    quantityReceived: numeric('quantity_received', { precision: 18, scale: 4 })
      .notNull()
      .default('0'),
    quantityInvoiced: numeric('quantity_invoiced', { precision: 18, scale: 4 })
      .notNull()
      .default('0'),

    /** Where the material goes and what it is for. */
    warehouseId: uuid('warehouse_id'),
    wbsNodeId: uuid('wbs_node_id'),
    requisitionLineId: uuid('requisition_line_id').references(() => requisitionLine.id, {
      onDelete: 'set null',
    }),
    quoteLineId: uuid('quote_line_id').references(() => quoteLine.id, { onDelete: 'set null' }),
    promisedDeliveryDate: date('promised_delivery_date'),
    ...timestamps(),
  },
  (t) => [
    unique('purchase_order_line_uq').on(t.purchaseOrderId, t.lineNumber),
    index('purchase_order_line_item_idx').on(t.tenantId, t.itemId),
    index('purchase_order_line_wbs_idx').on(t.tenantId, t.wbsNodeId),
  ],
);

// ---------------------------------------------------------------------------
// Goods receipt
// ---------------------------------------------------------------------------

export const goodsReceipt = procurement.table(
  'goods_receipt',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    number: varchar('number', { length: 48 }),
    numberPeriod: varchar('number_period', { length: 16 }),
    numberValue: integer('number_value'),

    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references(() => purchaseOrder.id, { onDelete: 'restrict' }),
    supplierId: uuid('supplier_id').notNull(),
    warehouseId: uuid('warehouse_id'),

    receivedOn: date('received_on').notNull(),
    /** The supplier's delivery note. The number the driver hands over. */
    deliveryNoteReference: varchar('delivery_note_reference', { length: 64 }),
    /** Set when the delivery exceeded the order beyond tolerance and was taken. */
    overDelivered: boolean('over_delivered').notNull().default(false),
    /** Damage, wrong colour, missing certificates — the storeman's note. */
    inspectionNotes: text('inspection_notes'),

    /** kernel.document — the signed delivery note, photographed at the gate. */
    documentId: uuid('document_id'),
    receivedBy: uuid('received_by'),
    ...timestamps(),
  },
  (t) => [
    unique('goods_receipt_number_uq').on(t.tenantId, t.number),
    index('goods_receipt_order_idx').on(t.tenantId, t.purchaseOrderId),
    index('goods_receipt_date_idx').on(t.tenantId, t.receivedOn),
  ],
);

/**
 * What actually came off the lorry. Append-only.
 *
 * Immutable because it moved stock and accrued a cost. A miscount is corrected
 * by a further receipt line — negative if goods went back — never by editing the
 * original, so the stock ledger and the accrual always reconcile to a sequence
 * of events that genuinely happened.
 */
export const goodsReceiptLine = procurement.table(
  'goods_receipt_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    goodsReceiptId: uuid('goods_receipt_id')
      .notNull()
      .references(() => goodsReceipt.id, { onDelete: 'restrict' }),
    purchaseOrderLineId: uuid('purchase_order_line_id')
      .notNull()
      .references(() => purchaseOrderLine.id, { onDelete: 'restrict' }),

    /** Negative for a return. The only way to undo a receipt. */
    quantityReceived: numeric('quantity_received', { precision: 18, scale: 4 }).notNull(),
    quantityRejected: numeric('quantity_rejected', { precision: 18, scale: 4 })
      .notNull()
      .default('0'),
    rejectionReason: text('rejection_reason'),

    /** Unit price at receipt, from the order. Values the accrual. */
    unitPrice: numeric('unit_price', { precision: 18, scale: 4 }).notNull(),
    /** In base currency. What Projects accrued and what Inventory valued at. */
    accrualValue: numeric('accrual_value', { precision: 18, scale: 2 }).notNull().default('0'),

    /** inventory.stock_movement, when Inventory is entitled. */
    stockMovementId: uuid('stock_movement_id'),
    /** projects.cost_entry — the accrual raised on receipt. */
    costEntryId: uuid('cost_entry_id'),

    batchReference: varchar('batch_reference', { length: 64 }),
    serialNumbers: jsonb('serial_numbers').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('goods_receipt_line_idx').on(t.tenantId, t.goodsReceiptId),
    index('goods_receipt_line_order_idx').on(t.tenantId, t.purchaseOrderLineId),
  ],
);

// ---------------------------------------------------------------------------
// Supplier invoice
// ---------------------------------------------------------------------------

export const supplierInvoice = procurement.table(
  'supplier_invoice',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    /** Our internal reference. The supplier's own is `supplierReference`. */
    number: varchar('number', { length: 48 }),
    numberPeriod: varchar('number_period', { length: 16 }),
    numberValue: integer('number_value'),

    supplierId: uuid('supplier_id').notNull(),
    purchaseOrderId: uuid('purchase_order_id').references(() => purchaseOrder.id, {
      onDelete: 'restrict',
    }),
    status: invoiceStatus('status').notNull().default('received'),

    /**
     * The supplier's invoice number, unique per supplier.
     *
     * The constraint is the point: the single commonest way a company pays
     * twice is the same invoice arriving by post and by email, and a uniqueness
     * check on (supplier, their number) stops it at the door for free.
     */
    supplierReference: varchar('supplier_reference', { length: 64 }).notNull(),
    invoiceDate: date('invoice_date').notNull(),
    receivedOn: date('received_on').notNull(),
    dueOn: date('due_on'),

    currencyCode: varchar('currency_code', { length: 3 }),
    exchangeRate: numeric('exchange_rate', { precision: 18, scale: 8 }).notNull().default('1'),
    netValue: numeric('net_value', { precision: 18, scale: 2 }).notNull().default('0'),
    taxAmount: numeric('tax_amount', { precision: 18, scale: 2 }).notNull().default('0'),
    grossValue: numeric('gross_value', { precision: 18, scale: 2 }).notNull().default('0'),
    baseValue: numeric('base_value', { precision: 18, scale: 2 }).notNull().default('0'),

    /** Tax registration number, required on a compliant GCC tax invoice. */
    supplierTaxNumber: varchar('supplier_tax_number', { length: 32 }),
    taxCode: varchar('tax_code', { length: 32 }),

    /** Comparison output at the time of matching, kept for the audit trail. */
    matchedOn: timestamp('matched_on', { withTimezone: true }),
    matchVariance: numeric('match_variance', { precision: 18, scale: 2 }),
    holdReason: text('hold_reason'),
    releasedBy: uuid('released_by'),
    releasedOn: timestamp('released_on', { withTimezone: true }),

    approvalInstanceId: uuid('approval_instance_id'),
    documentId: uuid('document_id'),
    postedOn: date('posted_on'),
    paidOn: date('paid_on'),
    notes: text('notes'),
    createdBy: uuid('created_by'),
    ...timestamps(),
  },
  (t) => [
    unique('supplier_invoice_number_uq').on(t.tenantId, t.number),
    // Duplicate-payment defence. See the note on `supplierReference`.
    unique('supplier_invoice_reference_uq').on(t.tenantId, t.supplierId, t.supplierReference),
    index('supplier_invoice_status_idx').on(t.tenantId, t.status, t.dueOn),
    index('supplier_invoice_order_idx').on(t.tenantId, t.purchaseOrderId),
  ],
);

export const supplierInvoiceLine = procurement.table(
  'supplier_invoice_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    supplierInvoiceId: uuid('supplier_invoice_id')
      .notNull()
      .references(() => supplierInvoice.id, { onDelete: 'cascade' }),
    /** Null when the supplier billed something that was never ordered. */
    purchaseOrderLineId: uuid('purchase_order_line_id').references(() => purchaseOrderLine.id, {
      onDelete: 'set null',
    }),
    lineNumber: integer('line_number').notNull(),

    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull(),
    uomCode: varchar('uom_code', { length: 16 }),
    unitPrice: numeric('unit_price', { precision: 18, scale: 4 }).notNull(),
    lineValue: numeric('line_value', { precision: 18, scale: 2 }).notNull().default('0'),
    taxPercent: numeric('tax_percent', { precision: 6, scale: 3 }),

    /** What the same quantity would have cost at the ordered price. */
    expectedValue: numeric('expected_value', { precision: 18, scale: 2 }),
    ...timestamps(),
  },
  (t) => [
    unique('supplier_invoice_line_uq').on(t.supplierInvoiceId, t.lineNumber),
    index('supplier_invoice_line_order_idx').on(t.tenantId, t.purchaseOrderLineId),
  ],
);

/**
 * What matching found, and what was done about it.
 *
 * A register rather than a flag on the invoice. The useful questions are all
 * historical — which supplier generates the most price variances, who releases
 * the most holds, how much a tolerance change would have cost last year — and a
 * boolean answers none of them.
 */
export const matchException = procurement.table(
  'match_exception',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    supplierInvoiceId: uuid('supplier_invoice_id').references(() => supplierInvoice.id, {
      onDelete: 'cascade',
    }),
    /** Set instead, for an over-delivery raised at the gate. */
    goodsReceiptId: uuid('goods_receipt_id').references(() => goodsReceipt.id, {
      onDelete: 'cascade',
    }),
    purchaseOrderLineId: uuid('purchase_order_line_id').references(() => purchaseOrderLine.id, {
      onDelete: 'set null',
    }),

    code: exceptionCode('code').notNull(),
    message: text('message').notNull(),
    /** Money at stake. Lets a buyer triage a hundred exceptions by size. */
    amount: numeric('amount', { precision: 18, scale: 2 }).notNull().default('0'),
    /** True for an undercharge: reported, never blocking. */
    isFavourable: boolean('is_favourable').notNull().default(false),

    /** 'open' | 'accepted' | 'rejected' | 'credited' | 'resolved' */
    resolution: varchar('resolution', { length: 24 }).notNull().default('open'),
    resolutionNote: text('resolution_note'),
    resolvedBy: uuid('resolved_by'),
    resolvedOn: timestamp('resolved_on', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    index('match_exception_invoice_idx').on(t.tenantId, t.supplierInvoiceId, t.resolution),
    index('match_exception_code_idx').on(t.tenantId, t.code, t.resolution),
  ],
);

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

export const PROCUREMENT_TENANT_TABLES = [
  'requisition',
  'requisition_line',
  'rfq',
  'rfq_line',
  'quote',
  'quote_line',
  'purchase_order',
  'purchase_order_line',
  'goods_receipt',
  'goods_receipt_line',
  'supplier_invoice',
  'supplier_invoice_line',
  'match_exception',
] as const;

/**
 * A receipt line moved stock and raised an accrual. Correcting one is a further
 * receipt — negative for a return — not an edit, and the database enforces it.
 */
export const PROCUREMENT_APPEND_ONLY_TABLES = new Set(['goods_receipt_line']);

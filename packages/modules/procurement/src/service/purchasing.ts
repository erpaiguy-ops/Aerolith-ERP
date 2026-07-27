/**
 * Requisition → RFQ → award → purchase order → receipt → matched invoice.
 *
 * Two rules shape everything in this file.
 *
 * **This module imports no other business module.** Stock movement on receipt
 * and commitment accounting against a project budget are real requirements, but
 * they belong to Inventory and Projects. So the functions here RETURN what those
 * modules need and accept the resulting ids back — `receiveGoods` hands out a
 * posting instruction, the application layer performs it, `linkReceiptPostings`
 * records where it landed. The alternative, importing them, would make
 * Procurement unsellable on its own and is mechanically blocked by the boundary
 * checker anyway.
 *
 * **Tolerances and terms come from the resolved rule snapshot**
 * (tenant → country → default) and are then snapshotted onto the document. A
 * buyer who widens the price tolerance next quarter must not retrospectively
 * un-hold an invoice that was held last quarter.
 */
import {
  allocateNumber,
  emit,
  loadRuleSnapshot,
  recordAudit,
  requireTenantContext,
  ruleValue,
  schema,
  type Transaction,
} from '@aerolith/kernel';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import {
  goodsReceipt,
  goodsReceiptLine,
  matchException,
  purchaseOrder,
  purchaseOrderLine,
  quote,
  quoteLine,
  requisition,
  requisitionLine,
  rfq,
  rfqLine,
  supplierInvoice,
  supplierInvoiceLine,
} from '../db/schema';
import {
  compareQuotes,
  type QuoteComparison,
  type QuoteInput,
} from '../domain/comparison';
import {
  DEFAULT_TOLERANCE,
  checkReceipt,
  matchInvoice,
  type MatchException,
  type MatchTolerance,
  type PurchaseOrderLine,
} from '../domain/matching';

export const MODULE_KEY = 'procurement';

export class ProcurementError extends Error {
  override readonly name = 'ProcurementError';
}

const num = (value: string | null | undefined): number => (value == null ? 0 : Number(value));
const money = (value: number): string => value.toFixed(2);
const qty = (value: number): string => value.toFixed(4);

/**
 * Matching tolerances for a country, falling back to the domain defaults.
 *
 * The fallback is not defensive padding: a tenant whose country pack predates
 * this module has no values for these rules, and a tolerance of `undefined`
 * silently becomes `NaN`, which compares false against everything and passes
 * every invoice. Better to use a sane default than to disable the control.
 */
export async function resolveTolerance(
  tx: Transaction,
  countryCode: string,
): Promise<MatchTolerance> {
  const { tenantId } = requireTenantContext();
  const snapshot = await loadRuleSnapshot(tx, { tenantId, countryCode });

  const read = (key: string, fallback: number): number => {
    const value = ruleValue<number>(snapshot, key);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  };

  return {
    pricePercent: read('procurement.match.price_tolerance_percent', DEFAULT_TOLERANCE.pricePercent),
    minorAmount: read('procurement.match.minor_amount', DEFAULT_TOLERANCE.minorAmount),
    maxAmount: read('procurement.match.max_amount', DEFAULT_TOLERANCE.maxAmount),
    quantityPercent: read(
      'procurement.receipt.over_delivery_percent',
      DEFAULT_TOLERANCE.quantityPercent,
    ),
  };
}

/**
 * The tenant's default purchase tax code for a country.
 *
 * Reads `kernel.tenant_tax_code` rather than a rule, because that table is
 * already the source of truth: it carries the rate, whether the tax is
 * recoverable, whether it reverse-charges, and the return box it aggregates
 * into. Falls back to zero-rated when the tenant has adopted no codes — a
 * business not registered for VAT is a real case, not an error.
 */
export async function resolveDefaultPurchaseTax(
  tx: Transaction,
  tenantId: string,
  countryCode: string,
): Promise<{ code: string | null; percent: number }> {
  const codes = await tx
    .select()
    .from(schema.tenantTaxCode)
    .where(
      and(
        eq(schema.tenantTaxCode.tenantId, tenantId),
        eq(schema.tenantTaxCode.countryCode, countryCode),
        eq(schema.tenantTaxCode.isActive, true),
        inArray(schema.tenantTaxCode.applicability, ['purchase', 'both']),
      ),
    )
    .orderBy(asc(schema.tenantTaxCode.sortOrder));

  const chosen = codes.find((code) => code.isDefault) ?? codes[0];
  if (!chosen) return { code: null, percent: 0 };

  return { code: chosen.code, percent: num(chosen.rate) };
}

// ---------------------------------------------------------------------------
// Requisition
// ---------------------------------------------------------------------------

export interface RequisitionLineInput {
  itemId?: string | null;
  description: string;
  specification?: string | null;
  quantity: number;
  uomCode?: string | null;
  estimatedUnitPrice?: number | null;
  wbsNodeId?: string | null;
}

export interface CreateRequisitionInput {
  title: string;
  projectId?: string | null;
  costCentreId?: string | null;
  requiredBy?: string | null;
  priority?: 'routine' | 'urgent' | 'emergency';
  justification?: string | null;
  sourceEstimateId?: string | null;
  sourceWorkOrderId?: string | null;
  lines: RequisitionLineInput[];
}

export async function createRequisition(
  tx: Transaction,
  input: CreateRequisitionInput,
): Promise<{ requisitionId: string; number: string; estimatedValue: number }> {
  const { tenantId, userId } = requireTenantContext();

  if (input.lines.length === 0) {
    throw new ProcurementError('A requisition must have at least one line.');
  }
  for (const line of input.lines) {
    if (!(line.quantity > 0)) {
      throw new ProcurementError(`Quantity for "${line.description}" must be greater than zero.`);
    }
  }

  const estimatedValue = input.lines.reduce(
    (total, line) => total + line.quantity * (line.estimatedUnitPrice ?? 0),
    0,
  );

  const allocated = await allocateNumber(tx, { entityType: 'procurement.requisition' });

  const [created] = await tx
    .insert(requisition)
    .values({
      tenantId,
      number: allocated.formatted,
      numberPeriod: allocated.period,
      numberValue: allocated.value,
      title: input.title,
      projectId: input.projectId,
      costCentreId: input.costCentreId,
      requiredBy: input.requiredBy,
      priority: input.priority ?? 'routine',
      justification: input.justification,
      estimatedValue: money(estimatedValue),
      sourceEstimateId: input.sourceEstimateId,
      sourceWorkOrderId: input.sourceWorkOrderId,
      requestedBy: userId,
    })
    .returning({ id: requisition.id });

  const requisitionId = created!.id;

  for (const [index, line] of input.lines.entries()) {
    await tx.insert(requisitionLine).values({
      tenantId,
      requisitionId,
      lineNumber: index + 1,
      itemId: line.itemId,
      description: line.description,
      specification: line.specification,
      quantity: qty(line.quantity),
      uomCode: line.uomCode,
      estimatedUnitPrice:
        line.estimatedUnitPrice == null ? null : qty(line.estimatedUnitPrice),
      wbsNodeId: line.wbsNodeId,
    });
  }

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    action: 'create',
    entityType: 'procurement.requisition',
    entityId: requisitionId,
    entityLabel: allocated.formatted,
    metadata: { title: input.title, estimatedValue, lines: input.lines.length },
  });

  return { requisitionId, number: allocated.formatted, estimatedValue };
}

export async function approveRequisition(
  tx: Transaction,
  input: { requisitionId: string },
): Promise<void> {
  const { tenantId, userId } = requireTenantContext();

  const [row] = await tx
    .select()
    .from(requisition)
    .where(and(eq(requisition.tenantId, tenantId), eq(requisition.id, input.requisitionId)));

  if (!row) throw new ProcurementError('Requisition not found.');
  if (row.status === 'approved' || row.status === 'sourcing' || row.status === 'ordered') return;
  if (row.status === 'cancelled' || row.status === 'rejected') {
    throw new ProcurementError(`A ${row.status} requisition cannot be approved.`);
  }

  await tx
    .update(requisition)
    .set({ status: 'approved', approvedBy: userId, approvedOn: new Date(), updatedAt: new Date() })
    .where(and(eq(requisition.tenantId, tenantId), eq(requisition.id, input.requisitionId)));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    action: 'approve',
    entityType: 'procurement.requisition',
    entityId: input.requisitionId,
    entityLabel: row.number,
    metadata: { estimatedValue: num(row.estimatedValue), projectId: row.projectId },
  });

  await emit(tx, {
    type: 'procurement.requisition.approved',
    sourceModule: MODULE_KEY,
    aggregateType: 'procurement.requisition',
    aggregateId: input.requisitionId,
    payload: {
      requisitionId: input.requisitionId,
      projectId: row.projectId,
      estimatedValue: num(row.estimatedValue),
    },
  });
}

// ---------------------------------------------------------------------------
// RFQ and quotes
// ---------------------------------------------------------------------------

export interface CreateRfqInput {
  title: string;
  projectId?: string | null;
  countryCode: string;
  currencyCode?: string | null;
  responseDueOn?: string | null;
  /** Whether MOQ surplus retains value. The buyer knows; the maths cannot. */
  surplusIsStock?: boolean;
  lines: {
    itemId?: string | null;
    description: string;
    specification?: string | null;
    quantity: number;
    uomCode?: string | null;
    requisitionLineIds?: string[];
  }[];
}

export async function createRfq(
  tx: Transaction,
  input: CreateRfqInput,
): Promise<{ rfqId: string; number: string }> {
  const { tenantId, userId } = requireTenantContext();

  if (input.lines.length === 0) {
    throw new ProcurementError('An RFQ must have at least one line.');
  }

  const snapshot = await loadRuleSnapshot(tx, { tenantId, countryCode: input.countryCode });
  const costOfCapital = ruleValue<number>(snapshot, 'procurement.cost_of_capital_percent');

  const allocated = await allocateNumber(tx, { entityType: 'procurement.rfq' });

  const [created] = await tx
    .insert(rfq)
    .values({
      tenantId,
      number: allocated.formatted,
      numberPeriod: allocated.period,
      numberValue: allocated.value,
      title: input.title,
      projectId: input.projectId,
      currencyCode: input.currencyCode,
      responseDueOn: input.responseDueOn,
      surplusIsStock: input.surplusIsStock ?? true,
      // Snapshotted so a comparison run today still reproduces in a year, after
      // somebody has revised the tenant's cost of capital.
      costOfCapitalPercent:
        typeof costOfCapital === 'number' && Number.isFinite(costOfCapital)
          ? String(costOfCapital)
          : '8',
      createdBy: userId,
    })
    .returning({ id: rfq.id });

  const rfqId = created!.id;

  for (const [index, line] of input.lines.entries()) {
    await tx.insert(rfqLine).values({
      tenantId,
      rfqId,
      lineNumber: index + 1,
      itemId: line.itemId,
      description: line.description,
      specification: line.specification,
      quantity: qty(line.quantity),
      uomCode: line.uomCode,
      requisitionLineIds: line.requisitionLineIds ?? [],
    });
  }

  // Mark the source requisitions as being sourced, so a second buyer does not
  // start again on the same demand.
  const requisitionLineIds = input.lines.flatMap((line) => line.requisitionLineIds ?? []);
  if (requisitionLineIds.length > 0) {
    const parents = await tx
      .selectDistinct({ requisitionId: requisitionLine.requisitionId })
      .from(requisitionLine)
      .where(
        and(eq(requisitionLine.tenantId, tenantId), inArray(requisitionLine.id, requisitionLineIds)),
      );

    if (parents.length > 0) {
      await tx
        .update(requisition)
        .set({ status: 'sourcing', updatedAt: new Date() })
        .where(
          and(
            eq(requisition.tenantId, tenantId),
            eq(requisition.status, 'approved'),
            inArray(
              requisition.id,
              parents.map((p) => p.requisitionId),
            ),
          ),
        );
    }
  }

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    action: 'create',
    entityType: 'procurement.rfq',
    entityId: rfqId,
    entityLabel: allocated.formatted,
    metadata: { title: input.title, lines: input.lines.length },
  });

  return { rfqId, number: allocated.formatted };
}

export interface RecordQuoteInput {
  rfqId: string;
  supplierId: string;
  reference?: string | null;
  receivedOn?: string | null;
  validUntil?: string | null;
  currencyCode?: string | null;
  exchangeRate?: number;
  freight?: number;
  dutyPercent?: number;
  otherCharges?: number;
  paymentTermDays?: number;
  earlyPaymentDiscountPercent?: number | null;
  earlyPaymentDays?: number | null;
  leadTimeDays?: number | null;
  notes?: string | null;
  documentId?: string | null;
  lines: {
    rfqLineId?: string | null;
    description: string;
    offeredAlternative?: string | null;
    quantity: number;
    uomCode?: string | null;
    unitPrice: number;
    minimumOrderQuantity?: number | null;
    orderIncrement?: number | null;
    leadTimeDays?: number | null;
  }[];
}

export async function recordQuote(
  tx: Transaction,
  input: RecordQuoteInput,
): Promise<{ quoteId: string }> {
  const { tenantId } = requireTenantContext();

  if (input.lines.length === 0) {
    throw new ProcurementError('A quote must have at least one priced line.');
  }
  if (input.exchangeRate != null && !(input.exchangeRate > 0)) {
    throw new ProcurementError('Exchange rate must be greater than zero.');
  }

  const [created] = await tx
    .insert(quote)
    .values({
      tenantId,
      rfqId: input.rfqId,
      supplierId: input.supplierId,
      status: 'received',
      reference: input.reference,
      receivedOn: input.receivedOn ?? new Date().toISOString().slice(0, 10),
      validUntil: input.validUntil,
      currencyCode: input.currencyCode,
      exchangeRate: String(input.exchangeRate ?? 1),
      freight: money(input.freight ?? 0),
      dutyPercent: String(input.dutyPercent ?? 0),
      otherCharges: money(input.otherCharges ?? 0),
      paymentTermDays: input.paymentTermDays ?? 0,
      earlyPaymentDiscountPercent:
        input.earlyPaymentDiscountPercent == null
          ? null
          : String(input.earlyPaymentDiscountPercent),
      earlyPaymentDays: input.earlyPaymentDays,
      leadTimeDays: input.leadTimeDays,
      notes: input.notes,
      documentId: input.documentId,
    })
    .onConflictDoNothing({ target: [quote.rfqId, quote.supplierId] })
    .returning({ id: quote.id });

  if (!created) {
    throw new ProcurementError('This supplier has already quoted on this RFQ.');
  }

  for (const [index, line] of input.lines.entries()) {
    await tx.insert(quoteLine).values({
      tenantId,
      quoteId: created.id,
      rfqLineId: line.rfqLineId,
      lineNumber: index + 1,
      description: line.description,
      offeredAlternative: line.offeredAlternative,
      quantity: qty(line.quantity),
      uomCode: line.uomCode,
      unitPrice: qty(line.unitPrice),
      minimumOrderQuantity:
        line.minimumOrderQuantity == null ? null : qty(line.minimumOrderQuantity),
      orderIncrement: line.orderIncrement == null ? null : qty(line.orderIncrement),
      leadTimeDays: line.leadTimeDays,
    });
  }

  return { quoteId: created.id };
}

export interface RfqComparison {
  rfqId: string;
  quantityRequired: number;
  surplusIsStock: boolean;
  costOfCapitalPercent: number;
  /** Cheapest first. */
  quotes: (QuoteComparison & { quoteId: string })[];
  /** Quotes below the governance minimum make this true. */
  belowMinimumQuotes: boolean;
  minimumQuotes: number;
}

/**
 * Compares every received quote on one RFQ line and stores the result.
 *
 * Compares a SINGLE line, deliberately. A multi-line RFQ is a package award and
 * the arithmetic that would combine lines — apportioning one freight charge
 * across four materials with different MOQs — is a genuinely different problem
 * with a genuinely different answer. Pretending one function does both produces
 * a number that is wrong in a way nobody can see.
 */
export async function compareRfqLine(
  tx: Transaction,
  input: { rfqId: string; rfqLineId: string; countryCode: string },
): Promise<RfqComparison> {
  const { tenantId } = requireTenantContext();

  const [header] = await tx
    .select()
    .from(rfq)
    .where(and(eq(rfq.tenantId, tenantId), eq(rfq.id, input.rfqId)));
  if (!header) throw new ProcurementError('RFQ not found.');

  const [line] = await tx
    .select()
    .from(rfqLine)
    .where(and(eq(rfqLine.tenantId, tenantId), eq(rfqLine.id, input.rfqLineId)));
  if (!line) throw new ProcurementError('RFQ line not found.');

  const received = await tx
    .select()
    .from(quote)
    .where(
      and(
        eq(quote.tenantId, tenantId),
        eq(quote.rfqId, input.rfqId),
        inArray(quote.status, ['received', 'shortlisted', 'awarded']),
      ),
    );

  const snapshot = await loadRuleSnapshot(tx, { tenantId, countryCode: input.countryCode });
  const minimumQuotes = ruleValue<number>(snapshot, 'procurement.rfq.minimum_quotes') ?? 3;
  const costOfCapitalPercent = num(header.costOfCapitalPercent) || 8;
  const quantityRequired = num(line.quantity);

  const inputs: (QuoteInput & { quoteId: string })[] = [];

  for (const row of received) {
    const [priced] = await tx
      .select()
      .from(quoteLine)
      .where(
        and(
          eq(quoteLine.tenantId, tenantId),
          eq(quoteLine.quoteId, row.id),
          eq(quoteLine.rfqLineId, input.rfqLineId),
        ),
      );

    // A supplier who did not price this line is not in the comparison. Treating
    // a missing price as zero would hand them the award.
    if (!priced) continue;

    inputs.push({
      quoteId: row.id,
      supplierId: row.supplierId,
      supplierName: row.reference ?? row.supplierId,
      currencyCode: row.currencyCode ?? 'AED',
      exchangeRate: num(row.exchangeRate) || 1,
      unitPrice: num(priced.unitPrice),
      minimumOrderQuantity:
        priced.minimumOrderQuantity == null ? undefined : num(priced.minimumOrderQuantity),
      orderIncrement: priced.orderIncrement == null ? undefined : num(priced.orderIncrement),
      freight: num(row.freight),
      dutyPercent: num(row.dutyPercent),
      otherCharges: num(row.otherCharges),
      paymentTermDays: row.paymentTermDays,
      earlyPaymentDiscountPercent:
        row.earlyPaymentDiscountPercent == null
          ? undefined
          : num(row.earlyPaymentDiscountPercent),
      earlyPaymentDays: row.earlyPaymentDays ?? undefined,
      leadTimeDays: priced.leadTimeDays ?? row.leadTimeDays ?? undefined,
      notes: row.notes ?? undefined,
    });
  }

  const ranked = compareQuotes(inputs, {
    quantityRequired,
    surplusIsStock: header.surplusIsStock,
    costOfCapitalPercent,
  });

  // `compareQuotes` returns re-ordered results keyed by supplier, so map back.
  const quoteIdBySupplier = new Map(inputs.map((i) => [i.supplierId, i.quoteId]));
  const withIds = ranked.map((r) => ({ ...r, quoteId: quoteIdBySupplier.get(r.supplierId)! }));

  const comparedAt = new Date();
  for (const result of withIds) {
    await tx
      .update(quote)
      .set({
        landedCost: money(result.landedCost),
        effectiveUnitCost: qty(result.effectiveUnitCost),
        premiumOverBest: money(result.premiumOverBest),
        comparedAt,
        updatedAt: comparedAt,
      })
      .where(and(eq(quote.tenantId, tenantId), eq(quote.id, result.quoteId)));
  }

  return {
    rfqId: input.rfqId,
    quantityRequired,
    surplusIsStock: header.surplusIsStock,
    costOfCapitalPercent,
    quotes: withIds,
    belowMinimumQuotes: withIds.length < minimumQuotes,
    minimumQuotes,
  };
}

/**
 * Awards an RFQ to one supplier.
 *
 * A rationale is REQUIRED when the winner is not the cheapest landed cost. Not
 * as ceremony: an award with no recorded reasoning is indistinguishable from a
 * favour, and the moment to capture the reason is while the buyer still
 * remembers it — never in the audit six months later.
 */
export async function awardRfq(
  tx: Transaction,
  input: { rfqId: string; quoteId: string; rationale?: string | null },
): Promise<void> {
  const { tenantId } = requireTenantContext();

  const quotes = await tx
    .select()
    .from(quote)
    .where(and(eq(quote.tenantId, tenantId), eq(quote.rfqId, input.rfqId)));

  const winner = quotes.find((q) => q.id === input.quoteId);
  if (!winner) throw new ProcurementError('Quote is not on this RFQ.');

  const compared = quotes.filter((q) => q.landedCost != null);
  const cheapest = compared.reduce<typeof compared[number] | undefined>(
    (best, q) => (best == null || num(q.landedCost) < num(best.landedCost) ? q : best),
    undefined,
  );

  const isCheapest = cheapest == null || cheapest.id === winner.id;
  if (!isCheapest && !input.rationale?.trim()) {
    throw new ProcurementError(
      'Awarding above the cheapest landed cost requires a recorded reason.',
    );
  }

  await tx
    .update(quote)
    .set({ status: 'lost', updatedAt: new Date() })
    .where(
      and(
        eq(quote.tenantId, tenantId),
        eq(quote.rfqId, input.rfqId),
        inArray(quote.status, ['received', 'shortlisted']),
      ),
    );

  await tx
    .update(quote)
    .set({ status: 'awarded', updatedAt: new Date() })
    .where(and(eq(quote.tenantId, tenantId), eq(quote.id, input.quoteId)));

  await tx
    .update(rfq)
    .set({
      status: 'awarded',
      awardedOn: new Date().toISOString().slice(0, 10),
      awardRationale: input.rationale ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(rfq.tenantId, tenantId), eq(rfq.id, input.rfqId)));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    action: 'approve',
    entityType: 'procurement.rfq',
    entityId: input.rfqId,
    entityLabel: winner.reference,
    // The reason goes in `reason`, where the audit reader looks for it, and the
    // premium is recorded as a number so "what did awarding off-lowest cost us
    // last year" is a query rather than an essay.
    reason: input.rationale ?? undefined,
    metadata: {
      supplierId: winner.supplierId,
      landedCost: num(winner.landedCost),
      isCheapest,
      premiumOverCheapest: isCheapest
        ? 0
        : Math.round((num(winner.landedCost) - num(cheapest?.landedCost)) * 100) / 100,
    },
  });
}

// ---------------------------------------------------------------------------
// Purchase order
// ---------------------------------------------------------------------------

export interface PurchaseOrderLineInput {
  itemId?: string | null;
  description: string;
  specification?: string | null;
  quantity: number;
  uomCode?: string | null;
  unitPrice: number;
  taxPercent?: number | null;
  warehouseId?: string | null;
  wbsNodeId?: string | null;
  requisitionLineId?: string | null;
  quoteLineId?: string | null;
  promisedDeliveryDate?: string | null;
}

export interface CreatePurchaseOrderInput {
  supplierId: string;
  countryCode: string;
  projectId?: string | null;
  costCentreId?: string | null;
  sourceQuoteId?: string | null;
  sourceRfqId?: string | null;
  currencyCode?: string | null;
  exchangeRate?: number;
  freight?: number;
  otherCharges?: number;
  incoterm?: string | null;
  deliveryAddress?: string | null;
  promisedDeliveryDate?: string | null;
  notes?: string | null;
  lines: PurchaseOrderLineInput[];
}

export interface CreatePurchaseOrderResult {
  purchaseOrderId: string;
  number: string;
  netValue: number;
  taxAmount: number;
  grossValue: number;
  baseValue: number;
}

export async function createPurchaseOrder(
  tx: Transaction,
  input: CreatePurchaseOrderInput,
): Promise<CreatePurchaseOrderResult> {
  const { tenantId, userId } = requireTenantContext();

  if (input.lines.length === 0) {
    throw new ProcurementError('A purchase order must have at least one line.');
  }
  const rate = input.exchangeRate ?? 1;
  if (!(rate > 0)) throw new ProcurementError('Exchange rate must be greater than zero.');

  const snapshot = await loadRuleSnapshot(tx, { tenantId, countryCode: input.countryCode });
  const paymentTermDays = ruleValue<number>(snapshot, 'contract.payment_terms.default_days');

  // Tax comes from the tenant's adopted tax codes, NOT from a rule. It was
  // tempting to add a `procurement.tax.default_percent` knob, and it would have
  // been a second source of truth for a fact `kernel.tenant_tax_code` already
  // owns — complete with rate, recoverability, reverse-charge flag and the
  // return box it aggregates into. A single percentage would have thrown all of
  // that away and drifted from the codes an invoice must actually quote.
  const defaultTax = await resolveDefaultPurchaseTax(tx, tenantId, input.countryCode);

  let netValue = 0;
  let taxAmount = 0;
  for (const line of input.lines) {
    if (!(line.quantity > 0)) {
      throw new ProcurementError(`Quantity for "${line.description}" must be greater than zero.`);
    }
    const lineValue = line.quantity * line.unitPrice;
    netValue += lineValue;
    const percent = line.taxPercent ?? defaultTax.percent;
    taxAmount += lineValue * (percent / 100);
  }

  const freight = input.freight ?? 0;
  const other = input.otherCharges ?? 0;
  const grossValue = netValue + freight + other + taxAmount;

  const allocated = await allocateNumber(tx, { entityType: 'procurement.purchase_order' });

  const [created] = await tx
    .insert(purchaseOrder)
    .values({
      tenantId,
      number: allocated.formatted,
      numberPeriod: allocated.period,
      numberValue: allocated.value,
      supplierId: input.supplierId,
      projectId: input.projectId,
      costCentreId: input.costCentreId,
      sourceQuoteId: input.sourceQuoteId,
      sourceRfqId: input.sourceRfqId,
      currencyCode: input.currencyCode,
      exchangeRate: String(rate),
      netValue: money(netValue),
      freight: money(freight),
      otherCharges: money(other),
      taxAmount: money(taxAmount),
      grossValue: money(grossValue),
      baseValue: money(grossValue * rate),
      paymentTermDays: typeof paymentTermDays === 'number' ? paymentTermDays : null,
      // Snapshotted with the rate that produced `taxAmount`, so the order still
      // explains itself after the tenant edits their tax codes.
      taxCode: defaultTax.code,
      incoterm: input.incoterm,
      deliveryAddress: input.deliveryAddress,
      promisedDeliveryDate: input.promisedDeliveryDate,
      notes: input.notes,
      createdBy: userId,
    })
    .returning({ id: purchaseOrder.id });

  const purchaseOrderId = created!.id;

  for (const [index, line] of input.lines.entries()) {
    await tx.insert(purchaseOrderLine).values({
      tenantId,
      purchaseOrderId,
      lineNumber: index + 1,
      itemId: line.itemId,
      description: line.description,
      specification: line.specification,
      quantity: qty(line.quantity),
      uomCode: line.uomCode,
      unitPrice: qty(line.unitPrice),
      lineValue: money(line.quantity * line.unitPrice),
      taxPercent: String(line.taxPercent ?? defaultTax.percent),
      warehouseId: line.warehouseId,
      wbsNodeId: line.wbsNodeId,
      requisitionLineId: line.requisitionLineId,
      quoteLineId: line.quoteLineId,
      promisedDeliveryDate: line.promisedDeliveryDate ?? input.promisedDeliveryDate,
    });

    if (line.requisitionLineId) {
      await tx
        .update(requisitionLine)
        .set({
          quantityOrdered: sql`${requisitionLine.quantityOrdered} + ${qty(line.quantity)}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(requisitionLine.tenantId, tenantId),
            eq(requisitionLine.id, line.requisitionLineId),
          ),
        );
    }
  }

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    action: 'create',
    entityType: 'procurement.purchase_order',
    entityId: purchaseOrderId,
    entityLabel: allocated.formatted,
    metadata: { supplierId: input.supplierId, grossValue, baseValue: grossValue * rate },
  });

  return {
    purchaseOrderId,
    number: allocated.formatted,
    netValue,
    taxAmount,
    grossValue,
    baseValue: grossValue * rate,
  };
}

export interface IssuedOrder {
  purchaseOrderId: string;
  number: string;
  projectId: string | null;
  supplierId: string;
  baseValue: number;
  currencyCode: string | null;
  /** Set once the caller has registered the commitment. */
  commitmentId: string | null;
  promisedDeliveryDate: string | null;
  /** WBS-level split, so a commitment can be held where the budget is. */
  lines: { wbsNodeId: string | null; baseValue: number }[];
}

/**
 * Issues a purchase order to the supplier.
 *
 * Returns the shape Projects needs to register a commitment, WITHOUT importing
 * Projects. Ordered-but-not-invoiced money is spent in every sense that matters
 * to a forecast, and a project whose commitments are not registered looks
 * healthier than it is right up until the invoices arrive.
 */
export async function issuePurchaseOrder(
  tx: Transaction,
  input: { purchaseOrderId: string; issuedOn?: string },
): Promise<IssuedOrder> {
  const { tenantId } = requireTenantContext();

  const [order] = await tx
    .select()
    .from(purchaseOrder)
    .where(
      and(eq(purchaseOrder.tenantId, tenantId), eq(purchaseOrder.id, input.purchaseOrderId)),
    );
  if (!order) throw new ProcurementError('Purchase order not found.');
  if (order.status === 'cancelled') {
    throw new ProcurementError('A cancelled purchase order cannot be issued.');
  }

  const alreadyIssued = order.issuedOn != null;
  const issuedOn = input.issuedOn ?? new Date().toISOString().slice(0, 10);

  if (!alreadyIssued) {
    await tx
      .update(purchaseOrder)
      .set({ status: 'issued', issuedOn, updatedAt: new Date() })
      .where(
        and(eq(purchaseOrder.tenantId, tenantId), eq(purchaseOrder.id, input.purchaseOrderId)),
      );

    await recordAudit(tx, {
      moduleKey: MODULE_KEY,
      action: 'approve',
      entityType: 'procurement.purchase_order',
      entityId: input.purchaseOrderId,
      entityLabel: order.number,
      metadata: {
        supplierId: order.supplierId,
        baseValue: num(order.baseValue),
        projectId: order.projectId,
      },
    });

    await emit(tx, {
      type: 'procurement.order.issued',
      sourceModule: MODULE_KEY,
      aggregateType: 'procurement.purchase_order',
      aggregateId: input.purchaseOrderId,
      payload: {
        purchaseOrderId: input.purchaseOrderId,
        number: order.number,
        supplierId: order.supplierId,
        projectId: order.projectId,
        baseValue: num(order.baseValue),
      },
    });
  }

  const lines = await tx
    .select()
    .from(purchaseOrderLine)
    .where(
      and(
        eq(purchaseOrderLine.tenantId, tenantId),
        eq(purchaseOrderLine.purchaseOrderId, input.purchaseOrderId),
      ),
    )
    .orderBy(asc(purchaseOrderLine.lineNumber));

  // Charges and tax sit on the header, so the WBS split is apportioned by line
  // value rather than taken from `lineValue` directly. A commitment that omits
  // freight understates what the job is committed to.
  const netTotal = lines.reduce((total, line) => total + num(line.lineValue), 0);
  const rate = num(order.exchangeRate) || 1;
  const gross = num(order.grossValue);

  const byNode = new Map<string | null, number>();
  for (const line of lines) {
    const share = netTotal === 0 ? 0 : num(line.lineValue) / netTotal;
    const key = line.wbsNodeId ?? null;
    byNode.set(key, (byNode.get(key) ?? 0) + gross * share * rate);
  }

  return {
    purchaseOrderId: input.purchaseOrderId,
    number: order.number ?? '',
    projectId: order.projectId,
    supplierId: order.supplierId,
    baseValue: num(order.baseValue),
    currencyCode: order.currencyCode,
    commitmentId: order.commitmentId,
    promisedDeliveryDate: order.promisedDeliveryDate,
    lines: [...byNode.entries()].map(([wbsNodeId, baseValue]) => ({
      wbsNodeId,
      baseValue: Math.round(baseValue * 100) / 100,
    })),
  };
}

/** Records where the caller registered the commitment. */
export async function linkCommitment(
  tx: Transaction,
  input: { purchaseOrderId: string; commitmentId: string },
): Promise<void> {
  const { tenantId } = requireTenantContext();
  await tx
    .update(purchaseOrder)
    .set({ commitmentId: input.commitmentId, updatedAt: new Date() })
    .where(and(eq(purchaseOrder.tenantId, tenantId), eq(purchaseOrder.id, input.purchaseOrderId)));
}

// ---------------------------------------------------------------------------
// Goods receipt
// ---------------------------------------------------------------------------

export interface ReceiveGoodsInput {
  purchaseOrderId: string;
  countryCode: string;
  receivedOn?: string;
  warehouseId?: string | null;
  deliveryNoteReference?: string | null;
  inspectionNotes?: string | null;
  documentId?: string | null;
  lines: {
    purchaseOrderLineId: string;
    /** Negative for a return. The only way to undo a receipt. */
    quantityReceived: number;
    quantityRejected?: number;
    rejectionReason?: string | null;
    batchReference?: string | null;
    serialNumbers?: string[];
  }[];
}

/**
 * A posting the caller must perform in Inventory and Projects.
 *
 * Returned rather than performed because this module must not import either.
 * The caller posts, then calls `linkReceiptPostings` with the resulting ids so
 * the receipt line records where its stock and its accrual landed.
 */
export interface ReceiptPosting {
  goodsReceiptLineId: string;
  purchaseOrderLineId: string;
  itemId: string | null;
  description: string;
  /** Net of rejections — what was actually taken into stock. */
  quantityAccepted: number;
  uomCode: string | null;
  warehouseId: string | null;
  wbsNodeId: string | null;
  unitPriceBase: number;
  accrualValue: number;
}

export interface ReceiveGoodsResult {
  goodsReceiptId: string;
  number: string;
  projectId: string | null;
  supplierId: string;
  receivedOn: string;
  postings: ReceiptPosting[];
  /** Total accrual in base currency — what the job is charged on delivery. */
  accrualValue: number;
  exceptions: MatchException[];
  overDelivered: boolean;
  orderStatus: 'partially_received' | 'received' | 'issued';
}

export async function receiveGoods(
  tx: Transaction,
  input: ReceiveGoodsInput,
): Promise<ReceiveGoodsResult> {
  const { tenantId, userId } = requireTenantContext();

  if (input.lines.length === 0) {
    throw new ProcurementError('A goods receipt must have at least one line.');
  }

  const [order] = await tx
    .select()
    .from(purchaseOrder)
    .where(
      and(eq(purchaseOrder.tenantId, tenantId), eq(purchaseOrder.id, input.purchaseOrderId)),
    );
  if (!order) throw new ProcurementError('Purchase order not found.');
  if (order.status === 'draft' || order.status === 'pending_approval') {
    throw new ProcurementError('Goods cannot be received against an unissued purchase order.');
  }
  if (order.status === 'cancelled') {
    throw new ProcurementError('Goods cannot be received against a cancelled purchase order.');
  }

  const orderLines = await tx
    .select()
    .from(purchaseOrderLine)
    .where(
      and(
        eq(purchaseOrderLine.tenantId, tenantId),
        eq(purchaseOrderLine.purchaseOrderId, input.purchaseOrderId),
      ),
    )
    .orderBy(asc(purchaseOrderLine.lineNumber));

  const byId = new Map(orderLines.map((line) => [line.id, line]));
  for (const line of input.lines) {
    if (!byId.has(line.purchaseOrderLineId)) {
      throw new ProcurementError('Receipt line does not belong to this purchase order.');
    }
  }

  const tolerance = await resolveTolerance(tx, input.countryCode);

  // Checked BEFORE anything is written: an over-delivery is a decision taken at
  // the gate while the lorry is still there, not a report read the next morning.
  const check = checkReceipt({
    orderLines: orderLines.map((line) => ({
      reference: line.id,
      description: line.description,
      quantityOrdered: num(line.quantity),
      quantityReceived: num(line.quantityReceived),
      unitPrice: num(line.unitPrice),
    })),
    receiptLines: input.lines.map((line) => ({
      purchaseOrderLineReference: line.purchaseOrderLineId,
      quantity: line.quantityReceived,
    })),
    tolerance,
  });

  const receivedOn = input.receivedOn ?? new Date().toISOString().slice(0, 10);
  const rate = num(order.exchangeRate) || 1;

  const allocated = await allocateNumber(tx, {
    entityType: 'procurement.goods_receipt',
    documentDate: new Date(receivedOn),
  });

  const [receipt] = await tx
    .insert(goodsReceipt)
    .values({
      tenantId,
      number: allocated.formatted,
      numberPeriod: allocated.period,
      numberValue: allocated.value,
      purchaseOrderId: input.purchaseOrderId,
      supplierId: order.supplierId,
      warehouseId: input.warehouseId,
      receivedOn,
      deliveryNoteReference: input.deliveryNoteReference,
      overDelivered: check.overDelivered,
      inspectionNotes: input.inspectionNotes,
      documentId: input.documentId,
      receivedBy: userId,
    })
    .returning({ id: goodsReceipt.id });

  const goodsReceiptId = receipt!.id;
  const postings: ReceiptPosting[] = [];
  let accrualTotal = 0;

  for (const line of input.lines) {
    const orderLine = byId.get(line.purchaseOrderLineId)!;
    const rejected = line.quantityRejected ?? 0;
    const accepted = line.quantityReceived - rejected;
    const unitPriceBase = num(orderLine.unitPrice) * rate;
    const accrualValue = Math.round(accepted * unitPriceBase * 100) / 100;
    accrualTotal += accrualValue;

    const [created] = await tx
      .insert(goodsReceiptLine)
      .values({
        tenantId,
        goodsReceiptId,
        purchaseOrderLineId: line.purchaseOrderLineId,
        quantityReceived: qty(line.quantityReceived),
        quantityRejected: qty(rejected),
        rejectionReason: line.rejectionReason,
        unitPrice: qty(num(orderLine.unitPrice)),
        accrualValue: money(accrualValue),
        batchReference: line.batchReference,
        serialNumbers: line.serialNumbers ?? [],
      })
      .returning({ id: goodsReceiptLine.id });

    // Only ACCEPTED quantity advances the cumulative figure. Counting rejected
    // goods as received would let a supplier invoice for material that is
    // sitting on the loading bay waiting to go back.
    await tx
      .update(purchaseOrderLine)
      .set({
        quantityReceived: sql`${purchaseOrderLine.quantityReceived} + ${qty(accepted)}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(purchaseOrderLine.tenantId, tenantId),
          eq(purchaseOrderLine.id, line.purchaseOrderLineId),
        ),
      );

    postings.push({
      goodsReceiptLineId: created!.id,
      purchaseOrderLineId: line.purchaseOrderLineId,
      itemId: orderLine.itemId,
      description: orderLine.description,
      quantityAccepted: accepted,
      uomCode: orderLine.uomCode,
      warehouseId: orderLine.warehouseId ?? input.warehouseId ?? null,
      wbsNodeId: orderLine.wbsNodeId,
      unitPriceBase,
      accrualValue,
    });
  }

  for (const exception of check.exceptions) {
    await tx.insert(matchException).values({
      tenantId,
      goodsReceiptId,
      purchaseOrderLineId: exception.lineReference,
      code: exception.code,
      message: exception.message,
      amount: money(exception.amount),
    });
  }

  // Re-read to decide the order status: the cumulative columns were just moved
  // by the updates above, and a status derived from the pre-update values would
  // leave the last delivery of an order reading "partially received" forever.
  const after = await tx
    .select({
      quantity: purchaseOrderLine.quantity,
      quantityReceived: purchaseOrderLine.quantityReceived,
    })
    .from(purchaseOrderLine)
    .where(
      and(
        eq(purchaseOrderLine.tenantId, tenantId),
        eq(purchaseOrderLine.purchaseOrderId, input.purchaseOrderId),
      ),
    );

  const fullyReceived = after.every(
    (line) => num(line.quantityReceived) >= num(line.quantity) - 0.0001,
  );
  const anyReceived = after.some((line) => num(line.quantityReceived) > 0);
  const orderStatus = fullyReceived ? 'received' : anyReceived ? 'partially_received' : 'issued';

  await tx
    .update(purchaseOrder)
    .set({ status: orderStatus, updatedAt: new Date() })
    .where(and(eq(purchaseOrder.tenantId, tenantId), eq(purchaseOrder.id, input.purchaseOrderId)));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    action: 'create',
    entityType: 'procurement.goods_receipt',
    entityId: goodsReceiptId,
    entityLabel: allocated.formatted,
    metadata: {
      purchaseOrderNumber: order.number,
      accrualValue: accrualTotal,
      overDelivered: check.overDelivered,
      deliveryNoteReference: input.deliveryNoteReference,
    },
  });

  await emit(tx, {
    type: 'procurement.goods.received',
    sourceModule: MODULE_KEY,
    aggregateType: 'procurement.goods_receipt',
    aggregateId: goodsReceiptId,
    payload: {
      goodsReceiptId,
      purchaseOrderId: input.purchaseOrderId,
      projectId: order.projectId,
      supplierId: order.supplierId,
      accrualValue: accrualTotal,
    },
  });

  if (check.overDelivered) {
    await emit(tx, {
      type: 'procurement.receipt.over_delivered',
      sourceModule: MODULE_KEY,
      aggregateType: 'procurement.goods_receipt',
      aggregateId: goodsReceiptId,
      payload: { goodsReceiptId, exceptions: check.exceptions },
    });
  }

  return {
    goodsReceiptId,
    number: allocated.formatted,
    projectId: order.projectId,
    supplierId: order.supplierId,
    receivedOn,
    postings,
    accrualValue: accrualTotal,
    exceptions: check.exceptions,
    overDelivered: check.overDelivered,
    orderStatus,
  };
}

/**
 * Records where a receipt's stock movement and cost accrual landed.
 *
 * `goods_receipt_line` is append-only in the database, so this writes to a
 * separate lookup rather than updating the row — the immutability is the point,
 * and weakening it to store two foreign keys would trade a real guarantee for a
 * convenience.
 */
export async function linkReceiptPostings(
  tx: Transaction,
  input: {
    goodsReceiptId: string;
    postings: { goodsReceiptLineId: string; stockMovementId?: string | null; costEntryId?: string | null }[];
  },
): Promise<void> {
  const { tenantId } = requireTenantContext();

  for (const posting of input.postings) {
    await tx
      .update(goodsReceiptLine)
      .set({
        stockMovementId: posting.stockMovementId ?? null,
        costEntryId: posting.costEntryId ?? null,
      })
      .where(
        and(
          eq(goodsReceiptLine.tenantId, tenantId),
          eq(goodsReceiptLine.id, posting.goodsReceiptLineId),
        ),
      );
  }
}

// ---------------------------------------------------------------------------
// Supplier invoice and three-way matching
// ---------------------------------------------------------------------------

export interface RegisterInvoiceInput {
  supplierId: string;
  purchaseOrderId: string;
  countryCode: string;
  supplierReference: string;
  invoiceDate: string;
  receivedOn?: string;
  currencyCode?: string | null;
  exchangeRate?: number;
  supplierTaxNumber?: string | null;
  taxCode?: string | null;
  documentId?: string | null;
  notes?: string | null;
  lines: {
    purchaseOrderLineId: string | null;
    description: string;
    quantity: number;
    uomCode?: string | null;
    unitPrice: number;
    taxPercent?: number | null;
  }[];
}

export interface RegisterInvoiceResult {
  supplierInvoiceId: string;
  number: string;
  status: 'matched' | 'on_hold';
  exceptions: MatchException[];
  favourable: MatchException[];
  invoiceTotal: number;
  expectedTotal: number;
  variance: number;
  /** Set when matched and the order carries a commitment to relieve. */
  commitment: { commitmentId: string; invoicedBase: number } | null;
  /** Accruals to reverse — the receipt charged the job, this is the real cost. */
  baseValue: number;
  projectId: string | null;
}

/**
 * Registers a supplier invoice and matches it three ways.
 *
 * The invoice is written whatever the outcome. Refusing to record a failed
 * invoice is the intuitive design and the wrong one: the document exists, the
 * supplier will chase it, and an invoice that was never recorded cannot be
 * reported on, aged, or answered.
 */
export async function registerInvoice(
  tx: Transaction,
  input: RegisterInvoiceInput,
): Promise<RegisterInvoiceResult> {
  const { tenantId, userId } = requireTenantContext();

  if (input.lines.length === 0) {
    throw new ProcurementError('An invoice must have at least one line.');
  }
  const rate = input.exchangeRate ?? 1;
  if (!(rate > 0)) throw new ProcurementError('Exchange rate must be greater than zero.');

  const [order] = await tx
    .select()
    .from(purchaseOrder)
    .where(
      and(eq(purchaseOrder.tenantId, tenantId), eq(purchaseOrder.id, input.purchaseOrderId)),
    );
  if (!order) throw new ProcurementError('Purchase order not found.');

  const orderLines = await tx
    .select()
    .from(purchaseOrderLine)
    .where(
      and(
        eq(purchaseOrderLine.tenantId, tenantId),
        eq(purchaseOrderLine.purchaseOrderId, input.purchaseOrderId),
      ),
    )
    .orderBy(asc(purchaseOrderLine.lineNumber));

  const tolerance = await resolveTolerance(tx, input.countryCode);

  const domainOrderLines: PurchaseOrderLine[] = orderLines.map((line) => ({
    reference: line.id,
    itemId: line.itemId,
    description: line.description,
    quantityOrdered: num(line.quantity),
    unitPrice: num(line.unitPrice),
    quantityReceived: num(line.quantityReceived),
    quantityInvoiced: num(line.quantityInvoiced),
  }));

  const match = matchInvoice({
    orderLines: domainOrderLines,
    invoiceLines: input.lines.map((line) => ({
      purchaseOrderLineReference: line.purchaseOrderLineId,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
    })),
    tolerance,
  });

  const netValue = match.invoiceTotal;
  let taxAmount = 0;
  for (const line of input.lines) {
    taxAmount += line.quantity * line.unitPrice * ((line.taxPercent ?? 0) / 100);
  }
  const grossValue = netValue + taxAmount;
  const status = match.status === 'matched' ? 'matched' : 'on_hold';

  const allocated = await allocateNumber(tx, {
    entityType: 'procurement.supplier_invoice',
    documentDate: new Date(input.invoiceDate),
  });

  const [created] = await tx
    .insert(supplierInvoice)
    .values({
      tenantId,
      number: allocated.formatted,
      numberPeriod: allocated.period,
      numberValue: allocated.value,
      supplierId: input.supplierId,
      purchaseOrderId: input.purchaseOrderId,
      status,
      supplierReference: input.supplierReference,
      invoiceDate: input.invoiceDate,
      receivedOn: input.receivedOn ?? new Date().toISOString().slice(0, 10),
      dueOn: dueDate(input.invoiceDate, order.paymentTermDays),
      currencyCode: input.currencyCode ?? order.currencyCode,
      exchangeRate: String(rate),
      netValue: money(netValue),
      taxAmount: money(taxAmount),
      grossValue: money(grossValue),
      baseValue: money(grossValue * rate),
      supplierTaxNumber: input.supplierTaxNumber,
      taxCode: input.taxCode,
      matchedOn: new Date(),
      matchVariance: money(match.variance),
      holdReason:
        match.status === 'matched'
          ? null
          : match.exceptions.map((exception) => exception.message).join(' '),
      documentId: input.documentId,
      notes: input.notes,
      createdBy: userId,
    })
    .returning({ id: supplierInvoice.id });

  const supplierInvoiceId = created!.id;

  for (const [index, line] of input.lines.entries()) {
    const orderLine = line.purchaseOrderLineId
      ? orderLines.find((candidate) => candidate.id === line.purchaseOrderLineId)
      : undefined;

    await tx.insert(supplierInvoiceLine).values({
      tenantId,
      supplierInvoiceId,
      purchaseOrderLineId: orderLine ? orderLine.id : null,
      lineNumber: index + 1,
      description: line.description,
      quantity: qty(line.quantity),
      uomCode: line.uomCode,
      unitPrice: qty(line.unitPrice),
      lineValue: money(line.quantity * line.unitPrice),
      taxPercent: line.taxPercent == null ? null : String(line.taxPercent),
      expectedValue: orderLine ? money(line.quantity * num(orderLine.unitPrice)) : null,
    });
  }

  const writeException = async (exception: MatchException, isFavourable: boolean) => {
    const onOrderLine = orderLines.some((line) => line.id === exception.lineReference);
    await tx.insert(matchException).values({
      tenantId,
      supplierInvoiceId,
      purchaseOrderLineId: onOrderLine ? exception.lineReference : null,
      code: exception.code,
      message: exception.message,
      amount: money(exception.amount),
      isFavourable,
      // A favourable variance is not a problem to work through, so it opens
      // resolved. Leaving it open would bury the real holds in a queue of
      // undercharges nobody needs to action.
      resolution: isFavourable ? 'accepted' : 'open',
    });
  };

  for (const exception of match.exceptions) await writeException(exception, false);
  for (const exception of match.favourable) await writeException(exception, true);

  // Cumulative invoiced quantity moves ONLY on a clean match. Advancing it on a
  // held invoice would consume the line's remaining allowance, so a later
  // correct invoice for the same goods would itself be held.
  if (match.status === 'matched') {
    for (const line of input.lines) {
      if (!line.purchaseOrderLineId) continue;
      await tx
        .update(purchaseOrderLine)
        .set({
          quantityInvoiced: sql`${purchaseOrderLine.quantityInvoiced} + ${qty(line.quantity)}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(purchaseOrderLine.tenantId, tenantId),
            eq(purchaseOrderLine.id, line.purchaseOrderLineId),
          ),
        );
    }
  }

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    action: 'create',
    entityType: 'procurement.supplier_invoice',
    entityId: supplierInvoiceId,
    entityLabel: input.supplierReference,
    metadata: {
      purchaseOrderNumber: order.number,
      grossValue,
      status,
      variance: match.variance,
      exceptionCount: match.exceptions.length,
      exceptionValue:
        Math.round(match.exceptions.reduce((total, e) => total + e.amount, 0) * 100) / 100,
    },
  });

  await emit(tx, {
    type: match.status === 'matched' ? 'procurement.invoice.matched' : 'procurement.invoice.held',
    sourceModule: MODULE_KEY,
    aggregateType: 'procurement.supplier_invoice',
    aggregateId: supplierInvoiceId,
    payload: {
      supplierInvoiceId,
      purchaseOrderId: input.purchaseOrderId,
      supplierId: input.supplierId,
      projectId: order.projectId,
      baseValue: grossValue * rate,
      variance: match.variance,
      exceptions: match.exceptions,
    },
  });

  return {
    supplierInvoiceId,
    number: allocated.formatted,
    status,
    exceptions: match.exceptions,
    favourable: match.favourable,
    invoiceTotal: match.invoiceTotal,
    expectedTotal: match.expectedTotal,
    variance: match.variance,
    commitment:
      match.status === 'matched' && order.commitmentId
        ? { commitmentId: order.commitmentId, invoicedBase: grossValue * rate }
        : null,
    baseValue: grossValue * rate,
    projectId: order.projectId,
  };
}

/**
 * Releases a held invoice over its exceptions.
 *
 * The most abusable operation in the module, so it demands a reason, records who
 * gave it, resolves every open exception explicitly and emits its own event.
 * A release that looked identical to a clean match in the audit trail would make
 * the whole control decorative.
 */
export async function releaseInvoice(
  tx: Transaction,
  input: { supplierInvoiceId: string; reason: string },
): Promise<{ released: boolean; commitment: { commitmentId: string; invoicedBase: number } | null }> {
  const { tenantId, userId } = requireTenantContext();

  if (!input.reason?.trim()) {
    throw new ProcurementError('Releasing a held invoice requires a recorded reason.');
  }

  const [invoice] = await tx
    .select()
    .from(supplierInvoice)
    .where(
      and(eq(supplierInvoice.tenantId, tenantId), eq(supplierInvoice.id, input.supplierInvoiceId)),
    );
  if (!invoice) throw new ProcurementError('Supplier invoice not found.');
  if (invoice.status !== 'on_hold') {
    throw new ProcurementError(`Only a held invoice can be released; this one is ${invoice.status}.`);
  }

  const now = new Date();

  await tx
    .update(supplierInvoice)
    .set({
      status: 'approved',
      releasedBy: userId,
      releasedOn: now,
      notes: invoice.notes ? `${invoice.notes}\nReleased: ${input.reason}` : `Released: ${input.reason}`,
      updatedAt: now,
    })
    .where(
      and(eq(supplierInvoice.tenantId, tenantId), eq(supplierInvoice.id, input.supplierInvoiceId)),
    );

  await tx
    .update(matchException)
    .set({
      resolution: 'accepted',
      resolutionNote: input.reason,
      resolvedBy: userId,
      resolvedOn: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(matchException.tenantId, tenantId),
        eq(matchException.supplierInvoiceId, input.supplierInvoiceId),
        eq(matchException.resolution, 'open'),
      ),
    );

  // The quantities were deliberately not advanced when the invoice was held, so
  // they are advanced now — otherwise the released invoice would leave the line
  // able to be billed a second time.
  const lines = await tx
    .select()
    .from(supplierInvoiceLine)
    .where(
      and(
        eq(supplierInvoiceLine.tenantId, tenantId),
        eq(supplierInvoiceLine.supplierInvoiceId, input.supplierInvoiceId),
      ),
    );

  for (const line of lines) {
    if (!line.purchaseOrderLineId) continue;
    await tx
      .update(purchaseOrderLine)
      .set({
        quantityInvoiced: sql`${purchaseOrderLine.quantityInvoiced} + ${line.quantity}`,
        updatedAt: now,
      })
      .where(
        and(
          eq(purchaseOrderLine.tenantId, tenantId),
          eq(purchaseOrderLine.id, line.purchaseOrderLineId),
        ),
      );
  }

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    action: 'approve',
    entityType: 'procurement.supplier_invoice',
    entityId: input.supplierInvoiceId,
    entityLabel: invoice.supplierReference,
    reason: input.reason,
    metadata: { released: true, baseValue: num(invoice.baseValue) },
  });

  await emit(tx, {
    type: 'procurement.invoice.released',
    sourceModule: MODULE_KEY,
    aggregateType: 'procurement.supplier_invoice',
    aggregateId: input.supplierInvoiceId,
    payload: {
      supplierInvoiceId: input.supplierInvoiceId,
      supplierId: invoice.supplierId,
      baseValue: num(invoice.baseValue),
      reason: input.reason,
    },
  });

  let commitment: { commitmentId: string; invoicedBase: number } | null = null;
  if (invoice.purchaseOrderId) {
    const [order] = await tx
      .select({ commitmentId: purchaseOrder.commitmentId })
      .from(purchaseOrder)
      .where(
        and(
          eq(purchaseOrder.tenantId, tenantId),
          eq(purchaseOrder.id, invoice.purchaseOrderId),
        ),
      );
    if (order?.commitmentId) {
      commitment = {
        commitmentId: order.commitmentId,
        invoicedBase: num(invoice.baseValue),
      };
    }
  }

  return { released: true, commitment };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface OrderPosition {
  purchaseOrderId: string;
  number: string;
  status: string;
  supplierId: string;
  grossValue: number;
  baseValue: number;
  lines: {
    id: string;
    lineNumber: number;
    description: string;
    quantityOrdered: number;
    quantityReceived: number;
    quantityInvoiced: number;
    /** Received and not yet billed — what an invoice may claim. */
    availableToBill: number;
    /** Ordered and not yet delivered — what is still expected. */
    outstanding: number;
    unitPrice: number;
    lineValue: number;
  }[];
  /** Value ordered but not yet received. The open commitment. */
  outstandingValue: number;
}

export async function getOrderPosition(
  tx: Transaction,
  input: { purchaseOrderId: string },
): Promise<OrderPosition> {
  const { tenantId } = requireTenantContext();

  const [order] = await tx
    .select()
    .from(purchaseOrder)
    .where(
      and(eq(purchaseOrder.tenantId, tenantId), eq(purchaseOrder.id, input.purchaseOrderId)),
    );
  if (!order) throw new ProcurementError('Purchase order not found.');

  const lines = await tx
    .select()
    .from(purchaseOrderLine)
    .where(
      and(
        eq(purchaseOrderLine.tenantId, tenantId),
        eq(purchaseOrderLine.purchaseOrderId, input.purchaseOrderId),
      ),
    )
    .orderBy(asc(purchaseOrderLine.lineNumber));

  let outstandingValue = 0;
  const mapped = lines.map((line) => {
    const ordered = num(line.quantity);
    const received = num(line.quantityReceived);
    const invoiced = num(line.quantityInvoiced);
    const outstanding = Math.max(0, ordered - received);
    outstandingValue += outstanding * num(line.unitPrice);

    return {
      id: line.id,
      lineNumber: line.lineNumber,
      description: line.description,
      quantityOrdered: ordered,
      quantityReceived: received,
      quantityInvoiced: invoiced,
      availableToBill: received - invoiced,
      outstanding,
      unitPrice: num(line.unitPrice),
      lineValue: num(line.lineValue),
    };
  });

  return {
    purchaseOrderId: order.id,
    number: order.number ?? '',
    status: order.status,
    supplierId: order.supplierId,
    grossValue: num(order.grossValue),
    baseValue: num(order.baseValue),
    lines: mapped,
    outstandingValue: Math.round(outstandingValue * num(order.exchangeRate || '1') * 100) / 100,
  };
}

/** Open exceptions, largest first — the buyer's work queue. */
export async function getOpenExceptions(
  tx: Transaction,
  input: { supplierInvoiceId?: string } = {},
): Promise<(typeof matchException.$inferSelect)[]> {
  const { tenantId } = requireTenantContext();

  const conditions = [
    eq(matchException.tenantId, tenantId),
    eq(matchException.resolution, 'open'),
  ];
  if (input.supplierInvoiceId) {
    conditions.push(eq(matchException.supplierInvoiceId, input.supplierInvoiceId));
  }

  return tx
    .select()
    .from(matchException)
    .where(and(...conditions))
    .orderBy(sql`${matchException.amount} desc`);
}

function dueDate(invoiceDate: string, termDays: number | null): string | null {
  if (termDays == null) return null;
  const date = new Date(`${invoiceDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + termDays);
  return date.toISOString().slice(0, 10);
}

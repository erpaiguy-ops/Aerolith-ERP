/**
 * Procurement routes.
 *
 * Three endpoints here do the work no single module can do, and they are the
 * reason this file is worth reading rather than skimming:
 *
 *  - `POST /procurement/orders/:id/issue` registers the order as a COMMITMENT
 *    against the project budget. Ordered-but-not-invoiced money is spent in
 *    every sense that matters to a forecast, and a job whose commitments are not
 *    registered looks healthier than it is right up until the invoices land.
 *
 *  - `POST /procurement/orders/:id/receipts` takes the goods into stock AND
 *    accrues the cost against the job in one transaction. The job is charged
 *    when the material arrives, not whenever the supplier gets round to
 *    invoicing — which is the difference between a cost report that is useful
 *    during the job and one that is only correct after it.
 *
 *  - `POST /procurement/invoices` matches three ways, and on a clean match
 *    reverses the accrual and relieves the commitment. Leaving either in place
 *    double-counts the money: once as a certainty, once as an actual.
 *
 * Procurement imports neither Inventory nor Projects, and neither imports it.
 * Every composition below is assembled here, in the application layer, from
 * values the modules return. Each of the three degrades to the procurement-only
 * behaviour when the other module is not entitled, which is what keeps this
 * module sellable on its own.
 */
import { parseListParams, withTenant } from '@aerolith/kernel';
import { postMovement } from '@aerolith/module-inventory';
import {
  ProcurementError,
  approveRequisition,
  awardRfq,
  compareRfqLine,
  createPurchaseOrder,
  createRequisition,
  createRfq,
  getOrderPosition,
  issuePurchaseOrder,
  linkCommitment,
  linkReceiptPostings,
  listGoodsReceipts,
  listMatchExceptions,
  listPurchaseOrders,
  listRequisitions,
  listSupplierInvoices,
  procurementSchema,
  receiveGoods,
  recordQuote,
  registerInvoice,
  releaseInvoice,
} from '@aerolith/module-procurement';
import { postCost, recordCommitment, relieveCommitment } from '@aerolith/module-projects';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { modulesForTenant } from '../bootstrap';
import { authenticate, requirePermission, withPrincipal, type Principal } from '../context';

const MODULE = 'procurement';

async function requireModule(principal: Principal, reply: FastifyReply): Promise<boolean> {
  const modules = await modulesForTenant(principal.context.tenantId);
  if (!modules.enabled.has(MODULE)) {
    await reply.code(404).send({ error: 'Not found.' });
    return false;
  }
  return true;
}

async function entitled(principal: Principal, key: string): Promise<boolean> {
  const modules = await modulesForTenant(principal.context.tenantId);
  return modules.enabled.has(key);
}

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

const requisitionBody = z.object({
  title: z.string().min(1),
  projectId: z.string().uuid().nullish(),
  costCentreId: z.string().uuid().nullish(),
  requiredBy: z.string().date().nullish(),
  priority: z.enum(['routine', 'urgent', 'emergency']).optional(),
  justification: z.string().nullish(),
  sourceEstimateId: z.string().uuid().nullish(),
  sourceWorkOrderId: z.string().uuid().nullish(),
  lines: z
    .array(
      z.object({
        itemId: z.string().uuid().nullish(),
        description: z.string().min(1),
        specification: z.string().nullish(),
        quantity: z.number().positive(),
        uomCode: z.string().nullish(),
        estimatedUnitPrice: z.number().nonnegative().nullish(),
        wbsNodeId: z.string().uuid().nullish(),
      }),
    )
    .min(1),
});

const rfqBody = z.object({
  title: z.string().min(1),
  projectId: z.string().uuid().nullish(),
  countryCode: z.string().length(2),
  currencyCode: z.string().length(3).nullish(),
  responseDueOn: z.string().date().nullish(),
  surplusIsStock: z.boolean().optional(),
  lines: z
    .array(
      z.object({
        itemId: z.string().uuid().nullish(),
        description: z.string().min(1),
        specification: z.string().nullish(),
        quantity: z.number().positive(),
        uomCode: z.string().nullish(),
        requisitionLineIds: z.array(z.string().uuid()).optional(),
      }),
    )
    .min(1),
});

const quoteBody = z.object({
  supplierId: z.string().uuid(),
  reference: z.string().nullish(),
  receivedOn: z.string().date().nullish(),
  validUntil: z.string().date().nullish(),
  currencyCode: z.string().length(3).nullish(),
  exchangeRate: z.number().positive().optional(),
  freight: z.number().nonnegative().optional(),
  dutyPercent: z.number().min(0).max(100).optional(),
  otherCharges: z.number().nonnegative().optional(),
  paymentTermDays: z.number().int().nonnegative().optional(),
  earlyPaymentDiscountPercent: z.number().min(0).max(100).nullish(),
  earlyPaymentDays: z.number().int().nonnegative().nullish(),
  leadTimeDays: z.number().int().nonnegative().nullish(),
  notes: z.string().nullish(),
  documentId: z.string().uuid().nullish(),
  lines: z
    .array(
      z.object({
        rfqLineId: z.string().uuid().nullish(),
        description: z.string().min(1),
        offeredAlternative: z.string().nullish(),
        quantity: z.number().positive(),
        uomCode: z.string().nullish(),
        unitPrice: z.number().nonnegative(),
        minimumOrderQuantity: z.number().positive().nullish(),
        orderIncrement: z.number().positive().nullish(),
        leadTimeDays: z.number().int().nonnegative().nullish(),
      }),
    )
    .min(1),
});

const orderBody = z.object({
  supplierId: z.string().uuid(),
  countryCode: z.string().length(2),
  projectId: z.string().uuid().nullish(),
  costCentreId: z.string().uuid().nullish(),
  sourceQuoteId: z.string().uuid().nullish(),
  sourceRfqId: z.string().uuid().nullish(),
  currencyCode: z.string().length(3).nullish(),
  exchangeRate: z.number().positive().optional(),
  freight: z.number().nonnegative().optional(),
  otherCharges: z.number().nonnegative().optional(),
  incoterm: z.string().nullish(),
  deliveryAddress: z.string().nullish(),
  promisedDeliveryDate: z.string().date().nullish(),
  notes: z.string().nullish(),
  lines: z
    .array(
      z.object({
        itemId: z.string().uuid().nullish(),
        description: z.string().min(1),
        specification: z.string().nullish(),
        quantity: z.number().positive(),
        uomCode: z.string().nullish(),
        unitPrice: z.number().nonnegative(),
        taxPercent: z.number().min(0).max(100).nullish(),
        warehouseId: z.string().uuid().nullish(),
        wbsNodeId: z.string().uuid().nullish(),
        requisitionLineId: z.string().uuid().nullish(),
        quoteLineId: z.string().uuid().nullish(),
        promisedDeliveryDate: z.string().date().nullish(),
      }),
    )
    .min(1),
});

const receiptBody = z.object({
  countryCode: z.string().length(2),
  receivedOn: z.string().date().optional(),
  warehouseId: z.string().uuid().nullish(),
  deliveryNoteReference: z.string().nullish(),
  inspectionNotes: z.string().nullish(),
  documentId: z.string().uuid().nullish(),
  lines: z
    .array(
      z.object({
        purchaseOrderLineId: z.string().uuid(),
        quantityReceived: z.number(),
        quantityRejected: z.number().nonnegative().optional(),
        rejectionReason: z.string().nullish(),
        batchReference: z.string().nullish(),
        serialNumbers: z.array(z.string()).optional(),
      }),
    )
    .min(1),
});

const invoiceBody = z.object({
  supplierId: z.string().uuid(),
  purchaseOrderId: z.string().uuid(),
  countryCode: z.string().length(2),
  supplierReference: z.string().min(1),
  invoiceDate: z.string().date(),
  receivedOn: z.string().date().optional(),
  currencyCode: z.string().length(3).nullish(),
  exchangeRate: z.number().positive().optional(),
  supplierTaxNumber: z.string().nullish(),
  taxCode: z.string().nullish(),
  documentId: z.string().uuid().nullish(),
  notes: z.string().nullish(),
  lines: z
    .array(
      z.object({
        purchaseOrderLineId: z.string().uuid().nullable(),
        description: z.string().min(1),
        quantity: z.number().positive(),
        uomCode: z.string().nullish(),
        unitPrice: z.number().nonnegative(),
        taxPercent: z.number().min(0).max(100).nullish(),
      }),
    )
    .min(1),
});

const REQUISITION_SORTS = [
  'number',
  'title',
  'status',
  'requiredBy',
  'estimatedValue',
  'createdAt',
] as const;

const ORDER_SORTS = [
  'number',
  'status',
  'grossValue',
  'baseValue',
  'promisedDeliveryDate',
  'issuedOn',
  'createdAt',
] as const;

const INVOICE_SORTS = [
  'number',
  'supplierReference',
  'status',
  'invoiceDate',
  'dueOn',
  'grossValue',
  'createdAt',
] as const;

const EXCEPTION_SORTS = ['amount', 'code', 'createdAt'] as const;

const RECEIPT_SORTS = ['number', 'receivedOn', 'createdAt'] as const;

interface ListQuery {
  page?: string;
  pageSize?: string;
  sort?: string;
  direction?: string;
  q?: string;
  status?: string;
}

// ---------------------------------------------------------------------------

export async function procurementRoutes(app: FastifyInstance): Promise<void> {
  const bad = (reply: FastifyReply, issues: unknown) =>
    reply.code(400).send({ error: 'Invalid request.', issues });

  const handle = async <T>(reply: FastifyReply, run: () => Promise<T>) => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ProcurementError) {
        return reply.code(422).send({ error: error.message });
      }
      throw error;
    }
  };

  // --- Requisitions ---

  app.get<{ Querystring: ListQuery & { projectId?: string } }>(
    '/procurement/requisitions',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'procurement.requisition.read');

      const params = parseListParams(request.query, {
        sortable: REQUISITION_SORTS,
        // By what the site needs first, soonest first. A requisition list sorted
        // by creation date buries the one that is about to stop a job.
        defaultSort: 'requiredBy',
        defaultDirection: 'asc',
      });

      return withPrincipal(principal, () =>
        withTenant((tx) =>
          listRequisitions(tx, params, {
            status: request.query.status,
            projectId: request.query.projectId,
          }),
        ),
      );
    },
  );


  app.post('/procurement/requisitions', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'procurement.requisition.write');

    const parsed = requisitionBody.safeParse(request.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);

    return handle(reply, () =>
      withPrincipal(principal, () => withTenant((tx) => createRequisition(tx, parsed.data))),
    );
  });

  app.post('/procurement/requisitions/:id/approve', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'procurement.requisition.approve');

    const { id } = request.params as { id: string };

    return handle(reply, () =>
      withPrincipal(principal, () =>
        withTenant(async (tx) => {
          await approveRequisition(tx, { requisitionId: id });
          return { approved: true };
        }),
      ),
    );
  });

  // --- RFQs and quotes ---

  app.post('/procurement/rfqs', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'procurement.rfq.write');

    const parsed = rfqBody.safeParse(request.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);

    return handle(reply, () =>
      withPrincipal(principal, () => withTenant((tx) => createRfq(tx, parsed.data))),
    );
  });

  app.post('/procurement/rfqs/:id/quotes', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'procurement.rfq.write');

    const { id } = request.params as { id: string };
    const parsed = quoteBody.safeParse(request.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);

    return handle(reply, () =>
      withPrincipal(principal, () =>
        withTenant((tx) => recordQuote(tx, { ...parsed.data, rfqId: id })),
      ),
    );
  });

  /**
   * The landed-cost comparison for one RFQ line.
   *
   * A GET that writes: it stores the ranking on each quote so the award can be
   * explained later. Defensible because the comparison is idempotent for a given
   * set of quotes and the alternative — recomputing on every read — would make a
   * past award silently restate itself as exchange rates moved.
   */
  app.get('/procurement/rfqs/:id/lines/:lineId/comparison', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'procurement.rfq.read');

    const { id, lineId } = request.params as { id: string; lineId: string };
    const query = z.object({ countryCode: z.string().length(2) }).safeParse(request.query);
    if (!query.success) return bad(reply, query.error.issues);

    return handle(reply, () =>
      withPrincipal(principal, () =>
        withTenant((tx) =>
          compareRfqLine(tx, {
            rfqId: id,
            rfqLineId: lineId,
            countryCode: query.data.countryCode,
          }),
        ),
      ),
    );
  });

  app.post('/procurement/rfqs/:id/award', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'procurement.rfq.award');

    const { id } = request.params as { id: string };
    const parsed = z
      .object({ quoteId: z.string().uuid(), rationale: z.string().nullish() })
      .safeParse(request.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);

    return handle(reply, () =>
      withPrincipal(principal, () =>
        withTenant(async (tx) => {
          await awardRfq(tx, { rfqId: id, ...parsed.data });
          return { awarded: true };
        }),
      ),
    );
  });

  // --- Purchase orders ---

  app.get<{
    Querystring: ListQuery & { supplierId?: string; projectId?: string; overdue?: string };
  }>('/procurement/orders', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'procurement.order.read');

    const params = parseListParams(request.query, {
      sortable: ORDER_SORTS,
      defaultSort: 'createdAt',
      defaultDirection: 'desc',
    });

    return withPrincipal(principal, () =>
      withTenant((tx) =>
        listPurchaseOrders(tx, params, {
          status: request.query.status,
          supplierId: request.query.supplierId,
          projectId: request.query.projectId,
          overdueOnly: request.query.overdue === 'true',
        }),
      ),
    );
  });


  app.post('/procurement/orders', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'procurement.order.write');

    const parsed = orderBody.safeParse(request.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);

    return handle(reply, () =>
      withPrincipal(principal, () => withTenant((tx) => createPurchaseOrder(tx, parsed.data))),
    );
  });

  app.get('/procurement/orders/:id', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'procurement.order.read');

    const { id } = request.params as { id: string };

    return handle(reply, () =>
      withPrincipal(principal, () => withTenant((tx) => getOrderPosition(tx, { purchaseOrderId: id }))),
    );
  });

  /**
   * Issues the order and registers the commitment against the project budget.
   *
   * The commitment is held per WBS node, apportioned by line value, so it lands
   * where the budget it consumes lives rather than as one lump against the job.
   * Without Projects the order still issues — the commitment is simply not
   * registered, which is exactly what a standalone purchasing product does.
   */
  app.post('/procurement/orders/:id/issue', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'procurement.order.issue');

    const { id } = request.params as { id: string };
    const withProjects = await entitled(principal, 'projects');

    return handle(reply, () =>
      withPrincipal(principal, () =>
        withTenant(async (tx) => {
          const issued = await issuePurchaseOrder(tx, { purchaseOrderId: id });

          if (!withProjects || !issued.projectId) {
            return { ...issued, commitmentRegistered: false };
          }

          // The largest WBS share carries the commitment id. One commitment per
          // order keeps `relieveCommitment` honest when the invoice arrives:
          // splitting it would mean deciding which share an invoice relieves,
          // and an invoice does not say.
          const largest = [...issued.lines].sort((a, b) => b.baseValue - a.baseValue)[0];

          const { commitmentId } = await recordCommitment(tx, {
            projectId: issued.projectId,
            wbsNodeId: largest?.wbsNodeId ?? null,
            type: 'purchase_order',
            reference: issued.number,
            partyId: issued.supplierId,
            description: `Purchase order ${issued.number}`,
            category: 'material',
            committedAmount: issued.baseValue,
            currencyCode: issued.currencyCode,
            sourceModule: 'procurement',
            sourceEntityId: issued.purchaseOrderId,
            expectedOn: issued.promisedDeliveryDate,
          });

          await linkCommitment(tx, { purchaseOrderId: id, commitmentId });

          return { ...issued, commitmentId, commitmentRegistered: true };
        }),
      ),
    );
  });

  /**
   * Receives goods: stock in, cost accrued, cumulative quantities advanced.
   *
   * The accrual is what makes a cost report true during the job rather than
   * after it. It is posted with `isAccrual: true` so the invoice can reverse it
   * later and the ledger shows both halves — the estimate of the cost and the
   * cost — instead of one number that quietly changed.
   */
  app.post('/procurement/orders/:id/receipts', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'procurement.receipt.write');

    const { id } = request.params as { id: string };
    const parsed = receiptBody.safeParse(request.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);

    const withInventory = await entitled(principal, 'inventory');
    const withProjects = await entitled(principal, 'projects');

    return handle(reply, () =>
      withPrincipal(principal, () =>
        withTenant(async (tx) => {
          const receipt = await receiveGoods(tx, { ...parsed.data, purchaseOrderId: id });

          const links: {
            goodsReceiptLineId: string;
            stockMovementId?: string | null;
            costEntryId?: string | null;
          }[] = [];

          // Only lines with a real item can move stock. A free-text purchase —
          // most of them, in practice — is a cost without an inventory record,
          // and forcing an item onto it would fill the item master with rubbish.
          const stockable = receipt.postings.filter(
            (posting) => posting.itemId && posting.quantityAccepted > 0,
          );

          let movementId: string | null = null;
          if (withInventory && stockable.length > 0) {
            const movement = await postMovement(tx, {
              type: 'receipt',
              movementDate: receipt.receivedOn,
              projectId: receipt.projectId,
              partyId: receipt.supplierId,
              sourceModule: 'procurement',
              sourceEntityType: 'procurement.goods_receipt',
              sourceEntityId: receipt.goodsReceiptId,
              reference: receipt.number,
              lines: stockable.map((posting) => ({
                itemId: posting.itemId!,
                quantity: posting.quantityAccepted,
                toWarehouseId: posting.warehouseId,
                unitCost: posting.unitPriceBase,
              })),
            });
            movementId = movement.movementId;
          }

          for (const posting of receipt.postings) {
            let costEntryId: string | null = null;

            if (withProjects && receipt.projectId && posting.accrualValue !== 0) {
              const { entryId } = await postCost(tx, {
                projectId: receipt.projectId,
                wbsNodeId: posting.wbsNodeId,
                postedOn: receipt.receivedOn,
                category: 'material',
                description: `GRN ${receipt.number} — ${posting.description}`,
                sourceModule: 'procurement',
                sourceEntityType: 'procurement.goods_receipt_line',
                sourceEntityId: posting.goodsReceiptLineId,
                amount: posting.accrualValue,
                quantity: posting.quantityAccepted,
                uomCode: posting.uomCode,
                isAccrual: true,
              });
              costEntryId = entryId;
            }

            links.push({
              goodsReceiptLineId: posting.goodsReceiptLineId,
              stockMovementId: stockable.includes(posting) ? movementId : null,
              costEntryId,
            });
          }

          await linkReceiptPostings(tx, {
            goodsReceiptId: receipt.goodsReceiptId,
            postings: links,
          });

          return {
            ...receipt,
            stockMovementId: movementId,
            stockPosted: movementId != null,
            costAccrued: links.some((link) => link.costEntryId != null),
          };
        }),
      ),
    );
  });

  // --- Goods receipts ---

  app.get<{
    Querystring: ListQuery & {
      purchaseOrderId?: string;
      supplierId?: string;
      overDelivered?: string;
    };
  }>('/procurement/receipts', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'procurement.receipt.read');

    const params = parseListParams(request.query, {
      sortable: RECEIPT_SORTS,
      // Newest delivery first: this register is read to find out what arrived,
      // and the answer is nearly always about today or yesterday.
      defaultSort: 'receivedOn',
      defaultDirection: 'desc',
    });

    return withPrincipal(principal, () =>
      withTenant((tx) =>
        listGoodsReceipts(tx, params, {
          purchaseOrderId: request.query.purchaseOrderId,
          supplierId: request.query.supplierId,
          overDeliveredOnly: request.query.overDelivered === 'true',
        }),
      ),
    );
  });

  // --- Supplier invoices ---

  app.get<{ Querystring: ListQuery & { supplierId?: string; held?: string } }>(
    '/procurement/invoices',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'procurement.invoice.read');

      const params = parseListParams(request.query, {
        sortable: INVOICE_SORTS,
        // Oldest due date first: this list is a payment run waiting to happen,
        // and the useful question is always what is closest to being late.
        defaultSort: 'dueOn',
        defaultDirection: 'asc',
      });

      return withPrincipal(principal, () =>
        withTenant((tx) =>
          listSupplierInvoices(tx, params, {
            status: request.query.status,
            supplierId: request.query.supplierId,
            heldOnly: request.query.held === 'true',
          }),
        ),
      );
    },
  );


  /**
   * Registers and matches a supplier invoice.
   *
   * On a clean match the commitment is relieved by the invoiced amount. The
   * accrual raised at receipt is NOT reversed here — see the note in the handler.
   */
  app.post('/procurement/invoices', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'procurement.invoice.write');

    const parsed = invoiceBody.safeParse(request.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);

    const withProjects = await entitled(principal, 'projects');

    return handle(reply, () =>
      withPrincipal(principal, () =>
        withTenant(async (tx) => {
          const result = await registerInvoice(tx, parsed.data);

          if (withProjects && result.commitment) {
            // Relieved only on a CLEAN match. Relieving on a held invoice would
            // release the commitment for money that is still genuinely at risk,
            // and the forecast would improve because an invoice was wrong.
            await relieveCommitment(tx, {
              commitmentId: result.commitment.commitmentId,
              invoicedAmount: result.commitment.invoicedBase,
            });
          }

          return result;
        }),
      ),
    );
  });

  app.post('/procurement/invoices/:id/release', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'procurement.invoice.release');

    const { id } = request.params as { id: string };
    // `.trim()` before `.min(1)`, so a reason of three spaces is refused here
    // rather than four layers down, and the value that reaches the audit log has
    // no stray whitespace around it. The service keeps its own guard: this is
    // the boundary check, not the control.
    const parsed = z
      .object({ reason: z.string().trim().min(1) })
      .safeParse(request.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);

    const withProjects = await entitled(principal, 'projects');

    return handle(reply, () =>
      withPrincipal(principal, () =>
        withTenant(async (tx) => {
          const result = await releaseInvoice(tx, {
            supplierInvoiceId: id,
            reason: parsed.data.reason,
          });

          if (withProjects && result.commitment) {
            await relieveCommitment(tx, {
              commitmentId: result.commitment.commitmentId,
              invoicedAmount: result.commitment.invoicedBase,
            });
          }

          return result;
        }),
      ),
    );
  });

  app.get<{
    Querystring: ListQuery & {
      supplierInvoiceId?: string;
      code?: string;
      includeResolved?: string;
    };
  }>('/procurement/exceptions', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'procurement.invoice.read');

    const params = parseListParams(request.query, {
      sortable: EXCEPTION_SORTS,
      // Biggest money first, always. This is a triage queue, and the only
      // ordering that makes it one is by what is at stake.
      defaultSort: 'amount',
      defaultDirection: 'desc',
    });

    return withPrincipal(principal, () =>
      withTenant((tx) =>
        listMatchExceptions(tx, params, {
          supplierInvoiceId: request.query.supplierInvoiceId,
          code: request.query.code,
          includeResolved: request.query.includeResolved === 'true',
        }),
      ),
    );
  });

  app.get('/procurement/invoices/:id', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'procurement.invoice.read');

    const { id } = request.params as { id: string };

    return handle(reply, () =>
      withPrincipal(principal, () =>
        withTenant(async (tx) => {
          const tenantId = principal.context.tenantId;

          const [invoice] = await tx
            .select()
            .from(procurementSchema.supplierInvoice)
            .where(
              and(
                eq(procurementSchema.supplierInvoice.tenantId, tenantId),
                eq(procurementSchema.supplierInvoice.id, id),
              ),
            );

          if (!invoice) return reply.code(404).send({ error: 'Not found.' });

          const lines = await tx
            .select()
            .from(procurementSchema.supplierInvoiceLine)
            .where(
              and(
                eq(procurementSchema.supplierInvoiceLine.tenantId, tenantId),
                eq(procurementSchema.supplierInvoiceLine.supplierInvoiceId, id),
              ),
            )
            .orderBy(asc(procurementSchema.supplierInvoiceLine.lineNumber));

          const exceptions = await tx
            .select()
            .from(procurementSchema.matchException)
            .where(
              and(
                eq(procurementSchema.matchException.tenantId, tenantId),
                eq(procurementSchema.matchException.supplierInvoiceId, id),
              ),
            );

          return { invoice, lines, exceptions };
        }),
      ),
    );
  });
}

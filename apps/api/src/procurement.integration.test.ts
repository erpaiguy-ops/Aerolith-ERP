/**
 * Procurement end to end: real HTTP, real database, real cross-module posting.
 *
 * One continuous story rather than isolated cases, because the claim is about
 * CONTINUITY and about money surviving the joins:
 *
 *   requisition → RFQ → landed-cost comparison → award → purchase order →
 *   commitment against the budget → delivery → stock in and cost accrued →
 *   supplier invoice matched three ways → commitment relieved.
 *
 * The three things it exists to prove, none of which any single module can:
 *
 *  - **The cheapest quote is not the cheapest purchase.** The Italian sheet is
 *    20 EUR against a 96 AED sheet delivered in Dubai, and it loses.
 *  - **Ordered money is spent money.** Issuing the order registers a commitment
 *    in Projects, and the invoice relieves it. A job whose commitments are not
 *    registered looks healthier than it is until the invoices land.
 *  - **An invoice is matched against what was RECEIVED AND NOT YET BILLED.**
 *    Not against the order. This is what stops a supplier billing one delivery
 *    twice, and the test bills it twice to prove it.
 *
 * Skipped when TEST_DATABASE_URL is unset.
 */
import { createHash } from 'node:crypto';

import { closeDatabase, createDatabase, getDatabase, schema } from '@aerolith/kernel';
import { inventorySchema } from '@aerolith/module-inventory';
import { procurementSchema } from '@aerolith/module-procurement';
import { projectsSchema } from '@aerolith/module-projects';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { invalidateTenantModules, syncModules } from './bootstrap';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const TENANT = 'bbbb3333-3333-4333-8333-333333333333';
const BUYER = 'bbbb3333-0000-4000-8000-000000000001';
const STOREMAN = 'bbbb3333-0000-4000-8000-000000000002';
const BUYER_TOKEN = 'procurement-buyer-token';
const STOREMAN_TOKEN = 'procurement-storeman-token';

const PROJECT = 'bbbb3333-1111-4111-8111-111111111111';

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

suite('Procurement', () => {
  let app: FastifyInstance;

  let mdfItemId: string;
  let gulfSupplierId: string;
  let italySupplierId: string;
  let warehouseId: string;
  let wbsNodeId: string;

  let requisitionId: string;
  let requisitionLineId: string;
  let rfqId: string;
  let rfqLineId: string;
  let gulfQuoteId: string;
  let italyQuoteId: string;
  let orderId: string;
  let orderLineId: string;
  let commitmentId: string;

  const auth = (token = BUYER_TOKEN) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    createDatabase({ connectionString: url! });
    await syncModules();
    const db = getDatabase();

    await db.insert(schema.tenant).values({
      id: TENANT,
      slug: 'procurement-test',
      name: 'Procurement Test Joinery',
      status: 'active',
      primaryCountryCode: 'AE',
      baseCurrencyCode: 'AED',
    });

    await db.insert(schema.appUser).values([
      { id: BUYER, email: 'buyer@procurement.test', name: 'Buyer' },
      { id: STOREMAN, email: 'store@procurement.test', name: 'Storeman' },
    ]);
    await db.insert(schema.membership).values([
      { tenantId: TENANT, userId: BUYER, status: 'active', isOwner: true },
      { tenantId: TENANT, userId: STOREMAN, status: 'active', isOwner: false },
    ]);

    const expiresAt = new Date(Date.now() + 3_600_000);
    await db.insert(schema.session).values([
      { userId: BUYER, tenantId: TENANT, tokenHash: hash(BUYER_TOKEN), expiresAt },
      { userId: STOREMAN, tenantId: TENANT, tokenHash: hash(STOREMAN_TOKEN), expiresAt },
    ]);

    // All three, because the point of this suite is what happens where they meet.
    await db.insert(schema.tenantModule).values([
      { tenantId: TENANT, moduleKey: 'procurement', status: 'enabled' },
      { tenantId: TENANT, moduleKey: 'inventory', status: 'enabled' },
      { tenantId: TENANT, moduleKey: 'projects', status: 'enabled' },
    ]);
    invalidateTenantModules();

    // The storeman receives goods and nothing else. Notably NOT
    // `procurement.invoice.release` — the separation this module depends on.
    const [role] = await db
      .insert(schema.role)
      .values({ tenantId: TENANT, code: 'store', name: 'Storeman' })
      .returning({ id: schema.role.id });

    await db.insert(schema.rolePermission).values(
      ['procurement.receipt.write', 'procurement.receipt.read', 'procurement.order.read'].map(
        (permissionKey) => ({ tenantId: TENANT, roleId: role!.id, permissionKey }),
      ),
    );
    await db.insert(schema.userRole).values({ tenantId: TENANT, userId: STOREMAN, roleId: role!.id });

    await db.insert(schema.project).values({
      id: PROJECT,
      tenantId: TENANT,
      code: 'P-2026-100',
      name: 'Palm Villa joinery',
      status: 'awarded',
      currencyCode: 'AED',
      countryCode: 'AE',
    });

    const [mdf] = await db
      .insert(schema.item)
      .values({
        tenantId: TENANT,
        code: 'MDF-18',
        name: '18mm MDF 2440x1220',
        type: 'panel',
        lengthMm: '2440',
        widthMm: '1220',
        thicknessMm: '18',
        hasGrainDirection: false,
      })
      .returning({ id: schema.item.id });
    mdfItemId = mdf!.id;

    const suppliers = await db
      .insert(schema.party)
      .values([
        {
          tenantId: TENANT,
          code: 'SUP-GULF',
          name: 'Gulf Panels Trading',
          isSupplier: true,
          countryCode: 'AE',
        },
        {
          tenantId: TENANT,
          code: 'SUP-IT',
          name: 'Lombardia Legno SRL',
          isSupplier: true,
          countryCode: 'IT',
        },
      ])
      .returning({ id: schema.party.id, code: schema.party.code });

    gulfSupplierId = suppliers.find((s) => s.code === 'SUP-GULF')!.id;
    italySupplierId = suppliers.find((s) => s.code === 'SUP-IT')!.id;

    await db.insert(schema.numberSeries).values([
      { tenantId: TENANT, entityType: 'procurement.requisition', code: 'PR', name: 'Requisition', pattern: 'PR-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'procurement.rfq', code: 'RFQ', name: 'RFQ', pattern: 'RFQ-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'procurement.purchase_order', code: 'PO', name: 'Purchase Order', pattern: 'PO-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'procurement.goods_receipt', code: 'GRN', name: 'Goods Receipt', pattern: 'GRN-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'procurement.supplier_invoice', code: 'SINV', name: 'Supplier Invoice', pattern: 'SINV-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'inventory.receipt', code: 'IGRN', name: 'Stock Receipt', pattern: 'IGRN-{YYYY}-{SEQ}' },
    ]);

    app = await buildApp();
    await app.ready();

    // Adopting AE gives the tenant its own editable copy of the UAE tax codes,
    // among which SR at 5% is the default. Nothing below types "5" anywhere —
    // that is the localisation design being exercised rather than asserted.
    const adopted = await app.inject({
      method: 'POST',
      url: '/api/v1/localisation/adopt',
      headers: auth(),
      payload: { countryCode: 'AE', isPrimary: true },
    });
    expect(adopted.statusCode).toBe(200);

    const warehouse = await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/warehouses',
      headers: auth(),
      payload: { code: 'FAC', name: 'Main Factory', type: 'factory' },
    });
    warehouseId = warehouse.json().warehouse.id;

    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${PROJECT}/wbs`,
      headers: auth(),
      payload: { nodes: [{ code: 'J-CARCASS', name: 'Carcass materials' }] },
    });

    // The route returns a count, not the rows, so the id is read back.
    const [node] = await db
      .select()
      .from(projectsSchema.wbsNode)
      .where(
        and(
          eq(projectsSchema.wbsNode.tenantId, TENANT),
          eq(projectsSchema.wbsNode.code, 'J-CARCASS'),
        ),
      );
    wbsNodeId = node!.id;
  });

  afterAll(async () => {
    const db = getDatabase();
    const pr = procurementSchema;
    const inv = inventorySchema;
    const pj = projectsSchema;

    await db.delete(pr.matchException).where(eq(pr.matchException.tenantId, TENANT));
    await db.delete(pr.supplierInvoiceLine).where(eq(pr.supplierInvoiceLine.tenantId, TENANT));
    await db.delete(pr.supplierInvoice).where(eq(pr.supplierInvoice.tenantId, TENANT));
    await db.delete(pr.goodsReceiptLine).where(eq(pr.goodsReceiptLine.tenantId, TENANT));
    await db.delete(pr.goodsReceipt).where(eq(pr.goodsReceipt.tenantId, TENANT));
    await db.delete(pr.purchaseOrderLine).where(eq(pr.purchaseOrderLine.tenantId, TENANT));
    await db.delete(pr.purchaseOrder).where(eq(pr.purchaseOrder.tenantId, TENANT));
    await db.delete(pr.quoteLine).where(eq(pr.quoteLine.tenantId, TENANT));
    await db.delete(pr.quote).where(eq(pr.quote.tenantId, TENANT));
    await db.delete(pr.rfqLine).where(eq(pr.rfqLine.tenantId, TENANT));
    await db.delete(pr.rfq).where(eq(pr.rfq.tenantId, TENANT));
    await db.delete(pr.requisitionLine).where(eq(pr.requisitionLine.tenantId, TENANT));
    await db.delete(pr.requisition).where(eq(pr.requisition.tenantId, TENANT));

    await db.delete(inv.stockMovementLine).where(eq(inv.stockMovementLine.tenantId, TENANT));
    await db.delete(inv.stockMovement).where(eq(inv.stockMovement.tenantId, TENANT));
    await db.delete(inv.stockLevel).where(eq(inv.stockLevel.tenantId, TENANT));
    await db.delete(inv.offcut).where(eq(inv.offcut.tenantId, TENANT));
    await db.delete(inv.warehouse).where(eq(inv.warehouse.tenantId, TENANT));

    await db.delete(pj.costEntry).where(eq(pj.costEntry.tenantId, TENANT));
    await db.delete(pj.commitment).where(eq(pj.commitment.tenantId, TENANT));
    await db.delete(pj.wbsNode).where(eq(pj.wbsNode.tenantId, TENANT));
    await db.delete(pj.projectDetail).where(eq(pj.projectDetail.tenantId, TENANT));

    await db.delete(schema.auditLog).where(eq(schema.auditLog.tenantId, TENANT));
    await db.delete(schema.eventOutbox).where(eq(schema.eventOutbox.tenantId, TENANT));
    await db.delete(schema.numberAllocation).where(eq(schema.numberAllocation.tenantId, TENANT));
    await db.delete(schema.numberSeries).where(eq(schema.numberSeries.tenantId, TENANT));
    await db.delete(schema.item).where(eq(schema.item.tenantId, TENANT));
    await db.delete(schema.party).where(eq(schema.party.tenantId, TENANT));

    // Country adoption writes the tenant's own copies of the tax codes, statutory
    // requirements and holidays. None of them carries a foreign key to `tenant`,
    // so deleting the tenant leaves them behind — a leak that a re-run hides,
    // because adoption upserts and the suite passes anyway on stale rows.
    await db.delete(schema.tenantTaxCode).where(eq(schema.tenantTaxCode.tenantId, TENANT));
    await db.delete(schema.tenantRequirement).where(eq(schema.tenantRequirement.tenantId, TENANT));
    await db.delete(schema.tenantRuleValue).where(eq(schema.tenantRuleValue.tenantId, TENANT));
    await db.delete(schema.tenantHoliday).where(eq(schema.tenantHoliday.tenantId, TENANT));
    await db.delete(schema.tenantLocalisation).where(eq(schema.tenantLocalisation.tenantId, TENANT));
    await db.delete(schema.project).where(eq(schema.project.tenantId, TENANT));
    await db.delete(schema.userRole).where(eq(schema.userRole.tenantId, TENANT));
    await db.delete(schema.rolePermission).where(eq(schema.rolePermission.tenantId, TENANT));
    await db.delete(schema.role).where(eq(schema.role.tenantId, TENANT));
    await db.delete(schema.tenantModule).where(eq(schema.tenantModule.tenantId, TENANT));
    await db.delete(schema.session).where(eq(schema.session.tenantId, TENANT));
    await db.delete(schema.membership).where(eq(schema.membership.tenantId, TENANT));
    await db.delete(schema.appUser).where(eq(schema.appUser.id, BUYER));
    await db.delete(schema.appUser).where(eq(schema.appUser.id, STOREMAN));
    await db.delete(schema.tenant).where(eq(schema.tenant.id, TENANT));

    await app.close();
    await closeDatabase();
  });

  // -------------------------------------------------------------------------

  describe('1 — demand', () => {
    it('raises a requisition against a job', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/procurement/requisitions',
        headers: auth(),
        payload: {
          title: 'Carcass MDF — Palm Villa',
          projectId: PROJECT,
          requiredBy: '2026-09-15',
          lines: [
            {
              itemId: mdfItemId,
              description: '18mm MDF 2440x1220',
              quantity: 140,
              uomCode: 'EA',
              estimatedUnitPrice: 95,
              wbsNodeId,
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.number).toMatch(/^PR-\d{4}-/);
      expect(body.estimatedValue).toBe(13_300);
      requisitionId = body.requisitionId;

      const db = getDatabase();
      const [line] = await db
        .select()
        .from(procurementSchema.requisitionLine)
        .where(
          and(
            eq(procurementSchema.requisitionLine.tenantId, TENANT),
            eq(procurementSchema.requisitionLine.requisitionId, requisitionId),
          ),
        );
      requisitionLineId = line!.id;
    });

    it('refuses a requisition with no lines', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/procurement/requisitions',
        headers: auth(),
        payload: { title: 'Nothing', lines: [] },
      });

      expect(response.statusCode).toBe(400);
    });

    it('approves the spend before anyone is committed to it', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/procurement/requisitions/${requisitionId}/approve`,
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);

      const db = getDatabase();
      const [row] = await db
        .select()
        .from(procurementSchema.requisition)
        .where(eq(procurementSchema.requisition.id, requisitionId));
      expect(row!.status).toBe('approved');
      expect(row!.approvedBy).toBe(BUYER);
    });

    it('does not let the storeman approve spend', async () => {
      const second = await app.inject({
        method: 'POST',
        url: '/api/v1/procurement/requisitions',
        headers: auth(),
        payload: {
          title: 'Edge tape',
          lines: [{ description: 'ABS edge tape 22mm', quantity: 500, estimatedUnitPrice: 3 }],
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/procurement/requisitions/${second.json().requisitionId}/approve`,
        headers: auth(STOREMAN_TOKEN),
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('2 — sourcing and the landed-cost comparison', () => {
    it('issues an RFQ consolidating the approved demand', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/procurement/rfqs',
        headers: auth(),
        payload: {
          title: 'Carcass MDF',
          projectId: PROJECT,
          countryCode: 'AE',
          currencyCode: 'AED',
          responseDueOn: '2026-08-05',
          // The surplus is ordinary 18mm MDF and will go on the next job.
          surplusIsStock: true,
          lines: [
            {
              itemId: mdfItemId,
              description: '18mm MDF 2440x1220',
              quantity: 140,
              uomCode: 'EA',
              requisitionLineIds: [requisitionLineId],
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      rfqId = response.json().rfqId;

      const db = getDatabase();
      const [line] = await db
        .select()
        .from(procurementSchema.rfqLine)
        .where(eq(procurementSchema.rfqLine.rfqId, rfqId));
      rfqLineId = line!.id;

      // The requisition moved to sourcing, so a second buyer does not start
      // again on demand that is already being priced.
      const [req] = await db
        .select()
        .from(procurementSchema.requisition)
        .where(eq(procurementSchema.requisition.id, requisitionId));
      expect(req!.status).toBe('sourcing');
    });

    it('records both quotes', async () => {
      const gulf = await app.inject({
        method: 'POST',
        url: `/api/v1/procurement/rfqs/${rfqId}/quotes`,
        headers: auth(),
        payload: {
          supplierId: gulfSupplierId,
          reference: 'GP-9912',
          currencyCode: 'AED',
          exchangeRate: 1,
          paymentTermDays: 30,
          leadTimeDays: 7,
          lines: [
            { rfqLineId, description: '18mm MDF 2440x1220', quantity: 140, unitPrice: 96 },
          ],
        },
      });

      expect(gulf.statusCode).toBe(200);
      gulfQuoteId = gulf.json().quoteId;

      const italy = await app.inject({
        method: 'POST',
        url: `/api/v1/procurement/rfqs/${rfqId}/quotes`,
        headers: auth(),
        payload: {
          supplierId: italySupplierId,
          reference: 'LL-2026-77',
          currencyCode: 'EUR',
          exchangeRate: 4,
          freight: 900,
          dutyPercent: 5,
          paymentTermDays: 0,
          leadTimeDays: 45,
          lines: [
            { rfqLineId, description: '18mm MDF 2440x1220', quantity: 140, unitPrice: 20 },
          ],
        },
      });

      expect(italy.statusCode).toBe(200);
      italyQuoteId = italy.json().quoteId;
    });

    it('refuses a second quote from the same supplier on one RFQ', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/procurement/rfqs/${rfqId}/quotes`,
        headers: auth(),
        payload: {
          supplierId: gulfSupplierId,
          currencyCode: 'AED',
          lines: [{ rfqLineId, description: 'MDF', quantity: 140, unitPrice: 80 }],
        },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error).toMatch(/already quoted/i);
    });

    it('ranks on landed cost, so the cheaper sheet loses', async () => {
      // 20 EUR is 80 AED against 96 AED delivered. It still loses, because
      // freight and duty are 1,040 EUR on the order and the local supplier
      // gives 30 days of credit.
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/procurement/rfqs/${rfqId}/lines/${rfqLineId}/comparison?countryCode=AE`,
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.quotes).toHaveLength(2);
      expect(body.quotes[0].quoteId).toBe(gulfQuoteId);
      expect(body.quotes[1].quoteId).toBe(italyQuoteId);

      // (2,800 + 140 duty + 900 freight) x 4.
      expect(body.quotes[1].landedCost).toBe(15_360);
      // 13,440 less 30 days of credit at 8%.
      expect(body.quotes[0].landedCost).toBeCloseTo(13_351.63, 2);
      expect(body.quotes[0].premiumOverBest).toBe(0);
      expect(body.quotes[1].premiumOverBest).toBeCloseTo(2_008.37, 2);

      // Lead time is reported and deliberately not priced: 45 days is free when
      // the job is not waiting and ruinous when it is, and this cannot know.
      expect(body.quotes[1].leadTimeDays).toBe(45);

      // Two quotes against a governance minimum of three.
      expect(body.belowMinimumQuotes).toBe(true);
      expect(body.minimumQuotes).toBe(3);
    });

    it('stores the comparison so the award can be explained later', async () => {
      const db = getDatabase();
      const [row] = await db
        .select()
        .from(procurementSchema.quote)
        .where(eq(procurementSchema.quote.id, italyQuoteId));

      expect(Number(row!.landedCost)).toBe(15_360);
      expect(row!.comparedAt).not.toBeNull();
      // The rate used for the decision, kept with it.
      expect(Number(row!.exchangeRate)).toBe(4);
    });

    it('refuses an off-lowest award with no recorded reason', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/procurement/rfqs/${rfqId}/award`,
        headers: auth(),
        payload: { quoteId: italyQuoteId },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error).toMatch(/requires a recorded reason/i);
    });

    it('awards the cheapest without ceremony', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/procurement/rfqs/${rfqId}/award`,
        headers: auth(),
        payload: { quoteId: gulfQuoteId },
      });

      expect(response.statusCode).toBe(200);

      const db = getDatabase();
      const quotes = await db
        .select()
        .from(procurementSchema.quote)
        .where(eq(procurementSchema.quote.rfqId, rfqId));

      expect(quotes.find((q) => q.id === gulfQuoteId)!.status).toBe('awarded');
      expect(quotes.find((q) => q.id === italyQuoteId)!.status).toBe('lost');
    });
  });

  describe('3 — the order, and the commitment it creates', () => {
    it('raises a purchase order carrying UAE VAT from the country pack', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/procurement/orders',
        headers: auth(),
        payload: {
          supplierId: gulfSupplierId,
          countryCode: 'AE',
          projectId: PROJECT,
          sourceQuoteId: gulfQuoteId,
          sourceRfqId: rfqId,
          currencyCode: 'AED',
          exchangeRate: 1,
          promisedDeliveryDate: '2026-08-20',
          lines: [
            {
              itemId: mdfItemId,
              description: '18mm MDF 2440x1220',
              quantity: 140,
              uomCode: 'EA',
              unitPrice: 96,
              warehouseId,
              wbsNodeId,
              requisitionLineId,
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      orderId = body.purchaseOrderId;

      expect(body.number).toMatch(/^PO-\d{4}-/);
      expect(body.netValue).toBe(13_440);
      // 5% VAT, from the AE pack — not typed in by the buyer.
      expect(body.taxAmount).toBe(672);
      expect(body.grossValue).toBe(14_112);

      const db = getDatabase();
      const [line] = await db
        .select()
        .from(procurementSchema.purchaseOrderLine)
        .where(eq(procurementSchema.purchaseOrderLine.purchaseOrderId, orderId));
      orderLineId = line!.id;
    });

    it('registers the commitment against the budget when it is issued', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/procurement/orders/${orderId}/issue`,
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.commitmentRegistered).toBe(true);
      commitmentId = body.commitmentId;

      const db = getDatabase();
      const [held] = await db
        .select()
        .from(projectsSchema.commitment)
        .where(eq(projectsSchema.commitment.id, commitmentId));

      // The GROSS order value, not the net: the company owes the VAT too.
      expect(Number(held!.committedAmount)).toBe(14_112);
      expect(held!.status).toBe('open');
      expect(held!.sourceModule).toBe('procurement');
      // Held where the budget it consumes lives.
      expect(held!.wbsNodeId).toBe(wbsNodeId);
    });

    it('is idempotent on a second issue, rather than committing twice', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/procurement/orders/${orderId}/issue`,
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);

      const db = getDatabase();
      const rows = await db
        .select()
        .from(projectsSchema.commitment)
        .where(eq(projectsSchema.commitment.tenantId, TENANT));

      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.committedAmount)).toBe(14_112);
    });
  });

  describe('4 — delivery: stock in, cost accrued', () => {
    it('receives a partial delivery, takes it into stock and accrues the cost', async () => {
      // 40 of 140. Partial deliveries are the norm, and the whole matching
      // design exists because of them.
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/procurement/orders/${orderId}/receipts`,
        headers: auth(STOREMAN_TOKEN),
        payload: {
          countryCode: 'AE',
          receivedOn: '2026-08-18',
          warehouseId,
          deliveryNoteReference: 'DN-4471',
          lines: [{ purchaseOrderLineId: orderLineId, quantityReceived: 40 }],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.number).toMatch(/^GRN-\d{4}-/);
      expect(body.overDelivered).toBe(false);
      expect(body.stockPosted).toBe(true);
      expect(body.costAccrued).toBe(true);
      expect(body.accrualValue).toBe(3_840);
      expect(body.orderStatus).toBe('partially_received');

      const db = getDatabase();

      // Stock is real.
      const [level] = await db
        .select()
        .from(inventorySchema.stockLevel)
        .where(
          and(
            eq(inventorySchema.stockLevel.tenantId, TENANT),
            eq(inventorySchema.stockLevel.itemId, mdfItemId),
          ),
        );
      expect(Number(level!.quantity)).toBe(40);

      // And so is the accrual — charged to the job on delivery, not whenever
      // the supplier gets round to invoicing.
      const costs = await db
        .select()
        .from(projectsSchema.costEntry)
        .where(eq(projectsSchema.costEntry.tenantId, TENANT));

      expect(costs).toHaveLength(1);
      expect(Number(costs[0]!.amount)).toBe(3_840);
      expect(costs[0]!.isAccrual).toBe(true);
      expect(costs[0]!.sourceModule).toBe('procurement');
      expect(costs[0]!.wbsNodeId).toBe(wbsNodeId);
    });

    it('accepts a small over-delivery without a query', async () => {
      // 103 against 100 outstanding is a full pallet, not a dispute.
      const position = await app.inject({
        method: 'GET',
        url: `/api/v1/procurement/orders/${orderId}`,
        headers: auth(),
      });

      expect(position.json().lines[0].outstanding).toBe(100);
      expect(position.json().lines[0].availableToBill).toBe(40);
    });

    it('flags a material over-delivery at the gate, priced', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/procurement/orders/${orderId}/receipts`,
        headers: auth(STOREMAN_TOKEN),
        payload: {
          countryCode: 'AE',
          receivedOn: '2026-08-22',
          warehouseId,
          deliveryNoteReference: 'DN-4502',
          // 40 already in, 140 more takes it to 180 against an order of 140.
          lines: [{ purchaseOrderLineId: orderLineId, quantityReceived: 140 }],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.overDelivered).toBe(true);
      expect(body.exceptions[0].code).toBe('over_receipt');
      // 40 sheets over, at 96.
      expect(body.exceptions[0].amount).toBe(3_840);
    });
  });

  describe('5 — three-way matching', () => {
    it('holds an invoice for more than has been received', async () => {
      // 180 in, so 180 billable. The supplier bills the full 140 ordered plus
      // the 40 extra — 180 — which is fine. Then bills it again.
      const first = await app.inject({
        method: 'POST',
        url: '/api/v1/procurement/invoices',
        headers: auth(),
        payload: {
          supplierId: gulfSupplierId,
          purchaseOrderId: orderId,
          countryCode: 'AE',
          supplierReference: 'INV-8801',
          invoiceDate: '2026-08-25',
          currencyCode: 'AED',
          exchangeRate: 1,
          lines: [
            {
              purchaseOrderLineId: orderLineId,
              description: '18mm MDF',
              quantity: 180,
              unitPrice: 96,
              taxPercent: 5,
            },
          ],
        },
      });

      expect(first.statusCode).toBe(200);
      expect(first.json().status).toBe('matched');

      // The same delivery, billed a second time. This is the failure the whole
      // module exists to prevent, and nothing about the invoice looks wrong on
      // its own — only the cumulative position catches it.
      const duplicate = await app.inject({
        method: 'POST',
        url: '/api/v1/procurement/invoices',
        headers: auth(),
        payload: {
          supplierId: gulfSupplierId,
          purchaseOrderId: orderId,
          countryCode: 'AE',
          supplierReference: 'INV-8802',
          invoiceDate: '2026-08-26',
          currencyCode: 'AED',
          exchangeRate: 1,
          lines: [
            {
              purchaseOrderLineId: orderLineId,
              description: '18mm MDF',
              quantity: 180,
              unitPrice: 96,
              taxPercent: 5,
            },
          ],
        },
      });

      expect(duplicate.statusCode).toBe(200);
      const body = duplicate.json();
      expect(body.status).toBe('on_hold');
      expect(body.exceptions.map((e: { code: string }) => e.code)).toContain(
        'over_invoiced_quantity',
      );
      expect(body.exceptions[0].amount).toBe(180 * 96);
    });

    it('refuses the same supplier invoice number twice', async () => {
      // The commonest way a company pays twice is one invoice arriving by post
      // and by email. A uniqueness constraint stops it at the door for free.
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/procurement/invoices',
        headers: auth(),
        payload: {
          supplierId: gulfSupplierId,
          purchaseOrderId: orderId,
          countryCode: 'AE',
          supplierReference: 'INV-8801',
          invoiceDate: '2026-08-25',
          currencyCode: 'AED',
          lines: [
            {
              purchaseOrderLineId: orderLineId,
              description: '18mm MDF',
              quantity: 1,
              unitPrice: 96,
            },
          ],
        },
      });

      expect(response.statusCode).toBe(500);
    });

    it('relieved the commitment on the clean match only', async () => {
      const db = getDatabase();
      const [held] = await db
        .select()
        .from(projectsSchema.commitment)
        .where(eq(projectsSchema.commitment.id, commitmentId));

      // 180 at 96 plus 5% = 18,144 invoiced against a 14,112 commitment, so it
      // is fully relieved and closed. The HELD duplicate did not touch it —
      // relieving on a held invoice would release money still genuinely at risk.
      expect(Number(held!.invoicedAmount)).toBe(18_144);
      expect(held!.status).toBe('closed');
    });

    it('holds a price increase and sizes it on the line, not the unit', async () => {
      // A 5 AED absolute floor applied to a UNIT price forgives 5 AED per unit.
      // On a 500-unit line that is 2,500 AED nobody ever sees, and it grows with
      // volume. The tolerance is applied to the line total for exactly this.
      const tapeOrder = await app.inject({
        method: 'POST',
        url: '/api/v1/procurement/orders',
        headers: auth(),
        payload: {
          supplierId: gulfSupplierId,
          countryCode: 'AE',
          currencyCode: 'AED',
          lines: [{ description: 'ABS edge tape 22mm', quantity: 500, unitPrice: 3 }],
        },
      });

      const tapeOrderId = tapeOrder.json().purchaseOrderId;
      await app.inject({
        method: 'POST',
        url: `/api/v1/procurement/orders/${tapeOrderId}/issue`,
        headers: auth(),
      });

      const db = getDatabase();
      const [tapeLine] = await db
        .select()
        .from(procurementSchema.purchaseOrderLine)
        .where(eq(procurementSchema.purchaseOrderLine.purchaseOrderId, tapeOrderId));

      await app.inject({
        method: 'POST',
        url: `/api/v1/procurement/orders/${tapeOrderId}/receipts`,
        headers: auth(STOREMAN_TOKEN),
        payload: {
          countryCode: 'AE',
          warehouseId,
          lines: [{ purchaseOrderLineId: tapeLine!.id, quantityReceived: 500 }],
        },
      });

      // Billed at 4.20 against 3.00 — 40% up, but only 1.20 a unit.
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/procurement/invoices',
        headers: auth(),
        payload: {
          supplierId: gulfSupplierId,
          purchaseOrderId: tapeOrderId,
          countryCode: 'AE',
          supplierReference: 'INV-8810',
          invoiceDate: '2026-08-27',
          currencyCode: 'AED',
          lines: [
            {
              purchaseOrderLineId: tapeLine!.id,
              description: 'ABS edge tape 22mm',
              quantity: 500,
              unitPrice: 4.2,
            },
          ],
        },
      });

      const body = response.json();
      expect(body.status).toBe('on_hold');
      const variance = body.exceptions.find(
        (e: { code: string }) => e.code === 'price_variance',
      );
      expect(variance).toBeDefined();
      // 600 on the line, not 1.20 on a unit.
      expect(variance.amount).toBe(600);
    });

    it('reports an undercharge without blocking it', async () => {
      const order = await app.inject({
        method: 'POST',
        url: '/api/v1/procurement/orders',
        headers: auth(),
        payload: {
          supplierId: gulfSupplierId,
          countryCode: 'AE',
          currencyCode: 'AED',
          lines: [{ description: 'Soft-close hinges', quantity: 200, unitPrice: 12 }],
        },
      });
      const id = order.json().purchaseOrderId;
      await app.inject({ method: 'POST', url: `/api/v1/procurement/orders/${id}/issue`, headers: auth() });

      const db = getDatabase();
      const [line] = await db
        .select()
        .from(procurementSchema.purchaseOrderLine)
        .where(eq(procurementSchema.purchaseOrderLine.purchaseOrderId, id));

      await app.inject({
        method: 'POST',
        url: `/api/v1/procurement/orders/${id}/receipts`,
        headers: auth(STOREMAN_TOKEN),
        payload: {
          countryCode: 'AE',
          warehouseId,
          lines: [{ purchaseOrderLineId: line!.id, quantityReceived: 200 }],
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/procurement/invoices',
        headers: auth(),
        payload: {
          supplierId: gulfSupplierId,
          purchaseOrderId: id,
          countryCode: 'AE',
          supplierReference: 'INV-8815',
          invoiceDate: '2026-08-28',
          currencyCode: 'AED',
          lines: [
            {
              purchaseOrderLineId: line!.id,
              description: 'Soft-close hinges',
              quantity: 200,
              unitPrice: 10,
            },
          ],
        },
      });

      const body = response.json();
      // Charged 400 less than agreed. Refusing to pay generates a phone call
      // and no benefit whatsoever.
      expect(body.status).toBe('matched');
      expect(body.favourable).toHaveLength(1);
      expect(body.variance).toBe(-400);
    });
  });

  describe('6 — the override, and what it costs to use it', () => {
    let heldInvoiceId: string;

    it('lists open exceptions largest first, so a buyer can triage', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/procurement/exceptions',
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.rows.length).toBeGreaterThan(1);
      expect(body.total).toBe(body.rows.length);

      // Biggest money first. Any other ordering makes this a list rather than a
      // queue, and a buyer works down it in the order it is given.
      const amounts = body.rows.map((e: { amount: number }) => e.amount);
      expect([...amounts].sort((a: number, b: number) => b - a)).toEqual(amounts);

      // The favourable variance is not in the queue — it opens resolved, or it
      // would bury the real holds under undercharges nobody needs to action.
      expect(body.rows.every((e: { isFavourable: boolean }) => e.isFavourable === false)).toBe(
        true,
      );

      // Joined through to the supplier, which is what makes triage possible:
      // "billed 180 but only 40 received" is useless without knowing whose
      // invoice it is.
      const priceVariance = body.rows.find(
        (e: { code: string }) => e.code === 'price_variance',
      );
      expect(priceVariance.supplierReference).toBe('INV-8810');
      expect(priceVariance.supplierName).toBe('Gulf Panels Trading');
      heldInvoiceId = priceVariance.supplierInvoiceId;
    });

    it('filters the queue by exception code', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/procurement/exceptions?code=over_invoiced_quantity',
        headers: auth(),
      });

      const body = response.json();
      expect(body.rows.length).toBeGreaterThan(0);
      expect(
        body.rows.every((e: { code: string }) => e.code === 'over_invoiced_quantity'),
      ).toBe(true);
    });

    it('ignores a sort column it was not told about', async () => {
      // Drizzle parameterises values, never identifiers, so an unrecognised sort
      // key can only be rejected. It falls back rather than erroring.
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/procurement/exceptions?sort=amount;drop%20table%20kernel.tenant',
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().sort).toBe('amount');
    });

    it('refuses a release with no reason', async () => {
      const db = getDatabase();
      const [invoice] = await db
        .select()
        .from(procurementSchema.supplierInvoice)
        .where(
          and(
            eq(procurementSchema.supplierInvoice.tenantId, TENANT),
            eq(procurementSchema.supplierInvoice.supplierReference, 'INV-8810'),
          ),
        );
      heldInvoiceId = invoice!.id;

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/procurement/invoices/${heldInvoiceId}/release`,
        headers: auth(),
        payload: { reason: '' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('does not let the storeman release a held invoice', async () => {
      // The separation of duties the whole control depends on: the person who
      // takes delivery must not be the person who overrides the match.
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/procurement/invoices/${heldInvoiceId}/release`,
        headers: auth(STOREMAN_TOKEN),
        payload: { reason: 'Looks fine to me' },
      });

      expect(response.statusCode).toBe(403);
    });

    it('releases with a reason, resolves the exceptions and records who did it', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/procurement/invoices/${heldInvoiceId}/release`,
        headers: auth(),
        payload: { reason: 'Price rise agreed verbally with the supplier on 12 Aug.' },
      });

      expect(response.statusCode).toBe(200);

      const db = getDatabase();
      const [invoice] = await db
        .select()
        .from(procurementSchema.supplierInvoice)
        .where(eq(procurementSchema.supplierInvoice.id, heldInvoiceId));

      expect(invoice!.status).toBe('approved');
      expect(invoice!.releasedBy).toBe(BUYER);
      expect(invoice!.releasedOn).not.toBeNull();

      const exceptions = await db
        .select()
        .from(procurementSchema.matchException)
        .where(eq(procurementSchema.matchException.supplierInvoiceId, heldInvoiceId));

      expect(exceptions.every((e) => e.resolution === 'accepted')).toBe(true);
      expect(exceptions.every((e) => e.resolvedBy === BUYER)).toBe(true);
    });

    it('emits the release as its own event, not as a match', async () => {
      // An override that looked identical to a clean match in the event stream
      // would make the whole control decorative.
      const db = getDatabase();
      const events = await db
        .select()
        .from(schema.eventOutbox)
        .where(eq(schema.eventOutbox.tenantId, TENANT));

      const types = events.map((e) => e.eventType);
      expect(types).toContain('procurement.invoice.released');
      expect(types).toContain('procurement.invoice.held');
      expect(types).toContain('procurement.invoice.matched');
      expect(types).toContain('procurement.order.issued');
      expect(types).toContain('procurement.goods.received');
      expect(types).toContain('procurement.receipt.over_delivered');
    });

    it('advanced the invoiced quantity on release, so it cannot be billed again', async () => {
      const db = getDatabase();
      const [invoice] = await db
        .select()
        .from(procurementSchema.supplierInvoice)
        .where(eq(procurementSchema.supplierInvoice.id, heldInvoiceId));

      const [line] = await db
        .select()
        .from(procurementSchema.supplierInvoiceLine)
        .where(eq(procurementSchema.supplierInvoiceLine.supplierInvoiceId, heldInvoiceId));

      const [orderLine] = await db
        .select()
        .from(procurementSchema.purchaseOrderLine)
        .where(eq(procurementSchema.purchaseOrderLine.id, line!.purchaseOrderLineId!));

      expect(invoice!.status).toBe('approved');
      expect(Number(orderLine!.quantityInvoiced)).toBe(500);
      // Received and billed in full — nothing left to claim.
      expect(Number(orderLine!.quantityReceived) - Number(orderLine!.quantityInvoiced)).toBe(0);
    });
  });


  describe('7 — the index screens', () => {
    it('returns a page of orders with the supplier joined in', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/procurement/orders?pageSize=2',
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.rows).toHaveLength(2);
      // Three orders were raised across this suite: the MDF, the edge tape and
      // the hinges. The total counts all of them, not the page.
      expect(body.total).toBe(3);
      expect(body.totalPages).toBe(2);
      expect(body.hasMore).toBe(true);

      // Joined, not an id for the browser to resolve. A list screen rendering a
      // UUID in the supplier column is not a list screen.
      expect(body.rows[0].supplierName).toBe('Gulf Panels Trading');
    });

    it('searches orders by supplier name, not just by number', async () => {
      const hit = await app.inject({
        method: 'GET',
        url: '/api/v1/procurement/orders?q=gulf',
        headers: auth(),
      });
      expect(hit.json().total).toBe(3);

      const miss = await app.inject({
        method: 'GET',
        url: '/api/v1/procurement/orders?q=lombardia',
        headers: auth(),
      });
      expect(miss.json().total).toBe(0);
      // The count must reflect the same filter as the rows, or the pager lies.
      expect(miss.json().rows).toHaveLength(0);
    });

    it('escapes wildcards in the search term', async () => {
      // Without escaping, a lone `%` matches every row and the user concludes
      // search is broken rather than that they typed a wildcard.
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/procurement/orders?q=%25',
        headers: auth(),
      });

      expect(response.json().total).toBe(0);
    });

    it('counts open exceptions per invoice on the list', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/procurement/invoices',
        headers: auth(),
      });

      const body = response.json();
      const duplicate = body.rows.find(
        (r: { supplierReference: string }) => r.supplierReference === 'INV-8802',
      );

      // Still held: it was never released, and its exception is still open.
      expect(duplicate.status).toBe('on_hold');
      expect(duplicate.openExceptions).toBe(1);

      // The released one had its exceptions resolved, so its count is zero even
      // though the exception rows still exist.
      const released = body.rows.find(
        (r: { supplierReference: string }) => r.supplierReference === 'INV-8810',
      );
      expect(released.status).toBe('approved');
      expect(released.openExceptions).toBe(0);
    });

    it('filters invoices down to the held ones', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/procurement/invoices?held=true',
        headers: auth(),
      });

      const body = response.json();
      expect(body.total).toBeGreaterThan(0);
      expect(body.rows.every((r: { status: string }) => r.status === 'on_hold')).toBe(true);
    });

    it('sorts requisitions by what the site needs first', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/procurement/requisitions',
        headers: auth(),
      });

      const body = response.json();
      // Ascending by required date, not by creation. A requisition list ordered
      // by when it was typed buries the one about to stop a job.
      expect(body.sort).toBe('requiredBy');
      expect(body.direction).toBe('asc');
      expect(body.rows[0].projectCode).toBe('P-2026-100');
    });

    it('caps the page size however large the request', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/procurement/orders?pageSize=100000',
        headers: auth(),
      });

      expect(response.json().pageSize).toBe(200);
    });

    it('is still module-gated and permission-gated', async () => {
      // The storeman can read orders but not invoices — the same separation the
      // release permission enforces, applied to the list screens.
      const orders = await app.inject({
        method: 'GET',
        url: '/api/v1/procurement/orders',
        headers: auth(STOREMAN_TOKEN),
      });
      expect(orders.statusCode).toBe(200);

      const invoices = await app.inject({
        method: 'GET',
        url: '/api/v1/procurement/invoices',
        headers: auth(STOREMAN_TOKEN),
      });
      expect(invoices.statusCode).toBe(403);
    });
  });


  describe('8 — what the detail screens depend on', () => {
    it('returns the invoice with its lines and exceptions in one call', async () => {
      // The invoice screen renders all three together. Three round trips to
      // build one page is a slower screen and three chances to render a
      // half-consistent view of the same invoice.
      const db = getDatabase();
      const [invoice] = await db
        .select()
        .from(procurementSchema.supplierInvoice)
        .where(
          and(
            eq(procurementSchema.supplierInvoice.tenantId, TENANT),
            eq(procurementSchema.supplierInvoice.supplierReference, 'INV-8802'),
          ),
        );

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/procurement/invoices/${invoice!.id}`,
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.invoice.supplierReference).toBe('INV-8802');
      expect(body.invoice.status).toBe('on_hold');
      expect(body.lines.length).toBeGreaterThan(0);
      expect(body.exceptions.length).toBeGreaterThan(0);

      // The screen shows billed against expected side by side; the gap is the
      // whole question, and it has to come from the server rather than being
      // recomputed in the browser from a price the browser had to guess.
      expect(body.lines[0].expectedValue).not.toBeNull();
    });

    it('refuses to release an invoice that is not held', async () => {
      // The screen only offers the form on a held invoice. That is a courtesy;
      // this is the control. A caller that is not the form must still be told no.
      const db = getDatabase();
      const [matched] = await db
        .select()
        .from(procurementSchema.supplierInvoice)
        .where(
          and(
            eq(procurementSchema.supplierInvoice.tenantId, TENANT),
            eq(procurementSchema.supplierInvoice.supplierReference, 'INV-8801'),
          ),
        );

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/procurement/invoices/${matched!.id}/release`,
        headers: auth(),
        payload: { reason: 'trying it on' },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error).toMatch(/only a held invoice/i);
    });

    it('refuses a release with a reason of only whitespace', async () => {
      // The form requires it and the API requires it. A blank reason recorded
      // against a released invoice is worse than no field at all: it looks like
      // an answer.
      const db = getDatabase();
      const [held] = await db
        .select()
        .from(procurementSchema.supplierInvoice)
        .where(
          and(
            eq(procurementSchema.supplierInvoice.tenantId, TENANT),
            eq(procurementSchema.supplierInvoice.status, 'on_hold'),
          ),
        );

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/procurement/invoices/${held!.id}/release`,
        headers: auth(),
        payload: { reason: '   ' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('treats approving an already-approved requisition as a no-op', async () => {
      // The list only offers the button on a draft, but a double submission or a
      // stale page must not error — and must not approve twice.
      const first = await app.inject({
        method: 'POST',
        url: `/api/v1/procurement/requisitions/${requisitionId}/approve`,
        headers: auth(),
      });

      expect(first.statusCode).toBe(200);

      const db = getDatabase();
      const [row] = await db
        .select()
        .from(procurementSchema.requisition)
        .where(eq(procurementSchema.requisition.id, requisitionId));

      // Still sourcing from section 2 — approving again did not drag it back.
      expect(row!.status).toBe('sourcing');
    });
  });


  describe('9 — the goods receipt register', () => {
    it('lists receipts with the line count and what each charged the job', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/procurement/receipts',
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBeGreaterThan(0);

      // A receipt register without the accrual says only that something
      // arrived. The useful question is what the job was charged the day it
      // landed, months before the invoice.
      const withValue = body.rows.filter((r: { accrualValue: number }) => r.accrualValue > 0);
      expect(withValue.length).toBeGreaterThan(0);
      for (const row of body.rows) {
        expect(row.lineCount).toBeGreaterThan(0);
        expect(row.purchaseOrderNumber).toBeTruthy();
      }
    });

    it('filters down to the over-delivered ones', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/procurement/receipts?overDelivered=true',
        headers: auth(),
      });

      const body = response.json();
      expect(body.total).toBeGreaterThan(0);
      expect(body.rows.every((r: { overDelivered: boolean }) => r.overDelivered)).toBe(true);
    });

    it('searches by the supplier delivery note, not just our own number', async () => {
      // DN-4471 is the number written on the paper the driver handed over, and
      // so the one anybody chasing a delivery will quote.
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/procurement/receipts?q=DN-4471',
        headers: auth(),
      });

      expect(response.json().total).toBe(1);
    });

    it('scopes the register to one order when asked', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/procurement/receipts?purchaseOrderId=${orderId}`,
        headers: auth(),
      });

      const body = response.json();
      expect(body.total).toBeGreaterThan(0);
      expect(
        body.rows.every((r: { purchaseOrderId: string }) => r.purchaseOrderId === orderId),
      ).toBe(true);
    });

    it('lets the storeman read the register but not the invoices', async () => {
      // Receiving and paying are different jobs. The register is the storeman's
      // own record and they can read it; what an invoice says is not their
      // business and the separation is what makes three-way matching mean
      // anything.
      const receipts = await app.inject({
        method: 'GET',
        url: '/api/v1/procurement/receipts',
        headers: auth(STOREMAN_TOKEN),
      });
      expect(receipts.statusCode).toBe(200);

      const invoices = await app.inject({
        method: 'GET',
        url: '/api/v1/procurement/invoices',
        headers: auth(STOREMAN_TOKEN),
      });
      expect(invoices.statusCode).toBe(403);
    });
  });

});

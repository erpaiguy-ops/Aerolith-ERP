/**
 * Seeds a demo workspace you can actually sign into.
 *
 * Idempotent: it deletes and rebuilds the demo tenant every run, so it is safe
 * to re-run while developing. It touches nothing outside that tenant.
 *
 * This exists because a web shell with no way to sign in cannot be evaluated,
 * and because the interesting part of this product is the CONTINUITY — a budget
 * that becomes progress that becomes a payment application. Seeding three
 * disconnected rows would demonstrate none of it.
 */
import {
  adoptCountry,
  closeDatabase,
  createDatabase,
  hashPassword,
  schema,
  runWithTenantContext,
  withTenant,
  withoutTenantGuard,
} from '@aerolith/kernel';
import { inventorySchema, postMovement } from '@aerolith/module-inventory';
import {
  approveRequisition,
  createPurchaseOrder,
  createRequisition,
  issuePurchaseOrder,
  linkCommitment,
  linkReceiptPostings,
  procurementSchema,
  receiveGoods,
  registerInvoice,
} from '@aerolith/module-procurement';
import {
  activateContract,
  approveVariation,
  certifyApplication,
  createContract,
  createPaymentApplication,
  createVariation,
  submitApplication,
  contractsSchema,
} from '@aerolith/module-contracts';
import {
  approveBudget,
  createBudgetVersion,
  createWbs,
  postCost,
  recordCommitment,
  recordProgress,
  projectsSchema,
} from '@aerolith/module-projects';
import { and, eq } from 'drizzle-orm';

import { syncModules } from '../src/bootstrap';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const TENANT = 'd0000000-0000-4000-8000-00000000d000';
const USER = 'd0000000-0000-4000-8000-00000000u000'.replace('u', 'a');
const PROJECT = 'd0000000-0000-4000-8000-00000000p000'.replace('p', 'b');
const EMAIL = 'demo@aerolith.test';
const PASSWORD = 'demo-passphrase-2026';

async function main() {
  createDatabase({ connectionString: url! });
  await syncModules();

  // --- Clean slate ---------------------------------------------------------
  await withoutTenantGuard(async (tx) => {
    for (const table of [
      schema.auditLog,
      schema.eventOutbox,
      schema.numberAllocation,

      // Order matters: children before parents, and every module's tables
      // before the kernel rows they point at. Deleting `kernel.project` does
      // NOT cascade into the module schemas — those columns are plain uuids by
      // design, so that a module can be dropped without a migration touching
      // the kernel — which meant a second run of this seed collided on
      // `wbs_node_uq` and the seed was only ever idempotent by accident of
      // always being run against a fresh database.
      contractsSchema.paymentApplicationLine,
      contractsSchema.retentionRelease,
      contractsSchema.paymentApplication,
      contractsSchema.variationLine,
      contractsSchema.variation,
      contractsSchema.backCharge,
      contractsSchema.correspondence,
      contractsSchema.contractLine,
      contractsSchema.contract,

      // Order matters. An offcut points at the movement that produced it, and a
      // stock count points at the adjustment that posted it, so both go before
      // `stockMovement`; bins and batches go before the warehouse that owns them.
      inventorySchema.offcut,
      inventorySchema.stockCountLine,
      inventorySchema.stockCount,
      inventorySchema.reorderRule,
      inventorySchema.stockMovementLine,
      inventorySchema.stockMovement,
      inventorySchema.stockLevel,
      inventorySchema.batch,
      inventorySchema.storageBin,
      inventorySchema.warehouse,
      procurementSchema.matchException,
      procurementSchema.supplierInvoiceLine,
      procurementSchema.supplierInvoice,
      procurementSchema.goodsReceiptLine,
      procurementSchema.goodsReceipt,
      procurementSchema.purchaseOrderLine,
      procurementSchema.purchaseOrder,
      procurementSchema.requisitionLine,
      procurementSchema.requisition,

      projectsSchema.costEntry,
      projectsSchema.commitment,
      projectsSchema.progressEntry,
      projectsSchema.budgetLine,
      projectsSchema.budget,
      projectsSchema.snag,
      projectsSchema.milestone,
      projectsSchema.wbsNode,
      projectsSchema.projectDetail,

      // Country adoption writes the tenant its own copies of these. None of
      // them has a foreign key to `tenant`, so they outlive it.
      schema.tenantTaxCode,
      schema.tenantRequirement,
      schema.tenantRuleValue,
      schema.tenantHoliday,
      schema.tenantLocalisation,

      schema.item,
      schema.party,
      schema.numberSeries,
      schema.tenantModule,
      schema.session,
      schema.userRole,
      schema.rolePermission,
      schema.role,
      schema.membership,
      schema.project,
    ]) {
      await tx.delete(table).where(eq((table as never as { tenantId: never }).tenantId, TENANT));
    }
    await tx.delete(schema.appUser).where(eq(schema.appUser.id, USER));
    await tx.delete(schema.tenant).where(eq(schema.tenant.id, TENANT));
  });

  console.log('→ workspace');
  await withoutTenantGuard(async (tx) => {
    await tx.insert(schema.tenant).values({
      id: TENANT,
      slug: 'aerolith-demo',
      name: 'Aerolith Demo Joinery',
      status: 'active',
      primaryCountryCode: 'AE',
      baseCurrencyCode: 'AED',
      timezone: 'Asia/Dubai',
    });

    await tx.insert(schema.appUser).values({
      id: USER,
      email: EMAIL,
      name: 'Demo Commercial Manager',
      locale: 'en',
      passwordHash: await hashPassword(PASSWORD),
    });

    await tx
      .insert(schema.membership)
      .values({ tenantId: TENANT, userId: USER, status: 'active', isOwner: true });

    await tx.insert(schema.tenantModule).values(
      ['projects', 'contracts', 'estimation', 'production', 'inventory', 'procurement'].map(
        (moduleKey) => ({
          tenantId: TENANT,
          moduleKey,
          status: 'enabled' as const,
        }),
      ),
    );

    await tx.insert(schema.numberSeries).values([
      { tenantId: TENANT, entityType: 'contracts.contract', code: 'CON', name: 'Contract', pattern: 'CON-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'contracts.variation', code: 'VO', name: 'Variation', pattern: 'VO-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'contracts.payment_application', code: 'IPC', name: 'Payment Application', pattern: 'IPC-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'projects.snag', code: 'SNG', name: 'Snag', pattern: 'SNG-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'estimation.tender', code: 'TND', name: 'Tender', pattern: 'TND-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'production.work_order', code: 'WO', name: 'Work Order', pattern: 'WO-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'procurement.requisition', code: 'PR', name: 'Requisition', pattern: 'PR-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'procurement.purchase_order', code: 'PO', name: 'Purchase Order', pattern: 'PO-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'procurement.goods_receipt', code: 'GRN', name: 'Goods Receipt', pattern: 'GRN-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'procurement.supplier_invoice', code: 'SINV', name: 'Supplier Invoice', pattern: 'SINV-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'inventory.receipt', code: 'IGRN', name: 'Stock Receipt', pattern: 'IGRN-{YYYY}-{SEQ}' },
      // Every movement type the demo posts needs its own series, and posting is
      // what allocates the number — a missing series does not degrade, it throws.
      { tenantId: TENANT, entityType: 'inventory.issue', code: 'ISS', name: 'Stock Issue', pattern: 'ISS-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'inventory.transfer', code: 'STR', name: 'Stock Transfer', pattern: 'STR-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'inventory.adjustment', code: 'ADJ', name: 'Stock Adjustment', pattern: 'ADJ-{YYYY}-{SEQ}' },
    ]);

    await tx.insert(schema.project).values({
      id: PROJECT,
      tenantId: TENANT,
      code: 'P-2026-001',
      name: 'Marina Tower — joinery package',
      status: 'in_progress',
      currencyCode: 'AED',
      countryCode: 'AE',
      contractValue: '1000000.00',
    });
  });

  // Everything below runs as the demo user, with both the AsyncLocalStorage
  // context (which the services read for the actor and tenant) and the database
  // guard set — exactly as a request does, so the seed exercises the same RLS
  // path the app will.
  const asUser = <T>(fn: (tx: Parameters<Parameters<typeof withTenant>[0]>[0]) => Promise<T>) =>
    runWithTenantContext(
      {
        tenantId: TENANT,
        userId: USER,
        actorType: 'user',
        locale: 'en',
        timezone: 'Asia/Dubai',
        countryCode: 'AE',
        currencyCode: 'AED',
        // Empty: the seed calls services directly rather than going through the
        // route layer, so nothing here consults the permission set. A request
        // arrives with it populated.
        permissions: new Set<string>(),
        // A uuid because the audit log stores it as one. Fixed rather than
        // random so every row this script writes correlates to one identifiable
        // "request" — "show me everything the demo seed did" is a query.
        requestId: '00000000-0000-4000-8000-00000000d0ed',
      },
      () => withTenant(fn),
    );

  console.log('→ work breakdown and budget');
  const { budgetId, nodes } = await asUser(async (tx) => {
    const wbs = await createWbs(tx, {
      projectId: PROJECT,
      nodes: [
        { code: 'J', name: 'Joinery package' },
        { code: 'J-DOORS', name: 'Veneered doors', parentCode: 'J', ruleOfCredit: 'units', unitsPlanned: 100, uomCode: 'NR' },
        { code: 'J-WARD', name: 'Bedroom wardrobes', parentCode: 'J', ruleOfCredit: 'units', unitsPlanned: 40, uomCode: 'NR' },
        { code: 'J-RECEP', name: 'Reception desk', parentCode: 'J', ruleOfCredit: 'started_finished' },
      ],
    });

    const budget = await createBudgetVersion(tx, {
      projectId: PROJECT,
      source: 'estimate',
      lines: [
        { wbsCode: 'J-DOORS', category: 'material', description: 'Door blanks and veneer', lineCost: 300_000, lineValue: 375_000 },
        { wbsCode: 'J-DOORS', category: 'labour', description: 'Door manufacture and install', lineCost: 180_000, lineValue: 225_000 },
        { wbsCode: 'J-WARD', category: 'material', description: 'Carcass board and hardware', lineCost: 200_000, lineValue: 250_000 },
        { wbsCode: 'J-WARD', category: 'labour', description: 'Wardrobe manufacture', lineCost: 120_000, lineValue: 150_000 },
        { wbsCode: 'J-RECEP', category: 'material', description: 'Solid surface and veneer', lineCost: 60_000, lineValue: 75_000 },
      ],
    });

    await approveBudget(tx, { budgetId: budget.budgetId });
    return { budgetId: budget.budgetId, nodes: wbs.idsByCode };
  });

  console.log(`  budget ${budgetId} approved`);

  console.log('→ contract on UAE terms');
  const contractId = await asUser(async (tx) => {
    const created = await createContract(tx, {
      name: 'Marina Tower joinery package',
      projectId: PROJECT,
      countryCode: 'AE',
      currencyCode: 'AED',
      originalSum: 1_075_000,
      awardedOn: '2026-01-05',
      overrides: { taxPercent: 5 },
      lines: [
        { reference: 'A1', description: 'Veneered doors', quantity: 100, uomCode: 'NR', unitRate: 6_000, wbsNodeId: nodes.get('J-DOORS') },
        { reference: 'A2', description: 'Bedroom wardrobes', quantity: 40, uomCode: 'NR', unitRate: 10_000, wbsNodeId: nodes.get('J-WARD') },
        { reference: 'A3', description: 'Reception desk', quantity: 1, uomCode: 'NR', unitRate: 75_000, wbsNodeId: nodes.get('J-RECEP') },
      ],
    });

    console.log(
      `  ${created.number}: ${created.terms.retentionPercent}% retention, ` +
        `${created.terms.paymentTermDays}-day terms, ` +
        `${created.terms.defectsLiabilityMonths}-month DLP — all from packs/AE.json`,
    );

    await activateContract(tx, { contractId: created.contractId, commencedOn: '2026-01-12' });
    return created.contractId;
  });

  console.log('→ progress, then a payment application valued from it');
  await asUser(async (tx) => {
    await recordProgress(tx, {
      projectId: PROJECT,
      periodEnd: '2026-02-28',
      measurements: [
        { wbsCode: 'J-DOORS', unitsComplete: 50 },
        { wbsCode: 'J-WARD', unitsComplete: 10 },
        { wbsCode: 'J-RECEP', started: true },
      ],
    });

    const application = await createPaymentApplication(tx, {
      contractId,
      periodTo: '2026-02-28',
      periodFrom: '2026-01-12',
      workDoneToDate: 100 * 0.5 * 6_000 + 40 * 0.25 * 10_000 + 1 * 0.2 * 75_000,
    });

    await submitApplication(tx, { applicationId: application.applicationId, submittedOn: '2026-03-05' });
    await certifyApplication(tx, {
      applicationId: application.applicationId,
      certifiedNet: 340_000,
      certifiedTax: 17_000,
      certifiedOn: '2026-03-20',
      certificateReference: 'IPC-01-CERT',
      disallowedReason: 'Client QS disallowed four doors as not yet delivered to site.',
    });

    console.log(`  ${application.number}: applied ${application.valuation.netThisCertificate.toFixed(2)}, certified 340000.00`);
  });

  console.log('→ variations, one approved and one still exposed');
  await asUser(async (tx) => {
    const approved = await createVariation(tx, {
      contractId,
      title: 'Twelve additional doors to level 8',
      basis: 'contract_rates',
      instructionReference: 'SI-014',
      instructedOn: '2026-02-02',
      instructedBy: 'M. Consultant',
      percentExecuted: 100,
      lines: [{ description: 'Additional veneered doors', quantity: 12, unitRate: 6_500, unitCost: 4_800 }],
    });

    await approveVariation(tx, {
      variationId: approved.variationId,
      approvedValue: 70_000,
      approvedOn: '2026-04-10',
      reference: 'VO-014-APPROVED',
    });

    // Instructed, built, unpriced, and past its 28-day notice window. This is
    // the row the contract screen shows in red — the whole reason the module
    // is worth more than a spreadsheet.
    await createVariation(tx, {
      contractId,
      title: 'Upgrade reception desk to book-matched veneer',
      basis: 'star_rate',
      instructionReference: 'SI-021',
      instructedOn: '2026-03-15',
      instructedBy: 'M. Consultant',
      percentExecuted: 100,
      lines: [{ description: 'Book-matched veneer upgrade', quantity: 1, unitRate: 34_000, unitCost: 26_500 }],
    });
  });

  console.log('→ job costs and commitments');
  await asUser(async (tx) => {
    const posts = [
      { wbs: 'J-DOORS', category: 'material' as const, description: 'Veneer and board issue', amount: 260_000, sourceModule: 'inventory' },
      { wbs: 'J-DOORS', category: 'labour' as const, description: 'February shop-floor hours', amount: 165_000, sourceModule: 'production' },
      { wbs: 'J-WARD', category: 'material' as const, description: 'Carcass board issue', amount: 118_000, sourceModule: 'inventory' },
      { wbs: 'J-RECEP', category: 'material' as const, description: 'Solid surface deposit', amount: 22_000, sourceModule: 'inventory' },
    ];

    for (const post of posts) {
      await postCost(tx, {
        projectId: PROJECT,
        wbsNodeId: nodes.get(post.wbs),
        postedOn: '2026-03-31',
        category: post.category,
        description: post.description,
        sourceModule: post.sourceModule,
        amount: post.amount,
        currencyCode: 'AED',
      });
    }

    await recordCommitment(tx, {
      projectId: PROJECT,
      wbsNodeId: nodes.get('J-WARD'),
      type: 'subcontract',
      reference: 'SC-2026-004',
      category: 'subcontract',
      committedAmount: 180_000,
      currencyCode: 'AED',
      sourceModule: 'procurement',
    });
  });

  console.log('→ purchasing: an order, a part delivery, and one invoice that does not agree');
  await asUser(async (tx) => {
    // Adopting AE gives the tenant its own copy of the UAE tax codes, so the
    // purchase order picks up 5% VAT without anybody typing it. Same mechanism
    // as the contract terms above, different table.
    await adoptCountry(tx, { tenantId: TENANT, countryCode: 'AE', isPrimary: true });

    const [mdfItem] = await tx
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

    // A warehouse, so receiving in the demo actually posts stock rather than
    // silently skipping it — the composition is the thing worth demonstrating.
    const [factory] = await tx
      .insert(inventorySchema.warehouse)
      .values({
        tenantId: TENANT,
        code: 'FAC',
        name: 'Main Factory',
        type: 'factory',
      })
      .returning({ id: inventorySchema.warehouse.id });

    const suppliers = await tx
      .insert(schema.party)
      .values([
        { tenantId: TENANT, code: 'SUP-GULF', name: 'Gulf Panels Trading', isSupplier: true, countryCode: 'AE' },
        { tenantId: TENANT, code: 'SUP-HAF', name: 'Hafele Middle East', isSupplier: true, countryCode: 'AE' },
      ])
      .returning({ id: schema.party.id, code: schema.party.code });

    const gulf = suppliers.find((row) => row.code === 'SUP-GULF')!.id;
    const hafele = suppliers.find((row) => row.code === 'SUP-HAF')!.id;

    // Demand from site, approved before anybody is committed to a supplier.
    const requisition = await createRequisition(tx, {
      title: 'Carcass board — wardrobes',
      projectId: PROJECT,
      requiredBy: '2026-04-10',
      lines: [
        {
          description: '18mm MDF 2440x1220',
          quantity: 140,
          uomCode: 'NR',
          estimatedUnitPrice: 95,
          wbsNodeId: nodes.get('J-WARD'),
        },
      ],
    });
    await approveRequisition(tx, { requisitionId: requisition.requisitionId });

    // An order that is now past its promised date and only part delivered —
    // the row the overdue filter exists to surface.
    const board = await createPurchaseOrder(tx, {
      supplierId: gulf,
      countryCode: 'AE',
      projectId: PROJECT,
      currencyCode: 'AED',
      promisedDeliveryDate: '2026-04-05',
      lines: [
        {
          itemId: mdfItem!.id,
          description: '18mm MDF 2440x1220',
          quantity: 140,
          uomCode: 'NR',
          unitPrice: 96,
          warehouseId: factory!.id,
          wbsNodeId: nodes.get('J-WARD'),
        },
      ],
    });
    const issued = await issuePurchaseOrder(tx, { purchaseOrderId: board.purchaseOrderId });

    // The commitment against the budget. This is the number that makes the
    // forecast honest: 141,120 is spent in every sense that matters, months
    // before an invoice for it exists.
    const { commitmentId } = await recordCommitment(tx, {
      projectId: PROJECT,
      wbsNodeId: nodes.get('J-WARD'),
      type: 'purchase_order',
      reference: issued.number,
      partyId: gulf,
      description: `Purchase order ${issued.number}`,
      category: 'material',
      committedAmount: issued.baseValue,
      currencyCode: 'AED',
      sourceModule: 'procurement',
      sourceEntityId: issued.purchaseOrderId,
    });
    await linkCommitment(tx, { purchaseOrderId: board.purchaseOrderId, commitmentId });

    const [boardLine] = await tx
      .select()
      .from(procurementSchema.purchaseOrderLine)
      .where(eq(procurementSchema.purchaseOrderLine.purchaseOrderId, board.purchaseOrderId));

    const delivery = await receiveGoods(tx, {
      purchaseOrderId: board.purchaseOrderId,
      countryCode: 'AE',
      receivedOn: '2026-04-02',
      deliveryNoteReference: 'DN-7781',
      lines: [{ purchaseOrderLineId: boardLine!.id, quantityReceived: 90 }],
    });

    // The same composition the API route performs, mirrored here for the same
    // reason the commitment above is: this script calls services directly, and a
    // demo whose seeded delivery never reached stock would disagree with one
    // recorded through the UI a minute later.
    const stockable = delivery.postings.filter((p) => p.itemId && p.quantityAccepted > 0);
    if (stockable.length > 0) {
      const movement = await postMovement(tx, {
        type: 'receipt',
        movementDate: delivery.receivedOn,
        projectId: PROJECT,
        partyId: gulf,
        sourceModule: 'procurement',
        sourceEntityType: 'procurement.goods_receipt',
        sourceEntityId: delivery.goodsReceiptId,
        reference: delivery.number,
        lines: stockable.map((posting) => ({
          itemId: posting.itemId!,
          quantity: posting.quantityAccepted,
          toWarehouseId: posting.warehouseId,
          unitCost: posting.unitPriceBase,
        })),
      });

      await linkReceiptPostings(tx, {
        goodsReceiptId: delivery.goodsReceiptId,
        postings: stockable.map((posting) => ({
          goodsReceiptLineId: posting.goodsReceiptLineId,
          stockMovementId: movement.movementId,
        })),
      });
    }

    // Billed for the whole order against a part delivery. Nothing about this
    // invoice looks wrong on its own — only the cumulative position catches it,
    // and it lands on the exceptions queue with the money named.
    await registerInvoice(tx, {
      supplierId: gulf,
      purchaseOrderId: board.purchaseOrderId,
      countryCode: 'AE',
      supplierReference: 'GP-11402',
      invoiceDate: '2026-04-03',
      // Passed explicitly, or it defaults to today and the demo shows an invoice
      // dated April, received in July, and already overdue on arrival.
      receivedOn: '2026-04-06',
      currencyCode: 'AED',
      lines: [
        {
          purchaseOrderLineId: boardLine!.id,
          description: '18mm MDF 2440x1220',
          quantity: 140,
          unitPrice: 96,
          taxPercent: 5,
        },
      ],
    });

    // A second order that behaves itself, so the queue is a queue and not the
    // whole list — a demo where everything is broken teaches nothing.
    const hardware = await createPurchaseOrder(tx, {
      supplierId: hafele,
      countryCode: 'AE',
      projectId: PROJECT,
      currencyCode: 'AED',
      promisedDeliveryDate: '2026-04-20',
      lines: [
        {
          description: 'Soft-close hinge, full overlay',
          quantity: 800,
          uomCode: 'NR',
          unitPrice: 12,
          wbsNodeId: nodes.get('J-WARD'),
        },
      ],
    });
    await issuePurchaseOrder(tx, { purchaseOrderId: hardware.purchaseOrderId });

    const [hardwareLine] = await tx
      .select()
      .from(procurementSchema.purchaseOrderLine)
      .where(eq(procurementSchema.purchaseOrderLine.purchaseOrderId, hardware.purchaseOrderId));

    await receiveGoods(tx, {
      purchaseOrderId: hardware.purchaseOrderId,
      countryCode: 'AE',
      receivedOn: '2026-04-18',
      deliveryNoteReference: 'DN-7790',
      lines: [{ purchaseOrderLineId: hardwareLine!.id, quantityReceived: 800 }],
    });

    await registerInvoice(tx, {
      supplierId: hafele,
      purchaseOrderId: hardware.purchaseOrderId,
      countryCode: 'AE',
      supplierReference: 'HAF-55012',
      invoiceDate: '2026-04-19',
      receivedOn: '2026-04-21',
      currencyCode: 'AED',
      lines: [
        {
          purchaseOrderLineId: hardwareLine!.id,
          description: 'Soft-close hinge, full overlay',
          quantity: 800,
          unitPrice: 12,
          taxPercent: 5,
        },
      ],
    });
  });

  console.log('→ stores: a catalogue, a site store, offcuts off the saw, and a count that disagrees');
  await asUser(async (tx) => {
    const [mdf] = await tx
      .select({ id: schema.item.id })
      .from(schema.item)
      .where(and(eq(schema.item.tenantId, TENANT), eq(schema.item.code, 'MDF-18')));

    // A catalogue with one row in it demonstrates nothing. These are the four
    // shapes a joinery item master actually has to carry: a plain board, a
    // veneered board whose grain constrains the cutlist, a linear edging, and a
    // counted fitting.
    // Annotated because the rows differ in shape — a panel carries dimensions, a
    // fitting does not — and Drizzle's insert overloads cannot resolve a union.
    const itemRows: (typeof schema.item.$inferInsert)[] = [
        {
          tenantId: TENANT,
          code: 'MDF-VEN-OAK',
          name: '18mm MDF, oak veneer one face',
          type: 'panel' as const,
          lengthMm: '2440',
          widthMm: '1220',
          thicknessMm: '18',
          // The reason the offcut register has to know grain direction: a part
          // needing long grain cannot be taken across this board.
          hasGrainDirection: true,
          isBatchTracked: true,
          standardCost: '284.00',
        },
        {
          tenantId: TENANT,
          code: 'EDG-OAK-22',
          name: 'Oak edging 22mm x 1mm',
          type: 'raw_material' as const,
          standardCost: '4.20',
        },
        {
          tenantId: TENANT,
          code: 'HNG-SC-FO',
          name: 'Soft-close hinge, full overlay',
          type: 'hardware' as const,
          standardCost: '12.00',
        },
        {
          tenantId: TENANT,
          code: 'LAM-WHT-08',
          name: '0.8mm white laminate 3050x1300',
          type: 'panel' as const,
          lengthMm: '3050',
          widthMm: '1300',
          thicknessMm: '0.8',
          // Discontinued, not deleted: it has moved, so the ledger still needs
          // it. This is the row that proves the list hides inactive items.
          isActive: false,
          standardCost: '96.00',
        },
    ];

    const items = await tx
      .insert(schema.item)
      .values(itemRows)
      .returning({ id: schema.item.id, code: schema.item.code });

    const itemId = (code: string) => items.find((i) => i.code === code)!.id;

    const [factory] = await tx
      .select({ id: inventorySchema.warehouse.id })
      .from(inventorySchema.warehouse)
      .where(and(eq(inventorySchema.warehouse.tenantId, TENANT), eq(inventorySchema.warehouse.code, 'FAC')));

    // A site store, so "where is it" is a real question in the demo rather than
    // a column with one value in it.
    const [site] = await tx
      .insert(inventorySchema.warehouse)
      .values({
        tenantId: TENANT,
        code: 'SITE-MT',
        name: 'Marina Tower site store',
        type: 'site' as const,
        projectId: PROJECT,
      })
      .returning({ id: inventorySchema.warehouse.id });

    await tx.insert(inventorySchema.storageBin).values([
      { tenantId: TENANT, warehouseId: factory!.id, code: 'A-01', name: 'Board rack A' },
      { tenantId: TENANT, warehouseId: factory!.id, code: 'OC-01', name: 'Offcut rack' },
      { tenantId: TENANT, warehouseId: site!.id, code: 'CONT-1', name: 'Container 1' },
    ]);

    const [oakBatch] = await tx
      .insert(inventorySchema.batch)
      .values({
        tenantId: TENANT,
        itemId: itemId('MDF-VEN-OAK'),
        code: 'B-OAK-2604',
        supplierBatchRef: 'GP-OAK-88213',
        // Veneer is matched by batch or the doors do not match each other.
        grainCode: 'OAK-CROWN',
        colourCode: 'NAT',
        receivedOn: '2026-04-08',
      })
      .returning({ id: inventorySchema.batch.id });

    // Receive the veneered board and the fittings, so there is something to cut
    // and something to count.
    await postMovement(tx, {
      type: 'receipt',
      movementDate: '2026-04-08',
      reference: 'IGRN-DEMO-OAK',
      lines: [
        {
          itemId: itemId('MDF-VEN-OAK'),
          quantity: 40,
          toWarehouseId: factory!.id,
          batchId: oakBatch!.id,
          unitCost: 284,
        },
        { itemId: itemId('EDG-OAK-22'), quantity: 900, toWarehouseId: factory!.id, unitCost: 4.2 },
        { itemId: itemId('HNG-SC-FO'), quantity: 800, toWarehouseId: factory!.id, unitCost: 12 },
      ],
    });

    // Some board goes to site, so one item sits in two places and the warehouse
    // filter has work to do.
    await postMovement(tx, {
      type: 'transfer',
      movementDate: '2026-04-22',
      reference: 'STR-DEMO-1',
      lines: [
        {
          itemId: itemId('MDF-VEN-OAK'),
          quantity: 6,
          fromWarehouseId: factory!.id,
          toWarehouseId: site!.id,
          batchId: oakBatch!.id,
        },
      ],
    });

    // Cutting the doors. This is the movement that fills the offcut register:
    // the remnants are declared against the parent sheet, so each one carries
    // its share of what the sheet cost rather than a guess.
    await postMovement(tx, {
      type: 'issue',
      movementDate: '2026-04-24',
      projectId: PROJECT,
      reference: 'ISS-DEMO-DOORS',
      lines: [
        {
          itemId: itemId('MDF-VEN-OAK'),
          quantity: 9,
          fromWarehouseId: factory!.id,
          batchId: oakBatch!.id,
          parentSheet: { lengthMm: 2440, widthMm: 1220 },
          offcutsProduced: [
            { lengthMm: 1180, widthMm: 620, thicknessMm: 18, grainDirection: 'length' as const, grainCode: 'OAK-CROWN', colourCode: 'NAT', finishedEdges: 2, barcode: 'OC-2026-0001' },
            { lengthMm: 2440, widthMm: 310, thicknessMm: 18, grainDirection: 'length' as const, grainCode: 'OAK-CROWN', colourCode: 'NAT', finishedEdges: 1, barcode: 'OC-2026-0002' },
            { lengthMm: 860, widthMm: 540, thicknessMm: 18, grainDirection: 'width' as const, grainCode: 'OAK-CROWN', colourCode: 'NAT', barcode: 'OC-2026-0003' },
            // Below the minimum usable size. Deliberately included: the register
            // should NOT show it, because the rule scrapped it at the saw, and a
            // demo that only contains passing cases proves the rule never fires.
            { lengthMm: 300, widthMm: 90, thicknessMm: 18, barcode: 'OC-2026-0004' },
          ],
        },
      ],
    });

    // Reorder levels, so "what is short" is answerable. The hinge level is set
    // above what is left on purpose — a register with no exceptions in it does
    // not show anyone what an exception looks like.
    await tx.insert(inventorySchema.reorderRule).values([
      { tenantId: TENANT, itemId: itemId('MDF-VEN-OAK'), warehouseId: factory!.id, minimumQuantity: '20', reorderQuantity: '40', leadTimeDays: 21 },
      { tenantId: TENANT, itemId: itemId('HNG-SC-FO'), warehouseId: factory!.id, minimumQuantity: '1200', reorderQuantity: '2000', leadTimeDays: 30 },
      { tenantId: TENANT, itemId: mdf!.id, warehouseId: factory!.id, minimumQuantity: '25', reorderQuantity: '100', leadTimeDays: 14 },
    ]);

    // A count in progress. The variances are the point: one over, one short, one
    // exact. A count that agrees with the book everywhere is not evidence that
    // counting works — it is evidence that nobody counted.
    const [count] = await tx
      .insert(inventorySchema.stockCount)
      .values({
        tenantId: TENANT,
        number: 'SC-2026-0001',
        warehouseId: factory!.id,
        status: 'counting' as const,
        countDate: '2026-06-30',
        notes: 'Half-year count, board rack and fittings.',
      })
      .returning({ id: inventorySchema.stockCount.id });

    await tx.insert(inventorySchema.stockCountLine).values([
      { tenantId: TENANT, countId: count!.id, itemId: itemId('MDF-VEN-OAK'), systemQuantity: '25', countedQuantity: '23', varianceReason: 'Two sheets damaged in handling, not written off yet.', countedAt: new Date('2026-06-30T06:20:00Z') },
      { tenantId: TENANT, countId: count!.id, itemId: itemId('HNG-SC-FO'), systemQuantity: '800', countedQuantity: '812', varianceReason: 'Returns from site never booked back in.', countedAt: new Date('2026-06-30T06:40:00Z') },
      { tenantId: TENANT, countId: count!.id, itemId: itemId('EDG-OAK-22'), systemQuantity: '900', countedQuantity: '900', countedAt: new Date('2026-06-30T07:00:00Z') },
      // Not yet counted. The register reports counted-of-total, so a count that
      // is half done looks half done rather than finished.
      { tenantId: TENANT, countId: count!.id, itemId: mdf!.id, systemQuantity: '90' },
    ]);

    // A clean one from the quarter before, so the register is not one row.
    const [prior] = await tx
      .insert(inventorySchema.stockCount)
      .values({
        tenantId: TENANT,
        number: 'SC-2026-0000',
        warehouseId: factory!.id,
        status: 'posted' as const,
        countDate: '2026-03-31',
        postedAt: new Date('2026-03-31T13:00:00Z'),
      })
      .returning({ id: inventorySchema.stockCount.id });

    await tx.insert(inventorySchema.stockCountLine).values([
      { tenantId: TENANT, countId: prior!.id, itemId: mdf!.id, systemQuantity: '40', countedQuantity: '40', countedAt: new Date('2026-03-31T09:00:00Z') },
    ]);
  });

  console.log('\n✓ demo workspace ready');
  console.log(`  sign in:  ${EMAIL} / ${PASSWORD}`);
  console.log(`  project:  /projects/${PROJECT}`);
  console.log(`  contract: /contracts/${contractId}`);
  console.log('  lists:    /projects · /contracts · /procurement/orders · /procurement/exceptions');
  console.log('  stores:   /inventory/items · /inventory/stock · /inventory/offcuts · /inventory/counts');

  await closeDatabase();
}

main().catch(async (error) => {
  console.error('✗ demo seed failed:', error);
  await closeDatabase().catch(() => undefined);
  process.exit(1);
});

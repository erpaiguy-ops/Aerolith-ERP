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
  requestApproval,
  schema,
  runWithTenantContext,
  withTenant,
  withTenantId,
  withoutTenantGuard,
} from '@aerolith/kernel';
import {
  createEstimate,
  createTender,
  estimationSchema,
  recordBidDecision,
  submitEstimate,
} from '@aerolith/module-estimation';
import { inventorySchema, postMovement } from '@aerolith/module-inventory';
import {
  createWorkOrder,
  productionSchema,
  releaseWorkOrder,
  saveCuttingPlan,
} from '@aerolith/module-production';
import {
  approveRequisition,
  createPurchaseOrder,
  createRequisition,
  createRfq,
  issuePurchaseOrder,
  linkCommitment,
  linkReceiptPostings,
  procurementSchema,
  receiveGoods,
  recordQuote,
  registerInvoice,
} from '@aerolith/module-procurement';
import {
  activateContract,
  approveVariation,
  certifyApplication,
  createContract,
  createPaymentApplication,
  createSubmittal,
  createVariation,
  recordReview,
  scheduleRetentionRelease,
  submitApplication,
  submitRevision,
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
import { optimise, type Part, type StockItem } from '@aerolith/cutlist';
import { and, eq, inArray } from 'drizzle-orm';

import { syncModules } from '../src/bootstrap';

// The same connection apps/api/src/main.ts uses, and deliberately not
// DATABASE_URL: every RLS policy `packages/kernel/src/db/rls.ts` creates is
// scoped `TO aerolith_app` by name. A connection authenticated as any other
// role — including the migration/owner role DATABASE_URL points at — matches
// zero policies on a tenant-scoped table, forced RLS included, and gets a
// hard "new row violates row-level security policy" on every INSERT no
// matter what `app.tenant_id` is set to. withTenant/withTenantId only ever
// set that guard; they cannot substitute for connecting as the role the
// policies actually name.
const url = process.env.DATABASE_APP_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_APP_URL (or DATABASE_URL) must be set.');
  process.exit(1);
}

const TENANT = 'd0000000-0000-4000-8000-00000000d000';
const USER = 'd0000000-0000-4000-8000-00000000u000'.replace('u', 'a');
/**
 * A second user, and not a decoration.
 *
 * The engine filters the requester out of the approver list — nobody approves
 * their own request — so a one-user demo has a permanently empty inbox and the
 * whole approval subsystem looks like it does nothing. This user raises the
 * requests the demo user is asked to decide.
 */
const QS_USER = 'd0000000-0000-4000-8000-00000000a001';
const PROJECT = 'd0000000-0000-4000-8000-00000000p000'.replace('p', 'b');
const EMAIL = 'demo@aerolith.test';
const PASSWORD = 'demo-passphrase-2026';

async function main() {
  createDatabase({ connectionString: url! });
  await syncModules();

  // --- Clean slate ---------------------------------------------------------
  // Every table below except `session` and `appUser` is tenant-scoped and RLS
  // protected (the module schemas apply the same `FORCE ROW LEVEL SECURITY`
  // policy shape as the kernel — see packages/*/db/security.ts). A DELETE's
  // `USING` policy that never matches does not error, it just deletes zero
  // rows — so running this under `withoutTenantGuard` looked idempotent and
  // was actually a silent no-op on any role without a bypass privilege,
  // leaving stale rows for the next run to collide with on their primary
  // keys. `withTenantId` makes the guard match every predicate here,
  // including `tenant`'s own self-keyed policy (`id = app.tenant_id`).
  //
  // `auditLog` and `approvalAction` are deliberately absent from this list.
  // Both are append-only (packages/kernel/src/db/rls.ts's APPEND_ONLY_TABLES):
  // `aerolith_app` has UPDATE and DELETE explicitly REVOKEd on them at the
  // database level, by design — "immutable audit trail" is meant to survive
  // even a demo tenant reset, not just a permission an admin could route
  // around. `approvalAction.instanceId` carries a real `ON DELETE CASCADE` FK
  // to `approvalInstance`, deleted below, so it cleans itself up regardless.
  // `auditLog` carries no FK into it from anything, so leaving its rows
  // behind (pointing at entity ids this reseed is about to recycle) breaks
  // nothing — there is no constraint anywhere that requires them gone first.
  await withTenantId(TENANT, async (tx) => {
    for (const table of [
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
      contractsSchema.submittalRevision,
      contractsSchema.submittal,
      contractsSchema.contractLine,
      contractsSchema.contract,

      // Order matters. An offcut points at the movement that produced it, and a
      // stock count points at the adjustment that posted it, so both go before
      // `stockMovement`; bins and batches go before the warehouse that owns them.
      // Production: parts, operations and scans hang off the work order; a
      // finishing batch points at parts, and a cutting plan at the order.
      // `productionScan` is not listed: it is append-only (PRODUCTION_APPEND_ONLY_TABLES),
      // so `aerolith_app` has DELETE revoked on it outright, same as `auditLog`
      // above — but every FK into it (`workOrderId`, `operationId`) cascades, so
      // deleting `workOrder` below removes it automatically.
      productionSchema.finishingBatchPart,
      productionSchema.finishingBatch,
      productionSchema.cuttingPlan,
      productionSchema.workOrderOperation,
      productionSchema.workOrderPart,
      productionSchema.workOrder,
      productionSchema.routingOperation,
      productionSchema.routing,
      productionSchema.workCentre,

      // Estimating: lines and components hang off the estimate, the estimate off
      // the tender, and rate items off the library. Deepest first.
      estimationSchema.estimateLineComponent,
      estimationSchema.estimateLine,
      estimationSchema.estimateSection,
      estimationSchema.estimate,
      estimationSchema.tenderAddendum,
      estimationSchema.tender,
      estimationSchema.rateComponent,
      estimationSchema.rateItem,
      estimationSchema.rateLibrary,

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
      // `goodsReceiptLine` is not listed: append-only (PROCUREMENT_APPEND_ONLY_TABLES),
      // DELETE revoked from `aerolith_app` outright. Unlike `productionScan`
      // above, its FK to `goodsReceipt` is `onDelete: 'restrict'`, not cascade —
      // so once this tenant has actually received goods, no role this script can
      // use is able to delete `goodsReceipt` either: `aerolith_app` still holds
      // the DELETE grant on `goodsReceipt` itself, but the restrict blocks it
      // while un-deletable `goodsReceiptLine` rows still reference it, and the
      // delete below will throw a real foreign-key violation rather than the
      // silent zero-row no-op the tables above get. A first run against a fresh
      // tenant (nothing received yet) never reaches this — flagged here as a
      // real limitation on any LATER reseed, not something this pass fixes.
      procurementSchema.goodsReceipt,
      procurementSchema.purchaseOrderLine,
      procurementSchema.purchaseOrder,
      // Quotes hang off the enquiry and lines off both, so deepest first. A
      // purchase order may point at the quote it was awarded from, which is why
      // these come after the order above rather than before it.
      procurementSchema.quoteLine,
      procurementSchema.quote,
      procurementSchema.rfqLine,
      procurementSchema.rfq,
      procurementSchema.requisitionLine,
      procurementSchema.requisition,

      // `costEntry` is not listed: append-only (PROJECTS_APPEND_ONLY_TABLES),
      // DELETE revoked from `aerolith_app`. Its own FKs are nullable/set-null
      // (`wbsNodeId`) or not real FKs at all (`projectId` is a plain uuid, same
      // reasoning as the kernel-vs-module note above), and nothing references it,
      // so leftover rows here are inert — no cascade needed, nothing blocked.
      projectsSchema.commitment,
      projectsSchema.progressEntry,
      projectsSchema.budgetLine,
      projectsSchema.budget,
      projectsSchema.snag,
      projectsSchema.milestone,
      projectsSchema.wbsNode,
      projectsSchema.projectDetail,

      // Approvals. Tasks hang off the instance, the instance off a pinned
      // workflow version, and the version off the workflow. Missing from this
      // list until now, which meant a second run of the seed died on
      // `approval_workflow_uq` — the same "idempotent by accident of always
      // running against a fresh database" failure the note above describes.
      // `approvalAction` is not listed: it is append-only (see the note above
      // this loop) and cleans itself up via its own `ON DELETE CASCADE` FK to
      // `approvalInstance`, deleted below.
      schema.approvalTask,
      schema.approvalInstance,
      schema.approvalWorkflowVersion,
      schema.approvalWorkflow,
      schema.approvalDelegation,
      schema.authorityLimit,

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
    await tx.delete(schema.appUser).where(inArray(schema.appUser.id, [USER, QS_USER]));
    await tx.delete(schema.tenant).where(eq(schema.tenant.id, TENANT));
  });

  console.log('→ workspace');
  // `tenant` and `appUser` carry no `tenant_id` at all — genuinely platform-level
  // tables, so `withoutTenantGuard` is correct for them. Everything below this
  // point (membership, role, rolePermission, userRole, tenantModule, numberSeries,
  // project) IS tenant-scoped, so it moves to `withTenantId`: the tenant row above
  // already exists once this transaction opens, and the id is known outright — no
  // request-scoped context exists yet, which is exactly what `withTenantId` is for.
  // Running these under `withoutTenantGuard` instead used to "work" locally only
  // because the local Postgres role holds a bypass privilege a managed database's
  // application role does not; Render's Postgres enforces `FORCE ROW LEVEL
  // SECURITY` for real and rejected every one of these inserts with
  // `new row violates row-level security policy`.
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

    const hash = await hashPassword(PASSWORD);

    await tx.insert(schema.appUser).values([
      {
        id: USER,
        email: EMAIL,
        name: 'Demo Commercial Manager',
        locale: 'en',
        passwordHash: hash,
      },
      {
        id: QS_USER,
        email: 'qs@aerolith.test',
        name: 'Rana Haddad',
        locale: 'en',
        passwordHash: hash,
      },
    ]);
  });

  await withTenantId(TENANT, async (tx) => {
    await tx.insert(schema.membership).values([
      { tenantId: TENANT, userId: USER, status: 'active', isOwner: true },
      // Not an owner: an owner bypasses the permission matrix, and a demo where
      // everyone is an owner cannot show an approval routed to somebody who
      // lacks the authority to just do the thing themselves.
      { tenantId: TENANT, userId: QS_USER, status: 'active', isOwner: false },
    ]);

    /*
     * Roles, and one person who actually holds one.
     *
     * The RBAC schema has been here since the first migration and the demo had
     * no roles at all: two members, both with an empty permission set, one of
     * them an owner who bypasses the matrix anyway. That meant every permission
     * gate in the application was only ever exercised against somebody it never
     * applied to, and Rana — the quantity surveyor the approval workflow routes
     * to — could sign in and see nothing but her inbox.
     *
     * `isApprovalTarget` matters on the QS role: an approval step can route to a
     * role rather than a named person, which is what keeps a workflow working
     * after somebody leaves.
     */
    const [qsRole, storeRole] = await tx
      .insert(schema.role)
      .values([
        {
          tenantId: TENANT,
          code: 'QUANTITY_SURVEYOR',
          name: 'Quantity Surveyor',
          description: 'Values work, raises variations, reads the commercial position.',
          isApprovalTarget: true,
        },
        {
          tenantId: TENANT,
          code: 'STOREKEEPER',
          name: 'Storekeeper',
          description: 'Runs the stores. Moves stock, counts it, cannot price it.',
        },
      ])
      .returning({ id: schema.role.id, code: schema.role.code });

    await tx.insert(schema.rolePermission).values([
      ...[
        'projects.project.read',
        'projects.progress.record',
        'projects.cost.read',
        'projects.snag.read',
        'contracts.contract.read',
        'contracts.variation.read',
        'contracts.variation.write',
        'contracts.application.read',
        'contracts.application.write',
        'inventory.stock.read',
      ].map((permissionKey) => ({ tenantId: TENANT, roleId: qsRole!.id, permissionKey })),
      ...[
        'inventory.item.read',
        'inventory.stock.read',
        'inventory.stock_movement.create',
      ].map((permissionKey) => ({ tenantId: TENANT, roleId: storeRole!.id, permissionKey })),
    ]);

    await tx
      .insert(schema.userRole)
      .values({ tenantId: TENANT, userId: QS_USER, roleId: qsRole!.id, grantedBy: USER });

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
      { tenantId: TENANT, entityType: 'contracts.submittal', code: 'SUB', name: 'Submittal', pattern: 'SUB-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'projects.snag', code: 'SNG', name: 'Snag', pattern: 'SNG-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'estimation.tender', code: 'TND', name: 'Tender', pattern: 'TND-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'production.work_order', code: 'WO', name: 'Work Order', pattern: 'WO-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'procurement.requisition', code: 'PR', name: 'Requisition', pattern: 'PR-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'procurement.purchase_order', code: 'PO', name: 'Purchase Order', pattern: 'PO-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'procurement.rfq', code: 'RFQ', name: 'Request for Quotation', pattern: 'RFQ-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'procurement.goods_receipt', code: 'GRN', name: 'Goods Receipt', pattern: 'GRN-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'procurement.supplier_invoice', code: 'SINV', name: 'Supplier Invoice', pattern: 'SINV-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'inventory.receipt', code: 'IGRN', name: 'Stock Receipt', pattern: 'IGRN-{YYYY}-{SEQ}' },
      // Every movement type the demo posts needs its own series, and posting is
      // what allocates the number — a missing series does not degrade, it throws.
      { tenantId: TENANT, entityType: 'inventory.issue', code: 'ISS', name: 'Stock Issue', pattern: 'ISS-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'inventory.transfer', code: 'STR', name: 'Stock Transfer', pattern: 'STR-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'inventory.adjustment', code: 'ADJ', name: 'Stock Adjustment', pattern: 'ADJ-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'inventory.stock_count', code: 'CNT', name: 'Stock Count', pattern: 'CNT-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'inventory.scrap', code: 'SCR', name: 'Stock Scrap', pattern: 'SCR-{YYYY}-{SEQ}' },
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

  /** The same, as the quantity surveyor who raises the requests. */
  const asQuantitySurveyor = <T>(
    fn: (tx: Parameters<Parameters<typeof withTenant>[0]>[0]) => Promise<T>,
  ) =>
    runWithTenantContext(
      {
        tenantId: TENANT,
        userId: QS_USER,
        actorType: 'user',
        locale: 'en',
        timezone: 'Asia/Dubai',
        countryCode: 'AE',
        currencyCode: 'AED',
        permissions: new Set<string>(),
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

  console.log('→ estimating: a rate library with actuals behind it, and two tenders');
  await asUser(async (tx) => {
    // The library is versioned and exactly one is current. An estimate pins the
    // one it was priced from, which is why the library can move on afterwards
    // without rewriting a submitted price.
    // The build-ups below link to real stock items, which is what lets an
    // estimate explode into a bill of materials rather than a list of prices.
    const itemRowsForRates = await tx
      .select({ id: schema.item.id, code: schema.item.code })
      .from(schema.item)
      .where(eq(schema.item.tenantId, TENANT));
    const itemsByCode = new Map(itemRowsForRates.map((i) => [i.code, i.id]));

    const [library] = await tx
      .insert(estimationSchema.rateLibrary)
      .values({
        tenantId: TENANT,
        code: 'STD',
        name: 'Standard joinery rates',
        version: 3,
        currencyCode: 'AED',
        isCurrent: true,
        effectiveFrom: '2026-01-01',
      })
      .returning({ id: estimationSchema.rateLibrary.id });

    // `lastActualCost` is what finished jobs have actually cost. The register
    // reports the gap as a suggestion and never applies it — an estimator whose
    // rates change under them stops trusting the library, which is worse than a
    // rate being slightly stale.
    // `directCost` and `unitRate` are CACHES of the build-up below, not
    // independent numbers — every figure here was computed from the components
    // rather than typed, or the rate library would disagree with the estimates
    // priced from it.
    const rateRows: (typeof estimationSchema.rateItem.$inferInsert)[] = [
      {
        tenantId: TENANT,
        libraryId: library!.id,
        code: 'DOOR-VEN',
        description: 'Veneered flush door, factory finished, hung',
        uomCode: 'NR',
        category: 'doors',
        directCost: '1217.1680',
        unitRate: '1521.4600',
        marginPercent: '20.000',
        // Costing MORE than the library charges: every door priced at this rate
        // has been losing the difference.
        lastActualCost: '1602.0000',
        actualSampleSize: 14,
        lastActualAt: new Date('2026-05-18T00:00:00Z'),
      },
      {
        tenantId: TENANT,
        libraryId: library!.id,
        code: 'WARD-CARC',
        description: 'Wardrobe carcass, 18mm MDF, edge banded',
        uomCode: 'M2',
        category: 'carcass',
        directCost: '317.7408',
        unitRate: '397.1760',
        marginPercent: '20.000',
        lastActualCost: '284.0000',
        actualSampleSize: 31,
        lastActualAt: new Date('2026-06-02T00:00:00Z'),
      },
      {
        tenantId: TENANT,
        libraryId: library!.id,
        code: 'RECEP-SS',
        description: 'Solid surface reception counter, fabricated and installed',
        uomCode: 'M',
        category: 'special',
        directCost: '2624.0000',
        unitRate: '3425.5875',
        marginPercent: '23.400',
      },
      {
        tenantId: TENANT,
        libraryId: library!.id,
        code: 'EDGE-TAPE',
        description: 'Edge banding, 22mm oak, applied',
        uomCode: 'M',
        category: 'carcass',
        directCost: '6.3105',
        unitRate: '7.8881',
        // Retired: superseded by a wider tape. Kept because estimates that used
        // it must still reproduce.
        isActive: false,
      },
    ];
    const rates = await tx
      .insert(estimationSchema.rateItem)
      .values(rateRows)
      .returning({ id: estimationSchema.rateItem.id, code: estimationSchema.rateItem.code });

    const rateId = (code: string) => rates.find((r) => r.code === code)!.id;

    // The build-ups. A rate without components prices a BOQ line to ZERO —
    // `createEstimate` snapshots the build-up, not the cached `unitRate`, which
    // is the whole reason a submitted price can be reproduced after the library
    // moves on. Seeding the cached figures alone produced two estimates worth
    // exactly the provisional sum and nothing else.
    //
    // `wastagePercent` is on material only. Cutting 10% extra board does not
    // mean paying the joiner 10% more, and putting wastage on labour is the
    // single most common way a build-up quietly inflates.
    const boardItem = itemsByCode.get('MDF-VEN-OAK') ?? null;

    await tx.insert(estimationSchema.rateComponent).values([
      // Veneered door: 1180.00 direct
      { tenantId: TENANT, rateItemId: rateId('DOOR-VEN'), sequence: 1, type: 'material' as const, description: 'Veneered blank, 2 faces', itemId: boardItem, quantityPerUnit: '1.900000', unitRate: '284.000000', wastagePercent: '8.000' },
      { tenantId: TENANT, rateItemId: rateId('DOOR-VEN'), sequence: 2, type: 'hardware' as const, description: 'Hinges, lockset, closer', quantityPerUnit: '1.000000', unitRate: '210.000000' },
      { tenantId: TENANT, rateItemId: rateId('DOOR-VEN'), sequence: 3, type: 'labour' as const, description: 'Machining, assembly and hanging', quantityPerUnit: '5.500000', unitRate: '42.000000' },
      { tenantId: TENANT, rateItemId: rateId('DOOR-VEN'), sequence: 4, type: 'finishing' as const, description: 'Spray, 2 coats plus cure', quantityPerUnit: '1.000000', unitRate: '148.000000', wastagePercent: '5.000' },
      { tenantId: TENANT, rateItemId: rateId('DOOR-VEN'), sequence: 5, type: 'transport' as const, description: 'Delivery and offload', quantityPerUnit: '1.000000', unitRate: '38.000000' },

      // Wardrobe carcass per m2: 312.00 direct
      { tenantId: TENANT, rateItemId: rateId('WARD-CARC'), sequence: 1, type: 'material' as const, description: '18mm MDF', itemId: boardItem, quantityPerUnit: '1.150000', unitRate: '96.000000', wastagePercent: '12.000' },
      { tenantId: TENANT, rateItemId: rateId('WARD-CARC'), sequence: 2, type: 'material' as const, description: 'Edge tape', quantityPerUnit: '4.200000', unitRate: '6.400000', wastagePercent: '6.000' },
      { tenantId: TENANT, rateItemId: rateId('WARD-CARC'), sequence: 3, type: 'labour' as const, description: 'Cut, band, drill and assemble', quantityPerUnit: '2.800000', unitRate: '42.000000' },
      { tenantId: TENANT, rateItemId: rateId('WARD-CARC'), sequence: 4, type: 'hardware' as const, description: 'Fittings and fixings', quantityPerUnit: '1.000000', unitRate: '48.000000' },

      // Reception counter per m: 2450.00 direct
      { tenantId: TENANT, rateItemId: rateId('RECEP-SS'), sequence: 1, type: 'material' as const, description: 'Solid surface sheet and adhesive', quantityPerUnit: '1.000000', unitRate: '1420.000000', wastagePercent: '15.000' },
      { tenantId: TENANT, rateItemId: rateId('RECEP-SS'), sequence: 2, type: 'material' as const, description: 'Substrate and framing', quantityPerUnit: '1.000000', unitRate: '190.000000', wastagePercent: '10.000' },
      { tenantId: TENANT, rateItemId: rateId('RECEP-SS'), sequence: 3, type: 'labour' as const, description: 'Fabrication, seaming and polishing', quantityPerUnit: '9.000000', unitRate: '58.000000' },
      { tenantId: TENANT, rateItemId: rateId('RECEP-SS'), sequence: 4, type: 'subcontract' as const, description: 'Specialist installation', quantityPerUnit: '1.000000', unitRate: '260.000000' },

      // Retired edge tape, kept so estimates that used it still reproduce.
      { tenantId: TENANT, rateItemId: rateId('EDGE-TAPE'), sequence: 1, type: 'material' as const, description: 'Oak tape 22mm', quantityPerUnit: '1.050000', unitRate: '4.200000', wastagePercent: '5.000' },
      { tenantId: TENANT, rateItemId: rateId('EDGE-TAPE'), sequence: 2, type: 'labour' as const, description: 'Apply and trim', quantityPerUnit: '0.040000', unitRate: '42.000000' },
    ]);

    // The seed had suppliers but no customer, so every client column rendered
    // empty and searching a tender by client matched nothing.
    const [client] = await tx
      .insert(schema.party)
      .values({
        tenantId: TENANT,
        code: 'CLI-EMAAR',
        name: 'Emaar Properties PJSC',
        isCustomer: true,
        countryCode: 'AE',
      })
      .returning({ id: schema.party.id });

    // A live tender, closing soon, priced twice. Two versions is the normal
    // case, not an edge case: the second is what actually went out.
    const live = await createTender(tx, {
      name: 'Business Bay lobby and lift lobbies',
      clientPartyId: client?.id,
      currencyCode: 'AED',
      submissionDueAt: '2026-08-04T12:00:00Z',
      validityDays: 90,
    });

    await createEstimate(tx, {
      tenderId: live.tenderId,
      label: 'Base bid',
      rateLibraryId: library!.id,
      overheadPercent: 8,
      marginPercent: 18,
      lines: [
        { description: 'Veneered doors to lobbies', quantity: 24, uomCode: 'NR', rateItemCode: 'DOOR-VEN' },
        { description: 'Reception counter', quantity: 6.5, uomCode: 'M', rateItemCode: 'RECEP-SS' },
        {
          description: 'Feature wall panelling — design not yet issued',
          quantity: 1,
          uomCode: 'SUM',
          kind: 'provisional_sum',
          unitRate: 85_000,
        },
      ],
    });

    const sharper = await createEstimate(tx, {
      tenderId: live.tenderId,
      label: 'Sharpened — reduced margin to win',
      rateLibraryId: library!.id,
      overheadPercent: 8,
      marginPercent: 12,
      lines: [
        { description: 'Veneered doors to lobbies', quantity: 24, uomCode: 'NR', rateItemCode: 'DOOR-VEN' },
        { description: 'Reception counter', quantity: 6.5, uomCode: 'M', rateItemCode: 'RECEP-SS' },
        {
          description: 'Feature wall panelling — design not yet issued',
          quantity: 1,
          uomCode: 'SUM',
          kind: 'provisional_sum',
          unitRate: 85_000,
        },
      ],
    });
    await submitEstimate(tx, { estimateId: sharper.estimateId });

    // A no-bid, with its reason. Recording WHY is the point: a no-bid without a
    // reason is indistinguishable from a tender nobody got round to.
    const declined = await createTender(tx, {
      name: 'Airport concourse retail fit-out',
      clientPartyId: client?.id,
      currencyCode: 'AED',
      submissionDueAt: '2026-07-10T12:00:00Z',
    });
    await recordBidDecision(tx, {
      tenderId: declined.tenderId,
      decision: 'no_bid',
      reason: 'Programme needs 40 doors a week through the spray booth. We can do 22.',
    });
  });

  console.log('→ production: work centres, a routing, an order on the floor and a booth curing');
  await asUser(async (tx) => {
    const centres = await tx
      .insert(productionSchema.workCentre)
      .values([
        { tenantId: TENANT, code: 'SAW', name: 'Beam saw', type: 'beam_saw' as const, setupMinutes: '15', runMinutesPerUnit: '2.5000', costPerHour: '180.0000' },
        { tenantId: TENANT, code: 'EB', name: 'Edgebander', type: 'edgebander' as const, setupMinutes: '10', runMinutesPerUnit: '1.8000', costPerHour: '150.0000' },
        { tenantId: TENANT, code: 'CNC', name: 'CNC router', type: 'cnc' as const, setupMinutes: '25', runMinutesPerUnit: '4.0000', costPerHour: '320.0000' },
        // A batch process, and the reason finishing is modelled separately: the
        // booth takes a load and the cure clock then runs regardless of how many
        // are in it.
        { tenantId: TENANT, code: 'SPRAY', name: 'Spray booth 1', type: 'spray_booth' as const, setupMinutes: '20', runMinutesPerUnit: '0.8000', costPerHour: '210.0000', isBatchProcess: true, batchCapacityUnits: 40 },
        { tenantId: TENANT, code: 'ASSY', name: 'Assembly bay', type: 'assembly' as const, setupMinutes: '5', runMinutesPerUnit: '12.0000', costPerHour: '140.0000' },
      ])
      .returning({ id: productionSchema.workCentre.id, code: productionSchema.workCentre.code });

    const centre = (code: string) => centres.find((c) => c.code === code)!.id;

    const [carcassRouting] = await tx
      .insert(productionSchema.routing)
      .values({
        tenantId: TENANT,
        code: 'RT-CARC',
        name: 'Carcass — saw, band, machine, assemble',
        description: 'Standard wardrobe and cupboard carcass.',
        isDefault: true,
      })
      .returning({ id: productionSchema.routing.id });

    const [doorRouting] = await tx
      .insert(productionSchema.routing)
      .values({
        tenantId: TENANT,
        code: 'RT-DOOR',
        name: 'Veneered door — saw, band, spray, cure',
        description: 'Anything that goes through the booth.',
      })
      .returning({ id: productionSchema.routing.id });

    await tx.insert(productionSchema.routingOperation).values([
      { tenantId: TENANT, routingId: carcassRouting!.id, sequence: 10, name: 'Cut to size', workCentreId: centre('SAW'), setupMinutes: '15', runMinutesPerUnit: '2.5000' },
      { tenantId: TENANT, routingId: carcassRouting!.id, sequence: 20, name: 'Edge band', workCentreId: centre('EB'), setupMinutes: '10', runMinutesPerUnit: '1.8000' },
      { tenantId: TENANT, routingId: carcassRouting!.id, sequence: 30, name: 'Drill and machine', workCentreId: centre('CNC'), setupMinutes: '25', runMinutesPerUnit: '4.0000' },
      { tenantId: TENANT, routingId: carcassRouting!.id, sequence: 40, name: 'Assemble', workCentreId: centre('ASSY'), setupMinutes: '5', runMinutesPerUnit: '12.0000', isQualityGate: true },

      { tenantId: TENANT, routingId: doorRouting!.id, sequence: 10, name: 'Cut to size', workCentreId: centre('SAW'), setupMinutes: '15', runMinutesPerUnit: '2.5000' },
      { tenantId: TENANT, routingId: doorRouting!.id, sequence: 20, name: 'Edge band', workCentreId: centre('EB'), setupMinutes: '10', runMinutesPerUnit: '1.8000' },
      // Cure is carried on the operation, not left as idle time to be optimised
      // away. Paint does not stop drying at five o'clock.
      { tenantId: TENANT, routingId: doorRouting!.id, sequence: 30, name: 'Spray and cure', workCentreId: centre('SPRAY'), setupMinutes: '20', runMinutesPerUnit: '0.8000', cureMinutes: 240 },
    ]);

    const [oak] = await tx
      .select({ id: schema.item.id })
      .from(schema.item)
      .where(and(eq(schema.item.tenantId, TENANT), eq(schema.item.code, 'MDF-VEN-OAK')));

    const doors = await createWorkOrder(tx, {
      description: 'Lobby doors — Marina Tower level 12',
      quantity: 24,
      projectId: PROJECT,
      routingId: doorRouting!.id,
      priority: 10,
      plannedStartDate: '2026-05-04',
      parts: [
        { label: 'Door leaf', materialItemId: oak!.id, lengthMm: 2100, widthMm: 900, thicknessMm: 18, quantity: 24, grainAlong: 'length' as const },
        { label: 'Door lipping', materialItemId: oak!.id, lengthMm: 2100, widthMm: 40, thicknessMm: 18, quantity: 48, grainAlong: 'length' as const },
      ],
    });
    await releaseWorkOrder(tx, { workOrderId: doors.workOrderId });

    // A second order, still in the office. Not everything on the list is on the
    // floor, and a register where every row is identical teaches nothing.
    // Five carcasses, two sides and five shelves each. The quantities are not
    // arbitrary: at this size the 1180x620 remnant on the rack saves a whole
    // sheet — 11 sheets and one offcut at 3,193.80 against 12 sheets at
    // 3,408.00 — which is the offcut register's entire argument, shown rather
    // than asserted. At six carcasses the same remnant saves nothing and the
    // optimiser correctly leaves it alone, which is the other half of the point.
    const reception = await createWorkOrder(tx, {
      description: 'Reception joinery — carcasses',
      quantity: 5,
      projectId: PROJECT,
      routingId: carcassRouting!.id,
      priority: 50,
      plannedStartDate: '2026-06-15',
      parts: [
        { label: 'Carcass side', materialItemId: oak!.id, lengthMm: 2400, widthMm: 600, thicknessMm: 18, quantity: 10 },
        { label: 'Shelf', materialItemId: oak!.id, lengthMm: 1180, widthMm: 580, thicknessMm: 18, quantity: 25 },
      ],
    });

    // Some doors are through the saw and the bander. Progress is derived from
    // scans, so the register shows it without anybody typing a percentage.
    await tx
      .update(productionSchema.workOrderPart)
      .set({ completedQuantity: 18 })
      .where(
        and(
          eq(productionSchema.workOrderPart.workOrderId, doors.workOrderId),
          eq(productionSchema.workOrderPart.partNumber, 1),
        ),
      );

    const [firstOp] = await tx
      .select({ id: productionSchema.workOrderOperation.id })
      .from(productionSchema.workOrderOperation)
      .where(
        and(
          eq(productionSchema.workOrderOperation.workOrderId, doors.workOrderId),
          eq(productionSchema.workOrderOperation.sequence, 10),
        ),
      );
    await tx
      .update(productionSchema.workOrderOperation)
      .set({ status: 'completed', completedQuantity: 24, actualMinutes: '78.00' })
      .where(eq(productionSchema.workOrderOperation.id, firstOp!.id));

    // Cutting plans, run through the REAL optimiser rather than written by hand.
    //
    // The plan JSON here used to be `{ boards: 11, note: '…' }` beside summary
    // columns claiming 11 sheets and 82.7% net yield — figures nothing had
    // computed, sitting on top of a plan with no boards in it. The register
    // looked convincing and the plan behind it could not be drawn, which is
    // exactly the failure this seed exists to prevent: a demo showing a number
    // the product cannot produce.
    const [oakItem] = await tx
      .select()
      .from(schema.item)
      .where(and(eq(schema.item.tenantId, TENANT), eq(schema.item.id, oak!.id)));

    const cutOptions = { kerfMm: 3.2, edgeTrimMm: 10, preferOffcuts: true };

    const planWorkOrder = async (workOrderId: string) => {
      const cutParts = await tx
        .select()
        .from(productionSchema.workOrderPart)
        .where(eq(productionSchema.workOrderPart.workOrderId, workOrderId));

      // Read fresh each time. The first plan reserves what it takes, so the
      // second must not be offered a remnant that is already spoken for.
      const rack = await tx
        .select()
        .from(inventorySchema.offcut)
        .where(
          and(
            eq(inventorySchema.offcut.tenantId, TENANT),
            eq(inventorySchema.offcut.itemId, oak!.id),
            eq(inventorySchema.offcut.status, 'available'),
          ),
        );

      const cutStock: StockItem[] = [
        ...rack.map(
          (piece): StockItem => ({
            id: piece.id,
            source: 'offcut',
            materialId: piece.itemId,
            lengthMm: Number(piece.lengthMm),
            widthMm: Number(piece.widthMm),
            thicknessMm: piece.thicknessMm === null ? null : Number(piece.thicknessMm),
            grainDirection: (piece.grainDirection as 'length' | 'width' | null) ?? null,
            cost: piece.unitCost === null ? undefined : Number(piece.unitCost),
            available: 1,
          }),
        ),
        {
          id: `sheet:${oakItem!.id}`,
          source: 'sheet',
          materialId: oakItem!.id,
          lengthMm: Number(oakItem!.lengthMm),
          widthMm: Number(oakItem!.widthMm),
          thicknessMm: oakItem!.thicknessMm === null ? null : Number(oakItem!.thicknessMm),
          grainDirection: oakItem!.hasGrainDirection ? 'length' : null,
          cost: oakItem!.standardCost === null ? undefined : Number(oakItem!.standardCost),
        },
      ];

      const plan = optimise(
        cutParts.map(
          (part): Part => ({
            id: part.id,
            label: part.label,
            materialId: part.materialItemId,
            lengthMm: Number(part.lengthMm),
            widthMm: Number(part.widthMm),
            thicknessMm: part.thicknessMm === null ? null : Number(part.thicknessMm),
            quantity: part.quantity,
            grainAlong: (part.grainAlong as 'length' | 'width' | 'any' | null) ?? undefined,
          }),
        ),
        cutStock,
        cutOptions,
      );

      const consumed = plan.boards.filter((b) => b.source === 'offcut').map((b) => b.stockId);

      // Reserved, not merely recorded: a plan that names a remnant has claimed
      // it, and a second job must not be planned against the same piece.
      if (consumed.length > 0) {
        await tx
          .update(inventorySchema.offcut)
          .set({ status: 'reserved', reservedForProjectId: PROJECT, updatedAt: new Date() })
          .where(
            and(
              eq(inventorySchema.offcut.tenantId, TENANT),
              inArray(inventorySchema.offcut.id, consumed),
            ),
          );
      }

      const saved = await saveCuttingPlan(tx, {
        workOrderId,
        plan: plan as unknown as Record<string, unknown>,
        options: cutOptions,
        sheetsUsed: plan.summary.sheetsUsed,
        offcutsUsed: plan.summary.offcutsUsed,
        // Two figures, deliberately. Gross treats a large reusable remnant as
        // waste; net excludes remnants big enough to go back on the rack and is
        // the economically honest number.
        grossYieldPercent: plan.summary.totalYieldPercent,
        netYieldPercent: plan.summary.netYieldPercent,
        materialCost: plan.summary.materialCost ?? null,
        consumedOffcutIds: consumed,
      });

      return { ...saved, offcutsUsed: plan.summary.offcutsUsed };
    };

    // The doors are on the floor, so their plan is committed — material has
    // been issued against it. Nothing on this job can come off the rack: a
    // 2100 x 900 leaf is bigger than every remnant there is.
    const doorPlan = await planWorkOrder(doors.workOrderId);
    await tx
      .update(productionSchema.cuttingPlan)
      .set({ isCommitted: true, committedAt: new Date('2026-05-06T07:15:00Z') })
      .where(eq(productionSchema.cuttingPlan.id, doorPlan.cuttingPlanId));

    // The reception carcasses are still in the office, so their plan stays
    // provisional — the remnants it names are reserved, not cut. This is the
    // job that shows the register earning its keep: the shelves overrun the
    // sheets opened for the sides, and rather than open one more the optimiser
    // takes a piece off the rack.
    const receptionPlan = await planWorkOrder(reception.workOrderId);
    console.log(
      `  cutting plans: doors took ${doorPlan.offcutsUsed} off the rack, ` +
        `reception took ${receptionPlan.offcutsUsed}`,
    );

    // A load in the booth with the cure clock running, and one already through.
    const doorParts = await tx
      .select({ id: productionSchema.workOrderPart.id })
      .from(productionSchema.workOrderPart)
      .where(eq(productionSchema.workOrderPart.workOrderId, doors.workOrderId));

    const [curing] = await tx
      .insert(productionSchema.finishingBatch)
      .values({
        tenantId: TENANT,
        number: 'FIN-2026-0002',
        workCentreId: centre('SPRAY'),
        status: 'curing' as const,
        colourCode: 'RAL9010',
        sheenCode: 'MATT-20',
        coatNumber: 2,
        totalCoats: 2,
        cureMinutes: 240,
        // Relative to now, deliberately. A fixed date makes the cure clock read
        // "ready 1,948 hours ago" whenever the demo is run, which is the one
        // thing this screen exists to show working.
        sprayedAt: new Date(Date.now() - 150 * 60_000),
        cureCompletesAt: new Date(Date.now() + 90 * 60_000),
      })
      .returning({ id: productionSchema.finishingBatch.id });

    const [held] = await tx
      .insert(productionSchema.finishingBatch)
      .values({
        tenantId: TENANT,
        number: 'FIN-2026-0003',
        workCentreId: centre('SPRAY'),
        status: 'queued' as const,
        colourCode: 'RAL9010',
        sheenCode: 'MATT-20',
        coatNumber: 1,
        totalCoats: 2,
        cureMinutes: 240,
        // Spraying outside spec produces rework, so the load waits. A held load
        // is not a queued one, and the register says which.
        isOnHold: true,
        holdReason: 'Booth humidity 71% — above the 65% spec for this lacquer.',
        conditions: { humidityPercent: 71, temperatureC: 33 },
      })
      .returning({ id: productionSchema.finishingBatch.id });

    await tx.insert(productionSchema.finishingBatchPart).values([
      { tenantId: TENANT, batchId: curing!.id, partId: doorParts[0]!.id, quantity: 18 },
      { tenantId: TENANT, batchId: held!.id, partId: doorParts[0]!.id, quantity: 6 },
      // Rework back through the booth. Counted separately or a busy booth looks
      // productive while it is redoing its own work.
      { tenantId: TENANT, batchId: held!.id, partId: doorParts[1]!.id, quantity: 4, isRework: true },
    ]);
  });

  console.log('→ the registers nobody had a screen for: notices, retention, an enquiry, snags');
  await asUser(async (tx) => {
    const [head] = await tx
      .select({ id: contractsSchema.contract.id })
      .from(contractsSchema.contract)
      .where(eq(contractsSchema.contract.tenantId, TENANT))
      .limit(1);

    // The notice register. Two of these are contractual and one is past its
    // deadline — which is the state the register exists to make visible, because
    // an unanswered notice is an entitlement quietly expiring.
    await tx.insert(contractsSchema.correspondence).values([
      {
        tenantId: TENANT,
        contractId: head!.id,
        type: 'rfi',
        reference: 'RFI-014',
        subject: 'Veneer direction at lift lobby returns — drawing conflict',
        direction: 'outgoing',
        issuedOn: '2026-06-18',
        responseDueOn: '2026-06-25',
        respondedOn: '2026-06-24',
        status: 'closed',
      },
      {
        tenantId: TENANT,
        contractId: head!.id,
        type: 'notice',
        reference: 'NOT-003',
        subject: 'Notice of delay — client fit-out access to level 12 withheld',
        direction: 'outgoing',
        issuedOn: '2026-07-02',
        responseDueOn: '2026-07-16',
        status: 'open',
        // Missing the reply window here forfeits the extension of time.
        isContractual: true,
      },
      {
        tenantId: TENANT,
        contractId: head!.id,
        type: 'eot_claim',
        reference: 'EOT-001',
        subject: 'Extension of time — 14 days, access and revised joinery details',
        direction: 'outgoing',
        issuedOn: '2026-07-09',
        responseDueOn: '2026-07-23',
        status: 'open',
        isContractual: true,
      },
      {
        tenantId: TENANT,
        contractId: head!.id,
        type: 'ncr',
        reference: 'NCR-002',
        subject: 'Non-conformance — substrate moisture content above specification',
        direction: 'incoming',
        issuedOn: '2026-07-20',
        responseDueOn: '2026-08-03',
        status: 'open',
      },
    ]);

    // The submittal register: the fit-out approval clock. One drawing sent
    // back and resubmitted before it was approved, one sample still sitting
    // with the consultant past its due date, and one method statement never
    // even submitted — a draft is a real state on this register, not an
    // empty row.
    const shopDrawing = await createSubmittal(tx, {
      contractId: head!.id,
      title: 'Reception desk — shop drawing',
      submittalType: 'shop_drawing',
      specSection: '06 41 00',
    });
    await submitRevision(tx, {
      submittalId: shopDrawing.id,
      submittedOn: '2026-06-10',
      dueOn: '2026-06-24',
    });
    await recordReview(tx, {
      submittalId: shopDrawing.id,
      decision: 'revise_resubmit',
      reviewedOn: '2026-06-20',
      reviewComments: 'Confirm edge banding colour against the approved sample board.',
    });
    await submitRevision(tx, {
      submittalId: shopDrawing.id,
      submittedOn: '2026-06-25',
      dueOn: '2026-07-09',
    });
    await recordReview(tx, {
      submittalId: shopDrawing.id,
      decision: 'approved',
      reviewedOn: '2026-07-05',
    });

    const veneerSample = await createSubmittal(tx, {
      contractId: head!.id,
      title: 'Veneer sample — lift lobby returns',
      submittalType: 'material_sample',
      specSection: '06 40 23',
    });
    await submitRevision(tx, {
      submittalId: veneerSample.id,
      submittedOn: '2026-07-06',
      // Past due with nobody chasing it — exactly the state this register
      // exists to surface.
      dueOn: '2026-07-20',
    });

    await createSubmittal(tx, {
      contractId: head!.id,
      title: 'Fire-rated door installation — method statement',
      submittalType: 'method_statement',
    });

    // Retention. Half at practical completion, half at the end of the defects
    // period — the schedule comes from the contract terms, which came from the
    // country pack.
    await scheduleRetentionRelease(tx, { contractId: head!.id });

    await tx.insert(contractsSchema.retentionRelease).values([
      {
        tenantId: TENANT,
        contractId: head!.id,
        trigger: 'practical_completion',
        amount: '57250.00',
        // Deliberately in the past and unreleased. Retention is the largest sum
        // on a joinery job that nobody owns, and it comes back by asking.
        dueOn: '2026-06-30',
      },
      {
        tenantId: TENANT,
        contractId: head!.id,
        trigger: 'end_of_dlp',
        amount: '57250.00',
        dueOn: '2027-06-30',
      },
    ]);

    // Snags, including one critical and open — which is what stops a handover.
    await tx.insert(projectsSchema.snag).values([
      {
        tenantId: TENANT,
        projectId: PROJECT,
        reference: 'SNG-0007',
        location: 'Level 12 — lift lobby A',
        description: 'Veneer join visible at 1.8m on return panel; grain mismatch either side.',
        severity: 'critical',
        status: 'in_progress',
        raisedOn: '2026-07-05',
        targetDate: '2026-07-19',
      },
      {
        tenantId: TENANT,
        projectId: PROJECT,
        reference: 'SNG-0008',
        location: 'Level 12 — reception',
        description: 'Solid surface seam at counter return proud by ~1mm.',
        severity: 'major',
        status: 'ready_for_inspection',
        raisedOn: '2026-07-11',
        targetDate: '2026-08-08',
        backChargeAmount: '2400.00',
      },
      {
        tenantId: TENANT,
        projectId: PROJECT,
        reference: 'SNG-0009',
        location: 'Level 12 — corridor',
        description: 'Two door closers adjusted; latching correctly on re-test.',
        severity: 'minor',
        status: 'closed',
        raisedOn: '2026-06-28',
        targetDate: '2026-07-12',
        closedOn: '2026-07-08',
      },
    ]);

    // An enquiry out to the market that closed with only one price. Two is where
    // a comparison starts meaning anything, so the register flags it.
    const suppliers = await tx
      .select({ id: schema.party.id, code: schema.party.code })
      .from(schema.party)
      .where(and(eq(schema.party.tenantId, TENANT), eq(schema.party.isSupplier, true)));

    const enquiry = await createRfq(tx, {
      title: 'Ironmongery package — levels 10 to 14',
      projectId: PROJECT,
      countryCode: 'AE',
      currencyCode: 'AED',
      responseDueOn: '2026-07-17',
      surplusIsStock: true,
      lines: [
        { description: 'Soft-close hinge, full overlay', quantity: 1200, uomCode: 'NR' },
        { description: 'Lever handle on rose, satin stainless', quantity: 240, uomCode: 'NR' },
      ],
    });

    const [enquiryLine] = await tx
      .select({ id: procurementSchema.rfqLine.id })
      .from(procurementSchema.rfqLine)
      .where(eq(procurementSchema.rfqLine.rfqId, enquiry.rfqId))
      .limit(1);

    await recordQuote(tx, {
      rfqId: enquiry.rfqId,
      supplierId: suppliers.find((s) => s.code === 'SUP-HAF')!.id,
      reference: 'HAF-Q-4471',
      receivedOn: '2026-07-15',
      currencyCode: 'AED',
      freight: 850,
      dutyPercent: 5,
      leadTimeDays: 28,
      lines: [
        {
          rfqLineId: enquiryLine!.id,
          description: 'Soft-close hinge, full overlay',
          quantity: 1200,
          uomCode: 'NR',
          unitPrice: 11.4,
          minimumOrderQuantity: 1000,
        },
      ],
    });

    // Issued, not left in draft. `createRfq` opens an enquiry as a draft and
    // there is no issue service yet, but an enquiry that never went out cannot
    // be late and cannot be uncompetitive — so the demo would show the register
    // with its two most useful signals permanently switched off.
    await tx
      .update(procurementSchema.rfq)
      .set({ status: 'issued', issuedOn: '2026-07-03' })
      .where(eq(procurementSchema.rfq.id, enquiry.rfqId));

    // A second enquiry, properly contested, so the register is not one row of
    // bad news.
    const contested = await createRfq(tx, {
      title: 'Solid surface — reception counters',
      projectId: PROJECT,
      countryCode: 'AE',
      currencyCode: 'AED',
      responseDueOn: '2026-08-14',
      lines: [{ description: 'Solid surface sheet, 12mm', quantity: 40, uomCode: 'NR' }],
    });

    const [contestedLine] = await tx
      .select({ id: procurementSchema.rfqLine.id })
      .from(procurementSchema.rfqLine)
      .where(eq(procurementSchema.rfqLine.rfqId, contested.rfqId))
      .limit(1);

    for (const [code, price, ref] of [
      ['SUP-GULF', 412, 'GP-Q-8890'],
      ['SUP-HAF', 398, 'HAF-Q-4482'],
    ] as const) {
      await recordQuote(tx, {
        rfqId: contested.rfqId,
        supplierId: suppliers.find((s) => s.code === code)!.id,
        reference: ref,
        receivedOn: '2026-07-24',
        currencyCode: 'AED',
        freight: 600,
        dutyPercent: 5,
        leadTimeDays: 21,
        lines: [
          {
            rfqLineId: contestedLine!.id,
            description: 'Solid surface sheet, 12mm',
            quantity: 40,
            uomCode: 'NR',
            unitPrice: price,
          },
        ],
      });
    }

    await tx
      .update(procurementSchema.rfq)
      .set({ status: 'issued', issuedOn: '2026-07-20' })
      .where(eq(procurementSchema.rfq.id, contested.rfqId));
  });

  console.log('→ approvals: a workflow, and two decisions waiting on the demo user');
  await asUser(async (tx) => {
    // Two workflows, because the interesting property of this engine is that it
    // routes by CONDITION rather than by document type. The variation matrix
    // only engages above a threshold; below it, the QS just does the work.
    const [variationFlow] = await tx
      .insert(schema.approvalWorkflow)
      .values({
        tenantId: TENANT,
        entityType: 'contracts.variation',
        code: 'VO-OVER-50K',
        name: 'Variations over AED 50,000',
        description: 'Anything smaller is the surveyor’s call.',
        priority: 10,
        isActive: true,
        fallbackBehaviour: 'auto_approve',
      })
      .returning({ id: schema.approvalWorkflow.id });

    await tx.insert(schema.approvalWorkflowVersion).values({
      tenantId: TENANT,
      workflowId: variationFlow!.id,
      version: 1,
      isCurrent: true,
      definition: {
        entityType: 'contracts.variation',
        // The condition is the point. Routing every variation to a director
        // makes the matrix noise, and a matrix people ignore approves things
        // nobody read.
        conditions: [{ field: 'amount', operator: 'gte', value: 50_000 }],
        steps: [
          {
            sequence: 1,
            name: 'Commercial manager',
            approverType: 'user',
            approverRef: USER,
            requireComment: false,
          },
        ],
      },
    });

    const [writeOffFlow] = await tx
      .insert(schema.approvalWorkflow)
      .values({
        tenantId: TENANT,
        entityType: 'inventory.stock_write_off',
        code: 'STOCK-WRITE-OFF',
        name: 'Stock write-off',
        description: 'Writing stock off is how loss gets hidden. Always reviewed.',
        priority: 10,
        isActive: true,
        fallbackBehaviour: 'auto_approve',
      })
      .returning({ id: schema.approvalWorkflow.id });

    await tx.insert(schema.approvalWorkflowVersion).values({
      tenantId: TENANT,
      workflowId: writeOffFlow!.id,
      version: 1,
      isCurrent: true,
      definition: {
        entityType: 'inventory.stock_write_off',
        // No threshold: any write-off is reviewed, at any value.
        conditions: [],
        steps: [
          {
            sequence: 1,
            name: 'Commercial manager',
            approverType: 'user',
            approverRef: USER,
            // A write-off approved without a word said is exactly the audit
            // finding this workflow exists to prevent.
            requireComment: true,
          },
        ],
      },
    });
  });

  // Requested BY THE SURVEYOR. The engine removes the requester from the
  // approver list, so anything the demo user asks for lands in nobody's inbox.
  await asQuantitySurveyor(async (tx) => {
    await requestApproval(tx, {
      entityType: 'contracts.variation',
      entityId: PROJECT,
      moduleKey: 'contracts',
      entityLabel: 'VO-004 — additional joinery to level 12 lift lobbies',
      context: { amount: 84_500 },
      amount: 84_500,
      currencyCode: 'AED',
    });

    await requestApproval(tx, {
      entityType: 'inventory.stock_write_off',
      entityId: PROJECT,
      moduleKey: 'inventory',
      entityLabel: 'Write off 2 sheets of oak-veneered MDF damaged in handling',
      context: { amount: 568 },
      amount: 568,
      currencyCode: 'AED',
    });

    // Below the threshold, so the matrix does not engage and it is approved on
    // the spot. Seeded to show that the condition genuinely gates: a demo where
    // everything needs a signature does not demonstrate routing, it demonstrates
    // a bottleneck.
    await requestApproval(tx, {
      entityType: 'contracts.variation',
      entityId: PROJECT,
      moduleKey: 'contracts',
      entityLabel: 'VO-005 — swap ironmongery finish, no cost change',
      context: { amount: 1_200 },
      amount: 1_200,
      currencyCode: 'AED',
    });
  });

  console.log('\n✓ demo workspace ready');
  console.log(`  sign in:  ${EMAIL} / ${PASSWORD}`);
  console.log(`  project:  /projects/${PROJECT}`);
  console.log(`  contract: /contracts/${contractId}`);
  console.log('  lists:    /projects · /contracts · /procurement/orders · /procurement/exceptions');
  console.log('  stores:   /inventory/items · /inventory/stock · /inventory/offcuts · /inventory/counts');
  console.log('  estimating: /estimating/tenders · /estimating/estimates · /estimating/rates');
  console.log('  approvals: /approvals · /approvals/submitted   (2 waiting, from Rana Haddad)');
  console.log('  registers: /contracts/correspondence · /contracts/retention · /contracts/submittals · /procurement/rfqs · /projects/costs · /projects/progress · /projects/snags');
  console.log('  factory:  /production/orders · /production/board · /production/cutlist · /production/finishing · /production/routings');

  await closeDatabase();
}

main().catch(async (error) => {
  console.error('✗ demo seed failed:', error);
  await closeDatabase().catch(() => undefined);
  process.exit(1);
});

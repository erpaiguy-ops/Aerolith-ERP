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
  closeDatabase,
  createDatabase,
  hashPassword,
  schema,
  runWithTenantContext,
  withTenant,
  withoutTenantGuard,
} from '@aerolith/kernel';
import {
  activateContract,
  approveVariation,
  certifyApplication,
  createContract,
  createPaymentApplication,
  createVariation,
  submitApplication,
} from '@aerolith/module-contracts';
import {
  approveBudget,
  createBudgetVersion,
  createWbs,
  postCost,
  recordCommitment,
  recordProgress,
} from '@aerolith/module-projects';
import { eq } from 'drizzle-orm';

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
      ['projects', 'contracts', 'estimation', 'production', 'inventory'].map((moduleKey) => ({
        tenantId: TENANT,
        moduleKey,
        status: 'enabled' as const,
      })),
    );

    await tx.insert(schema.numberSeries).values([
      { tenantId: TENANT, entityType: 'contracts.contract', code: 'CON', name: 'Contract', pattern: 'CON-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'contracts.variation', code: 'VO', name: 'Variation', pattern: 'VO-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'contracts.payment_application', code: 'IPC', name: 'Payment Application', pattern: 'IPC-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'projects.snag', code: 'SNG', name: 'Snag', pattern: 'SNG-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'estimation.tender', code: 'TND', name: 'Tender', pattern: 'TND-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'production.work_order', code: 'WO', name: 'Work Order', pattern: 'WO-{YYYY}-{SEQ}' },
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
        countryCode: 'AE',
        currencyCode: 'AED',
        permissions: new Set<string>(),
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

  console.log('\n✓ demo workspace ready');
  console.log(`  sign in:  ${EMAIL} / ${PASSWORD}`);
  console.log(`  project:  /projects/${PROJECT}`);
  console.log(`  contract: /contracts/${contractId}`);

  await closeDatabase();
}

main().catch(async (error) => {
  console.error('✗ demo seed failed:', error);
  await closeDatabase().catch(() => undefined);
  process.exit(1);
});

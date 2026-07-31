/**
 * Projects and Contract Administration end to end: real HTTP, real database.
 *
 * This is the back half of the joinery wedge, and the test is deliberately one
 * continuous story rather than a set of isolated cases, because the claim being
 * made is about CONTINUITY: a BOQ becomes a budget, becomes measured progress,
 * becomes a payment application, becomes a certificate — and a variation
 * instructed on site shows up as exposure before anyone has agreed a price.
 *
 * Two things it exists to prove above all:
 *
 *  - Commercial terms come from the AE country pack, not from a hardcoded 10%.
 *  - Application 2 is measured against what the client CERTIFIED, not against
 *    what was applied for. That single precedence is the difference between
 *    re-claiming a disallowance and losing it.
 *
 * Skipped when TEST_DATABASE_URL is unset.
 */
import { createHash } from 'node:crypto';

import { closeDatabase, createDatabase, getDatabase, schema } from '@aerolith/kernel';
import { contractsSchema } from '@aerolith/module-contracts';
import { projectsSchema } from '@aerolith/module-projects';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { invalidateTenantModules, syncModules } from './bootstrap';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const TENANT = 'cccc2222-2222-4222-8222-222222222222';
const OWNER = 'cccc2222-0000-4000-8000-000000000001';
const ENGINEER = 'cccc2222-0000-4000-8000-000000000002';
const OWNER_TOKEN = 'delivery-owner-token';
const ENGINEER_TOKEN = 'delivery-engineer-token';

const PROJECT = '99999999-1111-4111-8111-999999999999';

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

suite('Projects and Contract Administration', () => {
  let app: FastifyInstance;
  let contractId: string;
  let doorsNodeId: string;
  let wardrobesNodeId: string;

  const auth = (token = OWNER_TOKEN) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    createDatabase({ connectionString: url! });
    await syncModules();
    const db = getDatabase();

    await db.insert(schema.tenant).values({
      id: TENANT,
      slug: 'delivery-test',
      name: 'Delivery Test Joinery',
      status: 'active',
      primaryCountryCode: 'AE',
      baseCurrencyCode: 'AED',
    });

    await db.insert(schema.appUser).values([
      { id: OWNER, email: 'cm@delivery.test', name: 'Commercial Manager' },
      { id: ENGINEER, email: 'site@delivery.test', name: 'Site Engineer' },
    ]);
    await db.insert(schema.membership).values([
      { tenantId: TENANT, userId: OWNER, status: 'active', isOwner: true },
      { tenantId: TENANT, userId: ENGINEER, status: 'active', isOwner: false },
    ]);

    const expiresAt = new Date(Date.now() + 3_600_000);
    await db.insert(schema.session).values([
      { userId: OWNER, tenantId: TENANT, tokenHash: hash(OWNER_TOKEN), expiresAt },
      { userId: ENGINEER, tenantId: TENANT, tokenHash: hash(ENGINEER_TOKEN), expiresAt },
    ]);

    await db.insert(schema.tenantModule).values([
      { tenantId: TENANT, moduleKey: 'projects', status: 'enabled' },
      { tenantId: TENANT, moduleKey: 'contracts', status: 'enabled' },
    ]);
    invalidateTenantModules();

    // The site engineer reads job costs but must NOT see the forecast margin.
    const [role] = await db
      .insert(schema.role)
      .values({ tenantId: TENANT, code: 'site', name: 'Site Engineer' })
      .returning({ id: schema.role.id });

    await db.insert(schema.rolePermission).values(
      [
        'projects.cost.read',
        'projects.project.read',
        'projects.progress.record',
        // Read-only on purpose: proves `projects.snag.write` gates the write
        // routes and reading the register does not imply raising or closing.
        'projects.snag.read',
      ].map((permissionKey) => ({ tenantId: TENANT, roleId: role!.id, permissionKey })),
    );
    await db
      .insert(schema.userRole)
      .values({ tenantId: TENANT, userId: ENGINEER, roleId: role!.id });

    await db.insert(schema.project).values({
      id: PROJECT,
      tenantId: TENANT,
      code: 'P-2026-001',
      name: 'Marina Tower fit-out',
      status: 'awarded',
      currencyCode: 'AED',
      countryCode: 'AE',
    });

    await db.insert(schema.numberSeries).values([
      { tenantId: TENANT, entityType: 'contracts.contract', code: 'CON', name: 'Contract', pattern: 'CON-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'contracts.variation', code: 'VO', name: 'Variation', pattern: 'VO-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'contracts.payment_application', code: 'IPC', name: 'Payment Application', pattern: 'IPC-{YYYY}-{SEQ}' },
      { tenantId: TENANT, entityType: 'projects.snag', code: 'SNG', name: 'Snag', pattern: 'SNG-{YYYY}-{SEQ}' },
    ]);

    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    const db = getDatabase();
    const p = projectsSchema;
    const c = contractsSchema;

    await db.delete(c.paymentApplicationLine).where(eq(c.paymentApplicationLine.tenantId, TENANT));
    await db.delete(c.retentionRelease).where(eq(c.retentionRelease.tenantId, TENANT));
    await db.delete(c.paymentApplication).where(eq(c.paymentApplication.tenantId, TENANT));
    await db.delete(c.variationLine).where(eq(c.variationLine.tenantId, TENANT));
    await db.delete(c.variation).where(eq(c.variation.tenantId, TENANT));
    await db.delete(c.backCharge).where(eq(c.backCharge.tenantId, TENANT));
    await db.delete(c.correspondence).where(eq(c.correspondence.tenantId, TENANT));
    await db.delete(c.contractLine).where(eq(c.contractLine.tenantId, TENANT));
    await db.delete(c.contract).where(eq(c.contract.tenantId, TENANT));

    await db.delete(p.costEntry).where(eq(p.costEntry.tenantId, TENANT));
    await db.delete(p.commitment).where(eq(p.commitment.tenantId, TENANT));
    await db.delete(p.progressEntry).where(eq(p.progressEntry.tenantId, TENANT));
    await db.delete(p.budgetLine).where(eq(p.budgetLine.tenantId, TENANT));
    await db.delete(p.budget).where(eq(p.budget.tenantId, TENANT));
    await db.delete(p.snag).where(eq(p.snag.tenantId, TENANT));
    await db.delete(p.milestone).where(eq(p.milestone.tenantId, TENANT));
    await db.delete(p.wbsNode).where(eq(p.wbsNode.tenantId, TENANT));
    await db.delete(p.projectDetail).where(eq(p.projectDetail.tenantId, TENANT));

    await db
      .delete(schema.customFieldDefinition)
      .where(eq(schema.customFieldDefinition.tenantId, TENANT));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.tenantId, TENANT));
    await db.delete(schema.eventOutbox).where(eq(schema.eventOutbox.tenantId, TENANT));
    await db.delete(schema.numberAllocation).where(eq(schema.numberAllocation.tenantId, TENANT));
    await db.delete(schema.numberSeries).where(eq(schema.numberSeries.tenantId, TENANT));
    await db.delete(schema.project).where(eq(schema.project.tenantId, TENANT));
    await db.delete(schema.userRole).where(eq(schema.userRole.tenantId, TENANT));
    await db.delete(schema.rolePermission).where(eq(schema.rolePermission.tenantId, TENANT));
    await db.delete(schema.role).where(eq(schema.role.tenantId, TENANT));
    await db.delete(schema.tenantModule).where(eq(schema.tenantModule.tenantId, TENANT));
    await db.delete(schema.session).where(eq(schema.session.tenantId, TENANT));
    await db.delete(schema.membership).where(eq(schema.membership.tenantId, TENANT));
    await db.delete(schema.appUser).where(eq(schema.appUser.id, OWNER));
    await db.delete(schema.appUser).where(eq(schema.appUser.id, ENGINEER));
    await db.delete(schema.tenant).where(eq(schema.tenant.id, TENANT));

    await app.close();
    await closeDatabase();
  });

  // -------------------------------------------------------------------------

  describe('1 — work breakdown and budget', () => {
    it('creates a WBS, rejecting a child that names a parent it has not seen', async () => {
      const bad = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${PROJECT}/wbs`,
        headers: auth(),
        payload: { nodes: [{ code: 'CHILD', name: 'Child', parentCode: 'PARENT' }] },
      });

      expect(bad.statusCode).toBe(409);
      expect(bad.json().error).toMatch(/must be listed before their children/);

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${PROJECT}/wbs`,
        headers: auth(),
        payload: {
          nodes: [
            { code: 'J', name: 'Joinery package' },
            {
              code: 'J-DOORS',
              name: 'Veneered doors',
              parentCode: 'J',
              ruleOfCredit: 'units',
              unitsPlanned: 100,
              uomCode: 'NR',
            },
            {
              code: 'J-WARD',
              name: 'Bedroom wardrobes',
              parentCode: 'J',
              ruleOfCredit: 'units',
              unitsPlanned: 40,
              uomCode: 'NR',
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().created).toBe(3);

      const db = getDatabase();
      const nodes = await db
        .select()
        .from(projectsSchema.wbsNode)
        .where(eq(projectsSchema.wbsNode.projectId, PROJECT));

      doorsNodeId = nodes.find((n) => n.code === 'J-DOORS')!.id;
      wardrobesNodeId = nodes.find((n) => n.code === 'J-WARD')!.id;
      expect(nodes.find((n) => n.code === 'J-DOORS')!.path).toBe('J/J-DOORS');
    });

    it('rejects milestone credit whose weights do not total 100', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${PROJECT}/wbs`,
        headers: auth(),
        payload: {
          nodes: [
            {
              code: 'BAD-MS',
              name: 'Badly weighted',
              ruleOfCredit: 'milestone',
              creditMilestones: [
                { key: 'a', weightPercent: 40 },
                { key: 'b', weightPercent: 40 },
              ],
            },
          ],
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/total 100%/);
    });

    it('creates and approves a budget, caching the weights the roll-up needs', async () => {
      const created = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${PROJECT}/budgets`,
        headers: auth(),
        payload: {
          source: 'estimate',
          lines: [
            { wbsCode: 'J-DOORS', category: 'material', description: 'Door blanks and veneer', lineCost: 300_000, lineValue: 375_000 },
            { wbsCode: 'J-DOORS', category: 'labour', description: 'Door manufacture and install', lineCost: 180_000, lineValue: 225_000 },
            { wbsCode: 'J-WARD', category: 'material', description: 'Carcass board and hardware', lineCost: 200_000, lineValue: 250_000 },
            { wbsCode: 'J-WARD', category: 'labour', description: 'Wardrobe manufacture and install', lineCost: 120_000, lineValue: 150_000 },
          ],
        },
      });

      expect(created.statusCode).toBe(200);
      expect(created.json().version).toBe(1);
      expect(created.json().totalCost).toBe(800_000);
      expect(created.json().totalValue).toBe(1_000_000);

      const approved = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/budgets/${created.json().budgetId}/approve`,
        headers: auth(),
      });
      expect(approved.statusCode).toBe(200);

      const db = getDatabase();
      const [doors] = await db
        .select()
        .from(projectsSchema.wbsNode)
        .where(eq(projectsSchema.wbsNode.id, doorsNodeId));

      // 375k + 225k of revenue budget cached onto the node, which is what
      // weights the progress roll-up.
      expect(Number(doors!.budgetValue)).toBe(600_000);
      expect(Number(doors!.budgetCost)).toBe(480_000);
    });

    it('lists budget versions and reads one back with its lines resolved to WBS codes', async () => {
      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${PROJECT}/budgets`,
        headers: auth(),
      });
      expect(list.statusCode).toBe(200);

      const rows: { id: string; version: number; status: string; totalCost: string }[] =
        list.json().rows;
      const approved = rows.find((r) => r.version === 1);
      expect(approved?.status).toBe('approved');
      expect(Number(approved!.totalCost)).toBe(800_000);

      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/budgets/${approved!.id}`,
        headers: auth(),
      });
      expect(detail.statusCode).toBe(200);
      const lines: { wbsCode: string | null; description: string }[] = detail.json().lines;
      expect(lines).toHaveLength(4);
      expect(lines.every((l) => l.wbsCode === 'J-DOORS' || l.wbsCode === 'J-WARD')).toBe(true);

      const missing = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/budgets/00000000-0000-4000-8000-000000000000',
        headers: auth(),
      });
      expect(missing.statusCode).toBe(404);
    });

    it('refuses a site engineer who holds no projects.budget.read permission', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${PROJECT}/budgets`,
        headers: auth(ENGINEER_TOKEN),
      });
      expect(response.statusCode).toBe(403);
    });

    it('refuses a budget line pointing at a WBS code that does not exist', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${PROJECT}/budgets`,
        headers: auth(),
        payload: {
          lines: [{ wbsCode: 'NOPE', category: 'material', description: 'x', lineCost: 1 }],
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/does not exist on this project/);
    });
  });

  // -------------------------------------------------------------------------

  describe('2 — the contract, on UAE terms', () => {
    it('takes retention, DLP and payment terms from the country pack', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/contracts',
        headers: auth(),
        payload: {
          name: 'Marina Tower joinery package',
          projectId: PROJECT,
          countryCode: 'AE',
          currencyCode: 'AED',
          originalSum: 1_000_000,
          awardedOn: '2026-01-05',
          overrides: { taxPercent: 5 },
          lines: [
            { reference: 'A1', description: 'Veneered doors', quantity: 100, uomCode: 'NR', unitRate: 6_000, wbsNodeId: doorsNodeId },
            { reference: 'A2', description: 'Bedroom wardrobes', quantity: 40, uomCode: 'NR', unitRate: 10_000, wbsNodeId: wardrobesNodeId },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      contractId = body.contractId;

      // Nobody configured any of this. It came from packs/AE.json, resolved
      // tenant → country → default. That is the localisation design paying off.
      expect(body.terms.retentionPercent).toBe(10);
      expect(body.terms.paymentTermDays).toBe(60);
      expect(body.terms.defectsLiabilityMonths).toBe(12);
      expect(body.terms.retentionReleaseSchedule).toEqual({
        practicalCompletion: 50,
        endOfDlp: 50,
      });
      // From the contracts module's own rule, since no contract states it.
      expect(body.terms.noticePeriodDays).toBe(28);
      expect(body.number).toMatch(/^CON-\d{4}-/);
    });

    it('refuses to value anything before the contract is activated', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/${contractId}/applications`,
        headers: auth(),
        payload: { periodTo: '2026-02-28', workDoneToDate: 100_000 },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/Activate the contract/);
    });

    it('activates', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/${contractId}/activate`,
        headers: auth(),
        payload: { commencedOn: '2026-01-12' },
      });
      expect(response.statusCode).toBe(200);
    });
  });

  // -------------------------------------------------------------------------

  describe('3 — progress becomes a payment application', () => {
    it('records measured progress and weights it by budget', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${PROJECT}/progress`,
        headers: auth(),
        payload: {
          periodEnd: '2026-02-28',
          measurements: [
            { wbsCode: 'J-DOORS', unitsComplete: 50 },
            { wbsCode: 'J-WARD', unitsComplete: 10 },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Doors 50% of 600k = 300k earned; wardrobes 25% of 400k = 100k.
      // 400k of 1m budget value = 40%, NOT the (50+25)/2 = 37.5% an average
      // of percentages would have produced.
      expect(body.earnedValue).toBeCloseTo(400_000, 6);
      expect(body.percentComplete).toBeCloseTo(40, 6);
    });

    it('needs the dangerous permission for a typed percentage', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${PROJECT}/progress`,
        headers: auth(ENGINEER_TOKEN),
        payload: {
          periodEnd: '2026-02-28',
          measurements: [{ wbsCode: 'J-DOORS', manualPercent: 95 }],
        },
      });

      // The engineer can record progress. Claiming a number instead of
      // measuring one is a different act, and needs projects.progress.override.
      expect(response.statusCode).toBe(403);
    });

    it('values IPC 1 from the measured progress', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/${contractId}/applications/from-progress`,
        headers: auth(),
        payload: { projectId: PROJECT, periodTo: '2026-02-28', periodFrom: '2026-01-12' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // 100 doors x 50% x 6,000 = 300,000. 40 wardrobes x 25% x 10,000 = 100,000.
      expect(body.valuedFromProgress.workDoneToDate).toBeCloseTo(400_000, 6);
      expect(body.valuedFromProgress.linesValued).toBe(2);
      expect(body.valuedFromProgress.linesUnlinked).toEqual([]);

      const v = body.valuation;
      expect(v.grossValuationToDate).toBeCloseTo(400_000, 6);
      expect(v.retentionHeldToDate).toBeCloseTo(40_000, 6);
      expect(v.netThisCertificate).toBeCloseTo(360_000, 6);
      expect(v.taxAmount).toBeCloseTo(18_000, 6);
      expect(v.totalPayable).toBeCloseTo(378_000, 6);
      expect(body.sequence).toBe(1);
    });

    it('will not raise a second application while the first is still open', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/${contractId}/applications`,
        headers: auth(),
        payload: { periodTo: '2026-03-31', workDoneToDate: 500_000 },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/two different cumulative positions/);
    });
  });

  // -------------------------------------------------------------------------

  describe('4 — certification, and the disallowance that survives it', () => {
    let applicationId: string;

    it('submits, taking the due date from the 60-day UAE terms', async () => {
      const db = getDatabase();
      const [application] = await db
        .select()
        .from(contractsSchema.paymentApplication)
        .where(
          and(
            eq(contractsSchema.paymentApplication.contractId, contractId),
            eq(contractsSchema.paymentApplication.sequence, 1),
          ),
        );
      applicationId = application!.id;

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/applications/${applicationId}/submit`,
        headers: auth(),
        payload: { submittedOn: '2026-03-05' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().dueOn).toBe('2026-05-04');
    });

    it('refuses a reduced certificate with no reason recorded', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/applications/${applicationId}/certify`,
        headers: auth(),
        payload: { certifiedNet: 340_000, certifiedOn: '2026-03-20' },
      });

      // An unexplained disallowance is one nobody ever re-claims.
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/Record why/);
    });

    it('records what the client actually certified, beside what was applied for', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/applications/${applicationId}/certify`,
        headers: auth(),
        payload: {
          certifiedNet: 340_000,
          certifiedTax: 17_000,
          certifiedOn: '2026-03-20',
          certificateReference: 'IPC-01-CERT',
          disallowedReason: 'Client QS disallowed 4 doors as not yet delivered to site.',
        },
      });

      expect(response.statusCode).toBe(200);
      const c = response.json().comparison;
      expect(c.applied).toBeCloseTo(360_000, 6);
      expect(c.certified).toBe(340_000);
      expect(c.difference).toBeCloseTo(-20_000, 6);
      expect(c.wasReduced).toBe(true);

      const db = getDatabase();
      const [row] = await db
        .select()
        .from(contractsSchema.paymentApplication)
        .where(eq(contractsSchema.paymentApplication.id, applicationId));

      // Both figures survive. A spreadsheet would have typed one over the other
      // and the pattern of a client who certifies 94% of everything would be
      // invisible forever.
      expect(Number(row!.netThisApplication)).toBeCloseTo(360_000, 6);
      expect(Number(row!.certifiedNet)).toBe(340_000);
    });

    it('measures IPC 2 against the CERTIFIED figure, not the applied one', async () => {
      await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${PROJECT}/progress`,
        headers: auth(),
        payload: {
          periodEnd: '2026-03-31',
          measurements: [
            { wbsCode: 'J-DOORS', unitsComplete: 80 },
            { wbsCode: 'J-WARD', unitsComplete: 20 },
          ],
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/${contractId}/applications/from-progress`,
        headers: auth(),
        payload: { projectId: PROJECT, periodTo: '2026-03-31', periodFrom: '2026-03-01' },
      });

      expect(response.statusCode).toBe(200);
      const v = response.json().valuation;

      // 100 x 80% x 6,000 = 480,000. 40 x 50% x 10,000 = 200,000. Gross 680,000.
      expect(v.grossValuationToDate).toBeCloseTo(680_000, 6);
      expect(v.retentionHeldToDate).toBeCloseTo(68_000, 6);
      expect(v.netValuationToDate).toBeCloseTo(612_000, 6);

      // The whole point: previously certified is 340,000 — what the client
      // paid — not 360,000, what was asked for. So the disallowed 20,000 is
      // automatically back in this certificate rather than quietly written off.
      expect(v.previouslyCertifiedNet).toBe(340_000);
      expect(v.netThisCertificate).toBeCloseTo(272_000, 6);
    });
  });

  // -------------------------------------------------------------------------

  describe('5 — variations and exposure', () => {
    let variationId: string;

    it('records an instruction as exposure before anyone agrees a price', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/${contractId}/variations`,
        headers: auth(),
        payload: {
          title: 'Twelve additional doors to level 8',
          basis: 'contract_rates',
          instructionReference: 'SI-014',
          instructedOn: '2026-02-02',
          instructedBy: 'M. Consultant',
          percentExecuted: 100,
          lines: [
            { description: 'Additional veneered doors', quantity: 12, unitRate: 6_500, unitCost: 4_800 },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      variationId = response.json().variationId;
      expect(response.json().value).toBe(78_000);
      expect(response.json().cost).toBe(57_600);

      const register = await app.inject({
        method: 'GET',
        url: `/api/v1/contracts/${contractId}/variations`,
        headers: auth(),
      });

      const position = register.json().position;
      // Built, instructed, unpriced: 78k of money genuinely at risk. The
      // contract sum has not moved by a fil.
      expect(position.exposureValue).toBe(78_000);
      expect(position.exposureCost).toBe(57_600);
      expect(position.approvedValue).toBe(0);
      expect(position.currentContractSum).toBe(1_000_000);
      expect(position.anticipatedFinalValue).toBe(1_078_000);
    });

    it('flags the variation as time barred once its notice period has run', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/contracts/${contractId}/notice-exposure`,
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Instructed 2 February with a 28-day notice period and no notice given.
      // Entitlement extinguished — and the system knew the date all along.
      expect(body.timeBarredCount).toBe(1);
      expect(body.timeBarredValue).toBe(78_000);
      expect(body.atRisk[0].status.isTimeBarred).toBe(true);
    });

    it('moves the contract sum only on approval, and keeps the quote beside it', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/variations/${variationId}/approve`,
        headers: auth(),
        payload: {
          approvedValue: 70_000,
          approvedOn: '2026-04-10',
          reference: 'VO-014-APPROVED',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.currentSum).toBe(1_070_000);
      // The client settled at 70k against a 78k claim. Keeping the variance is
      // what makes "they settle everything at 90%" a fact you can price against.
      expect(body.variance).toBe(-8_000);

      const register = await app.inject({
        method: 'GET',
        url: `/api/v1/contracts/${contractId}/variations`,
        headers: auth(),
      });
      const position = register.json().position;
      expect(position.approvedValue).toBe(70_000);
      expect(position.exposureValue).toBe(0);
    });

    it('refuses to approve the same variation twice', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/variations/${variationId}/approve`,
        headers: auth(),
        payload: { approvedValue: 70_000, approvedOn: '2026-04-11' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/already approved/);
    });
  });

  // -------------------------------------------------------------------------

  describe('6 — job costing', () => {
    it('posts costs and traces every one to its source', async () => {
      const posts = [
        { category: 'material', description: 'Veneer and board issue', amount: 260_000, sourceModule: 'inventory', wbsNodeId: doorsNodeId },
        { category: 'labour', description: 'February shop-floor hours', amount: 165_000, sourceModule: 'production', wbsNodeId: doorsNodeId },
        { category: 'material', description: 'Carcass board issue', amount: 120_000, sourceModule: 'inventory', wbsNodeId: wardrobesNodeId },
      ];

      for (const post of posts) {
        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/projects/${PROJECT}/costs`,
          headers: auth(),
          payload: { ...post, postedOn: '2026-03-31' },
        });
        expect(response.statusCode).toBe(200);
      }

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${PROJECT}/costs`,
        headers: auth(),
      });

      const { summary, entries } = response.json();
      expect(summary.actualCost).toBe(545_000);
      expect(summary.budgetAtCompletion).toBe(800_000);
      expect(entries).toHaveLength(3);
      expect(entries.every((e: { sourceModule: string }) => e.sourceModule)).toBe(true);
    });

    it('corrects a cost with a reversal rather than an edit', async () => {
      const db = getDatabase();
      const [entry] = await db
        .select()
        .from(projectsSchema.costEntry)
        .where(
          and(
            eq(projectsSchema.costEntry.projectId, PROJECT),
            eq(projectsSchema.costEntry.description, 'Carcass board issue'),
          ),
        );

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/costs/${entry!.id}/reverse`,
        headers: auth(),
        payload: { postedOn: '2026-04-01', reason: 'Issued against the wrong project.' },
      });
      expect(response.statusCode).toBe(200);

      const again = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/costs/${entry!.id}/reverse`,
        headers: auth(),
        payload: { postedOn: '2026-04-01', reason: 'Duplicate attempt.' },
      });
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toMatch(/already been reversed/);

      const summary = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${PROJECT}/costs`,
        headers: auth(),
      });

      // Both rows remain. The correction is part of the record, not a gap in it.
      expect(summary.json().entries).toHaveLength(4);
      expect(summary.json().summary.actualCost).toBe(425_000);
    });

    it('counts only the unspent balance of a commitment as exposure', async () => {
      await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${PROJECT}/commitments`,
        headers: auth(),
        payload: {
          type: 'subcontract',
          reference: 'SC-2026-004',
          category: 'subcontract',
          committedAmount: 180_000,
          sourceModule: 'procurement',
          wbsNodeId: wardrobesNodeId,
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${PROJECT}/costs`,
        headers: auth(),
      });

      expect(response.json().summary.openCommitments).toBe(180_000);
    });

    it('measures cost performance in cost units, not revenue units', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${PROJECT}/position?contractValue=1070000&method=performance_rate`,
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // The job is 68% complete. On the revenue budget that is 680k earned; on
      // the 800k cost budget it is 544k. CPI must use the cost figure — 544/425
      // = 1.28, not 680/425 = 1.6, which would overstate performance by exactly
      // the 20% margin and keep saying so until the final account.
      expect(body.summary.earnedValue).toBeCloseTo(680_000, 6);
      expect(body.summary.earnedCost).toBeCloseTo(544_000, 6);
      expect(body.summary.actualCost).toBe(425_000);

      expect(body.metrics.earnedValue).toBeCloseTo(544_000, 6);
      expect(body.metrics.costPerformanceIndex).toBeCloseTo(1.28, 4);
      expect(body.metrics.percentComplete).toBeCloseTo(68, 6);
      expect(body.metrics.percentSpent).toBeCloseTo(53.125, 4);
    });

    it('floors the forecast at the open commitment and prices the margin', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${PROJECT}/position?contractValue=1070000&method=performance_rate`,
        headers: auth(),
      });

      const body = response.json();

      // Performance alone puts 200k of cost budget left at CPI 1.28 = 200k.
      // But 180k of subcontract is already committed, which is below that, so
      // performance is the binding constraint here.
      expect(body.forecast.commitmentBound).toBe(false);
      expect(body.forecast.estimateToComplete).toBeCloseTo(200_000, 6);
      expect(body.forecast.estimateAtCompletion).toBeCloseTo(625_000, 6);
      expect(body.forecast.varianceAtCompletion).toBeCloseTo(175_000, 6);

      // 1,070,000 of revenue less 625,000 of forecast cost.
      expect(body.forecastMargin).toBeCloseTo(445_000, 6);
    });

    it('hides the forecast margin from the site engineer but not the overrun', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${PROJECT}/position?contractValue=1070000`,
        headers: auth(ENGINEER_TOKEN),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.marginHidden).toBe(true);
      expect(body.forecastMargin).toBeUndefined();
      expect(body.forecastMarginPercent).toBeUndefined();
      expect(body.contractValue).toBeUndefined();
      // The cost position is still fully visible — that is the site team's job.
      expect(body.summary.actualCost).toBe(425_000);
      expect(body.forecast.estimateAtCompletion).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------

  describe('7 — completion and retention', () => {
    it('releases nothing before practical completion', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/${contractId}/retention/schedule`,
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().releasable).toBe(0);
      expect(response.json().created).toBe(false);
    });

    it('releases half at practical completion and dates the defects period', async () => {
      const pc = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/${contractId}/practical-completion`,
        headers: auth(),
        payload: { practicalCompletionOn: '2026-06-30' },
      });

      expect(pc.statusCode).toBe(200);
      // 12 months, from the AE pack, snapshotted onto the contract at creation.
      expect(pc.json().defectsLiabilityEndsOn).toBe('2027-06-30');

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/${contractId}/retention/schedule`,
        headers: auth(),
      });

      // 68,000 held on the latest application; 50% releasable at PC.
      expect(response.json().totalHeld).toBeCloseTo(68_000, 6);
      expect(response.json().releasable).toBeCloseTo(34_000, 6);
      expect(response.json().created).toBe(true);
    });

    it('does not release the second half while the defects period is running', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/${contractId}/retention/schedule`,
        headers: auth(),
      });

      // The remaining 34,000 is the only leverage that gets a snag list
      // finished. It waits for June 2027.
      expect(response.json().previouslyReleased).toBeCloseTo(34_000, 6);
      expect(response.json().releasable).toBe(0);
    });

    it('summarises the whole contract position in one call', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/contracts/${contractId}/position`,
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.originalSum).toBe(1_000_000);
      expect(body.currentSum).toBe(1_070_000);
      expect(body.grossValuedToDate).toBeCloseTo(680_000, 6);
      expect(body.certifiedToDate).toBe(340_000);
      // IPC 2 has been raised but not certified: 612k valued less 340k certified.
      expect(body.uncertified).toBeCloseTo(272_000, 6);
      expect(body.retentionHeld).toBeCloseTo(68_000, 6);
      expect(body.retentionReleased).toBeCloseTo(34_000, 6);
    });
  });

  // -------------------------------------------------------------------------

  describe('8 — entitlements', () => {
    it('hides Contract Administration from a tenant that has not bought it', async () => {
      const db = getDatabase();
      await db
        .delete(schema.tenantModule)
        .where(
          and(
            eq(schema.tenantModule.tenantId, TENANT),
            eq(schema.tenantModule.moduleKey, 'contracts'),
          ),
        );
      invalidateTenantModules(TENANT);

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/contracts/${contractId}/position`,
        headers: auth(),
      });

      // 404, not 403: an unentitled module should not confirm it exists.
      expect(response.statusCode).toBe(404);

      await db
        .insert(schema.tenantModule)
        .values({ tenantId: TENANT, moduleKey: 'contracts', status: 'enabled' });
      invalidateTenantModules(TENANT);
    });

    it('refuses to value from progress when Projects is not entitled', async () => {
      const db = getDatabase();
      await db
        .delete(schema.tenantModule)
        .where(
          and(
            eq(schema.tenantModule.tenantId, TENANT),
            eq(schema.tenantModule.moduleKey, 'projects'),
          ),
        );
      invalidateTenantModules(TENANT);

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/${contractId}/applications/from-progress`,
        headers: auth(),
        payload: { projectId: PROJECT, periodTo: '2026-04-30' },
      });

      // Contract Administration still works — it says how, rather than failing.
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/Enter measured quantities directly/);

      await db
        .insert(schema.tenantModule)
        .values({ tenantId: TENANT, moduleKey: 'projects', status: 'enabled' });
      invalidateTenantModules(TENANT);
    });
  });

  describe('7 — the index screens', () => {
    it('lists projects, left-joining detail that may not exist', async () => {
      // This project has a `kernel.project` row and no `projects.project_detail`
      // row — nothing in this suite created one. An inner join would return an
      // empty list, hiding exactly the project the user is looking for.
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/projects',
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.total).toBe(1);
      expect(body.rows[0].code).toBe('P-2026-001');
      expect(body.rows[0].name).toBe('Marina Tower fit-out');
      expect(body.rows[0].healthStatus).toBeNull();
      expect(body.rows[0].scheduleVarianceDays).toBeNull();
    });

    it('reads the project back — no client or project_detail row, and neither breaks it', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${PROJECT}`,
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.project.code).toBe('P-2026-001');
      expect(body.clientName).toBeNull();
      expect(body.healthStatus).toBeNull();
    });

    it('404s a project id that does not exist', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/00000000-0000-4000-8000-000000000000',
        headers: auth(),
      });

      expect(response.statusCode).toBe(404);
    });

    it('resolves the client, project manager and QS by name once they exist', async () => {
      const db = getDatabase();
      const [client] = await db
        .insert(schema.party)
        .values({ tenantId: TENANT, code: 'EMAAR', name: 'Emaar Properties PJSC', isCustomer: true })
        .returning({ id: schema.party.id });

      await db.insert(projectsSchema.projectDetail).values({
        tenantId: TENANT,
        projectId: PROJECT,
        projectManagerId: ENGINEER,
        healthStatus: 'green',
      });
      await db.update(schema.project).set({ clientPartyId: client!.id }).where(eq(schema.project.id, PROJECT));

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${PROJECT}`,
        headers: auth(),
      });

      const body = response.json();
      expect(body.clientName).toBe('Emaar Properties PJSC');
      expect(body.projectManagerName).toBe('Site Engineer');
      expect(body.healthStatus).toBe('green');

      // Cleanup, so later tests in this suite still see the bare fixture.
      await db.delete(projectsSchema.projectDetail).where(eq(projectsSchema.projectDetail.projectId, PROJECT));
      await db.update(schema.project).set({ clientPartyId: null }).where(eq(schema.project.id, PROJECT));
      await db.delete(schema.party).where(eq(schema.party.id, client!.id));
    });

    describe('custom fields on a project', () => {
      let fieldId: string;

      it('defines a custom field for projects', async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/custom-fields',
          headers: auth(),
          payload: {
            entityType: 'project',
            key: 'lift_count',
            label: 'Number of lifts',
            type: 'number',
            isRequired: false,
          },
        });

        expect(response.statusCode).toBe(200);
        fieldId = response.json().id;
      });

      it('lists it back for anyone signed in, not just an admin', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/custom-fields?entityType=project',
          headers: auth(),
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().some((f: { key: string }) => f.key === 'lift_count')).toBe(true);
      });

      it('sets the value, validated against the definition', async () => {
        const bad = await app.inject({
          method: 'PATCH',
          url: `/api/v1/projects/${PROJECT}/custom-fields`,
          headers: auth(),
          payload: { lift_count: 'not-a-number' },
        });
        expect(bad.statusCode).toBe(409);

        const good = await app.inject({
          method: 'PATCH',
          url: `/api/v1/projects/${PROJECT}/custom-fields`,
          headers: auth(),
          payload: { lift_count: 4 },
        });
        expect(good.statusCode).toBe(200);
        expect(good.json().values.lift_count).toBe(4);

        const [row] = await getDatabase()
          .select({ customFields: schema.project.customFields })
          .from(schema.project)
          .where(eq(schema.project.id, PROJECT));
        expect(row!.customFields).toEqual({ lift_count: 4 });
      });

      it('retires the field, and it drops out of the active list', async () => {
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/v1/admin/custom-fields/${fieldId}`,
          headers: auth(),
          payload: { isActive: false },
        });
        expect(response.statusCode).toBe(200);

        const list = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/custom-fields?entityType=project',
          headers: auth(),
        });
        expect(list.json().some((f: { key: string }) => f.key === 'lift_count')).toBe(false);

        // Cleanup.
        await getDatabase()
          .update(schema.project)
          .set({ customFields: {} })
          .where(eq(schema.project.id, PROJECT));
      });
    });

    it('searches projects by code and by name', async () => {
      const byCode = await app.inject({
        method: 'GET',
        url: '/api/v1/projects?q=2026-001',
        headers: auth(),
      });
      expect(byCode.json().total).toBe(1);

      const byName = await app.inject({
        method: 'GET',
        url: '/api/v1/projects?q=MARINA',
        headers: auth(),
      });
      expect(byName.json().total).toBe(1);

      const miss = await app.inject({
        method: 'GET',
        url: '/api/v1/projects?q=nothing-like-this',
        headers: auth(),
      });
      expect(miss.json().total).toBe(0);
    });

    it('filters projects by status', async () => {
      const awarded = await app.inject({
        method: 'GET',
        url: '/api/v1/projects?status=awarded',
        headers: auth(),
      });
      expect(awarded.json().total).toBe(1);

      const closed = await app.inject({
        method: 'GET',
        url: '/api/v1/projects?status=closed',
        headers: auth(),
      });
      expect(closed.json().total).toBe(0);
    });

    it('lists contracts with the project and client resolved to names', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/contracts',
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.total).toBe(1);
      const row = body.rows[0];
      expect(row.projectCode).toBe('P-2026-001');
      expect(row.number).toMatch(/^CON-/);

      // Current less original, which is exactly the approved variation value:
      // only an approved variation moves the current sum.
      expect(row.variationValue).toBeCloseTo(row.currentSum - row.originalSum, 2);
      expect(row.variationValue).toBeGreaterThan(0);
    });

    it('filters contracts by side', async () => {
      const receivable = await app.inject({
        method: 'GET',
        url: '/api/v1/contracts?side=receivable',
        headers: auth(),
      });
      expect(receivable.json().total).toBe(1);

      const payable = await app.inject({
        method: 'GET',
        url: '/api/v1/contracts?side=payable',
        headers: auth(),
      });
      expect(payable.json().total).toBe(0);
    });

    it('gives an empty list one page rather than zero', async () => {
      // "Page 1 of 0" is the kind of detail that makes a user distrust every
      // other number on the screen.
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/contracts?side=payable',
        headers: auth(),
      });

      expect(response.json().totalPages).toBe(1);
      expect(response.json().hasMore).toBe(false);
    });

it('returns the project id on the contract position', async () => {
      // The contract screen values an application from progress, which needs the
      // job. Without this it would have to fetch the contract row again just to
      // find one uuid — and the panel would silently not render if it were null.
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/contracts/${contractId}/position`,
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().projectId).toBe(PROJECT);
    });

    it('returns everything the progress form is built from', async () => {
      // The form renders one input per node, chosen by the node's rule of
      // credit. A units box on a milestone node would be ignored by the service
      // rather than quietly accepted, so the shape below is what stops a user
      // typing a number that does nothing.
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${PROJECT}/wbs`,
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const nodes = response.json().nodes;

      for (const node of nodes) {
        expect(node).toHaveProperty('ruleOfCredit');
        expect(node).toHaveProperty('creditMilestones');
        expect(node).toHaveProperty('percentComplete');
        // Leaves are the only measurable lines, so the form needs the parent
        // link to work out which nodes to offer.
        expect(node).toHaveProperty('parentId');
      }

      const measurable = nodes.filter(
        (n: { id: string }) => !nodes.some((c: { parentId: string }) => c.parentId === n.id),
      );
      expect(measurable.length).toBeGreaterThan(0);
    });

it('lists payment applications across contracts with the disallowance on the row', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/contracts/applications',
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBeGreaterThan(0);

      const certified = body.rows.filter((r: { certifiedTotal: number | null }) => r.certifiedTotal != null);
      expect(certified.length).toBeGreaterThan(0);

      // Carried on the row, not left for the reader to subtract two columns by
      // eye. A client who trims every valuation is a pattern you can price
      // against, and only if somebody can total it.
      for (const row of certified) {
        expect(row.disallowed).toBeCloseTo(row.certifiedTotal - row.totalApplied, 2);
      }

      // IPC 1 was certified below what was applied for.
      expect(certified.some((r: { disallowed: number }) => r.disallowed < 0)).toBe(true);
    });

    it('filters applications down to what is still outstanding', async () => {
      // Spans two statuses — applied-and-uncertified plus certified-and-unpaid —
      // so it could not be a status filter.
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/contracts/applications?outstanding=true',
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(
        body.rows.every((r: { paidOn: string | null; status: string }) => r.paidOn === null),
      ).toBe(true);
      expect(
        body.rows.every((r: { status: string }) =>
          ['submitted', 'certified', 'disputed'].includes(r.status),
        ),
      ).toBe(true);
    });

    it('returns one application with its lines and its contract', async () => {
      const list = await app.inject({
        method: 'GET',
        url: '/api/v1/contracts/applications',
        headers: auth(),
      });
      const first = list.json().rows[0];

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/contracts/applications/${first.id}`,
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.application.id).toBe(first.id);
      // The currency comes back with it: a certificate screen that renders an
      // amount without naming the currency is one nobody can safely act on.
      expect(body.contract.currencyCode).toBe('AED');
      expect(Array.isArray(body.lines)).toBe(true);
    });

    it('serves the application as a PDF a reader will open', async () => {
      const list = await app.inject({
        method: 'GET',
        url: '/api/v1/contracts/applications',
        headers: auth(),
      });
      const first = list.json().rows[0];

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/contracts/applications/${first.id}/pdf`,
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('application/pdf');
      // Named after the document, not after the route segment: what lands in
      // somebody's downloads folder has to be findable a month later.
      expect(response.headers['content-disposition']).toContain(`${first.number}.pdf`);

      const body = response.rawPayload;
      expect(body.subarray(0, 8).toString('latin1')).toBe('%PDF-1.7');
      expect(body.subarray(-6).toString('latin1').trim()).toBe('%%EOF');

      const text = body.toString('latin1');
      expect(text).toContain('(Interim payment application)');
      // Formatted for the tenant rather than stringified: the grouping and the
      // currency are what a cost consultant checks first.
      expect(text).toContain('AED ');
      expect(text).toMatch(/\(AED [\d,]+\.\d\d\)/);
      // Nothing on an English document should have reached the page as a
      // question mark. The em dash used as a placeholder did exactly that until
      // the writer learned to transliterate punctuation.
      expect(text).not.toMatch(/\(\?+\) Tj/);
    });

    it('404s an application that does not exist', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/contracts/applications/00000000-0000-4000-8000-000000000000',
        headers: auth(),
      });

      expect(response.statusCode).toBe(404);
    });

it('lists variations with the notice clock resolved per row', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/contracts/variations',
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const rows = response.json().rows;
      expect(rows.length).toBeGreaterThan(0);

      // The clock is computed server-side because it is a contractual rule that
      // depends on the contract's own notice period. Two clients disagreeing
      // about whether a claim is alive because their machines disagree about
      // the date is not a bug worth having.
      const instructed = rows.filter((r: { instructedOn: string | null }) => r.instructedOn);
      expect(instructed.length).toBeGreaterThan(0);
      for (const row of instructed) {
        expect(row.notice).not.toBeNull();
        expect(typeof row.notice.daysRemaining).toBe('number');
        expect(typeof row.notice.isTimeBarred).toBe('boolean');
      }
    });

    it('reports no clock at all when there is no instruction to run it from', async () => {
      // An identified-but-uninstructed variation has no deadline yet. Null is a
      // different claim from "not barred", and reporting the second would be a
      // quiet lie about a claim that has not started its clock.
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/contracts/variations',
        headers: auth(),
      });

      const uninstructed = response
        .json()
        .rows.filter((r: { instructedOn: string | null }) => !r.instructedOn);

      for (const row of uninstructed) {
        expect(row.notice).toBeNull();
      }
    });

    it('records a notice, and says so when it was late', async () => {
      const list = await app.inject({
        method: 'GET',
        url: '/api/v1/contracts/variations?atRisk=true',
        headers: auth(),
      });

      const atRisk = list.json().rows;
      expect(atRisk.length).toBeGreaterThan(0);
      // Everything the filter returns is instructed, unnoticed and unsettled.
      for (const row of atRisk) {
        expect(row.instructedOn).not.toBeNull();
        expect(row.noticeGivenOn).toBeNull();
      }

      const barred = atRisk.find((r: { notice: { isTimeBarred: boolean } }) => r.notice.isTimeBarred);
      expect(barred).toBeDefined();

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/variations/${barred.id}/notice`,
        headers: auth(),
        payload: { noticeGivenOn: '2026-07-01', noticeReference: 'LTR-2026-113' },
      });

      expect(response.statusCode).toBe(200);
      // Late notice is RECORDED, not refused: it is still evidence, and refusing
      // it would leave the strongest available fact out of the file to keep a
      // status column tidy.
      expect(response.json().wasLate).toBe(true);
      expect(response.json().deadlineOn).toBeTruthy();
    });

    it('drops a noticed variation out of the at-risk filter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/contracts/variations?atRisk=true',
        headers: auth(),
      });

      expect(
        response.json().rows.every((r: { noticeGivenOn: string | null }) => r.noticeGivenOn === null),
      ).toBe(true);
    });

    it('does not let a user without write permission serve a notice', async () => {
      const list = await app.inject({
        method: 'GET',
        url: '/api/v1/contracts/variations',
        headers: auth(),
      });

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/variations/${list.json().rows[0].id}/notice`,
        headers: auth(ENGINEER_TOKEN),
        payload: { noticeGivenOn: '2026-07-01' },
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns one variation with its lines and its clock', async () => {
      const list = await app.inject({
        method: 'GET',
        url: '/api/v1/contracts/variations',
        headers: auth(),
      });
      const first = list.json().rows[0];

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/contracts/variations/${first.id}`,
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.variation.id).toBe(first.id);
      expect(body.contract.currencyCode).toBe('AED');
      expect(Array.isArray(body.lines)).toBe(true);

      // The register and the detail screen must agree about whether a claim is
      // still alive — they call the same domain function to make sure.
      expect(body.notice?.isTimeBarred).toBe(first.notice?.isTimeBarred);
    });

    it('gates the project list on the permission, not just the module', async () => {
      // The site engineer has `projects.project.read`, so they see the list.
      const engineer = await app.inject({
        method: 'GET',
        url: '/api/v1/projects',
        headers: auth(ENGINEER_TOKEN),
      });
      expect(engineer.statusCode).toBe(200);

      // They have no contracts permission at all.
      const contracts = await app.inject({
        method: 'GET',
        url: '/api/v1/contracts',
        headers: auth(ENGINEER_TOKEN),
      });
      expect(contracts.statusCode).toBe(403);
    });
  });


  describe('the last six registers', () => {
    it('flags a contractual item past its deadline, and not a merely late RFI', async () => {
      const db = getDatabase();
      const [head] = await db
        .select({ id: contractsSchema.contract.id })
        .from(contractsSchema.contract)
        .where(eq(contractsSchema.contract.tenantId, TENANT))
        .limit(1);

      await db.insert(contractsSchema.correspondence).values([
        {
          tenantId: TENANT,
          contractId: head!.id,
          type: 'notice',
          reference: 'REG-NOT-1',
          subject: 'Late and contractual',
          issuedOn: '2026-01-01',
          responseDueOn: '2026-01-15',
          isContractual: true,
        },
        {
          tenantId: TENANT,
          contractId: head!.id,
          type: 'rfi',
          reference: 'REG-RFI-1',
          subject: 'Late but not contractual',
          issuedOn: '2026-01-01',
          responseDueOn: '2026-01-15',
          isContractual: false,
        },
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/contracts/correspondence?q=REG-',
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const rows: { reference: string; isAtRisk: boolean }[] = response.json().rows;

      // Both are overdue. Only one costs anything, and conflating them is how a
      // register full of chased RFIs hides the notice that mattered.
      expect(rows.find((r) => r.reference === 'REG-NOT-1')?.isAtRisk).toBe(true);
      expect(rows.find((r) => r.reference === 'REG-RFI-1')?.isAtRisk).toBe(false);

      await db
        .delete(contractsSchema.correspondence)
        .where(eq(contractsSchema.correspondence.tenantId, TENANT));
    });

    it('separates retention held from retention claimable today', async () => {
      const db = getDatabase();
      const [head] = await db
        .select({ id: contractsSchema.contract.id })
        .from(contractsSchema.contract)
        .where(eq(contractsSchema.contract.tenantId, TENANT))
        .limit(1);

      const before = (
        await app.inject({
          method: 'GET',
          url: '/api/v1/contracts/retention',
          headers: auth(),
        })
      ).json().summary;

      const made = await db
        .insert(contractsSchema.retentionRelease)
        .values([
          { tenantId: TENANT, contractId: head!.id, trigger: 'practical_completion', amount: '1000.00', dueOn: '2026-01-01' },
          { tenantId: TENANT, contractId: head!.id, trigger: 'end_of_dlp', amount: '2500.00', dueOn: '2099-01-01' },
          { tenantId: TENANT, contractId: head!.id, trigger: 'negotiated', amount: '400.00', dueOn: '2026-01-01', releasedOn: '2026-02-01' },
        ])
        .returning({ id: contractsSchema.retentionRelease.id });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/contracts/retention',
        headers: auth(),
      });

      const summary = response.json().summary;
      // Asserted as a DELTA against the register before these rows existed.
      // Earlier tests in this suite schedule retention of their own, so an
      // absolute total here would be asserting on the order tests happen to run
      // in rather than on the categorisation being tested.
      expect(summary.heldValue - before.heldValue).toBeCloseTo(2500, 2);
      expect(summary.dueValue - before.dueValue).toBeCloseTo(1000, 2);
      expect(summary.releasedValue - before.releasedValue).toBeCloseTo(400, 2);

      // By id. Deleting by trigger would take out retention other tests
      // scheduled under the same trigger names and depend on.
      await db.delete(contractsSchema.retentionRelease).where(
        inArray(
          contractsSchema.retentionRelease.id,
          made.map((row) => row.id),
        ),
      );
    });

    it('counts a snag as blocking handover only while it is critical AND open', async () => {
      const db = getDatabase();
      await db.insert(projectsSchema.snag).values([
        { tenantId: TENANT, projectId: PROJECT, reference: 'REG-S-1', description: 'Critical, disputed', severity: 'critical', status: 'rejected', raisedOn: '2026-01-01' },
        { tenantId: TENANT, projectId: PROJECT, reference: 'REG-S-2', description: 'Critical, done', severity: 'critical', status: 'closed', raisedOn: '2026-01-01' },
        { tenantId: TENANT, projectId: PROJECT, reference: 'REG-S-3', description: 'Minor, open', severity: 'minor', status: 'open', raisedOn: '2026-01-01' },
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/snags?q=REG-S-',
        headers: auth(),
      });

      const rows: { reference: string; blocksHandover: boolean }[] = response.json().rows;
      // A snag the subcontractor rejected is still a snag. Treating `rejected`
      // as closed is exactly how a critical defect reappears at handover.
      expect(rows.find((r) => r.reference === 'REG-S-1')?.blocksHandover).toBe(true);
      expect(rows.find((r) => r.reference === 'REG-S-2')?.blocksHandover).toBe(false);
      expect(rows.find((r) => r.reference === 'REG-S-3')?.blocksHandover).toBe(false);

      await db.delete(projectsSchema.snag).where(eq(projectsSchema.snag.tenantId, TENANT));
    });

    describe('raising and closing a snag', () => {
      it('allocates a SNG-prefixed reference on create', async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/projects/snags',
          headers: auth(),
          payload: {
            projectId: PROJECT,
            description: 'Door handle scratched during install',
            severity: 'major',
            location: 'Level 3, Unit 12',
          },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.id).toBeTruthy();
        expect(body.reference).toMatch(/^SNG-\d{4}-\d+$/);

        const db = getDatabase();
        await db.delete(projectsSchema.snag).where(eq(projectsSchema.snag.id, body.id));
      });

      it('closes a snag with a status and stamps who closed it', async () => {
        const db = getDatabase();
        const created = await app.inject({
          method: 'POST',
          url: '/api/v1/projects/snags',
          headers: auth(),
          payload: { projectId: PROJECT, description: 'Skirting gap', severity: 'minor' },
        });
        const { id } = created.json();

        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/projects/snags/${id}/close`,
          headers: auth(),
          payload: { closedBy: OWNER, status: 'closed' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().status).toBe('closed');

        const [row] = await db
          .select({ status: projectsSchema.snag.status, closedBy: projectsSchema.snag.closedBy, closedOn: projectsSchema.snag.closedOn })
          .from(projectsSchema.snag)
          .where(eq(projectsSchema.snag.id, id));
        expect(row?.status).toBe('closed');
        expect(row?.closedBy).toBe(OWNER);
        expect(row?.closedOn).toBeTruthy();

        await db.delete(projectsSchema.snag).where(eq(projectsSchema.snag.id, id));
      });

      it('refuses to close a snag that is already closed', async () => {
        const db = getDatabase();
        const created = await app.inject({
          method: 'POST',
          url: '/api/v1/projects/snags',
          headers: auth(),
          payload: { projectId: PROJECT, description: 'Already fixed', severity: 'minor' },
        });
        const { id } = created.json();

        await app.inject({
          method: 'POST',
          url: `/api/v1/projects/snags/${id}/close`,
          headers: auth(),
          payload: { closedBy: OWNER, status: 'closed' },
        });

        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/projects/snags/${id}/close`,
          headers: auth(),
          payload: { closedBy: OWNER, status: 'rejected' },
        });

        expect(response.statusCode).toBe(409);

        await db.delete(projectsSchema.snag).where(eq(projectsSchema.snag.id, id));
      });

      it('needs projects.snag.write, not just .read, to raise one', async () => {
        // The site role holds projects.snag.read (granted above) and reads the
        // register fine; raising a snag is a different act and needs the write
        // permission.
        const readOnly = await app.inject({
          method: 'GET',
          url: '/api/v1/projects/snags',
          headers: auth(ENGINEER_TOKEN),
        });
        expect(readOnly.statusCode).toBe(200);

        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/projects/snags',
          headers: auth(ENGINEER_TOKEN),
          payload: { projectId: PROJECT, description: 'Should be refused', severity: 'minor' },
        });

        expect(response.statusCode).toBe(403);
      });

      it('rejects an invalid severity on create', async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/projects/snags',
          headers: auth(),
          payload: { projectId: PROJECT, description: 'Bad severity', severity: 'catastrophic' },
        });

        expect(response.statusCode).toBe(400);
      });

      it('rejects an invalid status on close', async () => {
        const db = getDatabase();
        const created = await app.inject({
          method: 'POST',
          url: '/api/v1/projects/snags',
          headers: auth(),
          payload: { projectId: PROJECT, description: 'Bad close status', severity: 'minor' },
        });
        const { id } = created.json();

        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/projects/snags/${id}/close`,
          headers: auth(),
          payload: { closedBy: OWNER, status: 'done' },
        });

        expect(response.statusCode).toBe(400);

        await db.delete(projectsSchema.snag).where(eq(projectsSchema.snag.id, id));
      });
    });

    it('keeps a reversed cost on the ledger and marks it, rather than hiding it', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/costs',
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      for (const row of body.rows) {
        expect(row).toHaveProperty('isReversed');
      }
      // Actual and accrued are reported apart. An accrual is a cost incurred and
      // not yet invoiced; summing them into one figure is how a cost report
      // stops being true during the job.
      for (const group of body.summary) {
        expect(group).toHaveProperty('actual');
        expect(group).toHaveProperty('accrued');
      }
    });

    it('reports what a progress figure was measured from, not just the figure', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/progress',
        headers: auth(),
      });

      const rows: { ruleOfCredit: string; isSelfAssessed: boolean }[] = response.json().rows;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        // The flag must follow the rule, or a typed percentage renders exactly
        // like a counted one and the whole mechanism is decorative.
        expect(row.isSelfAssessed).toBe(row.ruleOfCredit === 'manual');
      }
    });
  });

  describe('9 — the audit trail', () => {
    it('reads back what every earlier section actually did', async () => {
      // Nothing in this suite has read `audit_log` before now — every mutation
      // in sections 1-8 called `recordAudit` on its way past, and this is the
      // first assertion that the table is not merely being written to.
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit',
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.total).toBeGreaterThan(0);
      expect(body.entityTypes).toEqual(
        expect.arrayContaining(['contracts.contract', 'contracts.payment_application']),
      );
      expect(body.actions.length).toBeGreaterThan(0);

      // Newest first by default: the whole reason this reads better than a
      // raw SQL client is that the recent change is the one somebody wants.
      const timestamps = body.rows.map((row: { occurredAt: string }) => row.occurredAt);
      expect([...timestamps].sort().reverse()).toEqual(timestamps);
    });

    it('narrows to one entity type without the option list losing the others', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit?entityType=contracts.payment_application',
        headers: auth(),
      });

      const body = response.json();
      expect(body.rows.length).toBeGreaterThan(0);
      for (const row of body.rows) {
        expect(row.entityType).toBe('contracts.payment_application');
      }

      // Computed over the whole trail, not the filtered slice — the same rule
      // the localisation rules screen's domain list follows, and for the same
      // reason: a filter's own other options must not disappear once applied.
      expect(body.entityTypes).toEqual(expect.arrayContaining(['contracts.contract']));
    });

    it('names who did it, not just their id', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit?entityType=contracts.contract',
        headers: auth(),
      });

      const rows: { actorId: string | null; actorName: string | null; actorEmail: string | null }[] =
        response.json().rows;
      const attributed = rows.find((row) => row.actorId != null);
      expect(attributed?.actorName).toBe('Commercial Manager');
      expect(attributed?.actorEmail).toBe('cm@delivery.test');
    });

    it('refuses a user who holds no kernel.audit.read permission', async () => {
      // The site engineer's role (section setup) grants three `projects.*`
      // permissions and nothing from `kernel` — this is the first thing in the
      // suite to check that omission actually bites.
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit',
        headers: auth(ENGINEER_TOKEN),
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('10 — back charges', () => {
    let doorsChargeId: string;
    let disputedChargeId: string;

    it('raises a back charge against the contract', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/${contractId}/back-charges`,
        headers: auth(),
        payload: {
          reference: 'BC-01',
          description: 'Rectifying four doors hung the wrong way round',
          category: 'rectification',
          amount: 3_200,
          incurredOn: '2026-04-05',
        },
      });

      expect(response.statusCode).toBe(200);
      doorsChargeId = response.json().id;
    });

    it('refuses a second back charge with the same reference on the same contract', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/${contractId}/back-charges`,
        headers: auth(),
        payload: {
          reference: 'BC-01',
          description: 'Duplicate',
          amount: 1,
          incurredOn: '2026-04-06',
        },
      });

      expect(response.statusCode).toBe(409);
    });

    it('refuses a site engineer who holds no contracts.back_charge.manage permission', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/${contractId}/back-charges`,
        headers: auth(ENGINEER_TOKEN),
        payload: { reference: 'BC-02', description: 'Should be refused', amount: 1, incurredOn: '2026-04-06' },
      });

      expect(response.statusCode).toBe(403);
    });

    it('lists back charges for the contract', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/contracts/back-charges?contractId=${contractId}`,
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const rows: { id: string; reference: string; status: string }[] = response.json().rows;
      expect(rows.some((r) => r.id === doorsChargeId && r.reference === 'BC-01')).toBe(true);
      expect(rows.every((r) => r.status === 'raised')).toBe(true);
    });

    it('refuses to mark a back charge agreed with no agreed amount ever recorded', async () => {
      const raised = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/${contractId}/back-charges`,
        headers: auth(),
        payload: {
          reference: 'BC-03',
          description: 'Disputed — deliberately never resolved in this suite',
          amount: 900,
          incurredOn: '2026-04-07',
        },
      });
      disputedChargeId = raised.json().id;

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/contracts/back-charges/${disputedChargeId}`,
        headers: auth(),
        payload: { status: 'agreed' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/agreed amount/);

      // Left disputed rather than agreed — sumAgreedBackCharges must not
      // pick this one up in the test below.
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/contracts/back-charges/${disputedChargeId}`,
        headers: auth(),
        payload: { status: 'disputed' },
      });
    });

    it('agrees a back charge at less than it was raised for', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/contracts/back-charges/${doorsChargeId}`,
        headers: auth(),
        payload: { status: 'agreed', agreedAmount: 2_800 },
      });

      expect(response.statusCode).toBe(200);

      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/contracts/back-charges?contractId=${contractId}&status=agreed`,
        headers: auth(),
      });
      const row = list.json().rows.find((r: { id: string }) => r.id === doorsChargeId);
      expect(row.agreedAmount).toBe('2800.00');
    });

    it('defaults a new payment application\'s back charges from the register, not zero', async () => {
      // Section 4's "IPC 2" (valued from progress, never submitted or
      // certified there — that section only checks its numbers) is still
      // open, and a second open application is refused regardless of back
      // charges. Close it out first; the point of this test is the default,
      // not section 4's certification behaviour.
      const [openApplication] = await getDatabase()
        .select()
        .from(contractsSchema.paymentApplication)
        .where(
          and(
            eq(contractsSchema.paymentApplication.contractId, contractId),
            eq(contractsSchema.paymentApplication.status, 'draft'),
          ),
        );
      if (openApplication) {
        await app.inject({
          method: 'POST',
          url: `/api/v1/contracts/applications/${openApplication.id}/submit`,
          headers: auth(),
          payload: { submittedOn: '2026-04-06' },
        });
        await app.inject({
          method: 'POST',
          url: `/api/v1/contracts/applications/${openApplication.id}/certify`,
          headers: auth(),
          payload: {
            certifiedNet: Number(openApplication.netThisApplication),
            certifiedOn: '2026-04-06',
          },
        });
      }

      // The AGREED amount (2,800), not the originally raised one (3,200) —
      // and the disputed BC-03 (900) must not appear in it at all.
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/${contractId}/applications`,
        headers: auth(),
        payload: {
          periodTo: '2026-04-30',
          workDoneToDate: 400_000,
        },
      });

      expect(response.statusCode).toBe(200);
      const { applicationId, valuation } = response.json();
      expect(valuation.backChargesToDate).toBe(2_800);

      // Move it out of 'draft' so the next test's application is not refused
      // as "still open" — the same rule section 3/4 already cover, not what
      // this test exists to prove. Certifying at exactly what was applied
      // avoids also needing a disallowance reason, which is that section's
      // concern, not this one's.
      await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/applications/${applicationId}/submit`,
        headers: auth(),
        payload: { submittedOn: '2026-05-05' },
      });
      const certify = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/applications/${applicationId}/certify`,
        headers: auth(),
        payload: { certifiedNet: valuation.netThisCertificate, certifiedOn: '2026-05-20' },
      });
      expect(certify.statusCode).toBe(200);
    });

    it('still honours an explicit override, including an explicit zero', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/${contractId}/applications`,
        headers: auth(),
        payload: {
          periodTo: '2026-05-31',
          workDoneToDate: 420_000,
          backChargesToDate: 0,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().valuation.backChargesToDate).toBe(0);
    });
  });

  describe('11 — the notice register, made writable', () => {
    let rfiId: string;

    it('raises an RFI against the contract', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/${contractId}/correspondence`,
        headers: auth(),
        payload: {
          type: 'rfi',
          reference: 'RFI-041',
          subject: 'Confirm veneer grain direction on reception desk',
          issuedOn: '2026-04-01',
          responseDueOn: '2026-04-15',
          isContractual: true,
        },
      });

      expect(response.statusCode).toBe(200);
      rfiId = response.json().id;
    });

    it('refuses a second item of the same type with the same reference on the same contract', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/${contractId}/correspondence`,
        headers: auth(),
        payload: {
          type: 'rfi',
          reference: 'RFI-041',
          subject: 'Duplicate',
          issuedOn: '2026-04-02',
        },
      });

      expect(response.statusCode).toBe(409);
    });

    it('refuses a site engineer who holds no contracts.correspondence.manage permission', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/${contractId}/correspondence`,
        headers: auth(ENGINEER_TOKEN),
        payload: {
          type: 'rfi',
          reference: 'RFI-042',
          subject: 'Should be refused',
          issuedOn: '2026-04-02',
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('lists the item, open and awaiting a reply', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/contracts/correspondence?contractId=${contractId}`,
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const rows: { id: string; reference: string; status: string; respondedOn: string | null }[] =
        response.json().rows;
      const row = rows.find((r) => r.id === rfiId);
      expect(row?.reference).toBe('RFI-041');
      expect(row?.status).toBe('open');
      expect(row?.respondedOn).toBeNull();
    });

    it('records a response, and the status follows without being told separately', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/contracts/correspondence/${rfiId}`,
        headers: auth(),
        payload: { respondedOn: '2026-04-10' },
      });

      expect(response.statusCode).toBe(200);

      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/contracts/correspondence?contractId=${contractId}&open=true`,
        headers: auth(),
      });
      const rows: { id: string }[] = list.json().rows;
      // Answered items drop out of "awaiting a reply" — that filter is what
      // openOnly means, distinct from the closed/open status column.
      expect(rows.some((r) => r.id === rfiId)).toBe(false);
    });

    it('links the item to the variation it became, refusing one that is not on this contract', async () => {
      const variation = await app.inject({
        method: 'POST',
        url: `/api/v1/contracts/${contractId}/variations`,
        headers: auth(),
        payload: {
          title: 'Book-matched veneer to reception desk, per RFI-041',
          basis: 'contract_rates',
          lines: [{ description: 'Veneer upgrade', quantity: 1, unitRate: 4_500 }],
        },
      });
      expect(variation.statusCode).toBe(200);
      const variationId = variation.json().variationId;

      const unrelated = await app.inject({
        method: 'PATCH',
        url: `/api/v1/contracts/correspondence/${rfiId}`,
        headers: auth(),
        payload: { variationId: '00000000-0000-4000-8000-000000000000' },
      });
      expect(unrelated.statusCode).toBe(409);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/contracts/correspondence/${rfiId}`,
        headers: auth(),
        payload: { variationId },
      });
      expect(response.statusCode).toBe(200);

      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/contracts/correspondence?contractId=${contractId}`,
        headers: auth(),
      });
      const row = list.json().rows.find((r: { id: string }) => r.id === rfiId);
      expect(row.variationId).toBe(variationId);
    });
  });
});

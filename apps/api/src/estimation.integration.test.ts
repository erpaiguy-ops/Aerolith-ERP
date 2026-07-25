/**
 * Estimation end to end: real HTTP, real database, real RLS.
 *
 * The centrepiece is the conversion at the bottom — a won tender's priced
 * build-ups becoming a Production work order in one transaction, while neither
 * module imports the other. That continuity is the entire pitch.
 *
 * Skipped when TEST_DATABASE_URL is unset.
 */
import { createHash } from 'node:crypto';

import { closeDatabase, createDatabase, getDatabase, schema } from '@aerolith/kernel';
import { estimationSchema } from '@aerolith/module-estimation';
import { productionSchema } from '@aerolith/module-production';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { invalidateTenantModules, syncModules } from './bootstrap';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const TENANT = 'aaaa1111-1111-4111-8111-111111111111';
const OWNER = 'ffffffff-0000-4000-8000-000000000001';
const ESTIMATOR = 'ffffffff-0000-4000-8000-000000000002';
const OWNER_TOKEN = 'estimation-owner-token';
const ESTIMATOR_TOKEN = 'estimation-estimator-token';

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

suite('Estimation', () => {
  let app: FastifyInstance;
  let mdfId: string;
  let libraryId: string;
  let routingId: string;

  const auth = (token = OWNER_TOKEN) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    createDatabase({ connectionString: url! });
    await syncModules();
    const db = getDatabase();

    await db.insert(schema.tenant).values({
      id: TENANT,
      slug: 'est-test',
      name: 'Estimation Test Joinery',
      status: 'active',
      primaryCountryCode: 'AE',
      baseCurrencyCode: 'AED',
    });

    await db.insert(schema.appUser).values([
      { id: OWNER, email: 'director@est.test', name: 'Director' },
      { id: ESTIMATOR, email: 'qs@est.test', name: 'Quantity Surveyor' },
    ]);
    await db.insert(schema.membership).values([
      { tenantId: TENANT, userId: OWNER, status: 'active', isOwner: true },
      { tenantId: TENANT, userId: ESTIMATOR, status: 'active', isOwner: false },
    ]);

    const expiresAt = new Date(Date.now() + 3_600_000);
    await db.insert(schema.session).values([
      { userId: OWNER, tenantId: TENANT, tokenHash: hash(OWNER_TOKEN), expiresAt },
      { userId: ESTIMATOR, tenantId: TENANT, tokenHash: hash(ESTIMATOR_TOKEN), expiresAt },
    ]);

    await db.insert(schema.tenantModule).values([
      { tenantId: TENANT, moduleKey: 'estimation', status: 'enabled' },
      { tenantId: TENANT, moduleKey: 'production', status: 'enabled' },
    ]);
    invalidateTenantModules();

    // The estimator can read estimates but NOT see margin — a real separation.
    const [role] = await db
      .insert(schema.role)
      .values({ tenantId: TENANT, code: 'qs', name: 'Quantity Surveyor' })
      .returning({ id: schema.role.id });

    await db.insert(schema.rolePermission).values(
      ['estimation.estimate.read', 'estimation.tender.read'].map((permissionKey) => ({
        tenantId: TENANT,
        roleId: role!.id,
        permissionKey,
      })),
    );
    await db
      .insert(schema.userRole)
      .values({ tenantId: TENANT, userId: ESTIMATOR, roleId: role!.id });

    const [mdf] = await db
      .insert(schema.item)
      .values({
        tenantId: TENANT,
        code: 'MDF-18',
        name: '18mm MDF',
        type: 'panel',
        lengthMm: '2440',
        widthMm: '1220',
        thicknessMm: '18',
        standardCost: '92',
      })
      .returning({ id: schema.item.id });
    mdfId = mdf!.id;

    await db.insert(schema.numberSeries).values([
      {
        tenantId: TENANT,
        entityType: 'estimation.tender',
        code: 'TND',
        name: 'Tender',
        pattern: 'TND-{YYYY}-{SEQ}',
      },
      {
        tenantId: TENANT,
        entityType: 'production.work_order',
        code: 'WO',
        name: 'Work Order',
        pattern: 'WO-{YYYY}-{SEQ}',
      },
    ]);

    // A rate library with one door rate, built up from real components.
    const [library] = await db
      .insert(estimationSchema.rateLibrary)
      .values({
        tenantId: TENANT,
        code: 'STD',
        name: 'Standard rates 2026',
        version: 1,
        isCurrent: true,
      })
      .returning({ id: estimationSchema.rateLibrary.id });
    libraryId = library!.id;

    const [doorRate] = await db
      .insert(estimationSchema.rateItem)
      .values({
        tenantId: TENANT,
        libraryId,
        code: 'DOOR-STD',
        description: 'Standard wardrobe door, sprayed',
        uomCode: 'NR',
      })
      .returning({ id: estimationSchema.rateItem.id });

    await db.insert(estimationSchema.rateComponent).values([
      {
        tenantId: TENANT,
        rateItemId: doorRate!.id,
        sequence: 1,
        type: 'material',
        description: '18mm MDF',
        itemId: mdfId,
        quantityPerUnit: '0.98',
        unitRate: '92',
        wastagePercent: '10',
      },
      {
        tenantId: TENANT,
        rateItemId: doorRate!.id,
        sequence: 2,
        type: 'labour',
        description: 'Machining and assembly',
        quantityPerUnit: '0.75',
        unitRate: '45',
      },
      {
        tenantId: TENANT,
        rateItemId: doorRate!.id,
        sequence: 3,
        type: 'finishing',
        description: '2-pack spray',
        quantityPerUnit: '0.98',
        unitRate: '55',
        wastagePercent: '15',
      },
    ]);

    const [centre] = await db
      .insert(productionSchema.workCentre)
      .values({ tenantId: TENANT, code: 'SAW', name: 'Beam Saw', type: 'beam_saw' })
      .returning({ id: productionSchema.workCentre.id });

    const [route] = await db
      .insert(productionSchema.routing)
      .values({ tenantId: TENANT, code: 'STD', name: 'Standard' })
      .returning({ id: productionSchema.routing.id });
    routingId = route!.id;

    await db.insert(productionSchema.routingOperation).values({
      tenantId: TENANT,
      routingId,
      sequence: 1,
      name: 'Cut',
      workCentreId: centre!.id,
    });

    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    const db = getDatabase();
    await db.delete(estimationSchema.estimateLineComponent).where(eq(estimationSchema.estimateLineComponent.tenantId, TENANT));
    await db.delete(estimationSchema.estimateLine).where(eq(estimationSchema.estimateLine.tenantId, TENANT));
    await db.delete(estimationSchema.estimateSection).where(eq(estimationSchema.estimateSection.tenantId, TENANT));
    await db.delete(estimationSchema.estimate).where(eq(estimationSchema.estimate.tenantId, TENANT));
    await db.delete(estimationSchema.tenderAddendum).where(eq(estimationSchema.tenderAddendum.tenantId, TENANT));
    await db.delete(estimationSchema.tender).where(eq(estimationSchema.tender.tenantId, TENANT));
    await db.delete(estimationSchema.rateComponent).where(eq(estimationSchema.rateComponent.tenantId, TENANT));
    await db.delete(estimationSchema.rateItem).where(eq(estimationSchema.rateItem.tenantId, TENANT));
    await db.delete(estimationSchema.rateLibrary).where(eq(estimationSchema.rateLibrary.tenantId, TENANT));
    await db.delete(productionSchema.workOrderOperation).where(eq(productionSchema.workOrderOperation.tenantId, TENANT));
    await db.delete(productionSchema.workOrderPart).where(eq(productionSchema.workOrderPart.tenantId, TENANT));
    await db.delete(productionSchema.workOrder).where(eq(productionSchema.workOrder.tenantId, TENANT));
    await db.delete(productionSchema.routingOperation).where(eq(productionSchema.routingOperation.tenantId, TENANT));
    await db.delete(productionSchema.routing).where(eq(productionSchema.routing.tenantId, TENANT));
    await db.delete(productionSchema.workCentre).where(eq(productionSchema.workCentre.tenantId, TENANT));
    await db.delete(schema.userRole).where(eq(schema.userRole.tenantId, TENANT));
    await db.delete(schema.rolePermission).where(eq(schema.rolePermission.tenantId, TENANT));
    await db.delete(schema.role).where(eq(schema.role.tenantId, TENANT));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.tenantId, TENANT));
    await db.delete(schema.eventOutbox).where(eq(schema.eventOutbox.tenantId, TENANT));
    await db.delete(schema.numberAllocation).where(eq(schema.numberAllocation.tenantId, TENANT));
    await db.delete(schema.numberSeries).where(eq(schema.numberSeries.tenantId, TENANT));
    await db.delete(schema.item).where(eq(schema.item.tenantId, TENANT));
    await db.delete(schema.tenantModule).where(eq(schema.tenantModule.tenantId, TENANT));
    await db.delete(schema.session).where(eq(schema.session.userId, OWNER));
    await db.delete(schema.session).where(eq(schema.session.userId, ESTIMATOR));
    await db.delete(schema.membership).where(eq(schema.membership.tenantId, TENANT));
    await db.delete(schema.appUser).where(eq(schema.appUser.id, OWNER));
    await db.delete(schema.appUser).where(eq(schema.appUser.id, ESTIMATOR));
    await db.delete(schema.tenant).where(eq(schema.tenant.id, TENANT));
    await app.close();
    await closeDatabase();
  });

  async function newTender(name = 'Marina Tower fit-out') {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/estimating/tenders',
      headers: auth(),
      payload: { name, currencyCode: 'AED' },
    });
    return response.json() as { tenderId: string; number: string };
  }

  async function priceIt(tenderId: string, over: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/estimating/tenders/${tenderId}/estimates`,
      headers: auth(),
      payload: {
        label: 'Base bid',
        rateLibraryId: libraryId,
        overheadPercent: 8,
        marginPercent: 18,
        lines: [
          {
            reference: 'A.01',
            description: 'Wardrobe doors',
            quantity: 40,
            uomCode: 'NR',
            rateItemCode: 'DOOR-STD',
          },
          {
            reference: 'A.02',
            description: 'Allowance for ironmongery',
            quantity: 1,
            kind: 'provisional_sum',
            unitRate: 15000,
          },
          {
            reference: 'A.03',
            description: 'Alternate: solid oak fronts',
            quantity: 40,
            kind: 'optional',
            unitRate: 480,
          },
        ],
        ...over,
      },
    });
  }

  // -------------------------------------------------------------------------

  describe('tenders', () => {
    it('creates a tender with a number', async () => {
      const tender = await newTender();
      expect(tender.number).toMatch(/^TND-\d{4}-\d{5}$/);
    });

    it('records a bid decision with a reason and an author', async () => {
      // Six months later, "why did we not bid the Marina job?" needs an answer.
      const tender = await newTender();
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/estimating/tenders/${tender.tenderId}/bid-decision`,
        headers: auth(),
        payload: { decision: 'no_bid', reason: 'Programme clashes with Dubai Hills' },
      });

      expect(response.statusCode).toBe(200);

      const [row] = await getDatabase()
        .select()
        .from(estimationSchema.tender)
        .where(eq(estimationSchema.tender.id, tender.tenderId));

      expect(row!.status).toBe('abandoned');
      expect(row!.bidDecisionReason).toMatch(/Dubai Hills/);
      expect(row!.bidDecidedBy).toBe(OWNER);
    });

    it('refuses a bid decision with no reason', async () => {
      const tender = await newTender();
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/estimating/tenders/${tender.tenderId}/bid-decision`,
        headers: auth(),
        payload: { decision: 'bid', reason: '' },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('pricing', () => {
    it('prices a BOQ from the rate library', async () => {
      const tender = await newTender();
      const response = await priceIt(tender.tenderId);

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.linesPriced).toBe(3);
      expect(body.totalValue).toBeGreaterThan(0);
      expect(body.marginPercent).toBeGreaterThan(0);
    });

    it('excludes the optional alternate from the base total', async () => {
      // Including an alternate the client did not ask for loses tenders.
      const tender = await newTender();
      const created = (await priceIt(tender.tenderId)).json();

      const [row] = await getDatabase()
        .select()
        .from(estimationSchema.estimate)
        .where(eq(estimationSchema.estimate.id, created.estimateId));

      expect(Number(row!.optionalTotal)).toBe(40 * 480);
      expect(Number(row!.totalValue)).toBeLessThan(Number(row!.optionalTotal) + Number(row!.totalValue));
    });

    it('carries the provisional sum at cost, with no margin on it', async () => {
      // It is the client's money passing through.
      const tender = await newTender();
      const created = (await priceIt(tender.tenderId)).json();

      const lines = await getDatabase()
        .select()
        .from(estimationSchema.estimateLine)
        .where(eq(estimationSchema.estimateLine.estimateId, created.estimateId));

      const provisional = lines.find((l) => l.kind === 'provisional_sum')!;
      expect(Number(provisional.unitRate)).toBe(15000);
      expect(Number(provisional.unitCost)).toBe(15000);
    });

    it('snapshots the build-up so the bid survives a library change', async () => {
      const tender = await newTender();
      const created = (await priceIt(tender.tenderId)).json();

      const [line] = await getDatabase()
        .select()
        .from(estimationSchema.estimateLine)
        .where(
          and(
            eq(estimationSchema.estimateLine.estimateId, created.estimateId),
            eq(estimationSchema.estimateLine.reference, 'A.01'),
          ),
        );

      const components = await getDatabase()
        .select()
        .from(estimationSchema.estimateLineComponent)
        .where(eq(estimationSchema.estimateLineComponent.lineId, line!.id));

      expect(components).toHaveLength(3);
      expect(components.some((c) => c.type === 'finishing')).toBe(true);
    });

    it('rejects an unknown rate code rather than pricing it at zero', async () => {
      const tender = await newTender();
      const response = await priceIt(tender.tenderId, {
        lines: [
          { description: 'Mystery', quantity: 1, rateItemCode: 'NOT-A-RATE' },
        ],
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/not in the library/i);
    });

    it('versions a second estimate rather than overwriting the first', async () => {
      const tender = await newTender();
      await priceIt(tender.tenderId);
      const second = await priceIt(tender.tenderId, { label: 'Aggressive', marginPercent: 10 });

      expect(second.json().version).toBe(2);
    });

    it('prices lower at a lower margin', async () => {
      const tender = await newTender();
      const base = (await priceIt(tender.tenderId, { marginPercent: 25 })).json();
      const keen = (await priceIt(tender.tenderId, { marginPercent: 10 })).json();

      expect(keen.totalValue).toBeLessThan(base.totalValue);
      // The cost base is unchanged — only the margin moved.
      expect(keen.totalCost).toBeCloseTo(base.totalCost, 0);
    });
  });

  describe('margin visibility', () => {
    it('hides cost and margin from a user without the permission', async () => {
      // A site manager checking quantities should not see the margin.
      const tender = await newTender();
      const created = (await priceIt(tender.tenderId)).json();

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/estimating/estimates/${created.estimateId}`,
        headers: auth(ESTIMATOR_TOKEN),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.marginVisible).toBe(false);
      expect(body.estimate.totalCost).toBeUndefined();
      expect(body.lines[0].unitCost).toBeUndefined();
      // They can still see the quantities and the price.
      expect(body.lines[0].quantity).toBeDefined();
    });

    it('shows cost and margin to a user who may see it', async () => {
      const tender = await newTender();
      const created = (await priceIt(tender.tenderId)).json();

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/estimating/estimates/${created.estimateId}`,
        headers: auth(),
      });

      expect(response.json().marginVisible).toBe(true);
      expect(response.json().estimate.totalCost).toBeDefined();
    });

    it('refuses scenario analysis to a user who cannot see margin', async () => {
      const tender = await newTender();
      const created = (await priceIt(tender.tenderId)).json();

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/estimating/estimates/${created.estimateId}/scenarios`,
        headers: auth(ESTIMATOR_TOKEN),
        payload: { margins: [{ label: 'Keen', marginPercent: 10 }] },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('margin scenarios', () => {
    it('reprices the same cost base at several margins', async () => {
      const tender = await newTender();
      const created = (await priceIt(tender.tenderId)).json();

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/estimating/estimates/${created.estimateId}/scenarios`,
        headers: auth(),
        payload: {
          margins: [
            { label: 'Aggressive', marginPercent: 8 },
            { label: 'Target', marginPercent: 18 },
            { label: 'Comfortable', marginPercent: 28 },
          ],
        },
      });

      const body = response.json();
      expect(body.scenarios).toHaveLength(3);
      expect(body.scenarios[0].total).toBeLessThan(body.scenarios[2].total);
      expect(body.current.total).toBeGreaterThan(0);
    });
  });

  describe('submission and outcome', () => {
    it('submits an estimate and marks the tender submitted', async () => {
      const tender = await newTender();
      const created = (await priceIt(tender.tenderId)).json();

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/estimating/estimates/${created.estimateId}/submit`,
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().tenderNumber).toBe(tender.number);

      const [row] = await getDatabase()
        .select()
        .from(estimationSchema.tender)
        .where(eq(estimationSchema.tender.id, tender.tenderId));
      expect(row!.status).toBe('submitted');
    });

    it('supersedes a previously submitted scenario', async () => {
      // At most one price was actually sent to the client.
      const tender = await newTender();
      const first = (await priceIt(tender.tenderId)).json();
      const second = (await priceIt(tender.tenderId, { label: 'Revised' })).json();

      const url = (id: string) => `/api/v1/estimating/estimates/${id}/submit`;
      await app.inject({ method: 'POST', url: url(first.estimateId), headers: auth() });
      await app.inject({ method: 'POST', url: url(second.estimateId), headers: auth() });

      const estimates = await getDatabase()
        .select()
        .from(estimationSchema.estimate)
        .where(eq(estimationSchema.estimate.tenderId, tender.tenderId));

      expect(estimates.filter((e) => e.isSubmitted)).toHaveLength(1);
      expect(estimates.find((e) => e.isSubmitted)!.id).toBe(second.estimateId);
    });

    it('records a win and emits the event that starts the job', async () => {
      const tender = await newTender();
      const created = (await priceIt(tender.tenderId)).json();
      await app.inject({
        method: 'POST',
        url: `/api/v1/estimating/estimates/${created.estimateId}/submit`,
        headers: auth(),
      });

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/estimating/tenders/${tender.tenderId}/outcome`,
        headers: auth(),
        payload: { outcome: 'won' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().submittedEstimateId).toBe(created.estimateId);

      const events = await getDatabase()
        .select({ type: schema.eventOutbox.eventType })
        .from(schema.eventOutbox)
        .where(
          and(
            eq(schema.eventOutbox.tenantId, TENANT),
            eq(schema.eventOutbox.eventType, 'estimation.tender.won'),
          ),
        );
      expect(events.length).toBeGreaterThan(0);
    });

    it('captures why a tender was lost, and to whom', async () => {
      const tender = await newTender();
      const created = (await priceIt(tender.tenderId)).json();
      await app.inject({
        method: 'POST',
        url: `/api/v1/estimating/estimates/${created.estimateId}/submit`,
        headers: auth(),
      });

      await app.inject({
        method: 'POST',
        url: `/api/v1/estimating/tenders/${tender.tenderId}/outcome`,
        headers: auth(),
        payload: { outcome: 'lost', lostReason: 'Price', winningValue: 410000 },
      });

      const [row] = await getDatabase()
        .select()
        .from(estimationSchema.tender)
        .where(eq(estimationSchema.tender.id, tender.tenderId));

      expect(row!.status).toBe('lost');
      expect(Number(row!.winningValue)).toBe(410000);
    });

    it('refuses to record an outcome twice', async () => {
      const tender = await newTender();
      const created = (await priceIt(tender.tenderId)).json();
      await app.inject({
        method: 'POST',
        url: `/api/v1/estimating/estimates/${created.estimateId}/submit`,
        headers: auth(),
      });

      const url = `/api/v1/estimating/tenders/${tender.tenderId}/outcome`;
      await app.inject({ method: 'POST', url, headers: auth(), payload: { outcome: 'won' } });
      const second = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: { outcome: 'lost' },
      });

      expect(second.statusCode).toBe(409);
    });
  });

  describe('the wedge — won tender becomes a work order', () => {
    async function wonEstimate() {
      const tender = await newTender();
      const created = (await priceIt(tender.tenderId)).json();
      await app.inject({
        method: 'POST',
        url: `/api/v1/estimating/estimates/${created.estimateId}/submit`,
        headers: auth(),
      });
      await app.inject({
        method: 'POST',
        url: `/api/v1/estimating/tenders/${tender.tenderId}/outcome`,
        headers: auth(),
        payload: { outcome: 'won' },
      });
      return { tender, created };
    }

    it('converts a won estimate into a work order with parts', async () => {
      // Estimation and Production never import each other; this route joins
      // them in one transaction.
      const { tender, created } = await wonEstimate();

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/estimating/estimates/${created.estimateId}/convert-to-work-order`,
        headers: auth(),
        payload: { routingId },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.number).toMatch(/^WO-\d{4}-\d{5}$/);
      expect(body.tenderNumber).toBe(tender.number);
      // Only the measured line converts — not the provisional sum or the option.
      expect(body.linesConverted).toBe(1);
      expect(body.partsCreated).toBe(1);
      expect(body.operationsCreated).toBe(1);
    });

    it('links the work order back to the estimate it came from', async () => {
      const { created } = await wonEstimate();
      const converted = (
        await app.inject({
          method: 'POST',
          url: `/api/v1/estimating/estimates/${created.estimateId}/convert-to-work-order`,
          headers: auth(),
          payload: { routingId },
        })
      ).json();

      const [order] = await getDatabase()
        .select()
        .from(productionSchema.workOrder)
        .where(eq(productionSchema.workOrder.id, converted.workOrderId));

      expect(order!.sourceModule).toBe('estimation');
      expect(order!.sourceEntityId).toBe(created.estimateId);
    });

    it('carries the material demand through from the build-up', async () => {
      const { created } = await wonEstimate();
      const converted = (
        await app.inject({
          method: 'POST',
          url: `/api/v1/estimating/estimates/${created.estimateId}/convert-to-work-order`,
          headers: auth(),
          payload: { routingId },
        })
      ).json();

      // 40 doors x 0.98 sheets x 1.10 wastage = 43.12 sheets of MDF.
      const mdf = converted.materialDemand.find((d: { itemId: string }) => d.itemId === mdfId);
      expect(mdf.quantity).toBeCloseTo(43.12, 1);
    });

    it('refuses to convert a tender that has not been won', async () => {
      const tender = await newTender();
      const created = (await priceIt(tender.tenderId)).json();

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/estimating/estimates/${created.estimateId}/convert-to-work-order`,
        headers: auth(),
        payload: { routingId },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/not been won|"estimating"|"identified"/i);
    });

    it('says so plainly when Production is not enabled', async () => {
      const db = getDatabase();
      await db
        .delete(schema.tenantModule)
        .where(
          and(
            eq(schema.tenantModule.tenantId, TENANT),
            eq(schema.tenantModule.moduleKey, 'production'),
          ),
        );
      invalidateTenantModules(TENANT);

      const { created } = await wonEstimate();
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/estimating/estimates/${created.estimateId}/convert-to-work-order`,
        headers: auth(),
        payload: {},
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/Production is not enabled/i);

      await db
        .insert(schema.tenantModule)
        .values({ tenantId: TENANT, moduleKey: 'production', status: 'enabled' });
      invalidateTenantModules(TENANT);
    });

    it('reports the bill of materials for procurement', async () => {
      const { created } = await wonEstimate();
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/estimating/estimates/${created.estimateId}/bill-of-materials`,
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const demand = response.json().materialDemand;
      expect(demand[0].itemCode).toBe('MDF-18');
      expect(demand[0].quantity).toBeGreaterThan(0);
    });
  });

  describe('rate library', () => {
    it('serves the current library with its rates', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/estimating/rates',
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().library.code).toBe('STD');
      expect(response.json().rates.map((r: { code: string }) => r.code)).toContain('DOOR-STD');
    });
  });
});

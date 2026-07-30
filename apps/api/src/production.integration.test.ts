/**
 * Production end to end: real HTTP, real database, real RLS.
 *
 * The centrepiece is the cutlist route, which composes Production, Inventory and
 * the cutlist engine in one transaction while neither module imports the other.
 *
 * Skipped when TEST_DATABASE_URL is unset.
 */
import { createHash } from 'node:crypto';

import { closeDatabase, createDatabase, getDatabase, schema } from '@aerolith/kernel';
import { inventorySchema } from '@aerolith/module-inventory';
import { productionSchema } from '@aerolith/module-production';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { invalidateTenantModules, syncModules } from './bootstrap';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const TENANT = '99999999-9999-4999-8999-999999999999';
const USER = 'eeeeeeee-0000-4000-8000-000000000001';
const TOKEN = 'production-token-for-tests';

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

suite('Production', () => {
  let app: FastifyInstance;
  let mdfId: string;
  let factoryId: string;
  let routingId: string;
  let sawId: string;
  let boothId: string;

  const auth = () => ({ authorization: `Bearer ${TOKEN}` });

  beforeAll(async () => {
    createDatabase({ connectionString: url! });
    await syncModules();
    const db = getDatabase();

    await db.insert(schema.tenant).values({
      id: TENANT,
      slug: 'prod-test',
      name: 'Production Test Joinery',
      status: 'active',
      primaryCountryCode: 'AE',
      baseCurrencyCode: 'AED',
    });
    await db.insert(schema.appUser).values({ id: USER, email: 'foreman@prod.test', name: 'Foreman' });
    await db
      .insert(schema.membership)
      .values({ tenantId: TENANT, userId: USER, status: 'active', isOwner: true });
    await db.insert(schema.session).values({
      userId: USER,
      tenantId: TENANT,
      tokenHash: hash(TOKEN),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await db.insert(schema.tenantModule).values([
      { tenantId: TENANT, moduleKey: 'production', status: 'enabled' },
      { tenantId: TENANT, moduleKey: 'inventory', status: 'enabled' },
    ]);
    invalidateTenantModules();

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
        entityType: 'production.work_order',
        code: 'WO',
        name: 'Work Order',
        pattern: 'WO-{YYYY}-{SEQ}',
      },
    ]);

    // A realistic joinery route: saw, edgebander, spray booth (batch, with
    // cure), then a QC gate.
    const [saw] = await db
      .insert(productionSchema.workCentre)
      .values({
        tenantId: TENANT,
        code: 'SAW',
        name: 'Beam Saw',
        type: 'beam_saw',
        setupMinutes: '15',
        runMinutesPerUnit: '2',
        costPerHour: '120',
      })
      .returning({ id: productionSchema.workCentre.id });
    sawId = saw!.id;

    const [edge] = await db
      .insert(productionSchema.workCentre)
      .values({
        tenantId: TENANT,
        code: 'EDGE',
        name: 'Edgebander',
        type: 'edgebander',
        setupMinutes: '10',
        runMinutesPerUnit: '1',
      })
      .returning({ id: productionSchema.workCentre.id });

    const [booth] = await db
      .insert(productionSchema.workCentre)
      .values({
        tenantId: TENANT,
        code: 'BOOTH',
        name: 'Spray Booth',
        type: 'spray_booth',
        setupMinutes: '20',
        runMinutesPerUnit: '30',
        isBatchProcess: true,
        batchCapacityUnits: 40,
      })
      .returning({ id: productionSchema.workCentre.id });
    boothId = booth!.id;

    const [qc] = await db
      .insert(productionSchema.workCentre)
      .values({ tenantId: TENANT, code: 'QC', name: 'Quality', type: 'quality' })
      .returning({ id: productionSchema.workCentre.id });

    const [route] = await db
      .insert(productionSchema.routing)
      .values({ tenantId: TENANT, code: 'STD-DOOR', name: 'Standard door', isDefault: true })
      .returning({ id: productionSchema.routing.id });
    routingId = route!.id;

    await db.insert(productionSchema.routingOperation).values([
      { tenantId: TENANT, routingId, sequence: 1, name: 'Cut', workCentreId: sawId },
      { tenantId: TENANT, routingId, sequence: 2, name: 'Edge', workCentreId: edge!.id },
      {
        tenantId: TENANT,
        routingId,
        sequence: 3,
        name: 'Spray',
        workCentreId: boothId,
        cureMinutes: 240,
      },
      {
        tenantId: TENANT,
        routingId,
        sequence: 4,
        name: 'QC',
        workCentreId: qc!.id,
        isQualityGate: true,
      },
    ]);

    app = await buildApp();
    await app.ready();

    const factory = await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/warehouses',
      headers: auth(),
      payload: { code: 'FAC', name: 'Factory', type: 'factory' },
    });
    factoryId = factory.json().warehouse.id;
  });

  afterAll(async () => {
    const db = getDatabase();
    await db.delete(productionSchema.productionScan).where(eq(productionSchema.productionScan.tenantId, TENANT));
    await db.delete(productionSchema.cuttingPlan).where(eq(productionSchema.cuttingPlan.tenantId, TENANT));
    await db.delete(productionSchema.workOrderOperation).where(eq(productionSchema.workOrderOperation.tenantId, TENANT));
    await db.delete(productionSchema.workOrderPart).where(eq(productionSchema.workOrderPart.tenantId, TENANT));
    await db.delete(productionSchema.workOrder).where(eq(productionSchema.workOrder.tenantId, TENANT));
    await db.delete(productionSchema.routingOperation).where(eq(productionSchema.routingOperation.tenantId, TENANT));
    await db.delete(productionSchema.routing).where(eq(productionSchema.routing.tenantId, TENANT));
    await db.delete(productionSchema.workCentre).where(eq(productionSchema.workCentre.tenantId, TENANT));
    await db.delete(inventorySchema.offcut).where(eq(inventorySchema.offcut.tenantId, TENANT));
    await db.delete(inventorySchema.warehouse).where(eq(inventorySchema.warehouse.tenantId, TENANT));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.tenantId, TENANT));
    await db.delete(schema.eventOutbox).where(eq(schema.eventOutbox.tenantId, TENANT));
    await db.delete(schema.numberAllocation).where(eq(schema.numberAllocation.tenantId, TENANT));
    await db.delete(schema.numberSeries).where(eq(schema.numberSeries.tenantId, TENANT));
    await db.delete(schema.item).where(eq(schema.item.tenantId, TENANT));
    await db.delete(schema.tenantModule).where(eq(schema.tenantModule.tenantId, TENANT));
    await db.delete(schema.session).where(eq(schema.session.userId, USER));
    await db.delete(schema.membership).where(eq(schema.membership.tenantId, TENANT));
    await db.delete(schema.appUser).where(eq(schema.appUser.id, USER));
    await db.delete(schema.tenant).where(eq(schema.tenant.id, TENANT));
    await app.close();
    await closeDatabase();
  });

  /** Creates a work order with four door parts on the standard routing. */
  async function createOrder(over: Record<string, unknown> = {}) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/production/work-orders',
      headers: auth(),
      payload: {
        description: 'Wardrobe doors',
        quantity: 4,
        routingId,
        parts: [
          {
            label: 'Door front',
            materialItemId: mdfId,
            lengthMm: 1980,
            widthMm: 497,
            thicknessMm: 18,
            quantity: 4,
          },
        ],
        ...over,
      },
    });
    return response;
  }

  async function operationsOf(workOrderId: string) {
    return getDatabase()
      .select()
      .from(productionSchema.workOrderOperation)
      .where(eq(productionSchema.workOrderOperation.workOrderId, workOrderId))
      .orderBy(productionSchema.workOrderOperation.sequence);
  }

  const scan = (workOrderId: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/production/work-orders/${workOrderId}/scans`,
      headers: auth(),
      payload,
    });

  // -------------------------------------------------------------------------

  describe('work orders', () => {
    it('creates a work order, its parts and its operations', async () => {
      const response = await createOrder();
      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.number).toMatch(/^WO-\d{4}-\d{5}$/);
      expect(body.partsCreated).toBe(1);
      expect(body.operationsCreated).toBe(4);
      expect(body.plannedMinutes).toBeGreaterThan(0);
    });

    it('gives every part a scannable barcode derived from the order number', async () => {
      const created = (await createOrder()).json();
      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/production/work-orders/${created.workOrderId}`,
        headers: auth(),
      });

      const part = detail.json().parts[0];
      expect(part.barcode).toBe(`${created.number}-001`);
    });

    it('resolves the routing and each operation\'s work centre to names, not just ids', async () => {
      // `getWorkOrderProgress` used to return the bare `workOrder` row: a
      // detail screen built on it would have had a `routingId` and a
      // `workCentreId` to show, and nothing a person could read.
      const created = (await createOrder()).json();
      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/production/work-orders/${created.workOrderId}`,
        headers: auth(),
      });

      const body = detail.json();
      expect(body.routingCode).toBe('STD-DOOR');
      expect(body.routingName).toBe('Standard door');
      expect(body.operations[0].workCentreCode).toBe('SAW');
      expect(body.operations[0].workCentreName).toBe('Beam Saw');
      // No project on this order — must be null, not a crash from an inner join.
      expect(body.projectCode).toBeNull();
    });

    it('opens only the first operation, leaving the rest pending', async () => {
      const created = (await createOrder()).json();
      const operations = await operationsOf(created.workOrderId);

      expect(operations[0]!.status).toBe('ready');
      expect(operations.slice(1).every((o) => o.status === 'pending')).toBe(true);
    });

    it('snapshots rates onto the operation, so editing the routing later is safe', async () => {
      const created = (await createOrder()).json();
      const operations = await operationsOf(created.workOrderId);

      expect(Number(operations[0]!.setupMinutes)).toBe(15);
      expect(Number(operations[0]!.runMinutesPerUnit)).toBe(2);
    });

    it('refuses a work order with no routing to be released', async () => {
      const created = (await createOrder({ routingId: null })).json();
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/production/work-orders/${created.workOrderId}/release`,
        headers: auth(),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/no operations/i);
    });

    it('rejects a zero quantity', async () => {
      const response = await createOrder({ quantity: 0 });
      expect(response.statusCode).toBe(400);
    });

    it('404s an unknown work order', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/production/work-orders/00000000-0000-4000-8000-000000000000',
        headers: auth(),
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('scheduling', () => {
    it('estimates lead time including cure, not just machine time', async () => {
      const created = (await createOrder()).json();
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/production/work-orders/${created.workOrderId}/schedule`,
        headers: auth(),
      });

      const body = response.json();
      expect(body.schedule).toHaveLength(4);
      // The booth's 240-minute cure dominates: lead time must exceed the sum of
      // machine occupancy alone.
      expect(body.leadMinutes).toBeGreaterThan(240);
    });

    it('treats the spray booth as one batch load, not four', async () => {
      const created = (await createOrder()).json();
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/production/work-orders/${created.workOrderId}/schedule`,
        headers: auth(),
      });

      const spray = response.json().schedule.find((s: { sequence: number }) => s.sequence === 3);
      // 4 doors in a 40-capacity booth is ONE load: setup 20 + run 30 = 50,
      // not 20 + 4 x 30.
      expect(spray.loads).toBe(1);
      expect(spray.occupancyMinutes).toBe(50);
    });
  });

  describe('release', () => {
    it('releases and reports the material it needs, without touching stock', async () => {
      const created = (await createOrder()).json();
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/production/work-orders/${created.workOrderId}/release`,
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.materialRequired).toHaveLength(1);
      expect(body.materialRequired[0].itemId).toBe(mdfId);
      // 4 doors at 1980x497 = 3.936 m2.
      expect(body.materialRequired[0].quantity).toBeCloseTo(3.936, 2);
    });

    it('emits the release event for Inventory to act on', async () => {
      const events = await getDatabase()
        .select({ type: schema.eventOutbox.eventType })
        .from(schema.eventOutbox)
        .where(
          and(
            eq(schema.eventOutbox.tenantId, TENANT),
            eq(schema.eventOutbox.eventType, 'production.work_order.released'),
          ),
        );

      expect(events.length).toBeGreaterThan(0);
    });

    it('refuses to release the same order twice', async () => {
      const created = (await createOrder()).json();
      const url = `/api/v1/production/work-orders/${created.workOrderId}/release`;

      await app.inject({ method: 'POST', url, headers: auth() });
      const second = await app.inject({ method: 'POST', url, headers: auth() });

      expect(second.statusCode).toBe(409);
    });
  });

  describe('shop-floor scanning', () => {
    it('refuses a scan on a work order that has not been released', async () => {
      const created = (await createOrder()).json();
      const operations = await operationsOf(created.workOrderId);

      const response = await scan(created.workOrderId, {
        operationId: operations[0]!.id,
        type: 'start',
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/not been released/i);
    });

    it('drives a job through every station to completion', async () => {
      const created = (await createOrder()).json();
      await app.inject({
        method: 'POST',
        url: `/api/v1/production/work-orders/${created.workOrderId}/release`,
        headers: auth(),
      });

      const operations = await operationsOf(created.workOrderId);
      let last;

      for (const operation of operations) {
        await scan(created.workOrderId, { operationId: operation.id, type: 'start' });
        last = await scan(created.workOrderId, {
          operationId: operation.id,
          type: 'complete',
          quantity: 4,
        });
      }

      const body = last!.json();
      expect(body.workOrderCompleted).toBe(true);
      expect(body.workOrderPercentComplete).toBe(100);

      const [order] = await getDatabase()
        .select()
        .from(productionSchema.workOrder)
        .where(eq(productionSchema.workOrder.id, created.workOrderId));
      expect(order!.status).toBe('completed');
    });

    it('opens the next operation when one completes', async () => {
      const created = (await createOrder()).json();
      await app.inject({
        method: 'POST',
        url: `/api/v1/production/work-orders/${created.workOrderId}/release`,
        headers: auth(),
      });

      const operations = await operationsOf(created.workOrderId);
      await scan(created.workOrderId, { operationId: operations[0]!.id, type: 'start' });
      await scan(created.workOrderId, {
        operationId: operations[0]!.id,
        type: 'complete',
        quantity: 4,
      });

      const after = await operationsOf(created.workOrderId);
      expect(after[0]!.status).toBe('completed');
      expect(after[1]!.status).toBe('ready');
    });

    it('records real elapsed time from the scans', async () => {
      const created = (await createOrder()).json();
      await app.inject({
        method: 'POST',
        url: `/api/v1/production/work-orders/${created.workOrderId}/release`,
        headers: auth(),
      });

      const operations = await operationsOf(created.workOrderId);
      const base = Date.now() - 90 * 60_000;

      await scan(created.workOrderId, {
        operationId: operations[0]!.id,
        type: 'start',
        scannedAt: new Date(base).toISOString(),
      });
      await scan(created.workOrderId, {
        operationId: operations[0]!.id,
        type: 'complete',
        quantity: 4,
        scannedAt: new Date(base + 45 * 60_000).toISOString(),
      });

      const after = await operationsOf(created.workOrderId);
      expect(Number(after[0]!.actualMinutes)).toBeCloseTo(45, 0);
    });

    it('tracks rejects without crediting them to the target', async () => {
      const created = (await createOrder()).json();
      await app.inject({
        method: 'POST',
        url: `/api/v1/production/work-orders/${created.workOrderId}/release`,
        headers: auth(),
      });

      const operations = await operationsOf(created.workOrderId);
      await scan(created.workOrderId, { operationId: operations[0]!.id, type: 'start' });
      await scan(created.workOrderId, {
        operationId: operations[0]!.id,
        type: 'complete',
        quantity: 3,
      });
      const response = await scan(created.workOrderId, {
        operationId: operations[0]!.id,
        type: 'reject',
        quantity: 1,
        reasonCode: 'CHIP',
      });

      expect(response.json().operationState).toBe('in_progress');
      expect(response.json().completedQuantity).toBe(3);
    });

    it('emits a rejection event for Quality to pick up', async () => {
      const events = await getDatabase()
        .select({ type: schema.eventOutbox.eventType })
        .from(schema.eventOutbox)
        .where(
          and(
            eq(schema.eventOutbox.tenantId, TENANT),
            eq(schema.eventOutbox.eventType, 'production.part.rejected'),
          ),
        );

      expect(events.length).toBeGreaterThan(0);
    });

    it('refuses a scan for an operation on a different work order', async () => {
      const a = (await createOrder()).json();
      const b = (await createOrder()).json();
      await app.inject({
        method: 'POST',
        url: `/api/v1/production/work-orders/${a.workOrderId}/release`,
        headers: auth(),
      });

      const bOperations = await operationsOf(b.workOrderId);
      const response = await scan(a.workOrderId, {
        operationId: bOperations[0]!.id,
        type: 'start',
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/does not belong/i);
    });

    it('rejects an invalid scan type', async () => {
      const created = (await createOrder()).json();
      const operations = await operationsOf(created.workOrderId);
      const response = await scan(created.workOrderId, {
        operationId: operations[0]!.id,
        type: 'teleport',
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('shop-floor board', () => {
    it('groups the open queue by work centre', async () => {
      const created = (await createOrder()).json();
      await app.inject({
        method: 'POST',
        url: `/api/v1/production/work-orders/${created.workOrderId}/release`,
        headers: auth(),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/production/board',
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const centres = response.json().workCentres;
      const saw = centres.find((c: { code: string }) => c.code === 'SAW');
      expect(saw.queue.length).toBeGreaterThan(0);
    });
  });

  describe('cutlist — composing Production, Inventory and the engine', () => {
    it('plans the work order against new sheets', async () => {
      const created = (await createOrder()).json();
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/production/work-orders/${created.workOrderId}/cutlist`,
        headers: auth(),
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.version).toBe(1);
      expect(body.plan.summary.partsPlaced).toBe(4);
      expect(body.cuttingList).toHaveLength(4);
    });

    it('consumes and RESERVES an offcut, so a second plan cannot claim it', async () => {
      // Only possible because Inventory's tables are in the same transaction —
      // the payoff of the modular monolith over microservices.
      await getDatabase().insert(inventorySchema.offcut).values({
        tenantId: TENANT,
        itemId: mdfId,
        barcode: 'OC-PROD-001',
        lengthMm: '2100',
        widthMm: '600',
        thicknessMm: '18',
        warehouseId: factoryId,
        status: 'available',
        unitCost: '30',
      });

      const created = (await createOrder({
        parts: [
          {
            label: 'Door front',
            materialItemId: mdfId,
            lengthMm: 1980,
            widthMm: 497,
            thicknessMm: 18,
            quantity: 1,
          },
        ],
      })).json();

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/production/work-orders/${created.workOrderId}/cutlist`,
        headers: auth(),
        payload: {},
      });

      const body = response.json();
      expect(body.plan.summary.offcutsUsed).toBe(1);
      expect(body.offcutsReserved).toBe(1);

      const [reserved] = await getDatabase()
        .select()
        .from(inventorySchema.offcut)
        .where(
          and(
            eq(inventorySchema.offcut.tenantId, TENANT),
            eq(inventorySchema.offcut.barcode, 'OC-PROD-001'),
          ),
        );
      expect(reserved!.status).toBe('reserved');
    });

    it('persists the plan so the saw drawing is reproducible later', async () => {
      const created = (await createOrder()).json();
      await app.inject({
        method: 'POST',
        url: `/api/v1/production/work-orders/${created.workOrderId}/cutlist`,
        headers: auth(),
        payload: {},
      });

      const [saved] = await getDatabase()
        .select()
        .from(productionSchema.cuttingPlan)
        .where(eq(productionSchema.cuttingPlan.workOrderId, created.workOrderId));

      expect(saved!.version).toBe(1);
      expect(Number(saved!.grossYieldPercent)).toBeGreaterThan(0);
      expect(saved!.plan).toHaveProperty('boards');
    });

    it('versions a replanned cutting plan rather than overwriting it', async () => {
      const created = (await createOrder()).json();
      const url = `/api/v1/production/work-orders/${created.workOrderId}/cutlist`;

      await app.inject({ method: 'POST', url, headers: auth(), payload: {} });
      const second = await app.inject({ method: 'POST', url, headers: auth(), payload: {} });

      expect(second.json().version).toBe(2);
    });

    it('returns SVG drawings on request', async () => {
      const created = (await createOrder()).json();
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/production/work-orders/${created.workOrderId}/cutlist`,
        headers: auth(),
        payload: { includeDrawings: true },
      });

      expect(response.json().drawings[0]).toContain('<svg');
      expect(response.json().drawings[0]).toContain(created.number);
    });

    it('refuses to plan a work order with no parts', async () => {
      const created = (await createOrder({ parts: [] })).json();
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/production/work-orders/${created.workOrderId}/cutlist`,
        headers: auth(),
        payload: {},
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/no parts/i);
    });

    it('emits the plan event so Inventory can commit the remnants', async () => {
      const events = await getDatabase()
        .select({ type: schema.eventOutbox.eventType })
        .from(schema.eventOutbox)
        .where(
          and(
            eq(schema.eventOutbox.tenantId, TENANT),
            eq(schema.eventOutbox.eventType, 'production.cutting_plan.generated'),
          ),
        );

      expect(events.length).toBeGreaterThan(0);
    });
  });

  describe('module entitlement', () => {
    it('exposes Production in the navigation for an entitled tenant', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth() });
      const keys = response.json().navigation.map((n: { key: string }) => n.key);

      expect(keys).toContain('production');
      expect(response.json().modules.map((m: { key: string }) => m.key)).toContain('production');
    });

    it('404s Production for a tenant that has not bought it', async () => {
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

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/production/work-orders',
        headers: auth(),
      });
      expect(response.statusCode).toBe(404);

      await db
        .insert(schema.tenantModule)
        .values({ tenantId: TENANT, moduleKey: 'production', status: 'enabled' });
      invalidateTenantModules(TENANT);
    });
  });

  describe('the registers', () => {
    it('pages work orders by priority, which is the order they actually run in', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/production/work-orders',
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body.rows)).toBe(true);
      expect(body.sort).toBe('priority');
      expect(body.direction).toBe('asc');

      const priorities = body.rows.map((r: { priority: number }) => r.priority);
      expect([...priorities].sort((a, b) => a - b)).toEqual(priorities);
    });

    it('counts progress in pieces, not in cutting-list rows', async () => {
      // A list of two rows can be seventy-two pieces. Counting completed pieces
      // against ROWS renders "18 of 2", which is what shipped until it was
      // driven in a browser.
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/production/work-orders',
        headers: auth(),
      });

      const withParts = response
        .json()
        .rows.find((r: { partCount: number }) => r.partCount > 0);

      if (withParts) {
        expect(withParts.partsPlanned).toBeGreaterThanOrEqual(withParts.partCount);
        expect(withParts.partsCompleted).toBeLessThanOrEqual(withParts.partsPlanned);
        if (withParts.progressPercent != null) {
          expect(withParts.progressPercent).toBeCloseTo(
            (withParts.partsCompleted / withParts.partsPlanned) * 100,
            1,
          );
        }
      }
    });

    it('summarises a routing by the stations it passes through', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/production/routings',
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const row = response.json().rows[0];
      if (row) {
        expect(row.operationCount).toBeGreaterThan(0);
        // In sequence, because a routing is recognised by its path far more
        // readily than by its name.
        expect(typeof row.workCentres === 'string' || row.workCentres === null).toBe(true);
      }
    });

    it('reports the cure clock as minutes remaining, signed', async () => {
      // Negative means the load is ready and nobody has moved it — a booth
      // standing idle, which is the most expensive state on that screen.
      const db = getDatabase();
      const [centre] = await db
        .select({ id: productionSchema.workCentre.id })
        .from(productionSchema.workCentre)
        .where(eq(productionSchema.workCentre.tenantId, TENANT))
        .limit(1);

      const [batch] = await db
        .insert(productionSchema.finishingBatch)
        .values({
          tenantId: TENANT,
          number: 'FIN-REGISTER-TEST',
          workCentreId: centre!.id,
          status: 'curing',
          cureMinutes: 240,
          sprayedAt: new Date(Date.now() - 60 * 60_000),
          cureCompletesAt: new Date(Date.now() + 30 * 60_000),
        })
        .returning({ id: productionSchema.finishingBatch.id });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/production/finishing?q=FIN-REGISTER-TEST',
        headers: auth(),
      });

      const row = response.json().rows[0];
      expect(row.number).toBe('FIN-REGISTER-TEST');
      expect(row.cureMinutesRemaining).toBeGreaterThan(25);
      expect(row.cureMinutesRemaining).toBeLessThanOrEqual(30);

      await db
        .delete(productionSchema.finishingBatch)
        .where(eq(productionSchema.finishingBatch.id, batch!.id));
    });

    it('returns one plan with its boards drawn and its materials named', async () => {
      const created = (await createOrder()).json();
      const generated = (
        await app.inject({
          method: 'POST',
          url: `/api/v1/production/work-orders/${created.workOrderId}/cutlist`,
          headers: auth(),
          payload: {},
        })
      ).json();

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/production/cutting-plans/${generated.cuttingPlanId}`,
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.workOrderNumber).toBe(created.number);
      expect(body.version).toBe(generated.version);
      // The engine's own output, stored and returned untouched — re-deriving it
      // would produce a different nest, and then the drawing would not match
      // what was cut.
      expect(body.plan.boards.length).toBeGreaterThan(0);
      expect(body.plan.summary.partsPlaced).toBeGreaterThan(0);

      // Every board names a material id; the endpoint resolves them so the
      // screen never has to render a uuid at a saw operator.
      const materialIds = new Set(
        body.plan.boards.map((b: { materialId: string }) => b.materialId),
      );
      expect(body.materials.length).toBe(materialIds.size);
      for (const m of body.materials) expect(materialIds.has(m.id)).toBe(true);

      // One drawing per board, in the same order, so `drawings[i]` belongs to
      // `boards[i]` — the screen pairs them by index.
      expect(body.drawings).toHaveLength(body.plan.boards.length);
      expect(body.drawings[0]).toContain('<svg');
      expect(body.cuttingList).toHaveLength(body.plan.summary.partsPlaced);
    });

    it('omits the drawings on request, keeping everything else', async () => {
      const created = (await createOrder()).json();
      const generated = (
        await app.inject({
          method: 'POST',
          url: `/api/v1/production/work-orders/${created.workOrderId}/cutlist`,
          headers: auth(),
          payload: {},
        })
      ).json();

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/production/cutting-plans/${generated.cuttingPlanId}?drawings=false`,
        headers: auth(),
      });

      const body = response.json();
      expect(body.drawings).toBeUndefined();
      expect(body.plan.boards.length).toBeGreaterThan(0);
      expect(body.cuttingList.length).toBeGreaterThan(0);
    });

    it('404s for a plan id that does not exist', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/production/cutting-plans/00000000-0000-4000-8000-000000000000',
        headers: auth(),
      });

      expect(response.statusCode).toBe(404);
    });

    it('pages cutting plans and reports what came off the rack', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/production/cutting-plans',
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.sort).toBe('createdAt');
      for (const row of body.rows) {
        // Both yield figures travel together. Gross treats a large reusable
        // remnant as waste; net is the economically honest number, and one
        // without the other is misleading in opposite directions.
        expect(row).toHaveProperty('grossYieldPercent');
        expect(row).toHaveProperty('netYieldPercent');
        expect(row.offcutsConsumed).toBeGreaterThanOrEqual(0);
      }
    });
  });
});

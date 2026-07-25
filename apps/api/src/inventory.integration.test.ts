/**
 * Inventory end to end: real HTTP, real database, real RLS.
 *
 * Skipped when TEST_DATABASE_URL is unset.
 */
import { createHash } from 'node:crypto';

import { closeDatabase, createDatabase, getDatabase, schema } from '@aerolith/kernel';
import { inventorySchema } from '@aerolith/module-inventory';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { invalidateTenantModules, syncModules } from './bootstrap';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const TENANT = '66666666-6666-4666-8666-666666666666';
const NO_INVENTORY_TENANT = '77777777-7777-4777-8777-777777777777';
const USER = 'cccccccc-0000-4000-8000-000000000001';
const TOKEN = 'inventory-token-for-tests';
const OTHER_TOKEN = 'no-inventory-token';

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

suite('Inventory', () => {
  let app: FastifyInstance;
  let mdfItemId: string;
  let hardwareItemId: string;
  let factoryId: string;
  let siteId: string;

  const auth = (token = TOKEN, tenantId?: string) => ({
    authorization: `Bearer ${token}`,
    ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
  });

  beforeAll(async () => {
    createDatabase({ connectionString: url! });
    await syncModules();
    const db = getDatabase();

    await db.insert(schema.tenant).values([
      {
        id: TENANT,
        slug: 'inv-test',
        name: 'Inventory Test Joinery',
        status: 'active',
        primaryCountryCode: 'AE',
        baseCurrencyCode: 'AED',
      },
      {
        id: NO_INVENTORY_TENANT,
        slug: 'no-inv-test',
        name: 'No Inventory Co',
        status: 'active',
        primaryCountryCode: 'AE',
        baseCurrencyCode: 'AED',
      },
    ]);

    await db.insert(schema.appUser).values({ id: USER, email: 'store@inv.test', name: 'Storekeeper' });
    await db.insert(schema.membership).values([
      { tenantId: TENANT, userId: USER, status: 'active', isOwner: true },
      { tenantId: NO_INVENTORY_TENANT, userId: USER, status: 'active', isOwner: true },
    ]);

    const expiresAt = new Date(Date.now() + 3_600_000);
    await db.insert(schema.session).values([
      { userId: USER, tenantId: TENANT, tokenHash: hash(TOKEN), expiresAt },
      { userId: USER, tenantId: NO_INVENTORY_TENANT, tokenHash: hash(OTHER_TOKEN), expiresAt },
    ]);

    // Only the first tenant buys Inventory.
    await db
      .insert(schema.tenantModule)
      .values({ tenantId: TENANT, moduleKey: 'inventory', status: 'enabled' });
    invalidateTenantModules();

    // Master data lives in the kernel, shared by every module.
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

    const [hinge] = await db
      .insert(schema.item)
      .values({ tenantId: TENANT, code: 'HNG-01', name: 'Soft-close hinge', type: 'hardware' })
      .returning({ id: schema.item.id });
    hardwareItemId = hinge!.id;

    await db.insert(schema.numberSeries).values([
      {
        tenantId: TENANT,
        entityType: 'inventory.receipt',
        code: 'GRN',
        name: 'Goods Receipt',
        pattern: 'GRN-{YYYY}-{SEQ}',
      },
      {
        tenantId: TENANT,
        entityType: 'inventory.issue',
        code: 'ISS',
        name: 'Material Issue',
        pattern: 'ISS-{YYYY}-{SEQ}',
      },
      {
        tenantId: TENANT,
        entityType: 'inventory.transfer',
        code: 'STR',
        name: 'Stock Transfer',
        pattern: 'STR-{YYYY}-{SEQ}',
      },
      {
        tenantId: TENANT,
        entityType: 'inventory.adjustment',
        code: 'ADJ',
        name: 'Adjustment',
        pattern: 'ADJ-{YYYY}-{SEQ}',
      },
    ]);

    app = await buildApp();
    await app.ready();

    const factory = await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/warehouses',
      headers: auth(),
      payload: { code: 'FAC', name: 'Main Factory', type: 'factory' },
    });
    factoryId = factory.json().warehouse.id;

    const site = await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/warehouses',
      headers: auth(),
      payload: { code: 'SITE1', name: 'Marina Tower Site', type: 'site' },
    });
    siteId = site.json().warehouse.id;
  });

  afterAll(async () => {
    const db = getDatabase();
    const tenants = [TENANT, NO_INVENTORY_TENANT];
    await db.delete(inventorySchema.offcut).where(eq(inventorySchema.offcut.tenantId, TENANT));
    await db
      .delete(inventorySchema.stockMovementLine)
      .where(eq(inventorySchema.stockMovementLine.tenantId, TENANT));
    await db
      .delete(inventorySchema.stockMovement)
      .where(eq(inventorySchema.stockMovement.tenantId, TENANT));
    await db.delete(inventorySchema.stockLevel).where(eq(inventorySchema.stockLevel.tenantId, TENANT));
    await db.delete(inventorySchema.reorderRule).where(eq(inventorySchema.reorderRule.tenantId, TENANT));
    await db.delete(inventorySchema.storageBin).where(eq(inventorySchema.storageBin.tenantId, TENANT));
    await db.delete(inventorySchema.warehouse).where(eq(inventorySchema.warehouse.tenantId, TENANT));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.tenantId, TENANT));
    await db.delete(schema.eventOutbox).where(eq(schema.eventOutbox.tenantId, TENANT));
    await db.delete(schema.numberAllocation).where(eq(schema.numberAllocation.tenantId, TENANT));
    await db.delete(schema.numberSeries).where(eq(schema.numberSeries.tenantId, TENANT));
    await db.delete(schema.item).where(eq(schema.item.tenantId, TENANT));
    await db.delete(schema.tenantModule).where(inArray(schema.tenantModule.tenantId, tenants));
    await db.delete(schema.session).where(eq(schema.session.userId, USER));
    await db.delete(schema.membership).where(inArray(schema.membership.tenantId, tenants));
    await db.delete(schema.appUser).where(eq(schema.appUser.id, USER));
    await db.delete(schema.tenant).where(inArray(schema.tenant.id, tenants));
    await app.close();
    await closeDatabase();
  });

  const post = async (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/inventory/movements', headers: auth(), payload });

  // -------------------------------------------------------------------------

  describe('module entitlement', () => {
    it('serves the module to a tenant that has it', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/inventory/warehouses',
        headers: auth(),
      });
      expect(response.statusCode).toBe(200);
    });

    it('404s for a tenant that has not bought it — not 403', async () => {
      // The module does not exist to them; confirming it does would leak the
      // product catalogue and invite probing.
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/inventory/warehouses',
        headers: auth(OTHER_TOKEN, NO_INVENTORY_TENANT),
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('receipts and costing', () => {
    it('posts a receipt, allocates a number and sets the average cost', async () => {
      const response = await post({
        type: 'receipt',
        movementDate: '2026-03-01',
        lines: [
          { itemId: mdfItemId, quantity: 100, toWarehouseId: factoryId, unitCost: 85 },
        ],
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.number).toMatch(/^GRN-2026-\d{5}$/);
      expect(body.linesPosted).toBe(1);

      const stock = await app.inject({
        method: 'GET',
        url: `/api/v1/inventory/stock?itemId=${mdfItemId}`,
        headers: auth(),
      });

      expect(stock.json().quantity).toBe(100);
      expect(stock.json().value).toBe(8500);
    });

    it('averages a second receipt at a different price', async () => {
      // 100 @ 85 + 100 @ 95 → 200 @ 90
      await post({
        type: 'receipt',
        lines: [{ itemId: mdfItemId, quantity: 100, toWarehouseId: factoryId, unitCost: 95 }],
      });

      const stock = await app.inject({
        method: 'GET',
        url: `/api/v1/inventory/stock?itemId=${mdfItemId}`,
        headers: auth(),
      });

      expect(stock.json().quantity).toBe(200);
      expect(stock.json().value).toBe(18000);
    });

    it('refuses a receipt with no unit cost', async () => {
      const response = await post({
        type: 'receipt',
        lines: [{ itemId: hardwareItemId, quantity: 10, toWarehouseId: factoryId }],
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/unit cost/i);
    });
  });

  describe('issues', () => {
    it('issues at the current average and leaves it unchanged', async () => {
      const response = await post({
        type: 'issue',
        lines: [{ itemId: mdfItemId, quantity: 50, fromWarehouseId: factoryId }],
      });

      expect(response.statusCode).toBe(200);

      const stock = await app.inject({
        method: 'GET',
        url: `/api/v1/inventory/stock?itemId=${mdfItemId}`,
        headers: auth(),
      });

      // 150 remaining, still valued at 90.
      expect(stock.json().quantity).toBe(150);
      expect(stock.json().value).toBe(13500);
    });

    it('refuses to issue more than is on hand', async () => {
      const response = await post({
        type: 'issue',
        lines: [{ itemId: mdfItemId, quantity: 10000, fromWarehouseId: factoryId }],
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/only 150/i);
    });

    it('refuses to issue from a warehouse closed for issues', async () => {
      const db = getDatabase();
      await db
        .update(inventorySchema.warehouse)
        .set({ isIssueBlocked: true })
        .where(eq(inventorySchema.warehouse.id, siteId));

      const response = await post({
        type: 'issue',
        lines: [{ itemId: mdfItemId, quantity: 1, fromWarehouseId: siteId }],
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/closed for issues/i);

      await db
        .update(inventorySchema.warehouse)
        .set({ isIssueBlocked: false })
        .where(eq(inventorySchema.warehouse.id, siteId));
    });

    it('rejects a movement with no lines', async () => {
      const response = await post({ type: 'issue', lines: [] });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('transfers', () => {
    it('moves stock between warehouses, conserving quantity and cost', async () => {
      const response = await post({
        type: 'transfer',
        lines: [
          {
            itemId: mdfItemId,
            quantity: 40,
            fromWarehouseId: factoryId,
            toWarehouseId: siteId,
          },
        ],
      });

      expect(response.statusCode).toBe(200);

      const factory = await app.inject({
        method: 'GET',
        url: `/api/v1/inventory/stock?itemId=${mdfItemId}&warehouseId=${factoryId}`,
        headers: auth(),
      });
      const site = await app.inject({
        method: 'GET',
        url: `/api/v1/inventory/stock?itemId=${mdfItemId}&warehouseId=${siteId}`,
        headers: auth(),
      });

      expect(factory.json().quantity).toBe(110);
      expect(site.json().quantity).toBe(40);
      // The transfer carries the cost with it — a site store is not free stock.
      expect(site.json().value).toBe(3600);
    });

    it('rejects a transfer to the same place', async () => {
      const response = await post({
        type: 'transfer',
        lines: [
          {
            itemId: mdfItemId,
            quantity: 1,
            fromWarehouseId: factoryId,
            toWarehouseId: factoryId,
          },
        ],
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/same/i);
    });
  });

  describe('offcut register', () => {
    it('registers usable remnants when a sheet is cut, and drops slivers', async () => {
      const response = await post({
        type: 'issue',
        projectId: null,
        lines: [
          {
            itemId: mdfItemId,
            quantity: 1,
            fromWarehouseId: factoryId,
            parentSheet: { lengthMm: 2440, widthMm: 1220 },
            offcutsProduced: [
              { lengthMm: 1200, widthMm: 600, thicknessMm: 18, barcode: 'OC-TEST-001' },
              { lengthMm: 900, widthMm: 450, thicknessMm: 18, barcode: 'OC-TEST-002' },
              // Below the usability threshold — a sliver nobody will ever cut.
              { lengthMm: 2000, widthMm: 60, thicknessMm: 18, barcode: 'OC-TEST-003' },
            ],
          },
        ],
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().offcutsCreated).toBe(2);

      const offcuts = await app.inject({
        method: 'GET',
        url: `/api/v1/inventory/offcuts?itemId=${mdfItemId}`,
        headers: auth(),
      });

      const barcodes = offcuts.json().offcuts.map((o: { barcode: string }) => o.barcode);
      expect(barcodes).toContain('OC-TEST-001');
      expect(barcodes).toContain('OC-TEST-002');
      expect(barcodes).not.toContain('OC-TEST-003');
    });

    it('costs a remnant by its share of the parent sheet', async () => {
      const db = getDatabase();
      const [piece] = await db
        .select()
        .from(inventorySchema.offcut)
        .where(
          and(
            eq(inventorySchema.offcut.tenantId, TENANT),
            eq(inventorySchema.offcut.barcode, 'OC-TEST-001'),
          ),
        );

      // 1200x600 = 0.72m² of a 2.9768m² sheet costing 90 → about 21.77.
      expect(Number(piece!.unitCost)).toBeCloseTo(21.77, 1);
      expect(Number(piece!.areaSqm)).toBeCloseTo(0.72, 2);
    });

    it('matches a part to the smallest offcut that fits', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/inventory/offcuts/match',
        headers: auth(),
        payload: { itemId: mdfItemId, lengthMm: 800, widthMm: 400, thicknessMm: 18 },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.matched).toBe(true);
      // 900x450 fits and is smaller than 1200x600 — keep the big piece back.
      expect(body.offcut.barcode).toBe('OC-TEST-002');
      expect(body.orientation).toBe('as_is');
    });

    it('tells the caller to open a new sheet when nothing fits', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/inventory/offcuts/match',
        headers: auth(),
        payload: { itemId: mdfItemId, lengthMm: 2000, widthMm: 900 },
      });

      const body = response.json();
      expect(body.matched).toBe(false);
      expect(body.recommendation).toMatch(/new sheet/i);
    });

    it('reports the value sitting on the offcut rack', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/inventory/offcuts',
        headers: auth(),
      });

      const summary = response.json().summary;
      expect(summary.count).toBe(2);
      expect(summary.totalAreaSqm).toBeCloseTo(1.125, 2);
      expect(summary.totalValue).toBeGreaterThan(0);
    });

    it('retires an offcut when it is consumed', async () => {
      const db = getDatabase();
      const [piece] = await db
        .select()
        .from(inventorySchema.offcut)
        .where(
          and(
            eq(inventorySchema.offcut.tenantId, TENANT),
            eq(inventorySchema.offcut.barcode, 'OC-TEST-002'),
          ),
        );

      const response = await post({
        type: 'issue',
        lines: [
          {
            itemId: mdfItemId,
            quantity: 1,
            fromWarehouseId: factoryId,
            offcutId: piece!.id,
          },
        ],
      });

      expect(response.statusCode).toBe(200);

      const [after] = await db
        .select()
        .from(inventorySchema.offcut)
        .where(eq(inventorySchema.offcut.id, piece!.id));

      expect(after!.status).toBe('consumed');
      expect(after!.consumedByMovementId).not.toBeNull();
    });
  });

  describe('reorder levels', () => {
    it('reports a breach without requiring Procurement to exist', async () => {
      const db = getDatabase();
      await db.insert(inventorySchema.reorderRule).values({
        tenantId: TENANT,
        itemId: hardwareItemId,
        warehouseId: factoryId,
        minimumQuantity: '50',
        reorderQuantity: '200',
      });

      await post({
        type: 'receipt',
        lines: [{ itemId: hardwareItemId, quantity: 60, toWarehouseId: factoryId, unitCost: 4 }],
      });

      const response = await post({
        type: 'issue',
        lines: [{ itemId: hardwareItemId, quantity: 20, fromWarehouseId: factoryId }],
      });

      const triggered = response.json().reorderTriggered;
      expect(triggered).toHaveLength(1);
      expect(triggered[0].itemId).toBe(hardwareItemId);
      expect(triggered[0].available).toBe(40);
      expect(triggered[0].minimum).toBe(50);
    });

    it('emits the breach as an event for whoever is listening', async () => {
      const events = await getDatabase()
        .select({ type: schema.eventOutbox.eventType })
        .from(schema.eventOutbox)
        .where(
          and(
            eq(schema.eventOutbox.tenantId, TENANT),
            eq(schema.eventOutbox.eventType, 'inventory.stock_level.below_reorder'),
          ),
        );

      expect(events.length).toBeGreaterThan(0);
    });
  });

  describe('audit and events', () => {
    it('writes an outbox event for every posting, in the same transaction', async () => {
      const events = await getDatabase()
        .select({ type: schema.eventOutbox.eventType })
        .from(schema.eventOutbox)
        .where(
          and(
            eq(schema.eventOutbox.tenantId, TENANT),
            eq(schema.eventOutbox.eventType, 'inventory.stock_movement.posted'),
          ),
        );

      expect(events.length).toBeGreaterThanOrEqual(8);
    });

    it('records every posting in the audit trail', async () => {
      const entries = await getDatabase()
        .select()
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.tenantId, TENANT),
            eq(schema.auditLog.entityType, 'inventory.stock_movement'),
          ),
        );

      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e) => e.action === 'post')).toBe(true);
      expect(entries.every((e) => e.actorId === USER)).toBe(true);
    });

    it('numbers movements consecutively within their own series', async () => {
      const movements = await app.inject({
        method: 'GET',
        url: '/api/v1/inventory/movements?limit=100',
        headers: auth(),
      });

      const grns = movements
        .json()
        .movements.filter((m: { type: string }) => m.type === 'receipt')
        .map((m: { number: string }) => m.number)
        .sort();

      expect(grns[0]).toBe('GRN-2026-00001');
      expect(new Set(grns).size).toBe(grns.length);
    });
  });
});

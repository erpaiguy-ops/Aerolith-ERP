/**
 * Cutlist optimisation against the live offcut register — real HTTP, real database.
 *
 * The point of this suite is the loop that makes the register worth keeping:
 * cut a sheet → remnants land in the register → the next job's cutting list
 * consumes them instead of opening a new sheet.
 *
 * Skipped when TEST_DATABASE_URL is unset.
 */
import { createHash } from 'node:crypto';

import { closeDatabase, createDatabase, getDatabase, schema } from '@aerolith/kernel';
import { inventorySchema } from '@aerolith/module-inventory';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { invalidateTenantModules, syncModules } from './bootstrap';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const TENANT = '88888888-8888-4888-8888-888888888888';
const USER = 'dddddddd-0000-4000-8000-000000000001';
const TOKEN = 'cutlist-token-for-tests';

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

suite('Cutlist', () => {
  let app: FastifyInstance;
  let mdfId: string;
  let plainId: string;
  let factoryId: string;

  const auth = () => ({ authorization: `Bearer ${TOKEN}` });

  beforeAll(async () => {
    createDatabase({ connectionString: url! });
    await syncModules();
    const db = getDatabase();

    await db.insert(schema.tenant).values({
      id: TENANT,
      slug: 'cutlist-test',
      name: 'Cutlist Test Joinery',
      status: 'active',
      primaryCountryCode: 'AE',
      baseCurrencyCode: 'AED',
    });
    await db.insert(schema.appUser).values({ id: USER, email: 'cnc@cut.test', name: 'CNC Operator' });
    await db
      .insert(schema.membership)
      .values({ tenantId: TENANT, userId: USER, status: 'active', isOwner: true });
    await db.insert(schema.session).values({
      userId: USER,
      tenantId: TENANT,
      tokenHash: hash(TOKEN),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await db
      .insert(schema.tenantModule)
      .values({ tenantId: TENANT, moduleKey: 'inventory', status: 'enabled' });
    invalidateTenantModules();

    // A grained oak-faced board and a plain MDF, both 2440x1220.
    const [oak] = await db
      .insert(schema.item)
      .values({
        tenantId: TENANT,
        code: 'OAK-18',
        name: '18mm Oak Veneered MDF',
        type: 'panel',
        lengthMm: '2440',
        widthMm: '1220',
        thicknessMm: '18',
        hasGrainDirection: true,
        standardCost: '210',
      })
      .returning({ id: schema.item.id });
    mdfId = oak!.id;

    const [plain] = await db
      .insert(schema.item)
      .values({
        tenantId: TENANT,
        code: 'MDF-18',
        name: '18mm Plain MDF',
        type: 'panel',
        lengthMm: '2440',
        widthMm: '1220',
        thicknessMm: '18',
        hasGrainDirection: false,
        standardCost: '92',
      })
      .returning({ id: schema.item.id });
    plainId = plain!.id;

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
    await db.delete(inventorySchema.offcut).where(eq(inventorySchema.offcut.tenantId, TENANT));
    await db.delete(inventorySchema.warehouse).where(eq(inventorySchema.warehouse.tenantId, TENANT));
    await db.delete(schema.item).where(eq(schema.item.tenantId, TENANT));
    await db.delete(schema.tenantModule).where(eq(schema.tenantModule.tenantId, TENANT));
    await db.delete(schema.session).where(eq(schema.session.userId, USER));
    await db.delete(schema.membership).where(eq(schema.membership.tenantId, TENANT));
    await db.delete(schema.appUser).where(eq(schema.appUser.id, USER));
    await db.delete(schema.tenant).where(eq(schema.tenant.id, TENANT));
    await app.close();
    await closeDatabase();
  });

  const optimise = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/inventory/cutlist/optimise',
      headers: auth(),
      payload,
    });

  /** Puts a remnant on the rack. */
  async function addOffcut(
    itemId: string,
    lengthMm: number,
    widthMm: number,
    barcode: string,
    grainDirection: 'length' | 'width' | null = null,
  ) {
    await getDatabase().insert(inventorySchema.offcut).values({
      tenantId: TENANT,
      itemId,
      barcode,
      lengthMm: String(lengthMm),
      widthMm: String(widthMm),
      thicknessMm: '18',
      grainDirection,
      warehouseId: factoryId,
      status: 'available',
      unitCost: '25',
    });
  }

  // -------------------------------------------------------------------------

  describe('planning against sheets', () => {
    it('plans a cutting list and reports yield', async () => {
      const response = await optimise({
        parts: [
          { id: 'door', label: 'Door', itemId: plainId, lengthMm: 600, widthMm: 400, quantity: 8 },
        ],
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.plan.summary.partsPlaced).toBe(8);
      expect(body.plan.summary.boardsUsed).toBe(1);
      expect(body.plan.summary.totalYieldPercent).toBeGreaterThan(0);
      expect(body.plan.unplaced).toEqual([]);
    });

    it('returns a cutting list with a position for every part', async () => {
      const response = await optimise({
        parts: [{ id: 'p', itemId: plainId, lengthMm: 600, widthMm: 400, quantity: 4 }],
      });

      const list = response.json().cuttingList;
      expect(list).toHaveLength(4);
      for (const row of list) {
        expect(row.board).toBe(1);
        expect(typeof row.xMm).toBe('number');
        expect(typeof row.yMm).toBe('number');
      }
    });

    it('resolves the material code onto each board', async () => {
      const response = await optimise({
        parts: [{ id: 'p', itemId: plainId, lengthMm: 600, widthMm: 400, quantity: 2 }],
      });

      expect(response.json().plan.boards[0].materialCode).toBe('MDF-18');
    });

    it('costs the plan from the item master', async () => {
      const response = await optimise({
        parts: [{ id: 'p', itemId: plainId, lengthMm: 1200, widthMm: 600, quantity: 8 }],
      });

      const body = response.json();
      expect(body.plan.summary.materialCost).toBe(body.plan.summary.boardsUsed * 92);
    });

    it('returns SVG drawings when asked, and not otherwise', async () => {
      const withDrawings = await optimise({
        parts: [{ id: 'p', itemId: plainId, lengthMm: 600, widthMm: 400, quantity: 2 }],
        includeDrawings: true,
      });
      expect(withDrawings.json().drawings[0]).toContain('<svg');

      const without = await optimise({
        parts: [{ id: 'p', itemId: plainId, lengthMm: 600, widthMm: 400, quantity: 2 }],
      });
      expect(without.json().drawings).toBeUndefined();
    });

    it('reports edge banding metres per tape', async () => {
      const response = await optimise({
        parts: [
          {
            id: 'shelf',
            itemId: plainId,
            lengthMm: 800,
            widthMm: 400,
            quantity: 2,
            edgeBanding: { tapeId: 'TAPE-WHITE', length1: true, length2: true },
          },
        ],
      });

      expect(response.json().plan.edgeBanding).toEqual([{ tapeId: 'TAPE-WHITE', metres: 3.2 }]);
    });
  });

  describe('planning against the offcut register', () => {
    it('consumes a remnant instead of opening a new sheet', async () => {
      await addOffcut(plainId, 900, 500, 'OC-CUT-001');

      const response = await optimise({
        parts: [{ id: 'p', itemId: plainId, lengthMm: 800, widthMm: 400, quantity: 1 }],
      });

      const body = response.json();
      expect(body.plan.summary.offcutsUsed).toBe(1);
      expect(body.plan.summary.sheetsUsed).toBe(0);
      expect(body.savings.offcutsConsumed).toBe(1);
      expect(body.savings.sheetsAvoided).toBeGreaterThan(0);
    });

    it('takes the smallest remnant that fits, keeping the big ones back', async () => {
      await addOffcut(plainId, 2000, 1000, 'OC-CUT-BIG');
      await addOffcut(plainId, 850, 450, 'OC-CUT-SNUG');

      const response = await optimise({
        parts: [{ id: 'p', itemId: plainId, lengthMm: 800, widthMm: 400, quantity: 1 }],
      });

      const board = response.json().plan.boards[0];
      const chosen = await getDatabase()
        .select()
        .from(inventorySchema.offcut)
        .where(eq(inventorySchema.offcut.id, board.stockId));

      // 850x450 is a tighter fit than 900x500 and far tighter than 2000x1000.
      expect(chosen[0]!.barcode).toBe('OC-CUT-SNUG');
    });

    it('can be told to ignore the register and plan on new sheets', async () => {
      const response = await optimise({
        parts: [{ id: 'p', itemId: plainId, lengthMm: 800, widthMm: 400, quantity: 1 }],
        ignoreOffcuts: true,
      });

      const body = response.json();
      expect(body.plan.summary.offcutsUsed).toBe(0);
      expect(body.plan.summary.sheetsUsed).toBe(1);
      expect(body.savings.offcutsConsumed).toBe(0);
    });

    it('does not offer a remnant of a different material', async () => {
      // Offcuts on the rack are all plain MDF; the part is oak-faced.
      const response = await optimise({
        parts: [{ id: 'p', itemId: mdfId, lengthMm: 800, widthMm: 400, quantity: 1 }],
      });

      const body = response.json();
      expect(body.plan.summary.offcutsUsed).toBe(0);
      expect(body.plan.summary.sheetsUsed).toBe(1);
    });

    it('respects grain when choosing a remnant', async () => {
      // Both remnants fit dimensionally, but only one has the grain running
      // the way the part needs.
      await addOffcut(mdfId, 900, 500, 'OC-GRAIN-WRONG', 'width');
      await addOffcut(mdfId, 1000, 600, 'OC-GRAIN-RIGHT', 'length');

      const response = await optimise({
        parts: [
          {
            id: 'face',
            itemId: mdfId,
            lengthMm: 800,
            widthMm: 400,
            quantity: 1,
            grainAlong: 'length',
          },
        ],
      });

      const board = response.json().plan.boards[0];
      const chosen = await getDatabase()
        .select()
        .from(inventorySchema.offcut)
        .where(eq(inventorySchema.offcut.id, board.stockId));

      expect(chosen[0]!.barcode).toBe('OC-GRAIN-RIGHT');
    });
  });

  describe('validation', () => {
    it('rejects an unknown material', async () => {
      const response = await optimise({
        parts: [
          {
            id: 'p',
            itemId: '00000000-0000-4000-8000-000000000000',
            lengthMm: 600,
            widthMm: 400,
            quantity: 1,
          },
        ],
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/unknown material/i);
    });

    it('refuses to plan against a material with no sheet dimensions', async () => {
      // Guessing a sheet size would produce a confident, wrong plan.
      const db = getDatabase();
      const [noDims] = await db
        .insert(schema.item)
        .values({ tenantId: TENANT, code: 'NODIM', name: 'No dimensions', type: 'panel' })
        .returning({ id: schema.item.id });

      const response = await optimise({
        parts: [{ id: 'p', itemId: noDims!.id, lengthMm: 600, widthMm: 400, quantity: 1 }],
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/no sheet dimensions/i);

      await db.delete(schema.item).where(eq(schema.item.id, noDims!.id));
    });

    it('rejects an empty parts list', async () => {
      expect((await optimise({ parts: [] })).statusCode).toBe(400);
    });

    it('rejects a part larger than the sheet, naming why', async () => {
      const response = await optimise({
        parts: [{ id: 'huge', itemId: plainId, lengthMm: 5000, widthMm: 3000, quantity: 1 }],
      });

      const body = response.json();
      expect(body.plan.summary.partsPlaced).toBe(0);
      expect(body.plan.unplaced[0].reason).toMatch(/larger than any available board/i);
    });

    it('requires authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/inventory/cutlist/optimise',
        payload: { parts: [] },
      });
      expect(response.statusCode).toBe(401);
    });
  });
});

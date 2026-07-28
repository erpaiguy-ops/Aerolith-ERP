/**
 * Inventory routes.
 *
 * Registered unconditionally, but every handler checks the tenant's entitlement
 * first — a tenant that has not bought Inventory gets 404, not a working
 * endpoint. That check is the runtime half of requirement 19; the navigation
 * filter in /me is the visible half.
 */
import { parseListParams, withTenant } from '@aerolith/kernel';
import {
  COUNT_SORTS,
  ITEM_SORTS,
  InvalidMovementError,
  OFFCUT_SORTS,
  STOCK_SORTS,
  inventorySchema,
  listItems,
  listOffcuts,
  listStockCounts,
  listStockOnHand,
  postMovement,
  selectBestOffcut,
  stockOnHand,
  summariseOffcuts,
  toNumber,
  type Panel,
} from '@aerolith/module-inventory';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { modulesForTenant } from '../bootstrap';
import { authenticate, requirePermission, withPrincipal, type Principal } from '../context';

const MODULE = 'inventory';

/** 404 rather than 403: a module the tenant has not bought does not exist to them. */
async function requireModule(principal: Principal, reply: FastifyReply): Promise<boolean> {
  const modules = await modulesForTenant(principal.context.tenantId);
  if (!modules.enabled.has(MODULE)) {
    await reply.code(404).send({ error: 'Not found.' });
    return false;
  }
  return true;
}

const movementLine = z.object({
  itemId: z.string().uuid(),
  quantity: z.number().positive(),
  stockQuantity: z.number().positive().optional(),
  uomId: z.string().uuid().nullish(),
  batchId: z.string().uuid().nullish(),
  fromWarehouseId: z.string().uuid().nullish(),
  fromBinId: z.string().uuid().nullish(),
  toWarehouseId: z.string().uuid().nullish(),
  toBinId: z.string().uuid().nullish(),
  unitCost: z.number().nullish(),
  offcutId: z.string().uuid().nullish(),
  notes: z.string().nullish(),
  offcutsProduced: z
    .array(
      z.object({
        lengthMm: z.number().positive(),
        widthMm: z.number().positive(),
        thicknessMm: z.number().positive().nullish(),
        grainDirection: z.enum(['length', 'width']).nullish(),
        grainCode: z.string().nullish(),
        colourCode: z.string().nullish(),
        finishedEdges: z.number().int().min(0).max(4).optional(),
        barcode: z.string().optional(),
      }),
    )
    .optional(),
  parentSheet: z.object({ lengthMm: z.number().positive(), widthMm: z.number().positive() }).optional(),
});

const movementBody = z.object({
  type: z.enum(['receipt', 'issue', 'transfer', 'adjustment', 'return', 'scrap', 'production_output']),
  movementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  projectId: z.string().uuid().nullish(),
  partyId: z.string().uuid().nullish(),
  costCodeId: z.string().uuid().nullish(),
  sourceModule: z.string().nullish(),
  sourceEntityType: z.string().nullish(),
  sourceEntityId: z.string().uuid().nullish(),
  reference: z.string().nullish(),
  notes: z.string().nullish(),
  lines: z.array(movementLine).min(1),
});

const warehouseBody = z.object({
  code: z.string().min(1).max(16),
  name: z.string().min(1),
  type: z.enum(['factory', 'site', 'yard', 'transit', 'virtual']).optional(),
  projectId: z.string().uuid().nullish(),
  legalEntityId: z.string().uuid().nullish(),
});

const matchBody = z.object({
  itemId: z.string().uuid(),
  lengthMm: z.number().positive(),
  widthMm: z.number().positive(),
  thicknessMm: z.number().positive().optional(),
  grainAlong: z.enum(['length', 'width', 'any']).optional(),
  grainCode: z.string().optional(),
  colourCode: z.string().optional(),
  warehouseId: z.string().uuid().optional(),
  kerfMm: z.number().min(0).optional(),
});

interface ListQuery {
  page?: string;
  pageSize?: string;
  sort?: string;
  direction?: string;
  q?: string;
  status?: string;
  warehouseId?: string;
  itemId?: string;
}

export async function inventoryRoutes(app: FastifyInstance) {
  // --- Registers ----------------------------------------------------------
  //
  // The module's four navigation slots. All reads, all paged the same way, and
  // all behind `requireModule` for the same reason as everything else here.

  app.get<{ Querystring: ListQuery & { type?: string; stocked?: string; inactive?: string } }>(
    '/inventory/items',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'inventory.item.read');

      const params = parseListParams(request.query, {
        sortable: ITEM_SORTS,
        // A catalogue is read by code. Sorting by anything else makes a user
        // scan for the row they already know the number of.
        defaultSort: 'code',
        defaultDirection: 'asc',
      });

      return withPrincipal(principal, () =>
        withTenant((tx) =>
          listItems(tx, params, {
            type: request.query.type,
            stockedOnly: request.query.stocked === 'true',
            includeInactive: request.query.inactive === 'true',
          }),
        ),
      );
    },
  );

  app.get<{ Querystring: ListQuery }>('/inventory/offcuts', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'inventory.stock.read');

    const params = parseListParams(request.query, {
      sortable: OFFCUT_SORTS,
      // Biggest first: the largest remnant is the one worth using, and the one
      // most expensive to have forgotten about.
      defaultSort: 'areaSqm',
      defaultDirection: 'desc',
    });

    // The summary is returned alongside the page rather than as a second
    // endpoint: "what is on the rack worth" is the question the register exists
    // to answer, and it must not change as the user pages through it.
    return withPrincipal(principal, () =>
      withTenant(async (tx) => {
        const [page, summary] = await Promise.all([
          listOffcuts(tx, params, {
            status: request.query.status,
            warehouseId: request.query.warehouseId,
            itemId: request.query.itemId,
          }),
          summariseOffcuts(tx, {
            warehouseId: request.query.warehouseId,
            itemId: request.query.itemId,
          }),
        ]);
        return { ...page, summary };
      }),
    );
  });

  app.get<{ Querystring: ListQuery & { open?: string } }>(
    '/inventory/counts',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'inventory.stock.read');

      const params = parseListParams(request.query, {
        sortable: COUNT_SORTS,
        defaultSort: 'countDate',
        defaultDirection: 'desc',
      });

      return withPrincipal(principal, () =>
        withTenant((tx) =>
          listStockCounts(tx, params, {
            status: request.query.status,
            warehouseId: request.query.warehouseId,
            openOnly: request.query.open === 'true',
          }),
        ),
      );
    },
  );

  // --- Warehouses ---------------------------------------------------------

  app.get('/inventory/warehouses', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'inventory.stock.read');

    return withPrincipal(principal, () =>
      withTenant(async (tx) => {
        const warehouses = await tx
          .select()
          .from(inventorySchema.warehouse)
          .where(eq(inventorySchema.warehouse.tenantId, principal.context.tenantId))
          .orderBy(asc(inventorySchema.warehouse.code));
        return { warehouses };
      }),
    );
  });

  app.post('/inventory/warehouses', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'inventory.item.write');

    const parsed = warehouseBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    return withPrincipal(principal, () =>
      withTenant(async (tx) => {
        const [created] = await tx
          .insert(inventorySchema.warehouse)
          .values({ tenantId: principal.context.tenantId, ...parsed.data })
          .returning();
        return { warehouse: created };
      }),
    );
  });

  // --- Stock --------------------------------------------------------------

  /**
   * A single item's position, or the paged register.
   *
   * Two questions, deliberately one endpoint: `?itemId=` asks "how much of this
   * do we have", which is a figure, and the bare call asks "what is in stock",
   * which is a list. Splitting them would mean two names for one noun.
   */
  app.get<{
    Querystring: ListQuery & { holding?: string; belowReorder?: string };
  }>('/inventory/stock', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'inventory.stock.read');

    if (request.query.itemId && !request.query.page && !request.query.sort) {
      return withPrincipal(principal, () =>
        withTenant(async (tx) => {
          const position = await stockOnHand(tx, {
            tenantId: principal.context.tenantId,
            itemId: request.query.itemId!,
            warehouseId: request.query.warehouseId,
          });
          return { itemId: request.query.itemId, ...position };
        }),
      );
    }

    const params = parseListParams(request.query, {
      sortable: STOCK_SORTS,
      defaultSort: 'itemCode',
      defaultDirection: 'asc',
    });

    const holding =
      request.query.holding === 'in_stock' || request.query.holding === 'zero'
        ? request.query.holding
        : undefined;

    return withPrincipal(principal, () =>
      withTenant((tx) =>
        listStockOnHand(tx, params, {
          warehouseId: request.query.warehouseId,
          itemId: request.query.itemId,
          holding,
          belowReorderOnly: request.query.belowReorder === 'true',
        }),
      ),
    );
  });

  // --- Movements ----------------------------------------------------------

  app.post('/inventory/movements', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'inventory.stock_movement.create');

    const parsed = movementBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      return await withPrincipal(principal, () =>
        withTenant((tx) => postMovement(tx, parsed.data)),
      );
    } catch (error) {
      // Insufficient stock, a blocked warehouse or a malformed line are user
      // errors, not server faults.
      if (error instanceof InvalidMovementError || (error as Error).name === 'NegativeStockError') {
        return reply.code(409).send({ error: (error as Error).message });
      }
      throw error;
    }
  });

  app.get<{ Querystring: { limit?: string } }>(
    '/inventory/movements',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'inventory.stock.read');

      return withPrincipal(principal, () =>
        withTenant(async (tx) => {
          const movements = await tx
            .select()
            .from(inventorySchema.stockMovement)
            .where(eq(inventorySchema.stockMovement.tenantId, principal.context.tenantId))
            .orderBy(desc(inventorySchema.stockMovement.postedAt))
            .limit(Math.min(Number(request.query.limit ?? 50), 200));
          return { movements };
        }),
      );
    },
  );

  // --- Offcut register ----------------------------------------------------

  /**
   * Find the offcut to cut a part from.
   *
   * The endpoint the cutlist optimiser calls before deciding to open a new
   * sheet, and the one that turns the offcut rack from a pile of scrap into
   * recoverable material.
   */
  app.post('/inventory/offcuts/match', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'inventory.stock.read');

    const parsed = matchBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    const part = parsed.data;

    return withPrincipal(principal, () =>
      withTenant(async (tx) => {
        const rows = await tx
          .select()
          .from(inventorySchema.offcut)
          .where(
            and(
              eq(inventorySchema.offcut.tenantId, principal.context.tenantId),
              eq(inventorySchema.offcut.itemId, part.itemId),
              eq(inventorySchema.offcut.status, 'available'),
              part.warehouseId
                ? eq(inventorySchema.offcut.warehouseId, part.warehouseId)
                : undefined,
            ),
          )
          .limit(1000);

        const panels: Panel[] = rows.map((row) => ({
          id: row.id,
          lengthMm: toNumber(row.lengthMm),
          widthMm: toNumber(row.widthMm),
          thicknessMm: row.thicknessMm === null ? null : toNumber(row.thicknessMm),
          grainDirection: (row.grainDirection as 'length' | 'width' | null) ?? null,
          grainCode: row.grainCode,
          colourCode: row.colourCode,
        }));

        const best = selectBestOffcut(
          panels,
          {
            lengthMm: part.lengthMm,
            widthMm: part.widthMm,
            thicknessMm: part.thicknessMm,
            grainAlong: part.grainAlong,
            grainCode: part.grainCode,
            colourCode: part.colourCode,
          },
          part.kerfMm === undefined ? {} : { kerfMm: part.kerfMm },
        );

        if (!best) {
          return {
            matched: false,
            candidatesConsidered: panels.length,
            // Actionable: the caller should open a new sheet.
            recommendation: 'No usable offcut. Cut from a new sheet.',
          };
        }

        const row = rows.find((r) => r.id === best.panel.id)!;
        return {
          matched: true,
          candidatesConsidered: panels.length,
          offcut: {
            id: row.id,
            barcode: row.barcode,
            lengthMm: toNumber(row.lengthMm),
            widthMm: toNumber(row.widthMm),
            warehouseId: row.warehouseId,
            binId: row.binId,
            unitCost: toNumber(row.unitCost),
          },
          orientation: best.fit.orientation,
          wasteSqm: best.fit.wasteSqm,
        };
      }),
    );
  });
}

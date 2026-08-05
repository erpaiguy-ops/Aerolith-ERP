/**
 * Cutlist optimisation against live stock.
 *
 * This is the endpoint that makes the offcut register pay for itself: it plans a
 * cutting list against the remnants actually on the rack before it opens a new
 * sheet, and reports how much material that saved.
 *
 * It sits under /inventory because the stock it plans against is Inventory's.
 * When the Production module lands, the work-order-driven version will live
 * there and call the same `@aerolith/cutlist` engine — the engine is a shared
 * package precisely so both can use it without either module depending on the
 * other.
 */
import { schema, withTenant } from '@aerolith/kernel';
import {
  optimise,
  renderPlanSvgs,
  toCuttingList,
  type Part,
  type StockItem,
} from '@aerolith/cutlist';
import { inventorySchema, toNumber } from '@aerolith/module-inventory';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { modulesForTenant } from '../bootstrap';
import { authenticate, requirePermission, withPrincipal, type Principal } from '../context';

const MODULE = 'inventory';

async function requireModule(principal: Principal, reply: FastifyReply): Promise<boolean> {
  const modules = await modulesForTenant(principal.context.tenantId);
  if (!modules.enabled.has(MODULE)) {
    await reply.code(404).send({ error: 'Not found.' });
    return false;
  }
  return true;
}

const partSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  itemId: z.string().uuid(),
  lengthMm: z.number().positive(),
  widthMm: z.number().positive(),
  quantity: z.number().int().positive(),
  grainAlong: z.enum(['length', 'width', 'any']).optional(),
  grainCode: z.string().nullish(),
  colourCode: z.string().nullish(),
  edgeBanding: z
    .object({
      tapeId: z.string(),
      thicknessMm: z.number().positive().optional(),
      length1: z.boolean().optional(),
      length2: z.boolean().optional(),
      width1: z.boolean().optional(),
      width2: z.boolean().optional(),
    })
    .optional(),
});

const optimiseBody = z.object({
  parts: z.array(partSchema).min(1).max(2000),
  warehouseId: z.string().uuid().optional(),
  /** Plan against new sheets only, ignoring the register. */
  ignoreOffcuts: z.boolean().optional(),
  kerfMm: z.number().min(0).max(20).optional(),
  edgeTrimMm: z.number().min(0).max(100).optional(),
  /** Include the SVG cutting diagrams in the response. */
  includeDrawings: z.boolean().optional(),
});

export async function cutlistRoutes(app: FastifyInstance) {
  app.post('/inventory/cutlist/optimise', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'inventory.stock.read');

    const parsed = optimiseBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    const input = parsed.data;
    const tenantId = principal.context.tenantId;
    const itemIds = [...new Set(input.parts.map((p) => p.itemId))];

    return withPrincipal(principal, () =>
      withTenant(async (tx) => {
        // --- Full sheets, from the item master ---------------------------
        const items = await tx
          .select({
            id: schema.item.id,
            code: schema.item.code,
            name: schema.item.name,
            lengthMm: schema.item.lengthMm,
            widthMm: schema.item.widthMm,
            thicknessMm: schema.item.thicknessMm,
            hasGrainDirection: schema.item.hasGrainDirection,
            standardCost: schema.item.standardCost,
          })
          .from(schema.item)
          .where(and(eq(schema.item.tenantId, tenantId), inArray(schema.item.id, itemIds)));

        const missingDimensions = items.filter((i) => !i.lengthMm || !i.widthMm);
        if (missingDimensions.length > 0) {
          // Without sheet dimensions there is nothing to cut from, and a plan
          // built on a guessed sheet size is worse than no plan.
          return reply.code(409).send({
            error: 'Some materials have no sheet dimensions on the item master.',
            items: missingDimensions.map((i) => ({ id: i.id, code: i.code })),
          });
        }

        const unknownItems = itemIds.filter((id) => !items.some((i) => i.id === id));
        if (unknownItems.length > 0) {
          return reply.code(400).send({ error: 'Unknown material.', itemIds: unknownItems });
        }

        const sheets: StockItem[] = items.map((item) => ({
          id: `sheet:${item.id}`,
          source: 'sheet',
          materialId: item.id,
          lengthMm: toNumber(item.lengthMm),
          widthMm: toNumber(item.widthMm),
          thicknessMm: item.thicknessMm === null ? null : toNumber(item.thicknessMm),
          grainDirection: item.hasGrainDirection ? 'length' : null,
          cost: item.standardCost === null ? undefined : toNumber(item.standardCost),
        }));

        // --- Offcuts, from the live register -----------------------------
        const offcuts = input.ignoreOffcuts
          ? []
          : await tx
              .select()
              .from(inventorySchema.offcut)
              .where(
                and(
                  eq(inventorySchema.offcut.tenantId, tenantId),
                  eq(inventorySchema.offcut.status, 'available'),
                  inArray(inventorySchema.offcut.itemId, itemIds),
                  input.warehouseId
                    ? eq(inventorySchema.offcut.warehouseId, input.warehouseId)
                    : undefined,
                ),
              )
              .limit(1000);

        const stock: StockItem[] = [
          ...offcuts.map(
            (o): StockItem => ({
              id: o.id,
              source: 'offcut',
              materialId: o.itemId,
              lengthMm: toNumber(o.lengthMm),
              widthMm: toNumber(o.widthMm),
              thicknessMm: o.thicknessMm === null ? null : toNumber(o.thicknessMm),
              grainDirection: (o.grainDirection as 'length' | 'width' | null) ?? null,
              grainCode: o.grainCode,
              colourCode: o.colourCode,
              cost: o.unitCost === null ? undefined : toNumber(o.unitCost),
              available: 1,
            }),
          ),
          ...sheets,
        ];

        const parts: Part[] = input.parts.map((p) => ({
          id: p.id,
          label: p.label,
          materialId: p.itemId,
          lengthMm: p.lengthMm,
          widthMm: p.widthMm,
          quantity: p.quantity,
          grainAlong: p.grainAlong,
          grainCode: p.grainCode,
          colourCode: p.colourCode,
          edgeBanding: p.edgeBanding,
        }));

        const plan = optimise(parts, stock, {
          ...(input.kerfMm === undefined ? {} : { kerfMm: input.kerfMm }),
          ...(input.edgeTrimMm === undefined ? {} : { edgeTrimMm: input.edgeTrimMm }),
          preferOffcuts: !input.ignoreOffcuts,
        });

        // What the register actually saved on this job — the number that
        // justifies the discipline of keeping it.
        const sheetArea = sheets[0]
          ? (sheets[0].lengthMm * sheets[0].widthMm) / 1_000_000
          : 0;
        const offcutAreaUsed = plan.boards
          .filter((b) => b.source === 'offcut')
          .reduce((sum, b) => sum + (b.lengthMm * b.widthMm) / 1_000_000, 0);

        return {
          plan: {
            ...plan,
            // The engine works in material ids; the caller wants item codes.
            boards: plan.boards.map((board) => ({
              ...board,
              materialCode: items.find((i) => i.id === board.materialId)?.code ?? null,
            })),
          },
          cuttingList: toCuttingList(plan),
          savings: {
            offcutsConsumed: plan.summary.offcutsUsed,
            offcutAreaUsedSqm: Math.round(offcutAreaUsed * 10000) / 10000,
            sheetsAvoided:
              sheetArea === 0 ? 0 : Math.round((offcutAreaUsed / sheetArea) * 100) / 100,
          },
          drawings: input.includeDrawings ? renderPlanSvgs(plan) : undefined,
        };
      }),
    );
  });
}

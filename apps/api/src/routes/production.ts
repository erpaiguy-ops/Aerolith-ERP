/**
 * Production routes.
 *
 * The cutlist endpoint here is the architectural showcase: it composes
 * Production, Inventory and the cutlist engine in ONE transaction. Neither
 * module imports the other — the application layer, which may depend on both,
 * does the joining. That is the payoff of the modular monolith over
 * microservices: this would otherwise be a distributed saga.
 */
import { schema, withTenant } from '@aerolith/kernel';
import { optimise, renderPlanSvgs, toCuttingList, type Part, type StockItem } from '@aerolith/cutlist';
import { inventorySchema, toNumber } from '@aerolith/module-inventory';
import {
  WorkOrderError,
  createWorkOrder,
  estimateCompletion,
  getWorkOrderProgress,
  productionSchema,
  recordScan,
  releaseWorkOrder,
  saveCuttingPlan,
} from '@aerolith/module-production';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { modulesForTenant } from '../bootstrap';
import { authenticate, requirePermission, withPrincipal, type Principal } from '../context';

const MODULE = 'production';

async function requireModule(principal: Principal, reply: FastifyReply): Promise<boolean> {
  const modules = await modulesForTenant(principal.context.tenantId);
  if (!modules.enabled.has(MODULE)) {
    await reply.code(404).send({ error: 'Not found.' });
    return false;
  }
  return true;
}

const partSchema = z.object({
  label: z.string().min(1),
  materialItemId: z.string().uuid(),
  lengthMm: z.number().positive(),
  widthMm: z.number().positive(),
  thicknessMm: z.number().positive().nullish(),
  quantity: z.number().int().positive(),
  grainAlong: z.enum(['length', 'width', 'any']).nullish(),
  edgeBanding: z.record(z.unknown()).nullish(),
  finishSpec: z.record(z.unknown()).nullish(),
  notes: z.string().nullish(),
});

const createBody = z.object({
  description: z.string().min(1),
  quantity: z.number().positive().optional(),
  projectId: z.string().uuid().nullish(),
  itemId: z.string().uuid().nullish(),
  routingId: z.string().uuid().nullish(),
  priority: z.number().int().optional(),
  plannedStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  sourceModule: z.string().nullish(),
  sourceEntityType: z.string().nullish(),
  sourceEntityId: z.string().uuid().nullish(),
  notes: z.string().nullish(),
  parts: z.array(partSchema).optional(),
});

const scanBody = z.object({
  operationId: z.string().uuid(),
  partId: z.string().uuid().nullish(),
  type: z.enum(['start', 'complete', 'pause', 'resume', 'reject', 'rework']),
  quantity: z.number().int().positive().optional(),
  reasonCode: z.string().max(32).nullish(),
  notes: z.string().nullish(),
  isOffline: z.boolean().optional(),
  deviceId: z.string().max(64).nullish(),
  scannedAt: z.string().datetime().optional(),
});

const cutlistBody = z.object({
  warehouseId: z.string().uuid().optional(),
  ignoreOffcuts: z.boolean().optional(),
  kerfMm: z.number().min(0).max(20).optional(),
  edgeTrimMm: z.number().min(0).max(100).optional(),
  includeDrawings: z.boolean().optional(),
});

export async function productionRoutes(app: FastifyInstance) {
  // --- Work orders --------------------------------------------------------

  app.post('/production/work-orders', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'production.work_order.write');

    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      return await withPrincipal(principal, () =>
        withTenant((tx) => createWorkOrder(tx, parsed.data)),
      );
    } catch (error) {
      if (error instanceof WorkOrderError) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get<{ Querystring: { status?: string; limit?: string } }>(
    '/production/work-orders',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'production.work_order.read');

      return withPrincipal(principal, () =>
        withTenant(async (tx) => {
          const orders = await tx
            .select()
            .from(productionSchema.workOrder)
            .where(
              and(
                eq(productionSchema.workOrder.tenantId, principal.context.tenantId),
                request.query.status
                  ? eq(productionSchema.workOrder.status, request.query.status as never)
                  : undefined,
              ),
            )
            .orderBy(
              asc(productionSchema.workOrder.priority),
              desc(productionSchema.workOrder.createdAt),
            )
            .limit(Math.min(Number(request.query.limit ?? 50), 200));

          return { workOrders: orders };
        }),
      );
    },
  );

  app.get<{ Params: { id: string } }>('/production/work-orders/:id', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'production.work_order.read');

    try {
      return await withPrincipal(principal, () =>
        withTenant(async (tx) => {
          const detail = await getWorkOrderProgress(tx, request.params.id);
          const parts = await tx
            .select()
            .from(productionSchema.workOrderPart)
            .where(eq(productionSchema.workOrderPart.workOrderId, request.params.id))
            .orderBy(asc(productionSchema.workOrderPart.partNumber));

          return { ...detail, parts };
        }),
      );
    } catch (error) {
      if (error instanceof WorkOrderError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>(
    '/production/work-orders/:id/release',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'production.work_order.release');

      try {
        return await withPrincipal(principal, () =>
          withTenant((tx) => releaseWorkOrder(tx, { workOrderId: request.params.id })),
        );
      } catch (error) {
        if (error instanceof WorkOrderError) return reply.code(409).send({ error: error.message });
        throw error;
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/production/work-orders/:id/schedule',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'production.work_order.read');

      try {
        return await withPrincipal(principal, () =>
          withTenant(async (tx) => {
            const { scheduled } = await estimateCompletion(tx, {
              workOrderId: request.params.id,
            });
            return {
              schedule: scheduled,
              // Elapsed, not occupancy — this is what to tell a client.
              leadMinutes:
                scheduled.length === 0
                  ? 0
                  : Math.round(
                      (scheduled[scheduled.length - 1]!.readyAt.getTime() -
                        scheduled[0]!.startAt.getTime()) /
                        60_000,
                    ),
            };
          }),
        );
      } catch (error) {
        if (error instanceof WorkOrderError) return reply.code(404).send({ error: error.message });
        throw error;
      }
    },
  );

  // --- Shop floor ---------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/production/work-orders/:id/scans',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'production.scan.create');

      const parsed = scanBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
      }

      // Skipping an operation is a separate, dangerous permission — not a flag
      // anyone with a scanner can set.
      const canOverride =
        principal.isOwner || principal.context.permissions?.has('production.scan.override');

      try {
        return await withPrincipal(principal, () =>
          withTenant((tx) =>
            recordScan(
              tx,
              {
                workOrderId: request.params.id,
                ...parsed.data,
                scannedAt: parsed.data.scannedAt ? new Date(parsed.data.scannedAt) : undefined,
              },
              { enforceSequence: !canOverride },
            ),
          ),
        );
      } catch (error) {
        if (error instanceof WorkOrderError) return reply.code(409).send({ error: error.message });
        throw error;
      }
    },
  );

  /** The queue at each work centre — what the shop-floor board renders. */
  app.get('/production/board', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'production.work_order.read');

    return withPrincipal(principal, () =>
      withTenant(async (tx) => {
        const rows = await tx
          .select({
            operation: productionSchema.workOrderOperation,
            centre: productionSchema.workCentre,
            orderNumber: productionSchema.workOrder.number,
            orderDescription: productionSchema.workOrder.description,
            orderPriority: productionSchema.workOrder.priority,
            orderStatus: productionSchema.workOrder.status,
          })
          .from(productionSchema.workOrderOperation)
          .innerJoin(
            productionSchema.workCentre,
            eq(productionSchema.workCentre.id, productionSchema.workOrderOperation.workCentreId),
          )
          .innerJoin(
            productionSchema.workOrder,
            eq(productionSchema.workOrder.id, productionSchema.workOrderOperation.workOrderId),
          )
          .where(
            and(
              eq(productionSchema.workOrderOperation.tenantId, principal.context.tenantId),
              inArray(productionSchema.workOrderOperation.status, [
                'ready',
                'in_progress',
                'paused',
              ]),
            ),
          )
          .orderBy(
            asc(productionSchema.workOrder.priority),
            asc(productionSchema.workOrderOperation.sequence),
          );

        // Grouped by station, because that is how a foreman looks at it.
        const byCentre = new Map<string, { code: string; name: string; queue: unknown[] }>();
        for (const row of rows) {
          const entry = byCentre.get(row.centre.id) ?? {
            code: row.centre.code,
            name: row.centre.name,
            queue: [],
          };
          entry.queue.push({
            operationId: row.operation.id,
            workOrderNumber: row.orderNumber,
            description: row.orderDescription,
            sequence: row.operation.sequence,
            name: row.operation.name,
            status: row.operation.status,
            priority: row.orderPriority,
            plannedMinutes: row.operation.plannedMinutes,
            actualMinutes: row.operation.actualMinutes,
            completedQuantity: row.operation.completedQuantity,
          });
          byCentre.set(row.centre.id, entry);
        }

        return {
          workCentres: [...byCentre.entries()].map(([id, entry]) => ({ id, ...entry })),
        };
      }),
    );
  });

  // --- Cutlist: the cross-module composition ------------------------------

  /**
   * Generates and persists a cutting plan for a work order.
   *
   * Reads Production's parts, Inventory's offcut register and the kernel's item
   * master, runs the optimiser, and saves the plan — all in one transaction.
   * Neither module imports the other; this route joins them.
   */
  app.post<{ Params: { id: string } }>(
    '/production/work-orders/:id/cutlist',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'production.cutlist.generate');

      const parsed = cutlistBody.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
      }
      const options = parsed.data;

      const modules = await modulesForTenant(principal.context.tenantId);
      const hasInventory = modules.enabled.has('inventory');

      return withPrincipal(principal, () =>
        withTenant(async (tx) => {
          const [order] = await tx
            .select()
            .from(productionSchema.workOrder)
            .where(
              and(
                eq(productionSchema.workOrder.tenantId, principal.context.tenantId),
                eq(productionSchema.workOrder.id, request.params.id),
              ),
            )
            .limit(1);

          if (!order) return reply.code(404).send({ error: 'Work order not found.' });

          const parts = await tx
            .select()
            .from(productionSchema.workOrderPart)
            .where(eq(productionSchema.workOrderPart.workOrderId, order.id))
            .orderBy(asc(productionSchema.workOrderPart.partNumber));

          if (parts.length === 0) {
            return reply.code(409).send({ error: 'This work order has no parts to cut.' });
          }

          const itemIds = [...new Set(parts.map((p) => p.materialItemId))];
          const items = await tx
            .select()
            .from(schema.item)
            .where(
              and(
                eq(schema.item.tenantId, principal.context.tenantId),
                inArray(schema.item.id, itemIds),
              ),
            );

          const missing = items.filter((i) => !i.lengthMm || !i.widthMm);
          if (missing.length > 0 || items.length !== itemIds.length) {
            return reply.code(409).send({
              error: 'Some materials have no sheet dimensions on the item master.',
              items: missing.map((i) => ({ id: i.id, code: i.code })),
            });
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

          // Offcuts only if the tenant actually has Inventory. Without it the
          // plan simply cuts from new sheets — the module still works.
          const offcuts =
            hasInventory && !options.ignoreOffcuts
              ? await tx
                  .select()
                  .from(inventorySchema.offcut)
                  .where(
                    and(
                      eq(inventorySchema.offcut.tenantId, principal.context.tenantId),
                      eq(inventorySchema.offcut.status, 'available'),
                      inArray(inventorySchema.offcut.itemId, itemIds),
                      options.warehouseId
                        ? eq(inventorySchema.offcut.warehouseId, options.warehouseId)
                        : undefined,
                    ),
                  )
                  .limit(1000)
              : [];

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

          const cutlistParts: Part[] = parts.map((p) => ({
            id: p.id,
            label: p.label,
            materialId: p.materialItemId,
            lengthMm: toNumber(p.lengthMm),
            widthMm: toNumber(p.widthMm),
            thicknessMm: p.thicknessMm === null ? null : toNumber(p.thicknessMm),
            quantity: p.quantity,
            grainAlong: (p.grainAlong as 'length' | 'width' | 'any' | null) ?? undefined,
            edgeBanding: p.edgeBanding as never,
          }));

          const cutOptions = {
            ...(options.kerfMm === undefined ? {} : { kerfMm: options.kerfMm }),
            ...(options.edgeTrimMm === undefined ? {} : { edgeTrimMm: options.edgeTrimMm }),
            preferOffcuts: !options.ignoreOffcuts,
          };

          const plan = optimise(cutlistParts, stock, cutOptions);

          const consumedOffcutIds = plan.boards
            .filter((b) => b.source === 'offcut')
            .map((b) => b.stockId);

          // Reserve what the plan committed, so a second plan cannot claim the
          // same physical remnant. Only possible because Inventory's tables are
          // in the same transaction.
          if (consumedOffcutIds.length > 0) {
            await tx
              .update(inventorySchema.offcut)
              .set({
                status: 'reserved',
                reservedForProjectId: order.projectId,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(inventorySchema.offcut.tenantId, principal.context.tenantId),
                  inArray(inventorySchema.offcut.id, consumedOffcutIds),
                ),
              );
          }

          const saved = await saveCuttingPlan(tx, {
            workOrderId: order.id,
            plan: plan as unknown as Record<string, unknown>,
            options: cutOptions,
            sheetsUsed: plan.summary.sheetsUsed,
            offcutsUsed: plan.summary.offcutsUsed,
            grossYieldPercent: plan.summary.totalYieldPercent,
            netYieldPercent: plan.summary.netYieldPercent,
            materialCost: plan.summary.materialCost ?? null,
            consumedOffcutIds,
          });

          return {
            ...saved,
            plan,
            cuttingList: toCuttingList(plan),
            offcutsReserved: consumedOffcutIds.length,
            drawings: options.includeDrawings
              ? renderPlanSvgs(plan, { title: order.number ?? undefined })
              : undefined,
          };
        }),
      );
    },
  );
}

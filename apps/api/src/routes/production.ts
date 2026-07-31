/**
 * Production routes.
 *
 * The cutlist endpoint here is the architectural showcase: it composes
 * Production, Inventory and the cutlist engine in ONE transaction. Neither
 * module imports the other — the application layer, which may depend on both,
 * does the joining. That is the payoff of the modular monolith over
 * microservices: this would otherwise be a distributed saga.
 */
import { parseListParams, schema, withTenant } from '@aerolith/kernel';
import {
  optimise,
  renderPlanSvgs,
  toCuttingList,
  type CutlistPlan,
  type Part,
  type StockItem,
} from '@aerolith/cutlist';
import { inventorySchema, toNumber } from '@aerolith/module-inventory';
import {
  CUTTING_PLAN_SORTS,
  FINISHING_SORTS,
  ROUTING_SORTS,
  WORK_ORDER_SORTS,
  FinishingError,
  RoutingError,
  WorkOrderError,
  addRoutingOperation,
  createFinishingBatch,
  createRouting,
  createWorkCentre,
  createWorkOrder,
  cuttingPlanOffcutIds,
  estimateCompletion,
  getCuttingPlan,
  getRoutingDetail,
  getWorkOrderProgress,
  listCuttingPlans,
  listFinishingBatches,
  listRoutings,
  listWorkOrders,
  productionSchema,
  recordScan,
  releaseWorkOrder,
  removeRoutingOperation,
  saveCuttingPlan,
  updateFinishingBatchStatus,
  updateRouting,
  updateRoutingOperation,
  updateWorkCentre,
} from '@aerolith/module-production';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { modulesForTenant } from '../bootstrap';
import { authenticate, requirePermission, withPrincipal, type Principal } from '../context';

interface ListQuery {
  page?: string;
  pageSize?: string;
  sort?: string;
  direction?: string;
  q?: string;
  status?: string;
}

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

const WORK_CENTRE_TYPES = [
  'beam_saw',
  'cnc',
  'edgebander',
  'drilling',
  'sanding',
  'spray_booth',
  'assembly',
  'quality',
  'packing',
  'other',
] as const;

const createWorkCentreBody = z.object({
  code: z.string().min(1).max(16),
  name: z.string().min(1),
  type: z.enum(WORK_CENTRE_TYPES),
  assetId: z.string().uuid().nullish(),
  capacityUnits: z.number().int().positive().optional(),
  setupMinutes: z.number().min(0).optional(),
  runMinutesPerUnit: z.number().min(0).optional(),
  costPerHour: z.number().min(0).nullish(),
  workingMinutesPerDay: z.number().int().positive().optional(),
  isBatchProcess: z.boolean().optional(),
  batchCapacityUnits: z.number().int().positive().nullish(),
  isActive: z.boolean().optional(),
});

const updateWorkCentreBody = createWorkCentreBody.omit({ code: true }).partial();

const createRoutingBody = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1),
  itemId: z.string().uuid().nullish(),
  description: z.string().nullish(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

const updateRoutingBody = createRoutingBody.omit({ code: true }).partial();

const addOperationBody = z.object({
  sequence: z.number().int().positive(),
  name: z.string().min(1),
  workCentreId: z.string().uuid(),
  setupMinutes: z.number().min(0).nullish(),
  runMinutesPerUnit: z.number().min(0).nullish(),
  cureMinutes: z.number().int().min(0).optional(),
  isQualityGate: z.boolean().optional(),
  instructions: z.string().nullish(),
});

const updateOperationBody = addOperationBody.partial();

const createFinishingBatchBody = z.object({
  workCentreId: z.string().uuid(),
  colourCode: z.string().max(32).nullish(),
  sheenCode: z.string().max(32).nullish(),
  coatNumber: z.number().int().positive().optional(),
  totalCoats: z.number().int().positive().optional(),
  cureMinutes: z.number().int().min(0).optional(),
  notes: z.string().nullish(),
  parts: z
    .array(
      z.object({
        partId: z.string().uuid(),
        quantity: z.number().int().positive(),
        isRework: z.boolean().optional(),
      }),
    )
    .min(1),
});

const updateFinishingStatusBody = z.object({
  status: z.enum(['queued', 'spraying', 'curing', 'completed', 'rejected']),
  holdReason: z.string().nullish(),
  notes: z.string().nullish(),
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

  // --- Registers ----------------------------------------------------------

  app.get<{ Querystring: ListQuery & { projectId?: string; open?: string; late?: string } }>(
    '/production/work-orders',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'production.work_order.read');

      const params = parseListParams(request.query, {
        sortable: WORK_ORDER_SORTS,
        // By priority, which is what decides the order work actually runs in
        // when work centres are contended. Sorting a shop-floor list by number
        // shows the office's view, not the floor's.
        defaultSort: 'priority',
        defaultDirection: 'asc',
      });

      return withPrincipal(principal, () =>
        withTenant((tx) =>
          listWorkOrders(tx, params, {
            status: request.query.status,
            projectId: request.query.projectId,
            openOnly: request.query.open === 'true',
            lateOnly: request.query.late === 'true',
          }),
        ),
      );
    },
  );

  app.get<{ Querystring: ListQuery & { workOrderId?: string; committed?: string } }>(
    '/production/cutting-plans',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'production.work_order.read');

      const params = parseListParams(request.query, {
        sortable: CUTTING_PLAN_SORTS,
        defaultSort: 'createdAt',
        defaultDirection: 'desc',
      });

      const committed =
        request.query.committed === 'yes' || request.query.committed === 'no'
          ? request.query.committed
          : undefined;

      return withPrincipal(principal, () =>
        withTenant((tx) =>
          listCuttingPlans(tx, params, {
            workOrderId: request.query.workOrderId,
            committed,
          }),
        ),
      );
    },
  );

  /**
   * One cutting plan, rendered.
   *
   * The drawing is produced here rather than stored, because the plan JSON is
   * the record and the SVG is a view of it: a renderer improvement should reach
   * every plan ever made, not only the ones cut after it shipped. Rendering is
   * a pure function of stored data, so this stays deterministic.
   *
   * The composition is the same as when the plan was generated — Production
   * holds the plan, Inventory holds the offcuts it reserved, the engine draws
   * it, and this layer joins the three. A tenant without Inventory gets the
   * plan and the drawing, and no offcut section, because there was no rack to
   * cut from in the first place.
   */
  app.get<{ Params: { id: string }; Querystring: { drawings?: string } }>(
    '/production/cutting-plans/:id',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'production.work_order.read');

      const modules = await modulesForTenant(principal.context.tenantId);
      const hasInventory = modules.enabled.has('inventory');

      return withPrincipal(principal, () =>
        withTenant(async (tx) => {
          const detail = await getCuttingPlan(tx, request.params.id);
          if (!detail) return reply.code(404).send({ error: 'Cutting plan not found.' });

          const plan = detail.plan as unknown as CutlistPlan;

          if (hasInventory) {
            const ids = await cuttingPlanOffcutIds(tx, request.params.id);
            if (ids.length > 0) {
              const rows = await tx
                .select({
                  id: inventorySchema.offcut.id,
                  itemCode: schema.item.code,
                  lengthMm: inventorySchema.offcut.lengthMm,
                  widthMm: inventorySchema.offcut.widthMm,
                  status: inventorySchema.offcut.status,
                })
                .from(inventorySchema.offcut)
                .leftJoin(schema.item, eq(schema.item.id, inventorySchema.offcut.itemId))
                .where(
                  and(
                    eq(inventorySchema.offcut.tenantId, principal.context.tenantId),
                    inArray(inventorySchema.offcut.id, ids),
                  ),
                );
              detail.offcutsConsumed = rows;
            }
          }

          return {
            ...detail,
            cuttingList: toCuttingList(plan),
            // On by default — a plan nobody can see is the thing this endpoint
            // exists to fix. `?drawings=false` is for a caller that wants the
            // summary and the cutting list without the largest part of the
            // payload by a wide margin.
            drawings:
              request.query.drawings === 'false'
                ? undefined
                : renderPlanSvgs(plan, {
                    title: detail.workOrderNumber ?? detail.workOrderDescription,
                  }),
          };
        }),
      );
    },
  );

  app.get<{ Querystring: ListQuery & { workCentreId?: string; open?: string } }>(
    '/production/finishing',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'production.work_order.read');

      const params = parseListParams(request.query, {
        sortable: FINISHING_SORTS,
        // Soonest out of the booth first. A cured load nobody has moved is a
        // booth standing idle, and that is the most expensive thing on this
        // screen.
        defaultSort: 'cureCompletesAt',
        defaultDirection: 'asc',
      });

      return withPrincipal(principal, () =>
        withTenant((tx) =>
          listFinishingBatches(tx, params, {
            status: request.query.status,
            workCentreId: request.query.workCentreId,
            openOnly: request.query.open === 'true',
          }),
        ),
      );
    },
  );

  app.get<{ Querystring: ListQuery & { inactive?: string } }>(
    '/production/routings',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'production.work_order.read');

      const params = parseListParams(request.query, {
        sortable: ROUTING_SORTS,
        defaultSort: 'code',
        defaultDirection: 'asc',
      });

      return withPrincipal(principal, () =>
        withTenant((tx) =>
          listRoutings(tx, params, { includeInactive: request.query.inactive === 'true' }),
        ),
      );
    },
  );

  // --- Work centres --------------------------------------------------------
  //
  // Reference data used throughout the module (the board groups by it, a
  // routing's operations run at it), so reading the list is open to anyone
  // who can read production at all. Creating and editing a station is what
  // `production.routing.manage` — "Manage routings AND work centres" — is for.

  app.get('/production/work-centres', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'production.work_order.read');

    return withPrincipal(principal, () =>
      withTenant(async (tx) => {
        const rows = await tx
          .select()
          .from(productionSchema.workCentre)
          .where(eq(productionSchema.workCentre.tenantId, principal.context.tenantId))
          .orderBy(asc(productionSchema.workCentre.code));
        return { workCentres: rows };
      }),
    );
  });

  app.post('/production/work-centres', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'production.routing.manage');

    const parsed = createWorkCentreBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      return await withPrincipal(principal, () =>
        withTenant((tx) => createWorkCentre(tx, parsed.data)),
      );
    } catch (error) {
      if (error instanceof RoutingError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>('/production/work-centres/:id', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'production.routing.manage');

    const parsed = updateWorkCentreBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      await withPrincipal(principal, () =>
        withTenant((tx) => updateWorkCentre(tx, { workCentreId: request.params.id, ...parsed.data })),
      );
    } catch (error) {
      if (error instanceof RoutingError) {
        return reply.code(error.message === 'Work centre not found.' ? 404 : 409).send({
          error: error.message,
        });
      }
      throw error;
    }

    return { updated: true };
  });

  // --- Routings and their operations ---------------------------------------

  app.post('/production/routings', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'production.routing.manage');

    const parsed = createRoutingBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      return await withPrincipal(principal, () => withTenant((tx) => createRouting(tx, parsed.data)));
    } catch (error) {
      if (error instanceof RoutingError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  /** One routing, with its steps resolved to the work centres that run them. */
  app.get<{ Params: { id: string } }>('/production/routings/:id', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'production.work_order.read');

    const detail = await withPrincipal(principal, () =>
      withTenant((tx) => getRoutingDetail(tx, request.params.id)),
    );
    if (!detail) return reply.code(404).send({ error: 'Routing not found.' });
    return detail;
  });

  app.patch<{ Params: { id: string } }>('/production/routings/:id', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'production.routing.manage');

    const parsed = updateRoutingBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      await withPrincipal(principal, () =>
        withTenant((tx) => updateRouting(tx, { routingId: request.params.id, ...parsed.data })),
      );
    } catch (error) {
      if (error instanceof RoutingError) {
        return reply.code(error.message === 'Routing not found.' ? 404 : 409).send({
          error: error.message,
        });
      }
      throw error;
    }

    return { updated: true };
  });

  app.post<{ Params: { id: string } }>(
    '/production/routings/:id/operations',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'production.routing.manage');

      const parsed = addOperationBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
      }

      try {
        return await withPrincipal(principal, () =>
          withTenant((tx) =>
            addRoutingOperation(tx, { routingId: request.params.id, ...parsed.data }),
          ),
        );
      } catch (error) {
        if (error instanceof RoutingError) {
          return reply.code(error.message === 'Routing not found.' ? 404 : 409).send({
            error: error.message,
          });
        }
        throw error;
      }
    },
  );

  app.patch<{ Params: { id: string; operationId: string } }>(
    '/production/routings/:id/operations/:operationId',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'production.routing.manage');

      const parsed = updateOperationBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
      }

      try {
        await withPrincipal(principal, () =>
          withTenant((tx) =>
            updateRoutingOperation(tx, { operationId: request.params.operationId, ...parsed.data }),
          ),
        );
      } catch (error) {
        if (error instanceof RoutingError) {
          return reply.code(error.message === 'Routing operation not found.' ? 404 : 409).send({
            error: error.message,
          });
        }
        throw error;
      }

      return { updated: true };
    },
  );

  /**
   * Removes a step from a routing. `POST .../remove` rather than `DELETE`,
   * matching how master data's contact removal is exposed — the same
   * "removal is an action, not a REST noun" convention across this API.
   */
  app.post<{ Params: { id: string; operationId: string } }>(
    '/production/routings/:id/operations/:operationId/remove',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'production.routing.manage');

      try {
        await withPrincipal(principal, () =>
          withTenant((tx) => removeRoutingOperation(tx, { operationId: request.params.operationId })),
        );
      } catch (error) {
        if (error instanceof RoutingError) return reply.code(404).send({ error: error.message });
        throw error;
      }

      return { removed: true };
    },
  );

  // --- Finishing -------------------------------------------------------------

  app.post('/production/finishing', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'production.finishing.manage');

    const parsed = createFinishingBatchBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      return await withPrincipal(principal, () =>
        withTenant((tx) => createFinishingBatch(tx, parsed.data)),
      );
    } catch (error) {
      if (error instanceof FinishingError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>(
    '/production/finishing/:id/status',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'production.finishing.manage');

      const parsed = updateFinishingStatusBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
      }

      try {
        return await withPrincipal(principal, () =>
          withTenant((tx) =>
            updateFinishingBatchStatus(tx, { batchId: request.params.id, ...parsed.data }),
          ),
        );
      } catch (error) {
        if (error instanceof FinishingError) {
          return reply.code(error.message === 'Finishing batch not found.' ? 404 : 409).send({
            error: error.message,
          });
        }
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

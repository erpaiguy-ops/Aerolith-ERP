/**
 * The read side of Production — the registers its navigation promises, minus
 * the board, which already has an endpoint shaped for the screen.
 *
 * Reads only, apart from `workOrders.ts`, which is where releasing, scheduling
 * and scanning live. Scans are append-only and a release commits material; a
 * file that mixes those with list queries makes it harder to see which is which.
 */
import {
  listResult,
  requireTenantContext,
  schema,
  searchPattern,
  type ListParams,
  type ListResult,
  type Transaction,
} from '@aerolith/kernel';
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';

import {
  cuttingPlan,
  finishingBatch,
  finishingBatchPart,
  routing,
  routingOperation,
  workCentre,
  workOrder,
  workOrderOperation,
  workOrderPart,
} from '../db/schema';

// ---------------------------------------------------------------------------
// Work orders
// ---------------------------------------------------------------------------

export interface WorkOrderListRow {
  id: string;
  number: string | null;
  description: string;
  status: string;
  priority: number;
  projectCode: string | null;
  projectName: string | null;
  routingCode: string | null;
  quantity: string;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  releasedAt: string | null;
  holdReason: string | null;
  /** Rows on the cutting list. */
  partCount: number;
  /** PIECES to make. A cutting list of 12 rows can be 300 pieces. */
  partsPlanned: number;
  /** Pieces finished, from scans at the final operation — never from a timesheet. */
  partsCompleted: number;
  partsRejected: number;
  operationsDone: number;
  operationCount: number;
  /** Null until something has been planned. */
  progressPercent: number | null;
  /** True once the planned end date has passed and the order is not complete. */
  isLate: boolean;
}

export const WORK_ORDER_SORTS = [
  'priority',
  'number',
  'status',
  'plannedEndDate',
  'createdAt',
] as const;

export async function listWorkOrders(
  tx: Transaction,
  params: ListParams,
  filters: { status?: string; projectId?: string; openOnly?: boolean; lateOnly?: boolean } = {},
): Promise<ListResult<WorkOrderListRow>> {
  const { tenantId } = requireTenantContext();

  const openStatuses = ['draft', 'planned', 'released', 'in_progress', 'on_hold'] as const;

  const isLate = sql<boolean>`(
    ${workOrder.plannedEndDate} is not null
    and ${workOrder.plannedEndDate} < current_date
    and ${workOrder.status} in ('draft', 'planned', 'released', 'in_progress', 'on_hold')
  )`;

  const parts = tx
    .select({
      workOrderId: workOrderPart.workOrderId,
      // Distinct part ROWS and the summed quantities are different questions —
      // "how many line items" and "how many pieces" — and a cutting list of 12
      // rows can be 300 pieces.
      partCount: sql<number>`count(*)::int`.as('part_count'),
      completed: sql<number>`coalesce(sum(${workOrderPart.completedQuantity}), 0)::int`.as(
        'parts_completed',
      ),
      rejected: sql<number>`coalesce(sum(${workOrderPart.rejectedQuantity}), 0)::int`.as(
        'parts_rejected',
      ),
      planned: sql<number>`coalesce(sum(${workOrderPart.quantity}), 0)::int`.as('parts_planned'),
    })
    .from(workOrderPart)
    .where(eq(workOrderPart.tenantId, tenantId))
    .groupBy(workOrderPart.workOrderId)
    .as('wo_parts');

  const operations = tx
    .select({
      workOrderId: workOrderOperation.workOrderId,
      total: sql<number>`count(*)::int`.as('operation_count'),
      done: sql<number>`count(*) filter (where ${workOrderOperation.status} = 'completed')::int`.as(
        'operations_done',
      ),
    })
    .from(workOrderOperation)
    .where(eq(workOrderOperation.tenantId, tenantId))
    .groupBy(workOrderOperation.workOrderId)
    .as('wo_operations');

  const conditions = [eq(workOrder.tenantId, tenantId)];
  if (filters.status) conditions.push(eq(workOrder.status, filters.status as never));
  if (filters.projectId) conditions.push(eq(workOrder.projectId, filters.projectId));
  if (filters.openOnly) conditions.push(inArray(workOrder.status, [...openStatuses]));
  if (filters.lateOnly) conditions.push(isLate);

  if (params.search) {
    const pattern = searchPattern(params.search);
    conditions.push(
      or(ilike(workOrder.number, pattern), ilike(workOrder.description, pattern))!,
    );
  }

  const where = and(...conditions);

  const sortColumn =
    {
      priority: workOrder.priority,
      number: workOrder.number,
      status: workOrder.status,
      plannedEndDate: workOrder.plannedEndDate,
      createdAt: workOrder.createdAt,
    }[params.sort as string] ?? workOrder.priority;

  const rows = await tx
    .select({
      id: workOrder.id,
      number: workOrder.number,
      description: workOrder.description,
      status: workOrder.status,
      priority: workOrder.priority,
      projectCode: schema.project.code,
      projectName: schema.project.name,
      routingCode: routing.code,
      quantity: workOrder.quantity,
      plannedStartDate: workOrder.plannedStartDate,
      plannedEndDate: workOrder.plannedEndDate,
      releasedAt: sql<string | null>`${workOrder.releasedAt}`,
      holdReason: workOrder.holdReason,
      partCount: sql<number>`coalesce(${parts.partCount}, 0)`,
      partsPlanned: sql<number>`coalesce(${parts.planned}, 0)`,
      partsCompleted: sql<number>`coalesce(${parts.completed}, 0)`,
      partsRejected: sql<number>`coalesce(${parts.rejected}, 0)`,
      operationsDone: sql<number>`coalesce(${operations.done}, 0)`,
      operationCount: sql<number>`coalesce(${operations.total}, 0)`,
      // Measured in PIECES, not in operations closed. An order whose last
      // operation is open is not 80% done because four of five stations have
      // signed off — the parts are what the customer receives.
      progressPercent: sql<number | null>`
        case
          when coalesce(${parts.planned}, 0) = 0 then null
          else round((coalesce(${parts.completed}, 0)::numeric / ${parts.planned}) * 100, 1)::float8
        end
      `,
      isLate,
    })
    .from(workOrder)
    .leftJoin(
      schema.project,
      and(eq(schema.project.id, workOrder.projectId), eq(schema.project.tenantId, tenantId)),
    )
    .leftJoin(routing, and(eq(routing.id, workOrder.routingId), eq(routing.tenantId, tenantId)))
    .leftJoin(parts, eq(parts.workOrderId, workOrder.id))
    .leftJoin(operations, eq(operations.workOrderId, workOrder.id))
    .where(where)
    .orderBy(params.direction === 'asc' ? asc(sortColumn) : desc(sortColumn), asc(workOrder.id))
    .limit(params.pageSize)
    .offset(params.offset);

  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(workOrder)
    .where(where);

  return listResult(rows, counted?.total ?? 0, params);
}

// ---------------------------------------------------------------------------
// Cutting plans
// ---------------------------------------------------------------------------

export interface CuttingPlanListRow {
  id: string;
  workOrderId: string;
  workOrderNumber: string | null;
  workOrderDescription: string;
  version: number;
  sheetsUsed: number;
  offcutsUsed: number;
  grossYieldPercent: string | null;
  netYieldPercent: string | null;
  materialCost: string | null;
  isCommitted: boolean;
  committedAt: string | null;
  createdAt: string;
  /** How many offcuts the plan actually consumed off the rack. */
  offcutsConsumed: number;
}

export const CUTTING_PLAN_SORTS = [
  'createdAt',
  'netYieldPercent',
  'sheetsUsed',
  'workOrderNumber',
] as const;

export async function listCuttingPlans(
  tx: Transaction,
  params: ListParams,
  filters: { workOrderId?: string; committed?: 'yes' | 'no' } = {},
): Promise<ListResult<CuttingPlanListRow>> {
  const { tenantId } = requireTenantContext();

  const conditions = [eq(cuttingPlan.tenantId, tenantId)];
  if (filters.workOrderId) conditions.push(eq(cuttingPlan.workOrderId, filters.workOrderId));
  if (filters.committed === 'yes') conditions.push(eq(cuttingPlan.isCommitted, true));
  if (filters.committed === 'no') conditions.push(eq(cuttingPlan.isCommitted, false));

  if (params.search) {
    const pattern = searchPattern(params.search);
    conditions.push(
      or(ilike(workOrder.number, pattern), ilike(workOrder.description, pattern))!,
    );
  }

  const where = and(...conditions);

  const sortColumn =
    {
      createdAt: cuttingPlan.createdAt,
      netYieldPercent: cuttingPlan.netYieldPercent,
      sheetsUsed: cuttingPlan.sheetsUsed,
      workOrderNumber: workOrder.number,
    }[params.sort as string] ?? cuttingPlan.createdAt;

  const rows = await tx
    .select({
      id: cuttingPlan.id,
      workOrderId: cuttingPlan.workOrderId,
      workOrderNumber: workOrder.number,
      workOrderDescription: workOrder.description,
      version: cuttingPlan.version,
      sheetsUsed: cuttingPlan.sheetsUsed,
      offcutsUsed: cuttingPlan.offcutsUsed,
      grossYieldPercent: cuttingPlan.grossYieldPercent,
      netYieldPercent: cuttingPlan.netYieldPercent,
      materialCost: cuttingPlan.materialCost,
      isCommitted: cuttingPlan.isCommitted,
      committedAt: sql<string | null>`${cuttingPlan.committedAt}`,
      createdAt: sql<string>`${cuttingPlan.createdAt}`,
      offcutsConsumed: sql<number>`coalesce(array_length(${cuttingPlan.consumedOffcutIds}, 1), 0)`,
    })
    .from(cuttingPlan)
    .innerJoin(
      workOrder,
      and(eq(workOrder.id, cuttingPlan.workOrderId), eq(workOrder.tenantId, tenantId)),
    )
    .where(where)
    .orderBy(params.direction === 'asc' ? asc(sortColumn) : desc(sortColumn), asc(cuttingPlan.id))
    .limit(params.pageSize)
    .offset(params.offset);

  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(cuttingPlan)
    .innerJoin(
      workOrder,
      and(eq(workOrder.id, cuttingPlan.workOrderId), eq(workOrder.tenantId, tenantId)),
    )
    .where(where);

  return listResult(rows, counted?.total ?? 0, params);
}

/**
 * One cutting plan, with everything the drawing needs named.
 *
 * The plan JSON is returned exactly as the engine produced it — boards,
 * placements, remnants, summary — because it is the record of what was
 * optimised and re-deriving it would produce a different nest. What this adds is
 * the identity around it: the item codes behind each board's `materialId`, and
 * the state of the offcuts the plan reserved.
 *
 * Rendering is not done here. The drawing comes from `@aerolith/cutlist`, and
 * the API layer composes the two the same way it does when the plan is
 * generated — a module that imported the engine would be a module that could not
 * be sold without it.
 */
export interface CuttingPlanDetail {
  id: string;
  workOrderId: string;
  workOrderNumber: string | null;
  workOrderDescription: string;
  workOrderStatus: string;
  projectCode: string | null;
  projectName: string | null;
  version: number;
  sheetsUsed: number;
  offcutsUsed: number;
  grossYieldPercent: string | null;
  netYieldPercent: string | null;
  materialCost: string | null;
  isCommitted: boolean;
  committedAt: string | null;
  createdAt: string;
  generatedByName: string | null;
  /** The options it was produced under, so the nest can be reproduced exactly. */
  options: Record<string, unknown>;
  /** The engine's own output, untouched. */
  plan: Record<string, unknown>;
  /** `materialId` → the item it names, for every board on the plan. */
  materials: { id: string; code: string; name: string; thicknessMm: string | null }[];
  /**
   * The offcuts this plan took off the rack, with their CURRENT status — which
   * is how you find out that a plan generated last week has had its remnants
   * consumed by a different job in the meantime.
   */
  offcutsConsumed: {
    id: string;
    itemCode: string | null;
    lengthMm: string;
    widthMm: string;
    status: string;
  }[];
}

export async function getCuttingPlan(
  tx: Transaction,
  planId: string,
): Promise<CuttingPlanDetail | null> {
  const { tenantId } = requireTenantContext();

  const [row] = await tx
    .select({
      id: cuttingPlan.id,
      workOrderId: cuttingPlan.workOrderId,
      workOrderNumber: workOrder.number,
      workOrderDescription: workOrder.description,
      workOrderStatus: workOrder.status,
      projectCode: schema.project.code,
      projectName: schema.project.name,
      version: cuttingPlan.version,
      sheetsUsed: cuttingPlan.sheetsUsed,
      offcutsUsed: cuttingPlan.offcutsUsed,
      grossYieldPercent: cuttingPlan.grossYieldPercent,
      netYieldPercent: cuttingPlan.netYieldPercent,
      materialCost: cuttingPlan.materialCost,
      isCommitted: cuttingPlan.isCommitted,
      committedAt: sql<string | null>`${cuttingPlan.committedAt}`,
      createdAt: sql<string>`${cuttingPlan.createdAt}`,
      generatedByName: schema.appUser.name,
      options: cuttingPlan.options,
      plan: cuttingPlan.plan,
      consumedOffcutIds: cuttingPlan.consumedOffcutIds,
    })
    .from(cuttingPlan)
    .innerJoin(
      workOrder,
      and(eq(workOrder.id, cuttingPlan.workOrderId), eq(workOrder.tenantId, tenantId)),
    )
    .leftJoin(
      schema.project,
      and(eq(schema.project.id, workOrder.projectId), eq(schema.project.tenantId, tenantId)),
    )
    .leftJoin(schema.appUser, eq(schema.appUser.id, cuttingPlan.generatedBy))
    .where(and(eq(cuttingPlan.tenantId, tenantId), eq(cuttingPlan.id, planId)))
    .limit(1);

  if (!row) return null;

  // Every board names a `materialId`. Read them out of the plan rather than off
  // the work order's parts: a plan is a historical record and the parts list may
  // have changed since, which would leave a board labelled with a material it
  // was never cut from.
  const boards = Array.isArray((row.plan as { boards?: unknown }).boards)
    ? ((row.plan as { boards: { materialId?: string }[] }).boards ?? [])
    : [];
  const materialIds = [...new Set(boards.map((b) => b.materialId).filter(Boolean))] as string[];

  const materials = materialIds.length
    ? await tx
        .select({
          id: schema.item.id,
          code: schema.item.code,
          name: schema.item.name,
          thicknessMm: schema.item.thicknessMm,
        })
        .from(schema.item)
        .where(and(eq(schema.item.tenantId, tenantId), inArray(schema.item.id, materialIds)))
    : [];

  // The offcut register belongs to Inventory, whose tables this module must not
  // read. The ids are recorded on the plan and the API resolves them when the
  // tenant has Inventory — without it the plan simply cut from new sheets and
  // there is nothing to resolve.
  const { consumedOffcutIds: _ids, ...plan } = row;

  return {
    ...plan,
    options: (row.options ?? {}) as Record<string, unknown>,
    plan: row.plan as Record<string, unknown>,
    materials,
    offcutsConsumed: [],
  };
}

/** The offcut ids a plan reserved, for the caller that can resolve them. */
export async function cuttingPlanOffcutIds(tx: Transaction, planId: string): Promise<string[]> {
  const { tenantId } = requireTenantContext();
  const [row] = await tx
    .select({ ids: cuttingPlan.consumedOffcutIds })
    .from(cuttingPlan)
    .where(and(eq(cuttingPlan.tenantId, tenantId), eq(cuttingPlan.id, planId)))
    .limit(1);
  return row?.ids ?? [];
}

// ---------------------------------------------------------------------------
// Finishing
// ---------------------------------------------------------------------------

export interface FinishingBatchListRow {
  id: string;
  number: string | null;
  workCentreCode: string;
  workCentreName: string;
  status: string;
  colourCode: string | null;
  sheenCode: string | null;
  coatNumber: number;
  totalCoats: number;
  cureMinutes: number;
  sprayedAt: string | null;
  cureCompletesAt: string | null;
  completedAt: string | null;
  isOnHold: boolean;
  holdReason: string | null;
  partCount: number;
  pieceCount: number;
  reworkCount: number;
  /**
   * Minutes until the cure clock runs out. Negative means the load is ready to
   * come out and nobody has moved it — which is a booth standing idle.
   */
  cureMinutesRemaining: number | null;
}

export const FINISHING_SORTS = ['cureCompletesAt', 'number', 'status', 'createdAt'] as const;

export async function listFinishingBatches(
  tx: Transaction,
  params: ListParams,
  filters: { status?: string; workCentreId?: string; openOnly?: boolean } = {},
): Promise<ListResult<FinishingBatchListRow>> {
  const { tenantId } = requireTenantContext();

  // Everything not yet out of the booth. `completed` and `rejected` are the two
  // terminal states; a rejected load has been through and failed, which is a
  // cost, not a queue.
  const openStatuses = ['queued', 'spraying', 'curing'] as const;

  const cureRemaining = sql<number | null>`
    case
      when ${finishingBatch.cureCompletesAt} is null then null
      else round(extract(epoch from (${finishingBatch.cureCompletesAt} - now())) / 60)::int
    end
  `;

  const contents = tx
    .select({
      batchId: finishingBatchPart.batchId,
      partCount: sql<number>`count(*)::int`.as('part_count'),
      pieceCount: sql<number>`coalesce(sum(${finishingBatchPart.quantity}), 0)::int`.as(
        'piece_count',
      ),
      // Rework through the booth is a real cost and a real capacity loss. It is
      // counted separately or a busy booth looks productive.
      reworkCount: sql<number>`coalesce(sum(${finishingBatchPart.quantity}) filter (where ${finishingBatchPart.isRework}), 0)::int`.as(
        'rework_count',
      ),
    })
    .from(finishingBatchPart)
    .where(eq(finishingBatchPart.tenantId, tenantId))
    .groupBy(finishingBatchPart.batchId)
    .as('batch_contents');

  const conditions = [eq(finishingBatch.tenantId, tenantId)];
  if (filters.status) conditions.push(eq(finishingBatch.status, filters.status as never));
  if (filters.workCentreId) conditions.push(eq(finishingBatch.workCentreId, filters.workCentreId));
  if (filters.openOnly) conditions.push(inArray(finishingBatch.status, [...openStatuses]));

  if (params.search) {
    const pattern = searchPattern(params.search);
    conditions.push(
      or(
        ilike(finishingBatch.number, pattern),
        ilike(finishingBatch.colourCode, pattern),
        ilike(workCentre.name, pattern),
      )!,
    );
  }

  const where = and(...conditions);

  const sortColumn =
    {
      cureCompletesAt: finishingBatch.cureCompletesAt,
      number: finishingBatch.number,
      status: finishingBatch.status,
      createdAt: finishingBatch.createdAt,
    }[params.sort as string] ?? finishingBatch.cureCompletesAt;

  const rows = await tx
    .select({
      id: finishingBatch.id,
      number: finishingBatch.number,
      workCentreCode: workCentre.code,
      workCentreName: workCentre.name,
      status: finishingBatch.status,
      colourCode: finishingBatch.colourCode,
      sheenCode: finishingBatch.sheenCode,
      coatNumber: finishingBatch.coatNumber,
      totalCoats: finishingBatch.totalCoats,
      cureMinutes: finishingBatch.cureMinutes,
      sprayedAt: sql<string | null>`${finishingBatch.sprayedAt}`,
      cureCompletesAt: sql<string | null>`${finishingBatch.cureCompletesAt}`,
      completedAt: sql<string | null>`${finishingBatch.completedAt}`,
      isOnHold: finishingBatch.isOnHold,
      holdReason: finishingBatch.holdReason,
      partCount: sql<number>`coalesce(${contents.partCount}, 0)`,
      pieceCount: sql<number>`coalesce(${contents.pieceCount}, 0)`,
      reworkCount: sql<number>`coalesce(${contents.reworkCount}, 0)`,
      cureMinutesRemaining: cureRemaining,
    })
    .from(finishingBatch)
    .innerJoin(
      workCentre,
      and(eq(workCentre.id, finishingBatch.workCentreId), eq(workCentre.tenantId, tenantId)),
    )
    .leftJoin(contents, eq(contents.batchId, finishingBatch.id))
    .where(where)
    // Soonest out of the booth first, and a load with no cure clock last rather
    // than first — a batch not yet sprayed is not the most urgent thing here.
    .orderBy(
      params.direction === 'asc'
        ? sql`${sortColumn} asc nulls last`
        : sql`${sortColumn} desc nulls last`,
      asc(finishingBatch.id),
    )
    .limit(params.pageSize)
    .offset(params.offset);

  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(finishingBatch)
    .innerJoin(
      workCentre,
      and(eq(workCentre.id, finishingBatch.workCentreId), eq(workCentre.tenantId, tenantId)),
    )
    .where(where);

  return listResult(rows, counted?.total ?? 0, params);
}

// ---------------------------------------------------------------------------
// Routings
// ---------------------------------------------------------------------------

export interface RoutingListRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  isActive: boolean;
  operationCount: number;
  /** Sum of setup and run time across the routing, at its stated quantities. */
  plannedMinutes: number | null;
  /** The stations it passes through, in sequence. */
  workCentres: string | null;
  /** How many work orders are currently using it. */
  workOrdersUsing: number;
}

export const ROUTING_SORTS = ['code', 'name', 'operationCount'] as const;

export async function listRoutings(
  tx: Transaction,
  params: ListParams,
  filters: { includeInactive?: boolean } = {},
): Promise<ListResult<RoutingListRow>> {
  const { tenantId } = requireTenantContext();

  const operations = tx
    .select({
      routingId: routingOperation.routingId,
      count: sql<number>`count(*)::int`.as('operation_count'),
      minutes: sql<number | null>`round(sum(
        coalesce(${routingOperation.setupMinutes}, 0)
        + coalesce(${routingOperation.runMinutesPerUnit}, 0)
      ))::int`.as('planned_minutes'),
      centres: sql<
        string | null
      >`string_agg(${workCentre.code}, ' → ' order by ${routingOperation.sequence})`.as(
        'work_centres',
      ),
    })
    .from(routingOperation)
    .leftJoin(workCentre, eq(workCentre.id, routingOperation.workCentreId))
    .where(eq(routingOperation.tenantId, tenantId))
    .groupBy(routingOperation.routingId)
    .as('routing_operations');

  const usage = tx
    .select({
      routingId: workOrder.routingId,
      count: sql<number>`count(*)::int`.as('orders_using'),
    })
    .from(workOrder)
    .where(eq(workOrder.tenantId, tenantId))
    .groupBy(workOrder.routingId)
    .as('routing_usage');

  const conditions = [eq(routing.tenantId, tenantId)];
  if (!filters.includeInactive) conditions.push(eq(routing.isActive, true));

  if (params.search) {
    const pattern = searchPattern(params.search);
    conditions.push(or(ilike(routing.code, pattern), ilike(routing.name, pattern))!);
  }

  const where = and(...conditions);

  const sortColumn =
    {
      code: routing.code,
      name: routing.name,
      operationCount: operations.count,
    }[params.sort as string] ?? routing.code;

  const rows = await tx
    .select({
      id: routing.id,
      code: routing.code,
      name: routing.name,
      description: routing.description,
      isDefault: routing.isDefault,
      isActive: routing.isActive,
      operationCount: sql<number>`coalesce(${operations.count}, 0)`,
      plannedMinutes: operations.minutes,
      workCentres: operations.centres,
      workOrdersUsing: sql<number>`coalesce(${usage.count}, 0)`,
    })
    .from(routing)
    .leftJoin(operations, eq(operations.routingId, routing.id))
    .leftJoin(usage, eq(usage.routingId, routing.id))
    .where(where)
    .orderBy(params.direction === 'asc' ? asc(sortColumn) : desc(sortColumn), asc(routing.id))
    .limit(params.pageSize)
    .offset(params.offset);

  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(routing)
    .where(where);

  return listResult(rows, counted?.total ?? 0, params);
}

export interface RoutingOperationDetail {
  id: string;
  sequence: number;
  name: string;
  workCentreId: string;
  workCentreCode: string;
  workCentreName: string;
  setupMinutes: string | null;
  runMinutesPerUnit: string | null;
  cureMinutes: number;
  isQualityGate: boolean;
  instructions: string | null;
}

export interface RoutingDetail {
  routing: typeof routing.$inferSelect;
  operations: RoutingOperationDetail[];
}

/** One routing, with its steps resolved to the work centres that run them. */
export async function getRoutingDetail(
  tx: Transaction,
  routingId: string,
): Promise<RoutingDetail | null> {
  const { tenantId } = requireTenantContext();

  const [row] = await tx
    .select()
    .from(routing)
    .where(and(eq(routing.tenantId, tenantId), eq(routing.id, routingId)))
    .limit(1);
  if (!row) return null;

  const operations = await tx
    .select({
      operation: routingOperation,
      workCentreCode: workCentre.code,
      workCentreName: workCentre.name,
    })
    .from(routingOperation)
    .innerJoin(workCentre, eq(workCentre.id, routingOperation.workCentreId))
    .where(and(eq(routingOperation.tenantId, tenantId), eq(routingOperation.routingId, routingId)))
    .orderBy(asc(routingOperation.sequence));

  return {
    routing: row,
    operations: operations.map(({ operation, workCentreCode, workCentreName }) => ({
      id: operation.id,
      sequence: operation.sequence,
      name: operation.name,
      workCentreId: operation.workCentreId,
      workCentreCode,
      workCentreName,
      setupMinutes: operation.setupMinutes,
      runMinutesPerUnit: operation.runMinutesPerUnit,
      cureMinutes: operation.cureMinutes,
      isQualityGate: operation.isQualityGate,
      instructions: operation.instructions,
    })),
  };
}

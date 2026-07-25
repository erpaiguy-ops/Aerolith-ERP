/**
 * Work order lifecycle and shop-floor scanning.
 *
 * Note what is absent: no import of Inventory, and no stock posting. Production
 * emits `production.work_order.released` and lets Inventory issue the material;
 * where a single transaction is genuinely needed, the application layer composes
 * both modules. That is the boundary rule, and it is what lets either module be
 * sold on its own.
 */
import {
  allocateNumber,
  emit,
  recordAudit,
  requireTenantContext,
  type Transaction,
} from '@aerolith/kernel';
import { and, asc, eq } from 'drizzle-orm';

import {
  cuttingPlan,
  productionScan,
  routingOperation,
  workCentre,
  workOrder,
  workOrderOperation,
  workOrderPart,
} from '../db/schema';
import {
  canStartOperation,
  operationProgress,
  workOrderProgress,
  type OperationSummary,
  type Scan,
} from '../domain/progress';
import { operationDuration, scheduleOperations, type WorkCentreCapacity } from '../domain/scheduling';

export const MODULE_KEY = 'production';

export class WorkOrderError extends Error {
  override readonly name = 'WorkOrderError';
}

export interface PartInput {
  label: string;
  materialItemId: string;
  lengthMm: number;
  widthMm: number;
  thicknessMm?: number | null;
  quantity: number;
  grainAlong?: 'length' | 'width' | 'any' | null;
  edgeBanding?: Record<string, unknown> | null;
  finishSpec?: Record<string, unknown> | null;
  notes?: string | null;
}

export interface CreateWorkOrderInput {
  description: string;
  quantity?: number;
  projectId?: string | null;
  itemId?: string | null;
  routingId?: string | null;
  priority?: number;
  plannedStartDate?: string | null;
  sourceModule?: string | null;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
  notes?: string | null;
  parts?: PartInput[];
}

export interface CreateWorkOrderResult {
  workOrderId: string;
  number: string;
  partsCreated: number;
  operationsCreated: number;
  plannedMinutes: number;
}

export async function createWorkOrder(
  tx: Transaction,
  input: CreateWorkOrderInput,
): Promise<CreateWorkOrderResult> {
  const { tenantId, userId } = requireTenantContext();
  const quantity = input.quantity ?? 1;

  if (quantity <= 0) throw new WorkOrderError('Quantity must be positive.');

  const allocated = await allocateNumber(tx, {
    entityType: 'production.work_order',
    documentDate: input.plannedStartDate ? new Date(input.plannedStartDate) : new Date(),
  });

  const [created] = await tx
    .insert(workOrder)
    .values({
      tenantId,
      number: allocated.formatted,
      numberPeriod: allocated.period,
      numberValue: allocated.value,
      description: input.description,
      quantity: String(quantity),
      projectId: input.projectId,
      itemId: input.itemId,
      routingId: input.routingId,
      status: 'draft',
      priority: input.priority ?? 100,
      plannedStartDate: input.plannedStartDate,
      sourceModule: input.sourceModule,
      sourceEntityType: input.sourceEntityType,
      sourceEntityId: input.sourceEntityId,
      notes: input.notes,
      createdBy: userId,
    })
    .returning({ id: workOrder.id });

  const workOrderId = created!.id;

  // --- Parts ---------------------------------------------------------------
  let partsCreated = 0;
  for (const [index, part] of (input.parts ?? []).entries()) {
    if (part.quantity <= 0) {
      throw new WorkOrderError(`Part "${part.label}": quantity must be positive.`);
    }
    if (part.lengthMm <= 0 || part.widthMm <= 0) {
      throw new WorkOrderError(`Part "${part.label}": dimensions must be positive.`);
    }

    await tx.insert(workOrderPart).values({
      tenantId,
      workOrderId,
      partNumber: index + 1,
      label: part.label,
      materialItemId: part.materialItemId,
      lengthMm: String(part.lengthMm),
      widthMm: String(part.widthMm),
      thicknessMm: part.thicknessMm == null ? null : String(part.thicknessMm),
      quantity: part.quantity,
      grainAlong: part.grainAlong ?? null,
      edgeBanding: part.edgeBanding ?? null,
      finishSpec: part.finishSpec ?? null,
      // Deterministic and human-readable — a storekeeper reads it off the label
      // when the scanner will not focus.
      barcode: `${allocated.formatted}-${String(index + 1).padStart(3, '0')}`,
      notes: part.notes,
    });
    partsCreated += 1;
  }

  // --- Operations, instantiated from the routing ---------------------------
  const { operationsCreated, plannedMinutes } = await instantiateRouting(tx, {
    tenantId,
    workOrderId,
    routingId: input.routingId ?? null,
    quantity,
  });

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'production.work_order',
    entityId: workOrderId,
    entityLabel: allocated.formatted,
    action: 'create',
  });

  return {
    workOrderId,
    number: allocated.formatted,
    partsCreated,
    operationsCreated,
    plannedMinutes,
  };
}

/**
 * Copies the routing onto the work order, snapshotting rates.
 *
 * Snapshotted so that editing a routing next month does not silently rewrite the
 * planned times of jobs already on the floor — the same reasoning as the
 * approval engine's version pinning.
 */
async function instantiateRouting(
  tx: Transaction,
  args: { tenantId: string; workOrderId: string; routingId: string | null; quantity: number },
): Promise<{ operationsCreated: number; plannedMinutes: number }> {
  if (!args.routingId) return { operationsCreated: 0, plannedMinutes: 0 };

  const operations = await tx
    .select({
      op: routingOperation,
      centre: workCentre,
    })
    .from(routingOperation)
    .innerJoin(workCentre, eq(workCentre.id, routingOperation.workCentreId))
    .where(
      and(
        eq(routingOperation.tenantId, args.tenantId),
        eq(routingOperation.routingId, args.routingId),
      ),
    )
    .orderBy(asc(routingOperation.sequence));

  if (operations.length === 0) {
    throw new WorkOrderError('The selected routing has no operations.');
  }

  let plannedMinutes = 0;

  for (const { op, centre } of operations) {
    // The operation may override the work centre's rates.
    const setupMinutes = Number(op.setupMinutes ?? centre.setupMinutes);
    const runMinutesPerUnit = Number(op.runMinutesPerUnit ?? centre.runMinutesPerUnit);

    const duration = operationDuration(
      {
        sequence: op.sequence,
        workCentreId: centre.id,
        setupMinutes,
        runMinutesPerUnit,
        cureMinutes: op.cureMinutes,
      },
      args.quantity,
      toCapacity(centre),
    );

    await tx.insert(workOrderOperation).values({
      tenantId: args.tenantId,
      workOrderId: args.workOrderId,
      sequence: op.sequence,
      name: op.name,
      workCentreId: centre.id,
      // The first operation is ready immediately; the rest wait their turn.
      status: op.sequence === operations[0]!.op.sequence ? 'ready' : 'pending',
      setupMinutes: String(setupMinutes),
      runMinutesPerUnit: String(runMinutesPerUnit),
      cureMinutes: op.cureMinutes,
      isQualityGate: op.isQualityGate,
      plannedMinutes: String(duration.occupancyMinutes),
      instructions: op.instructions,
    });

    plannedMinutes += duration.elapsedMinutes;
  }

  return { operationsCreated: operations.length, plannedMinutes: round(plannedMinutes, 2) };
}

// ---------------------------------------------------------------------------

/** Releases a job to the floor. Emits; does not touch stock itself. */
export async function releaseWorkOrder(
  tx: Transaction,
  input: { workOrderId: string },
): Promise<{ number: string; materialRequired: { itemId: string; quantity: number }[] }> {
  const { tenantId, userId } = requireTenantContext();

  const [order] = await tx
    .select()
    .from(workOrder)
    .where(and(eq(workOrder.tenantId, tenantId), eq(workOrder.id, input.workOrderId)))
    .limit(1)
    .for('update');

  if (!order) throw new WorkOrderError('Work order not found.');
  if (order.status !== 'draft' && order.status !== 'planned') {
    throw new WorkOrderError(`A ${order.status} work order cannot be released.`);
  }

  const operations = await tx
    .select({ id: workOrderOperation.id })
    .from(workOrderOperation)
    .where(eq(workOrderOperation.workOrderId, order.id));

  if (operations.length === 0) {
    throw new WorkOrderError('Cannot release a work order with no operations. Assign a routing.');
  }

  const parts = await tx
    .select()
    .from(workOrderPart)
    .where(eq(workOrderPart.workOrderId, order.id));

  // Material demand, summarised by item. Inventory decides how to satisfy it.
  const demand = new Map<string, number>();
  for (const part of parts) {
    const area = (Number(part.lengthMm) * Number(part.widthMm)) / 1_000_000;
    demand.set(part.materialItemId, (demand.get(part.materialItemId) ?? 0) + area * part.quantity);
  }

  const now = new Date();
  await tx
    .update(workOrder)
    .set({ status: 'released', releasedAt: now, releasedBy: userId, updatedAt: now })
    .where(eq(workOrder.id, order.id));

  const materialRequired = [...demand.entries()].map(([itemId, quantity]) => ({
    itemId,
    quantity: round(quantity, 4),
  }));

  await emit(tx, {
    type: 'production.work_order.released',
    sourceModule: MODULE_KEY,
    aggregateType: 'production.work_order',
    aggregateId: order.id,
    payload: {
      number: order.number,
      projectId: order.projectId,
      quantity: Number(order.quantity),
      partCount: parts.length,
      materialRequired,
    },
  });

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'production.work_order',
    entityId: order.id,
    entityLabel: order.number,
    action: 'submit',
    reason: 'Released to the shop floor',
  });

  return { number: order.number!, materialRequired };
}

// ---------------------------------------------------------------------------

export interface RecordScanInput {
  workOrderId: string;
  operationId: string;
  partId?: string | null;
  type: 'start' | 'complete' | 'pause' | 'resume' | 'reject' | 'rework';
  quantity?: number;
  reasonCode?: string | null;
  notes?: string | null;
  isOffline?: boolean;
  deviceId?: string | null;
  /** Set when the scan happened earlier and is being replayed from a device. */
  scannedAt?: Date;
}

export interface RecordScanResult {
  scanId: string;
  operationState: string;
  completedQuantity: number;
  workOrderPercentComplete: number;
  workOrderCompleted: boolean;
}

/**
 * Records a shop-floor scan and recomputes the operation from its scan history.
 *
 * State is always DERIVED from the full scan list rather than incremented. That
 * makes a replayed offline scan idempotent in effect and a mis-scan correctable
 * by a compensating scan, which is the only workable model when the input device
 * is a barcode gun in a noisy factory.
 */
export async function recordScan(
  tx: Transaction,
  input: RecordScanInput,
  options: { enforceSequence?: boolean } = {},
): Promise<RecordScanResult> {
  const { tenantId, userId } = requireTenantContext();
  const enforceSequence = options.enforceSequence ?? true;

  const [order] = await tx
    .select()
    .from(workOrder)
    .where(and(eq(workOrder.tenantId, tenantId), eq(workOrder.id, input.workOrderId)))
    .limit(1);

  if (!order) throw new WorkOrderError('Work order not found.');
  if (order.status === 'draft' || order.status === 'planned') {
    throw new WorkOrderError('This work order has not been released to the floor yet.');
  }
  if (order.status === 'cancelled') throw new WorkOrderError('This work order is cancelled.');

  const operations = await tx
    .select()
    .from(workOrderOperation)
    .where(eq(workOrderOperation.workOrderId, order.id))
    .orderBy(asc(workOrderOperation.sequence));

  const operation = operations.find((op) => op.id === input.operationId);
  if (!operation) throw new WorkOrderError('Operation does not belong to this work order.');

  const targetQuantity = Number(order.quantity);
  const summaries: OperationSummary[] = operations.map((op) => ({
    id: op.id,
    sequence: op.sequence,
    name: op.name,
    isQualityGate: op.isQualityGate,
    targetQuantity,
  }));

  const existingScans = await loadScans(tx, order.id);

  // The rule that stops a part reaching assembly without going through the
  // edgebander. Overridable, because some floors genuinely work out of order —
  // but overriding it is a permission, not a default.
  if (enforceSequence && input.type === 'start') {
    const check = canStartOperation(summaries, existingScans, operation.sequence);
    if (!check.allowed) throw new WorkOrderError(check.reason);
  }

  const scannedAt = input.scannedAt ?? new Date();
  const [scan] = await tx
    .insert(productionScan)
    .values({
      tenantId,
      workOrderId: order.id,
      operationId: operation.id,
      partId: input.partId ?? null,
      type: input.type,
      quantity: input.quantity ?? 1,
      operatorId: userId,
      workCentreId: operation.workCentreId,
      scannedAt,
      reasonCode: input.reasonCode,
      notes: input.notes,
      isOffline: input.isOffline ?? false,
      deviceId: input.deviceId,
    })
    .returning({ id: productionScan.id });

  // Recompute from the full history, including the scan just written.
  const allScans = [
    ...existingScans,
    {
      id: scan!.id,
      operationId: operation.id,
      partId: input.partId ?? null,
      type: input.type,
      quantity: input.quantity ?? 1,
      operatorId: userId,
      scannedAt,
      reasonCode: input.reasonCode ?? null,
    } satisfies Scan,
  ];

  const progress = operationProgress(operation.id, allScans, targetQuantity);

  await tx
    .update(workOrderOperation)
    .set({
      status: progress.state,
      completedQuantity: progress.completedQuantity,
      rejectedQuantity: progress.rejectedQuantity,
      actualMinutes: String(progress.activeMinutes),
      startedAt: progress.startedAt,
      completedAt: progress.completedAt,
      updatedAt: new Date(),
    })
    .where(eq(workOrderOperation.id, operation.id));

  // Opening the next operation is what makes the shop-floor board move.
  if (progress.state === 'completed') {
    const next = operations.find((op) => op.sequence > operation.sequence);
    if (next && next.status === 'pending') {
      await tx
        .update(workOrderOperation)
        .set({ status: 'ready', updatedAt: new Date() })
        .where(eq(workOrderOperation.id, next.id));
    }

    await emit(tx, {
      type: 'production.operation.completed',
      sourceModule: MODULE_KEY,
      aggregateType: 'production.work_order_operation',
      aggregateId: operation.id,
      payload: {
        workOrderId: order.id,
        workOrderNumber: order.number,
        sequence: operation.sequence,
        name: operation.name,
        workCentreId: operation.workCentreId,
        activeMinutes: progress.activeMinutes,
      },
    });
  }

  if (input.type === 'reject') {
    await emit(tx, {
      type: 'production.part.rejected',
      sourceModule: MODULE_KEY,
      aggregateType: 'production.work_order',
      aggregateId: order.id,
      payload: {
        workOrderNumber: order.number,
        operationId: operation.id,
        partId: input.partId ?? null,
        quantity: input.quantity ?? 1,
        reasonCode: input.reasonCode ?? null,
      },
    });
  }

  const overall = workOrderProgress(summaries, allScans);
  const isComplete = overall.completedOperations === overall.totalOperations;

  if (isComplete && order.status !== 'completed') {
    const now = new Date();
    await tx
      .update(workOrder)
      .set({
        status: 'completed',
        actualStartAt: overall.startedAt,
        actualEndAt: overall.completedAt ?? now,
        updatedAt: now,
      })
      .where(eq(workOrder.id, order.id));

    await emit(tx, {
      type: 'production.work_order.completed',
      sourceModule: MODULE_KEY,
      aggregateType: 'production.work_order',
      aggregateId: order.id,
      payload: {
        number: order.number,
        projectId: order.projectId,
        itemId: order.itemId,
        quantity: Number(order.quantity),
        totalActiveMinutes: overall.totalActiveMinutes,
        totalRejected: overall.totalRejected,
      },
    });
  } else if (order.status === 'released') {
    await tx
      .update(workOrder)
      .set({ status: 'in_progress', actualStartAt: overall.startedAt, updatedAt: new Date() })
      .where(eq(workOrder.id, order.id));
  }

  return {
    scanId: scan!.id,
    operationState: progress.state,
    completedQuantity: progress.completedQuantity,
    workOrderPercentComplete: overall.percentComplete,
    workOrderCompleted: isComplete,
  };
}

// ---------------------------------------------------------------------------

/** Live position of a job, derived from its scans. */
export async function getWorkOrderProgress(tx: Transaction, workOrderId: string) {
  const { tenantId } = requireTenantContext();

  const [order] = await tx
    .select()
    .from(workOrder)
    .where(and(eq(workOrder.tenantId, tenantId), eq(workOrder.id, workOrderId)))
    .limit(1);

  if (!order) throw new WorkOrderError('Work order not found.');

  const operations = await tx
    .select()
    .from(workOrderOperation)
    .where(eq(workOrderOperation.workOrderId, order.id))
    .orderBy(asc(workOrderOperation.sequence));

  const scans = await loadScans(tx, order.id);
  const targetQuantity = Number(order.quantity);

  const summaries: OperationSummary[] = operations.map((op) => ({
    id: op.id,
    sequence: op.sequence,
    name: op.name,
    isQualityGate: op.isQualityGate,
    targetQuantity,
  }));

  return {
    order,
    operations: operations.map((op) => ({
      ...op,
      progress: operationProgress(op.id, scans, targetQuantity),
    })),
    progress: workOrderProgress(summaries, scans),
    scanCount: scans.length,
  };
}

/** Estimated finish, from the routing. Infinite capacity — see scheduleOperations. */
export async function estimateCompletion(
  tx: Transaction,
  input: { workOrderId: string; startAt?: Date; cureRunsOutsideWorkingHours?: boolean },
) {
  const { tenantId } = requireTenantContext();

  const [order] = await tx
    .select()
    .from(workOrder)
    .where(and(eq(workOrder.tenantId, tenantId), eq(workOrder.id, input.workOrderId)))
    .limit(1);

  if (!order) throw new WorkOrderError('Work order not found.');

  const rows = await tx
    .select({ op: workOrderOperation, centre: workCentre })
    .from(workOrderOperation)
    .innerJoin(workCentre, eq(workCentre.id, workOrderOperation.workCentreId))
    .where(eq(workOrderOperation.workOrderId, order.id))
    .orderBy(asc(workOrderOperation.sequence));

  const centres = new Map<string, WorkCentreCapacity>(
    rows.map(({ centre }) => [centre.id, toCapacity(centre)]),
  );

  const scheduled = scheduleOperations(
    rows.map(({ op }) => ({
      sequence: op.sequence,
      workCentreId: op.workCentreId,
      setupMinutes: Number(op.setupMinutes),
      runMinutesPerUnit: Number(op.runMinutesPerUnit),
      cureMinutes: op.cureMinutes,
    })),
    Number(order.quantity),
    centres,
    input.startAt ?? new Date(),
    { cureRunsOutsideWorkingHours: input.cureRunsOutsideWorkingHours ?? true },
  );

  return { scheduled, centres };
}

/** Records a generated cutting plan against a work order. */
export async function saveCuttingPlan(
  tx: Transaction,
  input: {
    workOrderId: string;
    plan: Record<string, unknown>;
    options: Record<string, unknown>;
    sheetsUsed: number;
    offcutsUsed: number;
    grossYieldPercent: number;
    netYieldPercent: number;
    materialCost?: number | null;
    consumedOffcutIds: string[];
  },
): Promise<{ cuttingPlanId: string; version: number }> {
  const { tenantId, userId } = requireTenantContext();

  const existing = await tx
    .select({ version: cuttingPlan.version })
    .from(cuttingPlan)
    .where(
      and(eq(cuttingPlan.tenantId, tenantId), eq(cuttingPlan.workOrderId, input.workOrderId)),
    );

  const version = existing.reduce((max, row) => Math.max(max, row.version), 0) + 1;

  const [created] = await tx
    .insert(cuttingPlan)
    .values({
      tenantId,
      workOrderId: input.workOrderId,
      version,
      plan: input.plan,
      options: input.options,
      sheetsUsed: input.sheetsUsed,
      offcutsUsed: input.offcutsUsed,
      grossYieldPercent: String(input.grossYieldPercent),
      netYieldPercent: String(input.netYieldPercent),
      materialCost: input.materialCost == null ? null : String(input.materialCost),
      consumedOffcutIds: input.consumedOffcutIds,
      generatedBy: userId,
    })
    .returning({ id: cuttingPlan.id });

  await emit(tx, {
    type: 'production.cutting_plan.generated',
    sourceModule: MODULE_KEY,
    aggregateType: 'production.cutting_plan',
    aggregateId: created!.id,
    payload: {
      workOrderId: input.workOrderId,
      version,
      sheetsUsed: input.sheetsUsed,
      offcutsUsed: input.offcutsUsed,
      consumedOffcutIds: input.consumedOffcutIds,
    },
  });

  return { cuttingPlanId: created!.id, version };
}

// ---------------------------------------------------------------------------

async function loadScans(tx: Transaction, workOrderId: string): Promise<Scan[]> {
  const rows = await tx
    .select()
    .from(productionScan)
    .where(eq(productionScan.workOrderId, workOrderId))
    .orderBy(asc(productionScan.scannedAt));

  return rows.map((row) => ({
    id: row.id,
    operationId: row.operationId,
    partId: row.partId,
    type: row.type,
    quantity: row.quantity,
    operatorId: row.operatorId,
    scannedAt: row.scannedAt,
    reasonCode: row.reasonCode,
  }));
}

function toCapacity(centre: typeof workCentre.$inferSelect): WorkCentreCapacity {
  return {
    id: centre.id,
    capacityUnits: centre.capacityUnits,
    workingMinutesPerDay: centre.workingMinutesPerDay,
    isBatchProcess: centre.isBatchProcess,
    batchCapacityUnits: centre.batchCapacityUnits,
    costPerHour: centre.costPerHour === null ? null : Number(centre.costPerHour),
  };
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

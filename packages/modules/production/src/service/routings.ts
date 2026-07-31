/**
 * Work centres and routings — the master data `production.routing.manage`
 * actually gates.
 *
 * Separate from `workOrders.ts` for the same reason `registers.ts` is
 * separate from it: defining the standard route through the factory is master
 * data, not a shop-floor transaction. A work order INSTANTIATES a routing
 * (see `instantiateRouting` in `workOrders.ts`) by snapshotting it onto the
 * order's own operations, so editing a routing here never rewrites a job
 * already on the floor.
 */
import { recordAudit, requireTenantContext, type Transaction } from '@aerolith/kernel';
import { and, eq } from 'drizzle-orm';

import { routing, routingOperation, workCentre } from '../db/schema';
import { MODULE_KEY } from './workOrders';

export class RoutingError extends Error {
  override readonly name = 'RoutingError';
}

const numOrNull = (value: number | null | undefined): string | null =>
  value == null ? null : String(value);

// ---------------------------------------------------------------------------
// Work centres
// ---------------------------------------------------------------------------

export interface CreateWorkCentreInput {
  code: string;
  name: string;
  type: string;
  assetId?: string | null;
  capacityUnits?: number;
  setupMinutes?: number;
  runMinutesPerUnit?: number;
  costPerHour?: number | null;
  workingMinutesPerDay?: number;
  isBatchProcess?: boolean;
  batchCapacityUnits?: number | null;
  isActive?: boolean;
}

/** Creates a station on the shop floor — a saw, a booth, a QC bench. */
export async function createWorkCentre(
  tx: Transaction,
  input: CreateWorkCentreInput,
): Promise<{ id: string }> {
  const { tenantId } = requireTenantContext();

  const [row] = await tx
    .insert(workCentre)
    .values({
      tenantId,
      code: input.code,
      name: input.name,
      type: input.type as never,
      assetId: input.assetId ?? null,
      capacityUnits: input.capacityUnits ?? 1,
      setupMinutes: input.setupMinutes == null ? undefined : String(input.setupMinutes),
      runMinutesPerUnit:
        input.runMinutesPerUnit == null ? undefined : String(input.runMinutesPerUnit),
      costPerHour: numOrNull(input.costPerHour),
      workingMinutesPerDay: input.workingMinutesPerDay ?? 480,
      isBatchProcess: input.isBatchProcess ?? false,
      batchCapacityUnits: input.batchCapacityUnits ?? null,
      isActive: input.isActive ?? true,
    })
    .onConflictDoNothing({ target: [workCentre.tenantId, workCentre.code] })
    .returning({ id: workCentre.id });

  if (!row) throw new RoutingError(`"${input.code}" is already in use by another work centre.`);

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'production.work_centre',
    entityId: row.id,
    entityLabel: `${input.code} — ${input.name}`,
    action: 'create',
  });

  return { id: row.id };
}

export interface UpdateWorkCentreInput {
  name?: string;
  type?: string;
  assetId?: string | null;
  capacityUnits?: number;
  setupMinutes?: number;
  runMinutesPerUnit?: number;
  costPerHour?: number | null;
  workingMinutesPerDay?: number;
  isBatchProcess?: boolean;
  batchCapacityUnits?: number | null;
  isActive?: boolean;
}

export async function updateWorkCentre(
  tx: Transaction,
  input: { workCentreId: string } & UpdateWorkCentreInput,
): Promise<void> {
  const { tenantId } = requireTenantContext();

  const [existing] = await tx
    .select()
    .from(workCentre)
    .where(and(eq(workCentre.tenantId, tenantId), eq(workCentre.id, input.workCentreId)));
  if (!existing) throw new RoutingError('Work centre not found.');

  await tx
    .update(workCentre)
    .set({
      name: input.name ?? existing.name,
      type: (input.type as never) ?? existing.type,
      assetId: input.assetId !== undefined ? input.assetId : existing.assetId,
      capacityUnits: input.capacityUnits ?? existing.capacityUnits,
      setupMinutes: input.setupMinutes != null ? String(input.setupMinutes) : existing.setupMinutes,
      runMinutesPerUnit:
        input.runMinutesPerUnit != null
          ? String(input.runMinutesPerUnit)
          : existing.runMinutesPerUnit,
      costPerHour:
        input.costPerHour !== undefined ? numOrNull(input.costPerHour) : existing.costPerHour,
      workingMinutesPerDay: input.workingMinutesPerDay ?? existing.workingMinutesPerDay,
      isBatchProcess: input.isBatchProcess ?? existing.isBatchProcess,
      batchCapacityUnits:
        input.batchCapacityUnits !== undefined
          ? input.batchCapacityUnits
          : existing.batchCapacityUnits,
      isActive: input.isActive ?? existing.isActive,
      updatedAt: new Date(),
    })
    .where(eq(workCentre.id, input.workCentreId));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'production.work_centre',
    entityId: input.workCentreId,
    entityLabel: `${existing.code} — ${existing.name}`,
    action: 'update',
  });
}

// ---------------------------------------------------------------------------
// Routings
// ---------------------------------------------------------------------------

export interface CreateRoutingInput {
  code: string;
  name: string;
  itemId?: string | null;
  description?: string | null;
  isDefault?: boolean;
  isActive?: boolean;
}

export async function createRouting(
  tx: Transaction,
  input: CreateRoutingInput,
): Promise<{ id: string }> {
  const { tenantId } = requireTenantContext();

  const [row] = await tx
    .insert(routing)
    .values({
      tenantId,
      code: input.code,
      name: input.name,
      itemId: input.itemId ?? null,
      description: input.description ?? null,
      isDefault: input.isDefault ?? false,
      isActive: input.isActive ?? true,
    })
    .onConflictDoNothing({ target: [routing.tenantId, routing.code] })
    .returning({ id: routing.id });

  if (!row) throw new RoutingError(`"${input.code}" is already in use by another routing.`);

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'production.routing',
    entityId: row.id,
    entityLabel: `${input.code} — ${input.name}`,
    action: 'create',
  });

  return { id: row.id };
}

export interface UpdateRoutingInput {
  name?: string;
  itemId?: string | null;
  description?: string | null;
  isDefault?: boolean;
  isActive?: boolean;
}

export async function updateRouting(
  tx: Transaction,
  input: { routingId: string } & UpdateRoutingInput,
): Promise<void> {
  const { tenantId } = requireTenantContext();

  const [existing] = await tx
    .select()
    .from(routing)
    .where(and(eq(routing.tenantId, tenantId), eq(routing.id, input.routingId)));
  if (!existing) throw new RoutingError('Routing not found.');

  await tx
    .update(routing)
    .set({
      name: input.name ?? existing.name,
      itemId: input.itemId !== undefined ? input.itemId : existing.itemId,
      description: input.description !== undefined ? input.description : existing.description,
      isDefault: input.isDefault ?? existing.isDefault,
      isActive: input.isActive ?? existing.isActive,
      updatedAt: new Date(),
    })
    .where(eq(routing.id, input.routingId));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'production.routing',
    entityId: input.routingId,
    entityLabel: `${existing.code} — ${input.name ?? existing.name}`,
    action: 'update',
  });
}

// ---------------------------------------------------------------------------
// Routing operations — the routing's steps
// ---------------------------------------------------------------------------

export interface AddRoutingOperationInput {
  routingId: string;
  sequence: number;
  name: string;
  workCentreId: string;
  setupMinutes?: number | null;
  runMinutesPerUnit?: number | null;
  cureMinutes?: number;
  isQualityGate?: boolean;
  instructions?: string | null;
}

/**
 * Adds a step to a routing.
 *
 * Sequence is unique per routing at the database (`routing_operation_uq`), so
 * a duplicate is caught the same way `createItem` catches a duplicate code:
 * `onConflictDoNothing` plus a null-row check, rather than a pre-check that
 * would race against a concurrent insert of the same sequence.
 */
export async function addRoutingOperation(
  tx: Transaction,
  input: AddRoutingOperationInput,
): Promise<{ id: string }> {
  const { tenantId } = requireTenantContext();

  if (!Number.isInteger(input.sequence) || input.sequence <= 0) {
    throw new RoutingError('Sequence must be a positive whole number.');
  }

  const [route] = await tx
    .select({ id: routing.id })
    .from(routing)
    .where(and(eq(routing.tenantId, tenantId), eq(routing.id, input.routingId)));
  if (!route) throw new RoutingError('Routing not found.');

  const [centre] = await tx
    .select({ id: workCentre.id })
    .from(workCentre)
    .where(and(eq(workCentre.tenantId, tenantId), eq(workCentre.id, input.workCentreId)));
  if (!centre) throw new RoutingError('Work centre not found.');

  const [row] = await tx
    .insert(routingOperation)
    .values({
      tenantId,
      routingId: input.routingId,
      sequence: input.sequence,
      name: input.name,
      workCentreId: input.workCentreId,
      setupMinutes: numOrNull(input.setupMinutes),
      runMinutesPerUnit: numOrNull(input.runMinutesPerUnit),
      cureMinutes: input.cureMinutes ?? 0,
      isQualityGate: input.isQualityGate ?? false,
      instructions: input.instructions ?? null,
    })
    .onConflictDoNothing({ target: [routingOperation.routingId, routingOperation.sequence] })
    .returning({ id: routingOperation.id });

  if (!row) {
    throw new RoutingError(`Sequence ${input.sequence} is already used in this routing.`);
  }

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'production.routing',
    entityId: input.routingId,
    entityLabel: input.name,
    action: 'update',
    reason: `Operation added at sequence ${input.sequence}.`,
  });

  return { id: row.id };
}

export interface UpdateRoutingOperationInput {
  sequence?: number;
  name?: string;
  workCentreId?: string;
  setupMinutes?: number | null;
  runMinutesPerUnit?: number | null;
  cureMinutes?: number;
  isQualityGate?: boolean;
  instructions?: string | null;
}

export async function updateRoutingOperation(
  tx: Transaction,
  input: { operationId: string } & UpdateRoutingOperationInput,
): Promise<void> {
  const { tenantId } = requireTenantContext();

  const [existing] = await tx
    .select()
    .from(routingOperation)
    .where(and(eq(routingOperation.tenantId, tenantId), eq(routingOperation.id, input.operationId)));
  if (!existing) throw new RoutingError('Routing operation not found.');

  if (input.sequence !== undefined && input.sequence !== existing.sequence) {
    if (!Number.isInteger(input.sequence) || input.sequence <= 0) {
      throw new RoutingError('Sequence must be a positive whole number.');
    }
    const [conflict] = await tx
      .select({ id: routingOperation.id })
      .from(routingOperation)
      .where(
        and(
          eq(routingOperation.tenantId, tenantId),
          eq(routingOperation.routingId, existing.routingId),
          eq(routingOperation.sequence, input.sequence),
        ),
      );
    if (conflict) {
      throw new RoutingError(`Sequence ${input.sequence} is already used in this routing.`);
    }
  }

  if (input.workCentreId !== undefined && input.workCentreId !== existing.workCentreId) {
    const [centre] = await tx
      .select({ id: workCentre.id })
      .from(workCentre)
      .where(and(eq(workCentre.tenantId, tenantId), eq(workCentre.id, input.workCentreId)));
    if (!centre) throw new RoutingError('Work centre not found.');
  }

  await tx
    .update(routingOperation)
    .set({
      sequence: input.sequence ?? existing.sequence,
      name: input.name ?? existing.name,
      workCentreId: input.workCentreId ?? existing.workCentreId,
      setupMinutes:
        input.setupMinutes !== undefined ? numOrNull(input.setupMinutes) : existing.setupMinutes,
      runMinutesPerUnit:
        input.runMinutesPerUnit !== undefined
          ? numOrNull(input.runMinutesPerUnit)
          : existing.runMinutesPerUnit,
      cureMinutes: input.cureMinutes ?? existing.cureMinutes,
      isQualityGate: input.isQualityGate ?? existing.isQualityGate,
      instructions: input.instructions !== undefined ? input.instructions : existing.instructions,
      updatedAt: new Date(),
    })
    .where(eq(routingOperation.id, input.operationId));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'production.routing',
    entityId: existing.routingId,
    entityLabel: input.name ?? existing.name,
    action: 'update',
    reason: `Operation at sequence ${existing.sequence} updated.`,
  });
}

/**
 * Removes a step from a routing.
 *
 * A hard delete: `routing_operation` carries no soft-delete column, unlike
 * `kernel.item`, and nothing references a routing operation by id — a work
 * order's own operations are a snapshot copied at creation time (see
 * `instantiateRouting`), not a foreign key to this row. Deleting it here does
 * not touch a job already on the floor.
 */
export async function removeRoutingOperation(
  tx: Transaction,
  input: { operationId: string },
): Promise<void> {
  const { tenantId } = requireTenantContext();

  const [existing] = await tx
    .select()
    .from(routingOperation)
    .where(and(eq(routingOperation.tenantId, tenantId), eq(routingOperation.id, input.operationId)));
  if (!existing) throw new RoutingError('Routing operation not found.');

  await tx.delete(routingOperation).where(eq(routingOperation.id, input.operationId));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'production.routing',
    entityId: existing.routingId,
    entityLabel: existing.name,
    action: 'delete',
    reason: `Operation at sequence ${existing.sequence} removed.`,
  });
}

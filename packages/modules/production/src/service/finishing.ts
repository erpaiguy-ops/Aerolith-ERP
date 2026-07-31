/**
 * Finishing batches — loading and moving a spray load through the booth.
 *
 * `production.finishing.manage` had nothing behind it: the schema and the
 * register (`listFinishingBatches` in `registers.ts`) existed, but nothing
 * ever inserted a `finishing_batch` row outside the demo seed script, which
 * writes the table directly rather than through a service. This file is that
 * missing write path.
 */
import { allocateNumber, recordAudit, requireTenantContext, type Transaction } from '@aerolith/kernel';
import { and, eq, inArray } from 'drizzle-orm';

import { finishingBatch, finishingBatchPart, workCentre, workOrderPart } from '../db/schema';
import { MODULE_KEY } from './workOrders';

export class FinishingError extends Error {
  override readonly name = 'FinishingError';
}

export type FinishingStatus = 'queued' | 'spraying' | 'curing' | 'completed' | 'rejected';

export interface FinishingBatchPartInput {
  partId: string;
  quantity: number;
  isRework?: boolean;
}

export interface CreateFinishingBatchInput {
  workCentreId: string;
  colourCode?: string | null;
  sheenCode?: string | null;
  coatNumber?: number;
  totalCoats?: number;
  cureMinutes?: number;
  notes?: string | null;
  parts: FinishingBatchPartInput[];
}

/** Loads a spray booth — everything in the load shares one finish. */
export async function createFinishingBatch(
  tx: Transaction,
  input: CreateFinishingBatchInput,
): Promise<{ batchId: string; number: string }> {
  const { tenantId } = requireTenantContext();

  if (input.parts.length === 0) {
    throw new FinishingError('A spray load needs at least one part.');
  }
  for (const part of input.parts) {
    if (part.quantity <= 0) throw new FinishingError('Every part in the load needs a positive quantity.');
  }
  const partIds = input.parts.map((p) => p.partId);
  if (new Set(partIds).size !== partIds.length) {
    throw new FinishingError('The same part was listed twice in this load.');
  }

  const [centre] = await tx
    .select({ id: workCentre.id })
    .from(workCentre)
    .where(and(eq(workCentre.tenantId, tenantId), eq(workCentre.id, input.workCentreId)));
  if (!centre) throw new FinishingError('Work centre not found.');

  const parts = await tx
    .select({ id: workOrderPart.id })
    .from(workOrderPart)
    .where(and(eq(workOrderPart.tenantId, tenantId), inArray(workOrderPart.id, partIds)));
  if (parts.length !== partIds.length) {
    throw new FinishingError('One or more parts were not found.');
  }

  const allocated = await allocateNumber(tx, { entityType: 'production.finishing_batch' });

  const [created] = await tx
    .insert(finishingBatch)
    .values({
      tenantId,
      number: allocated.formatted,
      workCentreId: input.workCentreId,
      status: 'queued',
      colourCode: input.colourCode ?? null,
      sheenCode: input.sheenCode ?? null,
      coatNumber: input.coatNumber ?? 1,
      totalCoats: input.totalCoats ?? 1,
      cureMinutes: input.cureMinutes ?? 0,
      notes: input.notes ?? null,
    })
    .returning({ id: finishingBatch.id });

  const batchId = created!.id;

  await tx.insert(finishingBatchPart).values(
    input.parts.map((part) => ({
      tenantId,
      batchId,
      partId: part.partId,
      quantity: part.quantity,
      isRework: part.isRework ?? false,
    })),
  );

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'production.finishing_batch',
    entityId: batchId,
    entityLabel: allocated.formatted,
    action: 'create',
  });

  return { batchId, number: allocated.formatted };
}

/**
 * Where a batch is allowed to go next.
 *
 * `completed` and `rejected` are terminal — a booth's own history does not
 * get rewritten once a load is out. `queued` can go straight to `rejected`
 * (conditions found unfit before it was ever sprayed) as well as forward to
 * `spraying`. `spraying` can skip `curing` and land on `completed` directly —
 * a finish with zero cure minutes has nothing to wait for.
 */
const ALLOWED_TRANSITIONS: Record<FinishingStatus, readonly FinishingStatus[]> = {
  queued: ['spraying', 'rejected'],
  spraying: ['curing', 'completed', 'rejected'],
  curing: ['completed', 'rejected'],
  completed: [],
  rejected: [],
};

export interface UpdateFinishingBatchStatusInput {
  batchId: string;
  status: FinishingStatus;
  holdReason?: string | null;
  notes?: string | null;
}

/**
 * Moves a batch to its next state and derives the cure clock as it goes.
 *
 * `sprayedAt` is set the moment spraying finishes (the transition INTO
 * `curing`, or straight into `completed` when there is nothing to cure) —
 * matching what the register already assumes: `cureCompletesAt` is
 * `sprayedAt + cureMinutes`, not the moment the load was queued.
 */
export async function updateFinishingBatchStatus(
  tx: Transaction,
  input: UpdateFinishingBatchStatusInput,
): Promise<{ status: FinishingStatus }> {
  const { tenantId } = requireTenantContext();

  const [existing] = await tx
    .select()
    .from(finishingBatch)
    .where(and(eq(finishingBatch.tenantId, tenantId), eq(finishingBatch.id, input.batchId)))
    .limit(1)
    .for('update');
  if (!existing) throw new FinishingError('Finishing batch not found.');

  const current = existing.status as FinishingStatus;
  if (current === input.status) {
    throw new FinishingError(`This batch is already ${input.status}.`);
  }

  const allowed = ALLOWED_TRANSITIONS[current];
  if (!allowed.includes(input.status)) {
    throw new FinishingError(`A ${current} batch cannot move to ${input.status}.`);
  }

  const now = new Date();
  const patch: Partial<typeof finishingBatch.$inferInsert> = {
    status: input.status,
    updatedAt: now,
  };

  if (input.status === 'curing') {
    patch.sprayedAt = now;
    patch.cureCompletesAt =
      existing.cureMinutes > 0 ? new Date(now.getTime() + existing.cureMinutes * 60_000) : now;
  } else if (input.status === 'completed') {
    patch.completedAt = now;
    // Straight from `spraying` with no cure step — the clock never started.
    if (existing.sprayedAt == null) patch.sprayedAt = now;
  } else if (input.status === 'rejected') {
    patch.completedAt = now;
    if (input.holdReason !== undefined) patch.holdReason = input.holdReason;
  }

  if (input.notes !== undefined) patch.notes = input.notes;

  await tx.update(finishingBatch).set(patch).where(eq(finishingBatch.id, existing.id));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'production.finishing_batch',
    entityId: existing.id,
    entityLabel: existing.number ?? existing.id,
    action: 'update',
    reason: `Status: ${current} → ${input.status}`,
  });

  return { status: input.status };
}

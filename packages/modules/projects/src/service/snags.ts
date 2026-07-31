/**
 * The snag register's write side.
 *
 * Kept apart from `registers.ts` for the same reason `movements.ts` is kept
 * apart from the inventory module's `registers.ts`: reading the register and
 * changing what is on it are different kinds of surface, and a single file
 * that did both would make it easy to miss which functions here actually
 * commit anything.
 */
import {
  allocateNumber,
  recordAudit,
  requireTenantContext,
  type Transaction,
} from '@aerolith/kernel';
import { and, eq } from 'drizzle-orm';

import { snag } from '../db/schema';

const MODULE_KEY = 'projects';

export class SnagError extends Error {
  override readonly name = 'SnagError';
}

type SnagSeverity = 'minor' | 'major' | 'critical';
type SnagCloseStatus = 'closed' | 'rejected';

const today = (): string => new Date().toISOString().slice(0, 10);

export interface CreateSnagInput {
  projectId: string;
  wbsNodeId?: string | null;
  location?: string | null;
  description: string;
  severity?: SnagSeverity;
  raisedBy?: string | null;
  raisedOn?: string;
  assignedToUserId?: string | null;
  assignedToPartyId?: string | null;
  targetDate?: string | null;
}

/**
 * Raises a snag and allocates its reference from the `projects.snag` series
 * the manifest declares (`SNG-{YYYY}-{SEQ}`).
 */
export async function createSnag(
  tx: Transaction,
  input: CreateSnagInput,
): Promise<{ id: string; reference: string }> {
  const { tenantId } = requireTenantContext();

  const allocated = await allocateNumber(tx, { entityType: 'projects.snag' });

  const [created] = await tx
    .insert(snag)
    .values({
      tenantId,
      projectId: input.projectId,
      wbsNodeId: input.wbsNodeId,
      reference: allocated.formatted,
      location: input.location,
      description: input.description,
      severity: input.severity ?? 'minor',
      status: 'open',
      raisedBy: input.raisedBy,
      raisedOn: input.raisedOn ?? today(),
      assignedToUserId: input.assignedToUserId,
      assignedToPartyId: input.assignedToPartyId,
      targetDate: input.targetDate,
    })
    .returning({ id: snag.id, reference: snag.reference });

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'projects.snag',
    entityId: created!.id,
    entityLabel: created!.reference,
    action: 'create',
  });

  return { id: created!.id, reference: created!.reference };
}

export interface UpdateSnagInput {
  snagId: string;
  wbsNodeId?: string | null;
  location?: string | null;
  description?: string;
  severity?: SnagSeverity;
  raisedBy?: string | null;
  raisedOn?: string;
  assignedToUserId?: string | null;
  assignedToPartyId?: string | null;
  targetDate?: string | null;
}

/** Edits a snag's descriptive fields. Never touches status — see `closeSnag`. */
export async function updateSnag(tx: Transaction, input: UpdateSnagInput): Promise<void> {
  const { tenantId } = requireTenantContext();

  const [existing] = await tx
    .select()
    .from(snag)
    .where(and(eq(snag.tenantId, tenantId), eq(snag.id, input.snagId)));
  if (!existing) throw new SnagError('Snag not found.');

  await tx
    .update(snag)
    .set({
      wbsNodeId: input.wbsNodeId !== undefined ? input.wbsNodeId : existing.wbsNodeId,
      location: input.location !== undefined ? input.location : existing.location,
      description: input.description ?? existing.description,
      severity: input.severity ?? existing.severity,
      raisedBy: input.raisedBy !== undefined ? input.raisedBy : existing.raisedBy,
      raisedOn: input.raisedOn ?? existing.raisedOn,
      assignedToUserId:
        input.assignedToUserId !== undefined ? input.assignedToUserId : existing.assignedToUserId,
      assignedToPartyId:
        input.assignedToPartyId !== undefined
          ? input.assignedToPartyId
          : existing.assignedToPartyId,
      targetDate: input.targetDate !== undefined ? input.targetDate : existing.targetDate,
      updatedAt: new Date(),
    })
    .where(eq(snag.id, input.snagId));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'projects.snag',
    entityId: input.snagId,
    entityLabel: existing.reference,
    action: 'update',
  });
}

export interface CloseSnagInput {
  snagId: string;
  closedBy: string;
  status: SnagCloseStatus;
}

/**
 * Closes or rejects a snag. `rejected` is a live state, not a done one — see
 * `listSnags`, which still counts a rejected critical snag as blocking
 * handover — so this refuses to move a snag OUT of either terminal state, not
 * just to prevent closing twice.
 */
export async function closeSnag(tx: Transaction, input: CloseSnagInput): Promise<void> {
  const { tenantId } = requireTenantContext();

  const [existing] = await tx
    .select()
    .from(snag)
    .where(and(eq(snag.tenantId, tenantId), eq(snag.id, input.snagId)));
  if (!existing) throw new SnagError('Snag not found.');

  if (existing.status === 'closed' || existing.status === 'rejected') {
    throw new SnagError(`Snag "${existing.reference}" is already ${existing.status}.`);
  }

  await tx
    .update(snag)
    .set({
      status: input.status,
      closedOn: today(),
      closedBy: input.closedBy,
      updatedAt: new Date(),
    })
    .where(eq(snag.id, input.snagId));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'projects.snag',
    entityId: input.snagId,
    entityLabel: existing.reference,
    action: input.status === 'rejected' ? 'reject' : 'update',
  });
}

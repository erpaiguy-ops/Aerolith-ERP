/**
 * The approved supplier list.
 *
 * `kernel.party.isSupplier` is a role flag — it says a company COULD be bought
 * from, nothing more, and any party record can carry it from the moment it is
 * created. This file owns the separate, narrower fact procurement actually
 * needs before an order goes out: has this supplier been vetted, and are they
 * currently cleared to receive one. Kept as its own register rather than a
 * second flag on the party, for the same reason `kernel.party.isBlocked`
 * carries a `blockReason` next to it — qualifying or suspending a supplier is
 * a decision that needs a record, and a boolean loses it the moment someone
 * asks why.
 */
import {
  listResult,
  recordAudit,
  requireTenantContext,
  schema,
  type ListParams,
  type ListResult,
  type Transaction,
} from '@aerolith/kernel';
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { supplierQualification } from '../db/schema';

export const MODULE_KEY = 'procurement';

export class SupplierQualificationError extends Error {
  override readonly name = 'SupplierQualificationError';
}

export type SupplierQualificationStatus = 'pending' | 'approved' | 'suspended';

// ---------------------------------------------------------------------------
// Qualify
// ---------------------------------------------------------------------------

export interface QualifySupplierInput {
  partyId: string;
  status?: SupplierQualificationStatus;
  reason?: string | null;
  /** kernel.item_category — null qualifies the supplier for everything. */
  categoryId?: string | null;
  reviewDate?: string | null;
  approvedBy?: string | null;
}

/**
 * Adds a party to the approved supplier list — globally, or for one category.
 *
 * Refuses a party that is not marked `isSupplier`: qualifying a customer or a
 * consultant is not a status this list should ever record, because nothing
 * downstream that reads it would know what to do with the result.
 */
export async function qualifySupplier(
  tx: Transaction,
  input: QualifySupplierInput,
): Promise<{ qualificationId: string }> {
  const { tenantId } = requireTenantContext();

  const [party] = await tx
    .select()
    .from(schema.party)
    .where(and(eq(schema.party.tenantId, tenantId), eq(schema.party.id, input.partyId)));

  if (!party) throw new SupplierQualificationError('Party not found.');
  if (!party.isSupplier) {
    throw new SupplierQualificationError(
      `${party.name} is not marked as a supplier — set the supplier role on the party record before qualifying them.`,
    );
  }

  const status = input.status ?? 'pending';
  if (status === 'approved' && !input.approvedBy) {
    throw new SupplierQualificationError('Approving a supplier needs who approved it.');
  }

  const now = new Date();
  const [created] = await tx
    .insert(supplierQualification)
    .values({
      tenantId,
      partyId: input.partyId,
      status,
      reason: input.reason,
      categoryId: input.categoryId,
      reviewDate: input.reviewDate,
      approvedBy: status === 'approved' ? input.approvedBy : null,
      approvedAt: status === 'approved' ? now : null,
    })
    .returning({ id: supplierQualification.id });

  const qualificationId = created!.id;

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    action: 'create',
    entityType: 'procurement.supplier_qualification',
    entityId: qualificationId,
    entityLabel: `${party.code} — ${party.name}`,
    reason: input.reason ?? undefined,
    metadata: { partyId: input.partyId, status, categoryId: input.categoryId ?? null },
  });

  return { qualificationId };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export interface UpdateSupplierQualificationInput {
  qualificationId: string;
  status?: SupplierQualificationStatus;
  reason?: string | null;
  reviewDate?: string | null;
}

/**
 * Changes a supplier's status — approve, suspend, or send back to pending.
 *
 * Mirrors `updateParty`'s `isBlocked`/`blockReason` guard exactly: moving TO
 * `suspended` needs a reason, either supplied now or already on the row, and
 * a reason of only whitespace does not count. Suspending is the control that
 * stops the next purchase order going to this supplier, and a suspension with
 * no reason on file is one nobody can explain when it is challenged.
 */
export async function updateSupplierQualification(
  tx: Transaction,
  input: UpdateSupplierQualificationInput,
): Promise<void> {
  const { tenantId, userId } = requireTenantContext();

  const [existing] = await tx
    .select()
    .from(supplierQualification)
    .where(
      and(
        eq(supplierQualification.tenantId, tenantId),
        eq(supplierQualification.id, input.qualificationId),
      ),
    );
  if (!existing) throw new SupplierQualificationError('Supplier qualification not found.');

  const nextStatus = input.status ?? existing.status;
  const nextReason = input.reason !== undefined ? input.reason : existing.reason;

  if (nextStatus === 'suspended' && !nextReason?.trim()) {
    throw new SupplierQualificationError(
      'Suspending a supplier needs a reason — it stops procurement placing orders with them.',
    );
  }

  const now = new Date();
  // Only a genuine transition into 'approved' stamps who approved it and when
  // — re-saving an already-approved row (a changed review date, say) must not
  // silently move the approval date forward.
  const becomingApproved = nextStatus === 'approved' && existing.status !== 'approved';

  await tx
    .update(supplierQualification)
    .set({
      status: nextStatus,
      reason: nextReason,
      reviewDate: input.reviewDate !== undefined ? input.reviewDate : existing.reviewDate,
      approvedBy: becomingApproved ? userId : existing.approvedBy,
      approvedAt: becomingApproved ? now : existing.approvedAt,
      updatedAt: now,
    })
    .where(eq(supplierQualification.id, input.qualificationId));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    action: 'update',
    entityType: 'procurement.supplier_qualification',
    entityId: input.qualificationId,
    entityLabel: input.qualificationId,
    reason: nextReason ?? undefined,
    metadata: { status: nextStatus, previousStatus: existing.status },
  });
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export const SUPPLIER_QUALIFICATION_SORTS = ['createdAt', 'reviewDate', 'status'] as const;

export interface SupplierQualificationListRow {
  id: string;
  partyId: string;
  partyCode: string | null;
  partyName: string | null;
  status: string;
  reason: string | null;
  categoryId: string | null;
  reviewDate: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listSupplierQualifications(
  tx: Transaction,
  params: ListParams,
  filters: { status?: string; categoryId?: string } = {},
): Promise<ListResult<SupplierQualificationListRow>> {
  const { tenantId } = requireTenantContext();

  const conditions = [eq(supplierQualification.tenantId, tenantId)];
  if (filters.status) conditions.push(eq(supplierQualification.status, filters.status as never));
  if (filters.categoryId) {
    conditions.push(eq(supplierQualification.categoryId, filters.categoryId));
  }

  const where = and(...conditions);

  const sortColumn =
    {
      createdAt: supplierQualification.createdAt,
      reviewDate: supplierQualification.reviewDate,
      status: supplierQualification.status,
    }[params.sort as string] ?? supplierQualification.createdAt;

  const rows = await tx
    .select({
      id: supplierQualification.id,
      partyId: supplierQualification.partyId,
      partyCode: schema.party.code,
      partyName: schema.party.name,
      status: supplierQualification.status,
      reason: supplierQualification.reason,
      categoryId: supplierQualification.categoryId,
      reviewDate: sql<string | null>`${supplierQualification.reviewDate}`,
      approvedBy: supplierQualification.approvedBy,
      approvedAt: sql<string | null>`${supplierQualification.approvedAt}`,
      createdAt: sql<string>`${supplierQualification.createdAt}`,
      updatedAt: sql<string>`${supplierQualification.updatedAt}`,
    })
    .from(supplierQualification)
    .leftJoin(
      schema.party,
      and(
        eq(schema.party.id, supplierQualification.partyId),
        eq(schema.party.tenantId, tenantId),
      ),
    )
    .where(where)
    .orderBy(
      params.direction === 'asc' ? asc(sortColumn) : desc(sortColumn),
      asc(supplierQualification.id),
    )
    .limit(params.pageSize)
    .offset(params.offset);

  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(supplierQualification)
    .where(where);

  return listResult(rows, counted?.total ?? 0, params);
}

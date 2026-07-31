/**
 * Back charges — costs the contractor incurs recovering from a subcontractor
 * (damage, attendance, rectification, materials) and deducts from what is
 * paid them.
 *
 * The table existed since the first migration; every payment application
 * since has taken `backChargesToDate` as a manually typed number instead,
 * trusting whoever filled in the form to remember what the register would
 * have said. `sumAgreedBackCharges` closes that: `createPaymentApplication`
 * now falls back to it when the caller does not override the figure.
 */
import {
  listResult,
  recordAudit,
  requireTenantContext,
  type ListParams,
  type ListResult,
  type Transaction,
} from '@aerolith/kernel';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { backCharge, contract } from '../db/schema';

const MODULE_KEY = 'contracts';

export class BackChargeError extends Error {
  override readonly name = 'BackChargeError';
}

/** Amounts in this status or later are settled enough to actually deduct. */
const AGREED_STATUSES = ['agreed', 'recovered'] as const;

export interface BackChargeRow {
  id: string;
  contractId: string;
  reference: string;
  description: string;
  category: string;
  amount: string;
  incurredOn: string;
  status: string;
  notifiedOn: string | null;
  agreedAmount: string | null;
  sourceSnagId: string | null;
}

export const BACK_CHARGE_SORTS = ['incurredOn', 'reference', 'amount', 'status'] as const;
export type BackChargeSort = (typeof BACK_CHARGE_SORTS)[number];

export async function listBackCharges(
  tx: Transaction,
  params: ListParams<BackChargeSort>,
  filters: { contractId?: string; status?: string } = {},
): Promise<ListResult<BackChargeRow>> {
  const { tenantId } = requireTenantContext();

  const conditions = [eq(backCharge.tenantId, tenantId)];
  if (filters.contractId) conditions.push(eq(backCharge.contractId, filters.contractId));
  if (filters.status) conditions.push(eq(backCharge.status, filters.status));

  const where = and(...conditions);

  const sortColumn = {
    incurredOn: backCharge.incurredOn,
    reference: backCharge.reference,
    amount: backCharge.amount,
    status: backCharge.status,
  }[params.sort] ?? backCharge.incurredOn;

  const rows = await tx
    .select({
      id: backCharge.id,
      contractId: backCharge.contractId,
      reference: backCharge.reference,
      description: backCharge.description,
      category: backCharge.category,
      amount: backCharge.amount,
      incurredOn: backCharge.incurredOn,
      status: backCharge.status,
      notifiedOn: backCharge.notifiedOn,
      agreedAmount: backCharge.agreedAmount,
      sourceSnagId: backCharge.sourceSnagId,
    })
    .from(backCharge)
    .where(where)
    .orderBy(params.direction === 'asc' ? asc(sortColumn) : desc(sortColumn), asc(backCharge.id))
    .limit(params.pageSize)
    .offset(params.offset);

  const [counted] = await tx.select({ total: sql<number>`count(*)::int` }).from(backCharge).where(where);

  return listResult(rows, counted?.total ?? 0, params);
}

export interface CreateBackChargeInput {
  contractId: string;
  reference: string;
  description: string;
  category?: string;
  amount: number;
  incurredOn: string;
  sourceSnagId?: string | null;
  documentIds?: string[];
}

/**
 * Raises a back charge. `reference` is chosen by the caller, not allocated —
 * unlike a variation or an application, a back charge is usually numbered
 * against the subcontractor's own correspondence ("BC-04"), not the
 * contractor's own sequence.
 */
export async function createBackCharge(
  tx: Transaction,
  input: CreateBackChargeInput,
): Promise<{ id: string }> {
  const { tenantId } = requireTenantContext();

  const [head] = await tx
    .select({ id: contract.id, number: contract.number })
    .from(contract)
    .where(and(eq(contract.tenantId, tenantId), eq(contract.id, input.contractId)));
  if (!head) throw new BackChargeError('Contract not found.');

  const [row] = await tx
    .insert(backCharge)
    .values({
      tenantId,
      contractId: input.contractId,
      reference: input.reference,
      description: input.description,
      category: input.category ?? 'other',
      amount: String(input.amount),
      incurredOn: input.incurredOn,
      sourceSnagId: input.sourceSnagId,
      documentIds: input.documentIds ?? [],
    })
    .onConflictDoNothing({ target: [backCharge.contractId, backCharge.reference] })
    .returning({ id: backCharge.id });

  if (!row) throw new BackChargeError(`"${input.reference}" is already in use on this contract.`);

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'contracts.back_charge',
    entityId: row.id,
    entityLabel: `${input.reference} — ${head.number ?? head.id}`,
    action: 'create',
  });

  return { id: row.id };
}

export interface UpdateBackChargeInput {
  description?: string;
  category?: string;
  amount?: number;
  incurredOn?: string;
  status?: string;
  notifiedOn?: string | null;
  agreedAmount?: number | null;
  sourceSnagId?: string | null;
  documentIds?: string[];
}

const VALID_STATUSES = ['raised', 'notified', 'agreed', 'disputed', 'recovered', 'written_off'];

export async function updateBackCharge(
  tx: Transaction,
  input: { backChargeId: string } & UpdateBackChargeInput,
): Promise<void> {
  const { tenantId } = requireTenantContext();

  const [existing] = await tx
    .select()
    .from(backCharge)
    .where(and(eq(backCharge.tenantId, tenantId), eq(backCharge.id, input.backChargeId)));
  if (!existing) throw new BackChargeError('Back charge not found.');

  if (input.status && !VALID_STATUSES.includes(input.status)) {
    throw new BackChargeError(`"${input.status}" is not a status a back charge can hold.`);
  }
  // Moving to 'agreed' without ever recording what was agreed would leave
  // `sumAgreedBackCharges` deducting the originally CLAIMED amount, which is
  // usually not what a subcontractor actually accepted.
  if (input.status === 'agreed' && input.agreedAmount == null && existing.agreedAmount == null) {
    throw new BackChargeError('Record the agreed amount before marking a back charge agreed.');
  }

  await tx
    .update(backCharge)
    .set({
      description: input.description ?? existing.description,
      category: input.category ?? existing.category,
      amount: input.amount !== undefined ? String(input.amount) : existing.amount,
      incurredOn: input.incurredOn ?? existing.incurredOn,
      status: input.status ?? existing.status,
      notifiedOn: input.notifiedOn !== undefined ? input.notifiedOn : existing.notifiedOn,
      agreedAmount:
        input.agreedAmount !== undefined
          ? input.agreedAmount == null
            ? null
            : String(input.agreedAmount)
          : existing.agreedAmount,
      sourceSnagId: input.sourceSnagId !== undefined ? input.sourceSnagId : existing.sourceSnagId,
      documentIds: input.documentIds ?? existing.documentIds,
      updatedAt: new Date(),
    })
    .where(eq(backCharge.id, input.backChargeId));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'contracts.back_charge',
    entityId: input.backChargeId,
    entityLabel: existing.reference,
    action: 'update',
  });
}

/**
 * The cumulative deduction a payment application should carry, straight from
 * the register: everything 'agreed' or already 'recovered', at the AGREED
 * amount where one was recorded (falling back to the claimed amount only if
 * it genuinely was not). 'disputed' is deliberately excluded — a disputed
 * charge is not a settled deduction, and unilaterally withholding it is how a
 * dispute over one figure turns into a dispute over the whole certificate.
 * 'written_off' is excluded because it no longer is one.
 */
export async function sumAgreedBackCharges(tx: Transaction, contractId: string): Promise<number> {
  const { tenantId } = requireTenantContext();

  const [row] = await tx
    .select({
      total: sql<string>`coalesce(sum(coalesce(${backCharge.agreedAmount}, ${backCharge.amount})), 0)`,
    })
    .from(backCharge)
    .where(
      and(
        eq(backCharge.tenantId, tenantId),
        eq(backCharge.contractId, contractId),
        inArray(backCharge.status, [...AGREED_STATUSES]),
      ),
    );

  return Number(row?.total ?? 0);
}

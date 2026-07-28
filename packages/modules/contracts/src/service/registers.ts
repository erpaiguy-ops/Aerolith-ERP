/**
 * The two contract registers the navigation still promised: correspondence and
 * retention.
 *
 * Both are cross-contract on purpose. "What have I not had an answer to" and
 * "what money is being held and when does it come back" are questions about the
 * business, not about one job — and a per-contract view answers a different
 * question that is already one filter away.
 */
import {
  listResult,
  requireTenantContext,
  searchPattern,
  type ListParams,
  type ListResult,
  type Transaction,
} from '@aerolith/kernel';
import { and, asc, eq, ilike, isNull, or, sql } from 'drizzle-orm';

import { contract, correspondence, paymentApplication, retentionRelease, variation } from '../db/schema';

// ---------------------------------------------------------------------------
// Correspondence — the notice register
// ---------------------------------------------------------------------------

export interface CorrespondenceListRow {
  id: string;
  contractId: string;
  contractNumber: string | null;
  contractName: string;
  type: string;
  reference: string;
  subject: string;
  direction: string;
  issuedOn: string;
  responseDueOn: string | null;
  respondedOn: string | null;
  status: string;
  isContractual: boolean;
  variationId: string | null;
  variationNumber: string | null;
  /** Days until a response is due. Negative once the deadline has passed. */
  daysToResponse: number | null;
  /**
   * Overdue AND contractual — the combination that costs money.
   *
   * An unanswered RFI is an irritation; an unanswered notice on which an
   * extension of time depends is a claim being lost while nobody watches.
   */
  isAtRisk: boolean;
}

export const CORRESPONDENCE_SORTS = [
  'responseDueOn',
  'issuedOn',
  'reference',
  'status',
  'type',
] as const;

export async function listCorrespondence(
  tx: Transaction,
  params: ListParams,
  filters: {
    contractId?: string;
    type?: string;
    status?: string;
    openOnly?: boolean;
    contractualOnly?: boolean;
  } = {},
): Promise<ListResult<CorrespondenceListRow>> {
  const { tenantId } = requireTenantContext();

  const daysToResponse = sql<number | null>`
    case
      when ${correspondence.responseDueOn} is null then null
      else (${correspondence.responseDueOn} - current_date)
    end
  `;

  const isAtRisk = sql<boolean>`(
    ${correspondence.isContractual}
    and ${correspondence.respondedOn} is null
    and ${correspondence.responseDueOn} is not null
    and ${correspondence.responseDueOn} < current_date
  )`;

  const conditions = [eq(correspondence.tenantId, tenantId)];
  if (filters.contractId) conditions.push(eq(correspondence.contractId, filters.contractId));
  if (filters.type) conditions.push(eq(correspondence.type, filters.type));
  if (filters.status) conditions.push(eq(correspondence.status, filters.status));
  // Awaiting a reply — which is not the same as "not closed": a responded item
  // can still be open pending agreement, and that is not what this asks.
  if (filters.openOnly) conditions.push(isNull(correspondence.respondedOn));
  if (filters.contractualOnly) conditions.push(eq(correspondence.isContractual, true));

  if (params.search) {
    const pattern = searchPattern(params.search);
    conditions.push(
      or(
        ilike(correspondence.reference, pattern),
        ilike(correspondence.subject, pattern),
        ilike(contract.number, pattern),
      )!,
    );
  }

  const where = and(...conditions);

  const sortColumn =
    {
      responseDueOn: correspondence.responseDueOn,
      issuedOn: correspondence.issuedOn,
      reference: correspondence.reference,
      status: correspondence.status,
      type: correspondence.type,
    }[params.sort as string] ?? correspondence.responseDueOn;

  const rows = await tx
    .select({
      id: correspondence.id,
      contractId: correspondence.contractId,
      contractNumber: contract.number,
      contractName: contract.name,
      type: correspondence.type,
      reference: correspondence.reference,
      subject: correspondence.subject,
      direction: correspondence.direction,
      issuedOn: correspondence.issuedOn,
      responseDueOn: correspondence.responseDueOn,
      respondedOn: correspondence.respondedOn,
      status: correspondence.status,
      isContractual: correspondence.isContractual,
      variationId: correspondence.variationId,
      variationNumber: variation.number,
      daysToResponse,
      isAtRisk,
    })
    .from(correspondence)
    .innerJoin(
      contract,
      and(eq(contract.id, correspondence.contractId), eq(contract.tenantId, tenantId)),
    )
    .leftJoin(variation, eq(variation.id, correspondence.variationId))
    .where(where)
    // Nulls last: an item with no response deadline is not the most urgent thing
    // on a register sorted by deadline.
    .orderBy(
      params.direction === 'asc'
        ? sql`${sortColumn} asc nulls last`
        : sql`${sortColumn} desc nulls last`,
      asc(correspondence.id),
    )
    .limit(params.pageSize)
    .offset(params.offset);

  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(correspondence)
    .innerJoin(
      contract,
      and(eq(contract.id, correspondence.contractId), eq(contract.tenantId, tenantId)),
    )
    .where(where);

  return listResult(rows, counted?.total ?? 0, params);
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export interface RetentionListRow {
  id: string;
  contractId: string;
  contractNumber: string | null;
  contractName: string;
  currencyCode: string | null;
  trigger: string;
  amount: string;
  dueOn: string | null;
  releasedOn: string | null;
  applicationId: string | null;
  applicationNumber: string | null;
  note: string | null;
  /** Days until release falls due. Negative once it is late. */
  daysToDue: number | null;
  /** Due, and nobody has claimed it. This is the money that goes missing. */
  isOverdue: boolean;
}

export const RETENTION_SORTS = ['dueOn', 'amount', 'contractNumber', 'trigger'] as const;

export interface RetentionSummary {
  /** Unreleased and not yet due. */
  heldValue: number;
  /** Unreleased and the due date has arrived — claimable today. */
  dueValue: number;
  releasedValue: number;
  currencyCode: string | null;
}

export async function listRetention(
  tx: Transaction,
  params: ListParams,
  filters: { contractId?: string; state?: 'held' | 'due' | 'released' } = {},
): Promise<ListResult<RetentionListRow>> {
  const { tenantId } = requireTenantContext();

  const daysToDue = sql<number | null>`
    case
      when ${retentionRelease.dueOn} is null then null
      else (${retentionRelease.dueOn} - current_date)
    end
  `;

  const isOverdue = sql<boolean>`(
    ${retentionRelease.releasedOn} is null
    and ${retentionRelease.dueOn} is not null
    and ${retentionRelease.dueOn} < current_date
  )`;

  const conditions = [eq(retentionRelease.tenantId, tenantId)];
  if (filters.contractId) conditions.push(eq(retentionRelease.contractId, filters.contractId));
  if (filters.state === 'released') conditions.push(sql`${retentionRelease.releasedOn} is not null`);
  if (filters.state === 'due') conditions.push(isOverdue);
  if (filters.state === 'held') {
    conditions.push(
      sql`${retentionRelease.releasedOn} is null and (${retentionRelease.dueOn} is null or ${retentionRelease.dueOn} >= current_date)`,
    );
  }

  if (params.search) {
    const pattern = searchPattern(params.search);
    conditions.push(or(ilike(contract.number, pattern), ilike(contract.name, pattern))!);
  }

  const where = and(...conditions);

  const sortColumn =
    {
      dueOn: retentionRelease.dueOn,
      amount: retentionRelease.amount,
      contractNumber: contract.number,
      trigger: retentionRelease.trigger,
    }[params.sort as string] ?? retentionRelease.dueOn;

  const rows = await tx
    .select({
      id: retentionRelease.id,
      contractId: retentionRelease.contractId,
      contractNumber: contract.number,
      contractName: contract.name,
      currencyCode: contract.currencyCode,
      trigger: retentionRelease.trigger,
      amount: retentionRelease.amount,
      dueOn: retentionRelease.dueOn,
      releasedOn: retentionRelease.releasedOn,
      applicationId: retentionRelease.applicationId,
      applicationNumber: paymentApplication.number,
      note: retentionRelease.note,
      daysToDue,
      isOverdue,
    })
    .from(retentionRelease)
    .innerJoin(
      contract,
      and(eq(contract.id, retentionRelease.contractId), eq(contract.tenantId, tenantId)),
    )
    .leftJoin(paymentApplication, eq(paymentApplication.id, retentionRelease.applicationId))
    .where(where)
    .orderBy(
      params.direction === 'asc'
        ? sql`${sortColumn} asc nulls last`
        : sql`${sortColumn} desc nulls last`,
      asc(retentionRelease.id),
    )
    .limit(params.pageSize)
    .offset(params.offset);

  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(retentionRelease)
    .innerJoin(
      contract,
      and(eq(contract.id, retentionRelease.contractId), eq(contract.tenantId, tenantId)),
    )
    .where(where);

  return listResult(rows, counted?.total ?? 0, params);
}

/**
 * What is held, what is due, and what has come back.
 *
 * Spans the whole register rather than the page, because the total held is the
 * number the register exists to produce — retention is the largest sum on a
 * joinery job that nobody has an owner for, and it is released by asking.
 */
export async function summariseRetention(
  tx: Transaction,
  filters: { contractId?: string } = {},
): Promise<RetentionSummary> {
  const { tenantId } = requireTenantContext();

  const conditions = [eq(retentionRelease.tenantId, tenantId)];
  if (filters.contractId) conditions.push(eq(retentionRelease.contractId, filters.contractId));

  const [row] = await tx
    .select({
      heldValue: sql<string>`coalesce(sum(${retentionRelease.amount}) filter (
        where ${retentionRelease.releasedOn} is null
          and (${retentionRelease.dueOn} is null or ${retentionRelease.dueOn} >= current_date)
      ), 0)`,
      dueValue: sql<string>`coalesce(sum(${retentionRelease.amount}) filter (
        where ${retentionRelease.releasedOn} is null and ${retentionRelease.dueOn} < current_date
      ), 0)`,
      releasedValue: sql<string>`coalesce(sum(${retentionRelease.amount}) filter (
        where ${retentionRelease.releasedOn} is not null
      ), 0)`,
    })
    .from(retentionRelease)
    .where(and(...conditions));

  // One currency, because a total across currencies is not a number. The tenant
  // base currency is what the screen falls back to.
  const [anyContract] = await tx
    .select({ currencyCode: contract.currencyCode })
    .from(contract)
    .where(eq(contract.tenantId, tenantId))
    .limit(1);

  return {
    heldValue: Number(row?.heldValue ?? 0),
    dueValue: Number(row?.dueValue ?? 0),
    releasedValue: Number(row?.releasedValue ?? 0),
    currencyCode: anyContract?.currencyCode ?? null,
  };
}

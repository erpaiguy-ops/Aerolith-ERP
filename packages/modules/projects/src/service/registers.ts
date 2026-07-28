/**
 * The three project registers the navigation still promised: snags, job costs
 * and progress.
 *
 * All three are cross-project. The per-project views already exist and answer a
 * different question; these answer "where is the business", which is the one a
 * commercial manager asks first and which no per-project screen can produce.
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

import { costEntry, progressEntry, snag, wbsNode } from '../db/schema';

// ---------------------------------------------------------------------------
// Snags
// ---------------------------------------------------------------------------

export interface SnagListRow {
  id: string;
  projectId: string;
  projectCode: string | null;
  projectName: string | null;
  reference: string;
  location: string | null;
  description: string;
  severity: string;
  status: string;
  raisedOn: string;
  targetDate: string | null;
  closedOn: string | null;
  assignedToPartyName: string | null;
  wbsCode: string | null;
  backChargeAmount: string | null;
  photoCount: number;
  /** Days until the target date. Negative once it has passed. */
  daysToTarget: number | null;
  /** Open, past its target date. */
  isOverdue: boolean;
  /** Critical and open — this is what stops a handover. */
  blocksHandover: boolean;
}

export const SNAG_SORTS = ['targetDate', 'raisedOn', 'severity', 'reference', 'status'] as const;

export async function listSnags(
  tx: Transaction,
  params: ListParams,
  filters: {
    projectId?: string;
    status?: string;
    severity?: string;
    openOnly?: boolean;
    overdueOnly?: boolean;
  } = {},
): Promise<ListResult<SnagListRow>> {
  const { tenantId } = requireTenantContext();

  const openStatuses = ['open', 'in_progress', 'ready_for_inspection', 'rejected'] as const;

  const daysToTarget = sql<number | null>`
    case when ${snag.targetDate} is null then null else (${snag.targetDate} - current_date) end
  `;

  const isOverdue = sql<boolean>`(
    ${snag.closedOn} is null
    and ${snag.targetDate} is not null
    and ${snag.targetDate} < current_date
  )`;

  // `rejected` counts as open on purpose: a snag the subcontractor disputes is
  // still a snag, and treating it as closed is how it disappears until handover.
  const blocksHandover = sql<boolean>`(
    ${snag.severity} = 'critical' and ${snag.status} <> 'closed'
  )`;

  const conditions = [eq(snag.tenantId, tenantId)];
  if (filters.projectId) conditions.push(eq(snag.projectId, filters.projectId));
  if (filters.status) conditions.push(eq(snag.status, filters.status as never));
  if (filters.severity) conditions.push(eq(snag.severity, filters.severity));
  if (filters.openOnly) conditions.push(inArray(snag.status, [...openStatuses]));
  if (filters.overdueOnly) conditions.push(isOverdue);

  if (params.search) {
    const pattern = searchPattern(params.search);
    conditions.push(
      or(
        ilike(snag.reference, pattern),
        ilike(snag.description, pattern),
        ilike(snag.location, pattern),
      )!,
    );
  }

  const where = and(...conditions);

  const sortColumn =
    {
      targetDate: snag.targetDate,
      raisedOn: snag.raisedOn,
      severity: snag.severity,
      reference: snag.reference,
      status: snag.status,
    }[params.sort as string] ?? snag.targetDate;

  const rows = await tx
    .select({
      id: snag.id,
      projectId: snag.projectId,
      projectCode: schema.project.code,
      projectName: schema.project.name,
      reference: snag.reference,
      location: snag.location,
      description: snag.description,
      severity: snag.severity,
      status: snag.status,
      raisedOn: snag.raisedOn,
      targetDate: snag.targetDate,
      closedOn: snag.closedOn,
      assignedToPartyName: schema.party.name,
      wbsCode: wbsNode.code,
      backChargeAmount: snag.backChargeAmount,
      photoCount: sql<number>`coalesce(jsonb_array_length(${snag.documentIds}), 0)`,
      daysToTarget,
      isOverdue,
      blocksHandover,
    })
    .from(snag)
    .leftJoin(
      schema.project,
      and(eq(schema.project.id, snag.projectId), eq(schema.project.tenantId, tenantId)),
    )
    .leftJoin(
      schema.party,
      and(eq(schema.party.id, snag.assignedToPartyId), eq(schema.party.tenantId, tenantId)),
    )
    .leftJoin(wbsNode, eq(wbsNode.id, snag.wbsNodeId))
    .where(where)
    .orderBy(
      params.direction === 'asc'
        ? sql`${sortColumn} asc nulls last`
        : sql`${sortColumn} desc nulls last`,
      asc(snag.id),
    )
    .limit(params.pageSize)
    .offset(params.offset);

  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(snag)
    .where(where);

  return listResult(rows, counted?.total ?? 0, params);
}

// ---------------------------------------------------------------------------
// Job costs
// ---------------------------------------------------------------------------

export interface CostEntryListRow {
  id: string;
  projectId: string;
  projectCode: string | null;
  projectName: string | null;
  wbsCode: string | null;
  wbsName: string | null;
  postedOn: string;
  category: string;
  description: string | null;
  sourceModule: string | null;
  amount: string;
  currencyCode: string | null;
  quantity: string | null;
  uomCode: string | null;
  isAccrual: boolean;
  reversesEntryId: string | null;
  /** True when a later entry reverses this one. */
  isReversed: boolean;
}

export const COST_SORTS = ['postedOn', 'amount', 'category', 'projectCode'] as const;

export async function listCostEntries(
  tx: Transaction,
  params: ListParams,
  filters: {
    projectId?: string;
    category?: string;
    /** 'accrual' shows only accruals, 'actual' only settled costs. */
    kind?: 'accrual' | 'actual';
    hideReversed?: boolean;
  } = {},
): Promise<ListResult<CostEntryListRow>> {
  const { tenantId } = requireTenantContext();

  // A reversal points at what it reverses, so the reversed entry is the one with
  // a pointer AT it. Both stay on the ledger — a cost is corrected by a
  // compensating entry, never by deletion, which is why this is a flag rather
  // than a filter applied by default.
  const isReversed = sql<boolean>`exists (
    select 1 from ${costEntry} r
    where r.tenant_id = ${tenantId} and r.reverses_entry_id = ${costEntry.id}
  )`;

  const conditions = [eq(costEntry.tenantId, tenantId)];
  if (filters.projectId) conditions.push(eq(costEntry.projectId, filters.projectId));
  if (filters.category) conditions.push(eq(costEntry.category, filters.category as never));
  if (filters.kind === 'accrual') conditions.push(eq(costEntry.isAccrual, true));
  if (filters.kind === 'actual') conditions.push(eq(costEntry.isAccrual, false));
  if (filters.hideReversed) conditions.push(sql`not ${isReversed}`);

  if (params.search) {
    const pattern = searchPattern(params.search);
    conditions.push(
      or(ilike(costEntry.description, pattern), ilike(schema.project.code, pattern))!,
    );
  }

  const where = and(...conditions);

  const sortColumn =
    {
      postedOn: costEntry.postedOn,
      amount: costEntry.amount,
      category: costEntry.category,
      projectCode: schema.project.code,
    }[params.sort as string] ?? costEntry.postedOn;

  const rows = await tx
    .select({
      id: costEntry.id,
      projectId: costEntry.projectId,
      projectCode: schema.project.code,
      projectName: schema.project.name,
      wbsCode: wbsNode.code,
      wbsName: wbsNode.name,
      postedOn: costEntry.postedOn,
      category: costEntry.category,
      description: costEntry.description,
      sourceModule: costEntry.sourceModule,
      amount: costEntry.amount,
      currencyCode: costEntry.currencyCode,
      quantity: costEntry.quantity,
      uomCode: costEntry.uomCode,
      isAccrual: costEntry.isAccrual,
      reversesEntryId: costEntry.reversesEntryId,
      isReversed,
    })
    .from(costEntry)
    .leftJoin(
      schema.project,
      and(eq(schema.project.id, costEntry.projectId), eq(schema.project.tenantId, tenantId)),
    )
    .leftJoin(wbsNode, eq(wbsNode.id, costEntry.wbsNodeId))
    .where(where)
    .orderBy(params.direction === 'asc' ? asc(sortColumn) : desc(sortColumn), asc(costEntry.id))
    .limit(params.pageSize)
    .offset(params.offset);

  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(costEntry)
    .leftJoin(
      schema.project,
      and(eq(schema.project.id, costEntry.projectId), eq(schema.project.tenantId, tenantId)),
    )
    .where(where);

  return listResult(rows, counted?.total ?? 0, params);
}

/** Distinct from `CostSummary` in `projects.ts`, which is a per-project EVM
 * position. This is one row per cost category. */
export interface CostCategoryTotal {
  category: string;
  actual: number;
  accrued: number;
}

/**
 * Cost by category, actual and accrued kept apart.
 *
 * An accrual is a cost the job has incurred and not yet been invoiced for.
 * Merging it into the actual makes a job look more expensive than the ledger
 * says and less expensive than it really is, depending which way you read it —
 * so both travel, and neither is a total on its own.
 */
export async function summariseCosts(
  tx: Transaction,
  filters: { projectId?: string } = {},
): Promise<CostCategoryTotal[]> {
  const { tenantId } = requireTenantContext();

  const conditions = [eq(costEntry.tenantId, tenantId)];
  if (filters.projectId) conditions.push(eq(costEntry.projectId, filters.projectId));

  const rows = await tx
    .select({
      category: costEntry.category,
      actual: sql<string>`coalesce(sum(${costEntry.amount}) filter (where not ${costEntry.isAccrual}), 0)`,
      accrued: sql<string>`coalesce(sum(${costEntry.amount}) filter (where ${costEntry.isAccrual}), 0)`,
    })
    .from(costEntry)
    .where(and(...conditions))
    .groupBy(costEntry.category);

  return rows.map((row) => ({
    category: row.category,
    actual: Number(row.actual),
    accrued: Number(row.accrued),
  }));
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export interface ProgressListRow {
  id: string;
  projectId: string;
  projectCode: string | null;
  projectName: string | null;
  wbsCode: string | null;
  wbsName: string | null;
  periodEnd: string;
  ruleOfCredit: string;
  unitsComplete: string | null;
  unitsPlanned: string | null;
  started: boolean | null;
  finished: boolean | null;
  manualPercent: string | null;
  percentComplete: string;
  earnedValue: string;
  note: string | null;
  hasEvidence: boolean;
  /**
   * True when the figure was typed rather than counted.
   *
   * The distinction the rule-of-credit system exists to preserve: a measured
   * percentage and somebody's opinion are not the same claim, and a screen that
   * renders them identically undoes the whole mechanism.
   */
  isSelfAssessed: boolean;
}

export const PROGRESS_SORTS = ['periodEnd', 'percentComplete', 'earnedValue', 'projectCode'] as const;

export async function listProgress(
  tx: Transaction,
  params: ListParams,
  filters: { projectId?: string; periodEnd?: string; selfAssessedOnly?: boolean } = {},
): Promise<ListResult<ProgressListRow>> {
  const { tenantId } = requireTenantContext();

  const isSelfAssessed = sql<boolean>`(${progressEntry.ruleOfCredit} = 'manual')`;

  const conditions = [eq(progressEntry.tenantId, tenantId)];
  if (filters.projectId) conditions.push(eq(progressEntry.projectId, filters.projectId));
  if (filters.periodEnd) conditions.push(eq(progressEntry.periodEnd, filters.periodEnd));
  if (filters.selfAssessedOnly) conditions.push(eq(progressEntry.ruleOfCredit, 'manual' as never));

  if (params.search) {
    const pattern = searchPattern(params.search);
    conditions.push(
      or(ilike(schema.project.code, pattern), ilike(wbsNode.code, pattern), ilike(wbsNode.name, pattern))!,
    );
  }

  const where = and(...conditions);

  const sortColumn =
    {
      periodEnd: progressEntry.periodEnd,
      percentComplete: progressEntry.percentComplete,
      earnedValue: progressEntry.earnedValue,
      projectCode: schema.project.code,
    }[params.sort as string] ?? progressEntry.periodEnd;

  const rows = await tx
    .select({
      id: progressEntry.id,
      projectId: progressEntry.projectId,
      projectCode: schema.project.code,
      projectName: schema.project.name,
      wbsCode: wbsNode.code,
      wbsName: wbsNode.name,
      periodEnd: progressEntry.periodEnd,
      ruleOfCredit: progressEntry.ruleOfCredit,
      unitsComplete: progressEntry.unitsComplete,
      unitsPlanned: progressEntry.unitsPlanned,
      started: progressEntry.started,
      finished: progressEntry.finished,
      manualPercent: progressEntry.manualPercent,
      percentComplete: progressEntry.percentComplete,
      earnedValue: progressEntry.earnedValue,
      note: progressEntry.note,
      hasEvidence: sql<boolean>`(${progressEntry.evidenceDocumentId} is not null)`,
      isSelfAssessed,
    })
    .from(progressEntry)
    .leftJoin(
      schema.project,
      and(eq(schema.project.id, progressEntry.projectId), eq(schema.project.tenantId, tenantId)),
    )
    .leftJoin(wbsNode, eq(wbsNode.id, progressEntry.wbsNodeId))
    .where(where)
    .orderBy(
      params.direction === 'asc' ? asc(sortColumn) : desc(sortColumn),
      asc(progressEntry.id),
    )
    .limit(params.pageSize)
    .offset(params.offset);

  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(progressEntry)
    .leftJoin(
      schema.project,
      and(eq(schema.project.id, progressEntry.projectId), eq(schema.project.tenantId, tenantId)),
    )
    .leftJoin(wbsNode, eq(wbsNode.id, progressEntry.wbsNodeId))
    .where(where);

  return listResult(rows, counted?.total ?? 0, params);
}

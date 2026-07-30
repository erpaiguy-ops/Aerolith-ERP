/**
 * The read side of Estimating — the three registers its navigation promises.
 *
 * Reads only, kept apart from `estimates.ts` for the same reason Inventory keeps
 * its registers apart from posting: pricing and submitting are the module's
 * consequential operations, and a file that mixes them with list queries makes
 * it harder to see which functions commit the company to a number.
 *
 * **Margin is redacted here, not in the route.** `estimation.margin.view` is a
 * separate permission from reading an estimate — a site manager checking
 * quantities should not see what the company makes on the job — and the detail
 * endpoint already honours it. Doing it per-caller in the route would mean the
 * next list to be written forgets, and a cost column leaking to everyone is not
 * a bug anyone notices from the screen. So `listEstimates` takes the flag and
 * omits the fields itself.
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
import { alias } from 'drizzle-orm/pg-core';

import { estimate, rateComponent, rateItem, rateLibrary, tender } from '../db/schema';

// ---------------------------------------------------------------------------
// Tenders
// ---------------------------------------------------------------------------

export interface TenderListRow {
  id: string;
  number: string | null;
  name: string;
  status: string;
  clientName: string | null;
  currencyCode: string | null;
  submissionDueAt: string | null;
  submittedAt: string | null;
  bidDecision: string | null;
  outcomeValue: string | null;
  /** Days until submission closes. Negative once the deadline has passed. */
  daysToDeadline: number | null;
  estimateCount: number;
  /** Value of the version actually submitted, when there is one. */
  submittedValue: string | null;
}

export const TENDER_SORTS = [
  'submissionDueAt',
  'number',
  'name',
  'status',
  'createdAt',
] as const;

export async function listTenders(
  tx: Transaction,
  params: ListParams,
  filters: { status?: string; bidDecision?: string; openOnly?: boolean } = {},
): Promise<ListResult<TenderListRow>> {
  const { tenantId } = requireTenantContext();

  // Anything still capable of being won or lost — six of the ten statuses, which
  // is exactly why this is a filter rather than a status chip. "What is live"
  // is the question an estimator asks every morning; "which ones are at
  // clarification stage" is not.
  const openStatuses = [
    'identified',
    'prequalifying',
    'bid_no_bid',
    'estimating',
    'submitted',
    'clarifying',
  ] as const;

  const daysToDeadline = sql<number | null>`
    case
      when ${tender.submissionDueAt} is null then null
      else date_part('day', ${tender.submissionDueAt} - now())::int
    end
  `;

  const estimates = tx
    .select({
      tenderId: estimate.tenderId,
      count: sql<number>`count(*)::int`.as('estimate_count'),
      submittedValue: sql<
        string | null
      >`max(${estimate.totalValue}) filter (where ${estimate.isSubmitted})`.as('submitted_value'),
    })
    .from(estimate)
    .where(eq(estimate.tenantId, tenantId))
    .groupBy(estimate.tenderId)
    .as('tender_estimates');

  const conditions = [eq(tender.tenantId, tenantId)];
  if (filters.status) conditions.push(eq(tender.status, filters.status as never));
  if (filters.bidDecision) conditions.push(eq(tender.bidDecision, filters.bidDecision));
  if (filters.openOnly) conditions.push(inArray(tender.status, [...openStatuses]));

  if (params.search) {
    const pattern = searchPattern(params.search);
    conditions.push(
      or(ilike(tender.number, pattern), ilike(tender.name, pattern), ilike(schema.party.name, pattern))!,
    );
  }

  const where = and(...conditions);

  const sortColumn =
    {
      submissionDueAt: tender.submissionDueAt,
      number: tender.number,
      name: tender.name,
      status: tender.status,
      createdAt: tender.createdAt,
    }[params.sort as string] ?? tender.submissionDueAt;

  const rows = await tx
    .select({
      id: tender.id,
      number: tender.number,
      name: tender.name,
      status: tender.status,
      clientName: schema.party.name,
      currencyCode: tender.currencyCode,
      submissionDueAt: sql<string | null>`${tender.submissionDueAt}`,
      submittedAt: sql<string | null>`${tender.submittedAt}`,
      bidDecision: tender.bidDecision,
      outcomeValue: tender.outcomeValue,
      daysToDeadline,
      estimateCount: sql<number>`coalesce(${estimates.count}, 0)`,
      submittedValue: estimates.submittedValue,
    })
    .from(tender)
    .leftJoin(
      schema.party,
      and(eq(schema.party.id, tender.clientPartyId), eq(schema.party.tenantId, tenantId)),
    )
    .leftJoin(estimates, eq(estimates.tenderId, tender.id))
    .where(where)
    // Nulls last on the deadline: a tender with no date is not the most urgent
    // thing on the list, and the default ordering puts it there otherwise.
    .orderBy(
      params.direction === 'asc' ? sql`${sortColumn} asc nulls last` : sql`${sortColumn} desc nulls last`,
      asc(tender.id),
    )
    .limit(params.pageSize)
    .offset(params.offset);

  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(tender)
    .leftJoin(
      schema.party,
      and(eq(schema.party.id, tender.clientPartyId), eq(schema.party.tenantId, tenantId)),
    )
    .where(where);

  return listResult(rows, counted?.total ?? 0, params);
}

export interface TenderEstimateRow {
  id: string;
  version: number;
  label: string;
  status: string;
  totalValue: string;
  isSubmitted: boolean;
}

export interface TenderDetail {
  tender: typeof tender.$inferSelect;
  clientName: string | null;
  consultantName: string | null;
  mainContractorName: string | null;
  estimates: TenderEstimateRow[];
}

/**
 * One tender, with its three parties resolved to names.
 *
 * Three joins against the same `kernel.party` table, aliased apart — a client,
 * a consultant and a main contractor are frequently three different
 * organisations, and a screen that can only show one of them is not reading the
 * tender, it is reading a summary of it.
 */
export async function getTenderDetail(
  tx: Transaction,
  tenderId: string,
): Promise<TenderDetail | null> {
  const { tenantId } = requireTenantContext();

  const clientParty = alias(schema.party, 'client_party');
  const consultantParty = alias(schema.party, 'consultant_party');
  const mainContractorParty = alias(schema.party, 'main_contractor_party');

  const [row] = await tx
    .select({
      tender,
      clientName: clientParty.name,
      consultantName: consultantParty.name,
      mainContractorName: mainContractorParty.name,
    })
    .from(tender)
    .leftJoin(
      clientParty,
      and(eq(clientParty.id, tender.clientPartyId), eq(clientParty.tenantId, tenantId)),
    )
    .leftJoin(
      consultantParty,
      and(eq(consultantParty.id, tender.consultantPartyId), eq(consultantParty.tenantId, tenantId)),
    )
    .leftJoin(
      mainContractorParty,
      and(
        eq(mainContractorParty.id, tender.mainContractorPartyId),
        eq(mainContractorParty.tenantId, tenantId),
      ),
    )
    .where(and(eq(tender.tenantId, tenantId), eq(tender.id, tenderId)))
    .limit(1);

  if (!row) return null;

  const estimates = await tx
    .select({
      id: estimate.id,
      version: estimate.version,
      label: estimate.label,
      status: estimate.status,
      totalValue: estimate.totalValue,
      isSubmitted: estimate.isSubmitted,
    })
    .from(estimate)
    .where(eq(estimate.tenderId, tenderId))
    .orderBy(desc(estimate.version));

  return { ...row, estimates };
}

// ---------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------

export interface EstimateListRow {
  id: string;
  tenderId: string;
  tenderNumber: string | null;
  tenderName: string;
  clientName: string | null;
  version: number;
  label: string;
  status: string;
  isSubmitted: boolean;
  currencyCode: string | null;
  totalValue: string;
  provisionalTotal: string;
  optionalTotal: string;
  /** Omitted entirely without `estimation.margin.view`. */
  totalCost?: string;
  /** What the estimator ASKED for. Not what the estimate achieves. */
  marginPercent?: string | null;
  /** Derived, and therefore also privileged: it reveals the cost. */
  marginValue?: string;
  /**
   * What the estimate actually achieves, as a share of value.
   *
   * Reported separately because it is routinely NOT the requested margin: a
   * provisional sum is the client's money passing through and carries none, so
   * an estimate set to 18% with a large PC sum in it might achieve 7%. Showing
   * only the requested figure beside a money amount invites a reader to divide
   * the two, get a third number, and conclude the screen is broken.
   */
  marginPercentAchieved?: number | null;
}

export const ESTIMATE_SORTS = [
  'createdAt',
  'totalValue',
  'version',
  'status',
  'tenderNumber',
] as const;

export async function listEstimates(
  tx: Transaction,
  params: ListParams,
  filters: {
    status?: string;
    tenderId?: string;
    submittedOnly?: boolean;
    /** Comes from the caller's permissions, never from the request. */
    canSeeMargin?: boolean;
  } = {},
): Promise<ListResult<EstimateListRow>> {
  const { tenantId } = requireTenantContext();

  const conditions = [eq(estimate.tenantId, tenantId)];
  if (filters.status) conditions.push(eq(estimate.status, filters.status as never));
  if (filters.tenderId) conditions.push(eq(estimate.tenderId, filters.tenderId));
  if (filters.submittedOnly) conditions.push(eq(estimate.isSubmitted, true));

  if (params.search) {
    const pattern = searchPattern(params.search);
    conditions.push(
      or(ilike(tender.number, pattern), ilike(tender.name, pattern), ilike(estimate.label, pattern))!,
    );
  }

  const where = and(...conditions);

  const sortColumn =
    {
      createdAt: estimate.createdAt,
      totalValue: estimate.totalValue,
      version: estimate.version,
      status: estimate.status,
      tenderNumber: tender.number,
    }[params.sort as string] ?? estimate.createdAt;

  const rows = await tx
    .select({
      id: estimate.id,
      tenderId: estimate.tenderId,
      tenderNumber: tender.number,
      tenderName: tender.name,
      clientName: schema.party.name,
      version: estimate.version,
      label: estimate.label,
      status: estimate.status,
      isSubmitted: estimate.isSubmitted,
      currencyCode: tender.currencyCode,
      totalCost: estimate.totalCost,
      totalValue: estimate.totalValue,
      provisionalTotal: estimate.provisionalTotal,
      optionalTotal: estimate.optionalTotal,
      marginPercent: estimate.marginPercent,
    })
    .from(estimate)
    .innerJoin(tender, and(eq(tender.id, estimate.tenderId), eq(tender.tenantId, tenantId)))
    .leftJoin(
      schema.party,
      and(eq(schema.party.id, tender.clientPartyId), eq(schema.party.tenantId, tenantId)),
    )
    .where(where)
    .orderBy(params.direction === 'asc' ? asc(sortColumn) : desc(sortColumn), asc(estimate.id))
    .limit(params.pageSize)
    .offset(params.offset);

  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(estimate)
    .innerJoin(tender, and(eq(tender.id, estimate.tenderId), eq(tender.tenantId, tenantId)))
    .where(where);

  // The fields are DELETED rather than blanked. A `totalCost: null` on the wire
  // is indistinguishable from an estimate that genuinely has no cost yet, and it
  // still tells the reader the field exists and is being withheld from them.
  const visible = filters.canSeeMargin
    ? rows.map((row) => {
        const value = Number(row.totalValue);
        const marginValue = value - Number(row.totalCost);
        return {
          ...row,
          marginValue: marginValue.toFixed(2),
          // Margin is a share of the SELLING PRICE, not of cost. Dividing by
          // cost here would produce markup and label it margin, which is the
          // distinction this module exists to keep straight.
          marginPercentAchieved: value === 0 ? null : Math.round((marginValue / value) * 1000) / 10,
        };
      })
    : rows.map(({ totalCost: _cost, marginPercent: _margin, ...rest }) => rest);

  return listResult(visible, counted?.total ?? 0, params);
}

// ---------------------------------------------------------------------------
// Rate library
// ---------------------------------------------------------------------------

export interface RateListRow {
  id: string;
  code: string;
  description: string;
  uomCode: string | null;
  category: string | null;
  unitRate: string;
  /** Summed from the build-up, which is the source of truth for what a rate costs. */
  directCost: string;
  isActive: boolean;
  lastActualCost: string | null;
  actualSampleSize: number;
  lastActualAt: string | null;
  /**
   * How far the library's assumed cost sits from what jobs have actually cost,
   * as a percentage of the assumed cost. NEGATIVE is the one that matters: the
   * work costs more than the build-up says, so every line priced from this rate
   * is losing the difference.
   */
  actualVariancePercent: number | null;
}

export const RATE_SORTS = ['code', 'description', 'unitRate', 'category', 'lastActualAt'] as const;

export interface RateLibraryHeader {
  id: string;
  code: string;
  name: string;
  version: number;
  currencyCode: string | null;
  effectiveFrom: string | null;
}

/** The current library, or null when the tenant has not built one. */
export async function currentRateLibrary(tx: Transaction): Promise<RateLibraryHeader | null> {
  const { tenantId } = requireTenantContext();

  const [row] = await tx
    .select({
      id: rateLibrary.id,
      code: rateLibrary.code,
      name: rateLibrary.name,
      version: rateLibrary.version,
      currencyCode: rateLibrary.currencyCode,
      effectiveFrom: rateLibrary.effectiveFrom,
    })
    .from(rateLibrary)
    .where(and(eq(rateLibrary.tenantId, tenantId), eq(rateLibrary.isCurrent, true)))
    .orderBy(desc(rateLibrary.version))
    .limit(1);

  return row ?? null;
}

export async function listRates(
  tx: Transaction,
  params: ListParams,
  filters: { libraryId?: string; category?: string; includeInactive?: boolean } = {},
): Promise<ListResult<RateListRow>> {
  const { tenantId } = requireTenantContext();

  // The cost is DERIVED from the build-up, not read from `rate_item.direct_cost`.
  // That column is documented as a cache of exactly this sum, and nothing in the
  // system maintains it — it is zero on every rate the pricing path has created,
  // which made the variance below silently null and the "assumed cost" column
  // silently wrong. The components are the source of truth; the cache is only a
  // fallback for a rate that genuinely has no build-up.
  //
  // This is the same arithmetic `calculateBuildUp` performs: wastage multiplies
  // each component, then the components are summed.
  const buildUp = tx
    .select({
      rateItemId: rateComponent.rateItemId,
      cost: sql<string>`sum(
        ${rateComponent.quantityPerUnit}
        * ${rateComponent.unitRate}
        * (1 + coalesce(${rateComponent.wastagePercent}, 0) / 100)
      )`.as('build_up_cost'),
    })
    .from(rateComponent)
    .where(eq(rateComponent.tenantId, tenantId))
    .groupBy(rateComponent.rateItemId)
    .as('build_up');

  const assumedCost = sql<string>`coalesce(${buildUp.cost}, ${rateItem.directCost})`;

  // Cost against cost. Comparing `lastActualCost` to `unitRate` — the SELLING
  // rate — would measure the margin and call it a rate variance, and the number
  // would look plausible while answering a different question entirely.
  const variance = sql<number | null>`
    case
      when ${rateItem.lastActualCost} is null or coalesce(${buildUp.cost}, ${rateItem.directCost}) = 0
        then null
      else round(
        ((coalesce(${buildUp.cost}, ${rateItem.directCost}) - ${rateItem.lastActualCost})
          / coalesce(${buildUp.cost}, ${rateItem.directCost})) * 100,
        1
      )::float8
    end
  `;

  const conditions = [eq(rateItem.tenantId, tenantId)];
  if (filters.libraryId) conditions.push(eq(rateItem.libraryId, filters.libraryId));
  if (filters.category) conditions.push(eq(rateItem.category, filters.category));
  if (!filters.includeInactive) conditions.push(eq(rateItem.isActive, true));

  if (params.search) {
    const pattern = searchPattern(params.search);
    conditions.push(or(ilike(rateItem.code, pattern), ilike(rateItem.description, pattern))!);
  }

  const where = and(...conditions);

  const sortColumn =
    {
      code: rateItem.code,
      description: rateItem.description,
      unitRate: rateItem.unitRate,
      category: rateItem.category,
      lastActualAt: rateItem.lastActualAt,
    }[params.sort as string] ?? rateItem.code;

  const rows = await tx
    .select({
      id: rateItem.id,
      code: rateItem.code,
      description: rateItem.description,
      uomCode: rateItem.uomCode,
      category: rateItem.category,
      unitRate: rateItem.unitRate,
      directCost: assumedCost,
      isActive: rateItem.isActive,
      lastActualCost: rateItem.lastActualCost,
      actualSampleSize: rateItem.actualSampleSize,
      lastActualAt: sql<string | null>`${rateItem.lastActualAt}`,
      actualVariancePercent: variance,
    })
    .from(rateItem)
    .leftJoin(buildUp, eq(buildUp.rateItemId, rateItem.id))
    .where(where)
    .orderBy(params.direction === 'asc' ? asc(sortColumn) : desc(sortColumn), asc(rateItem.id))
    .limit(params.pageSize)
    .offset(params.offset);

  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(rateItem)
    .where(where);

  return listResult(rows, counted?.total ?? 0, params);
}

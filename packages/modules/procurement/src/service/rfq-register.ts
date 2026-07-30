/**
 * The RFQ register.
 *
 * The one procurement screen that was never built, and the one that answers the
 * question a buyer is actually judged on: which enquiries are out, who has not
 * come back, and which are sitting priced and undecided while the site waits.
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
import { and, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm';

import { quote, rfq, rfqLine } from '../db/schema';

export interface RfqListRow {
  id: string;
  number: string | null;
  title: string;
  status: string;
  projectId: string | null;
  projectCode: string | null;
  currencyCode: string | null;
  issuedOn: string | null;
  responseDueOn: string | null;
  awardedOn: string | null;
  awardRationale: string | null;
  lineCount: number;
  /**
   * Suppliers with a quote record against this enquiry — priced, declined or
   * still awaited.
   *
   * NOT "suppliers invited": nothing in the system creates a record at the point
   * of inviting, so a supplier who was asked and has said nothing does not
   * appear here at all. Naming it `invited` would have promised a number the
   * data cannot produce.
   */
  suppliers: number;
  /** Of those, the ones who actually put a price on it. */
  quoted: number;
  declined: number;
  /** Days until quotes close. Negative once the date has passed. */
  daysToClose: number | null;
  /**
   * Issued, past its response date, and fewer than two suppliers have priced.
   *
   * Two is the point at which a comparison means anything. One quote is not a
   * market test, and an enquiry that closed last week with one price is the
   * quiet way a job ends up paying whatever it was told.
   */
  isUncompetitive: boolean;
}

export const RFQ_SORTS = ['responseDueOn', 'number', 'status', 'issuedOn', 'title'] as const;

export async function listRfqs(
  tx: Transaction,
  params: ListParams,
  filters: { status?: string; projectId?: string; openOnly?: boolean } = {},
): Promise<ListResult<RfqListRow>> {
  const { tenantId } = requireTenantContext();

  const openStatuses = ['draft', 'issued'] as const;

  const lines = tx
    .select({
      rfqId: rfqLine.rfqId,
      lineCount: sql<number>`count(*)::int`.as('line_count'),
    })
    .from(rfqLine)
    .where(eq(rfqLine.tenantId, tenantId))
    .groupBy(rfqLine.rfqId)
    .as('rfq_lines');

  const quotes = tx
    .select({
      rfqId: quote.rfqId,
      suppliers: sql<number>`count(*)::int`.as('suppliers'),
      // `awaited` is an invitation nobody has answered. Counting it as a quote
      // would make an enquiry with no prices look fully covered.
      quoted: sql<number>`count(*) filter (
        where ${quote.status} in ('received', 'shortlisted', 'awarded', 'lost')
      )::int`.as('quoted'),
      declined: sql<number>`count(*) filter (where ${quote.status} = 'declined')::int`.as(
        'declined',
      ),
    })
    .from(quote)
    .where(eq(quote.tenantId, tenantId))
    .groupBy(quote.rfqId)
    .as('rfq_quotes');

  const daysToClose = sql<number | null>`
    case when ${rfq.responseDueOn} is null then null else (${rfq.responseDueOn} - current_date) end
  `;

  const isUncompetitive = sql<boolean>`(
    ${rfq.status} = 'issued'
    and ${rfq.responseDueOn} is not null
    and ${rfq.responseDueOn} < current_date
    and coalesce(${quotes.quoted}, 0) < 2
  )`;

  const conditions = [eq(rfq.tenantId, tenantId)];
  if (filters.status) conditions.push(eq(rfq.status, filters.status as never));
  if (filters.projectId) conditions.push(eq(rfq.projectId, filters.projectId));
  if (filters.openOnly) conditions.push(inArray(rfq.status, [...openStatuses]));

  if (params.search) {
    const pattern = searchPattern(params.search);
    conditions.push(or(ilike(rfq.number, pattern), ilike(rfq.title, pattern))!);
  }

  const where = and(...conditions);

  const sortColumn =
    {
      responseDueOn: rfq.responseDueOn,
      number: rfq.number,
      status: rfq.status,
      issuedOn: rfq.issuedOn,
      title: rfq.title,
    }[params.sort as string] ?? rfq.responseDueOn;

  const rows = await tx
    .select({
      id: rfq.id,
      number: rfq.number,
      title: rfq.title,
      status: rfq.status,
      projectId: rfq.projectId,
      projectCode: schema.project.code,
      currencyCode: rfq.currencyCode,
      issuedOn: rfq.issuedOn,
      responseDueOn: rfq.responseDueOn,
      awardedOn: rfq.awardedOn,
      awardRationale: rfq.awardRationale,
      lineCount: sql<number>`coalesce(${lines.lineCount}, 0)`,
      suppliers: sql<number>`coalesce(${quotes.suppliers}, 0)`,
      quoted: sql<number>`coalesce(${quotes.quoted}, 0)`,
      declined: sql<number>`coalesce(${quotes.declined}, 0)`,
      daysToClose,
      isUncompetitive,
    })
    .from(rfq)
    .leftJoin(
      schema.project,
      and(eq(schema.project.id, rfq.projectId), eq(schema.project.tenantId, tenantId)),
    )
    .leftJoin(lines, eq(lines.rfqId, rfq.id))
    .leftJoin(quotes, eq(quotes.rfqId, rfq.id))
    .where(where)
    .orderBy(
      params.direction === 'asc'
        ? sql`${sortColumn} asc nulls last`
        : sql`${sortColumn} desc nulls last`,
      asc(rfq.id),
    )
    .limit(params.pageSize)
    .offset(params.offset);

  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(rfq)
    .where(where);

  return listResult(rows, counted?.total ?? 0, params);
}

export interface RfqLineRow {
  id: string;
  lineNumber: number;
  description: string;
  specification: string | null;
  quantity: string;
  uomCode: string | null;
}

export interface RfqQuoteRow {
  id: string;
  supplierId: string;
  supplierName: string | null;
  status: string;
  reference: string | null;
  receivedOn: string | null;
  leadTimeDays: number | null;
  /** Set once `compareRfqLine` has run against this quote; null until then. */
  landedCost: string | null;
  effectiveUnitCost: string | null;
  premiumOverBest: string | null;
  comparedAt: string | null;
}

export interface RfqDetail {
  rfq: typeof rfq.$inferSelect;
  projectCode: string | null;
  projectName: string | null;
  lines: RfqLineRow[];
  quotes: RfqQuoteRow[];
}

/**
 * One enquiry, with its lines and every quote received against it.
 *
 * `landedCost`/`effectiveUnitCost`/`premiumOverBest` are shown exactly as
 * `compareRfqLine` last stored them — this does not recompute the comparison,
 * because a past figure that silently restated itself as exchange rates moved
 * is the one thing an awarded RFQ must not do. A quote with `comparedAt: null`
 * has not been run through the comparison yet.
 */
export async function getRfqDetail(tx: Transaction, rfqId: string): Promise<RfqDetail | null> {
  const { tenantId } = requireTenantContext();

  const [row] = await tx
    .select({
      rfq,
      projectCode: schema.project.code,
      projectName: schema.project.name,
    })
    .from(rfq)
    .leftJoin(
      schema.project,
      and(eq(schema.project.id, rfq.projectId), eq(schema.project.tenantId, tenantId)),
    )
    .where(and(eq(rfq.tenantId, tenantId), eq(rfq.id, rfqId)))
    .limit(1);

  if (!row) return null;

  const lines = await tx
    .select({
      id: rfqLine.id,
      lineNumber: rfqLine.lineNumber,
      description: rfqLine.description,
      specification: rfqLine.specification,
      quantity: rfqLine.quantity,
      uomCode: rfqLine.uomCode,
    })
    .from(rfqLine)
    .where(eq(rfqLine.rfqId, rfqId))
    .orderBy(asc(rfqLine.lineNumber));

  const quotes = await tx
    .select({
      id: quote.id,
      supplierId: quote.supplierId,
      supplierName: schema.party.name,
      status: quote.status,
      reference: quote.reference,
      receivedOn: sql<string | null>`${quote.receivedOn}`,
      leadTimeDays: quote.leadTimeDays,
      landedCost: quote.landedCost,
      effectiveUnitCost: quote.effectiveUnitCost,
      premiumOverBest: quote.premiumOverBest,
      comparedAt: sql<string | null>`${quote.comparedAt}`,
    })
    .from(quote)
    .leftJoin(
      schema.party,
      and(eq(schema.party.id, quote.supplierId), eq(schema.party.tenantId, tenantId)),
    )
    .where(eq(quote.rfqId, rfqId))
    .orderBy(asc(quote.createdAt));

  return { ...row, lines, quotes };
}

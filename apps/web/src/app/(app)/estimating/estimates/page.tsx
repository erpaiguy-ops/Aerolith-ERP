import Link from 'next/link';

import {
  EmptyList,
  FilterChips,
  Pager,
  SearchBox,
  SortTh,
  fetchList,
  listQuery,
} from '@/components/List';
import { Badge, Card, Money, PageHeader, Table, Td, Th } from '@/components/ui';
import { percent } from '@/lib/format';
import { getMe } from '@/lib/session';

interface EstimateRow {
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
  /** Absent, not null, without `estimation.margin.view`. */
  totalCost?: string;
  marginPercent?: string | null;
  marginValue?: string;
  marginPercentAchieved?: number | null;
}

const BASE = '/estimating/estimates';

const STATUSES = [
  { label: 'All', value: null },
  { label: 'Draft', value: 'draft' },
  { label: 'Awaiting approval', value: 'pending_approval' },
  { label: 'Approved', value: 'approved' },
  { label: 'Superseded', value: 'superseded' },
];

export default async function EstimatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();

  const result = await fetchList<EstimateRow, { marginVisible: boolean }>(
    '/estimating/estimates',
    query,
  );

  return (
    <>
      <PageHeader
        title="Estimates"
        subtitle="Every priced version, across every tender — including the ones not submitted."
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          <FilterChips base={BASE} query={query} param="status" options={STATUSES} />
          {/* A tender usually carries several priced versions and exactly one
              that went out. "What did we actually bid" is a different question
              from "what did we price". */}
          <FilterChips
            base={BASE}
            query={query}
            param="submitted"
            options={[{ label: 'Submitted only', value: 'true' }]}
          />
        </div>
        <SearchBox base={BASE} query={query} placeholder="Tender number, name or label…" />
      </div>

      {!result.marginVisible ? (
        // Said out loud rather than left as absent columns. A table that quietly
        // omits cost looks like a table that has no cost in it, and a user who
        // cannot tell the difference will report the figures as wrong.
        <p className="mb-3 rounded-md border border-(--color-line) bg-(--color-canvas) px-3 py-2 text-xs text-(--color-muted)">
          Cost and margin are hidden. Viewing them is a separate permission from
          viewing an estimate.
        </p>
      ) : null}

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['estimate', 'estimates']}
            hint="Estimates are priced against a tender, each version pinning a rate library."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="tenderNumber" current={result.sort} direction={result.direction}>
                  Tender
                </SortTh>
                <SortTh base={BASE} query={query} column="version" current={result.sort} direction={result.direction}>
                  Version
                </SortTh>
                <SortTh base={BASE} query={query} column="status" current={result.sort} direction={result.direction}>
                  Status
                </SortTh>
                <SortTh base={BASE} query={query} column="totalValue" current={result.sort} direction={result.direction} numeric>
                  Value
                </SortTh>
                {result.marginVisible ? <Th numeric>Cost</Th> : null}
                {result.marginVisible ? <Th numeric>Margin</Th> : null}
                <Th numeric>Provisional</Th>
              </tr>
            }
          >
            {result.rows.map((row) => {
              const currency = row.currencyCode ?? me.tenant.currencyCode;

              return (
                <tr key={row.id} className="hover:bg-(--color-canvas)">
                  <Td>
                    <Link
                      href={`/estimating/tenders/${row.tenderId}`}
                      className="numeric block text-(--color-accent) hover:underline"
                    >
                      {row.tenderNumber ?? '—'}
                    </Link>
                    <span className="text-xs text-(--color-muted)">
                      {[row.tenderName, row.clientName].filter(Boolean).join(' · ')}
                    </span>
                  </Td>
                  <Td>
                    <Link
                      href={`/estimating/estimates/${row.id}`}
                      className="numeric block text-(--color-accent) hover:underline"
                    >
                      v{row.version}
                    </Link>
                    <span className="text-xs text-(--color-muted)">{row.label}</span>
                  </Td>
                  <Td>
                    <Badge
                      tone={
                        row.status === 'approved'
                          ? 'good'
                          : row.status === 'superseded'
                            ? 'neutral'
                            : 'neutral'
                      }
                    >
                      {row.status.replace(/_/g, ' ')}
                    </Badge>
                    {row.isSubmitted ? (
                      <span className="mt-0.5 block">
                        <Badge tone="good">submitted</Badge>
                      </span>
                    ) : null}
                  </Td>
                  <Td numeric>
                    <Money amount={row.totalValue} currency={currency} />
                  </Td>
                  {result.marginVisible ? (
                    <Td numeric>
                      <Money amount={row.totalCost} currency={currency} />
                    </Td>
                  ) : null}
                  {result.marginVisible ? (
                    <Td numeric>
                      {/* The ACHIEVED margin, not the requested one. They
                          differ whenever a provisional sum dilutes the price,
                          and showing the request beside the money invites a
                          reader to divide, get a third number, and distrust the
                          screen. The request is shown too, when it differs. */}
                      <Money amount={row.marginValue} currency={currency} />
                      {row.marginPercentAchieved != null ? (
                        <span className="block text-xs text-(--color-muted)">
                          {`${percent(row.marginPercentAchieved)} of value`}
                          {row.marginPercent &&
                          Math.abs(Number(row.marginPercent) - row.marginPercentAchieved) >= 0.1
                            ? ` · ${percent(row.marginPercent)} set`
                            : ''}
                        </span>
                      ) : null}
                    </Td>
                  ) : null}
                  <Td numeric>
                    {/* Provisional sums are money in the price that is not yet a
                        commitment either way. Kept visible so a headline value
                        is never read as if it were all measured work. */}
                    {Number(row.provisionalTotal) === 0 ? (
                      <span className="text-(--color-muted)">—</span>
                    ) : (
                      <Money amount={row.provisionalTotal} currency={currency} />
                    )}
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['estimate', 'estimates']} />
      </Card>
    </>
  );
}

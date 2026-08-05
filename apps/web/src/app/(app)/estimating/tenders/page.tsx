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
import { date, integer } from '@/lib/format';
import { getMe } from '@/lib/session';

interface TenderRow {
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
  daysToDeadline: number | null;
  estimateCount: number;
  submittedValue: string | null;
}

const BASE = '/estimating/tenders';

const STATUSES = [
  { label: 'All', value: null },
  { label: 'Identified', value: 'identified' },
  { label: 'Estimating', value: 'estimating' },
  { label: 'Submitted', value: 'submitted' },
  { label: 'Won', value: 'won' },
  { label: 'Lost', value: 'lost' },
];

const STATUS_TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  won: 'good',
  lost: 'bad',
  abandoned: 'bad',
  cancelled: 'bad',
};

export default async function TendersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();

  const result = await fetchList<TenderRow>('/estimating/tenders', query);

  return (
    <>
      <PageHeader
        title="Tenders"
        subtitle="What has been asked for, what closes when, and what came of it."
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          <FilterChips base={BASE} query={query} param="status" options={STATUSES} />
          {/* Six of the ten statuses are "still live", which is why this is a
              filter and not a chip. It is also the question an estimator asks
              every morning. */}
          <FilterChips
            base={BASE}
            query={query}
            param="open"
            options={[{ label: 'Live only', value: 'true' }]}
          />
          <FilterChips
            base={BASE}
            query={query}
            param="bidDecision"
            options={[{ label: 'No-bid', value: 'no_bid' }]}
          />
        </div>
        <SearchBox base={BASE} query={query} placeholder="Number, name or client…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['tender', 'tenders']}
            hint="A tender is the enquiry. Pricing it produces one or more estimates."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="number" current={result.sort} direction={result.direction}>
                  Number
                </SortTh>
                <SortTh base={BASE} query={query} column="name" current={result.sort} direction={result.direction}>
                  Tender
                </SortTh>
                <SortTh base={BASE} query={query} column="status" current={result.sort} direction={result.direction}>
                  Status
                </SortTh>
                <SortTh base={BASE} query={query} column="submissionDueAt" current={result.sort} direction={result.direction}>
                  Closes
                </SortTh>
                <Th numeric>Estimates</Th>
                <Th numeric>Value</Th>
              </tr>
            }
          >
            {result.rows.map((row) => {
              // Only meaningful while the tender can still be submitted. A
              // closed-days-ago badge on a tender that was won three months ago
              // is noise, and worse, it looks like something needs doing.
              const live = !['won', 'lost', 'abandoned', 'cancelled'].includes(row.status);
              const overdue = live && !row.submittedAt && (row.daysToDeadline ?? 1) < 0;
              const soon =
                live && !row.submittedAt && row.daysToDeadline != null && row.daysToDeadline <= 7;

              return (
                <tr key={row.id} className="hover:bg-(--color-canvas)">
                  <Td>
                    <Link
                      href={`/estimating/tenders/${row.id}`}
                      className="numeric text-(--color-accent) hover:underline"
                    >
                      {row.number ?? '—'}
                    </Link>
                  </Td>
                  <Td>
                    <span className="block">{row.name}</span>
                    {row.clientName ? (
                      <span className="text-xs text-(--color-muted)">{row.clientName}</span>
                    ) : null}
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>
                      {row.status.replace(/_/g, ' ')}
                    </Badge>
                    {row.bidDecision === 'no_bid' ? (
                      <span className="mt-0.5 block">
                        <Badge tone="bad">no-bid</Badge>
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    <span className={overdue ? 'text-(--color-bad)' : soon ? 'text-(--color-warn)' : ''}>
                      {date(row.submissionDueAt)}
                    </span>
                    {row.submittedAt ? (
                      <span className="block text-xs text-(--color-muted)">
                        submitted {date(row.submittedAt)}
                      </span>
                    ) : overdue ? (
                      <span className="block text-xs text-(--color-bad)">
                        closed {integer(Math.abs(row.daysToDeadline ?? 0))} days ago, not submitted
                      </span>
                    ) : soon ? (
                      <span className="block text-xs text-(--color-warn)">
                        {integer(row.daysToDeadline ?? 0)} days left
                      </span>
                    ) : null}
                  </Td>
                  <Td numeric>
                    {row.estimateCount === 0 ? (
                      <span className="text-(--color-muted)">—</span>
                    ) : (
                      <span className="numeric">{integer(row.estimateCount)}</span>
                    )}
                  </Td>
                  <Td numeric>
                    {/* The outcome value once there is one, otherwise what was
                        submitted. Cost and margin are a separate permission and
                        deliberately absent from this screen entirely. */}
                    <Money
                      amount={row.outcomeValue ?? row.submittedValue}
                      currency={row.currencyCode ?? me.tenant.currencyCode}
                    />
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['tender', 'tenders']} />
      </Card>
    </>
  );
}

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
import { Badge, Card, PageHeader, ProgressBar, Table, Td, Th } from '@/components/ui';
import { date, integer, quantity } from '@/lib/format';

interface WorkOrderRow {
  id: string;
  number: string | null;
  description: string;
  status: string;
  priority: number;
  projectCode: string | null;
  projectName: string | null;
  routingCode: string | null;
  quantity: string;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  releasedAt: string | null;
  holdReason: string | null;
  partCount: number;
  partsPlanned: number;
  partsCompleted: number;
  partsRejected: number;
  operationsDone: number;
  operationCount: number;
  progressPercent: number | null;
  isLate: boolean;
}

const BASE = '/production/orders';

const STATUSES = [
  { label: 'All', value: null },
  { label: 'Draft', value: 'draft' },
  { label: 'Planned', value: 'planned' },
  { label: 'Released', value: 'released' },
  { label: 'In progress', value: 'in_progress' },
  { label: 'On hold', value: 'on_hold' },
];

const STATUS_TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  completed: 'good',
  cancelled: 'bad',
  on_hold: 'bad',
};

export default async function WorkOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);

  const result = await fetchList<WorkOrderRow>('/production/work-orders', query);

  return (
    <>
      <PageHeader
        title="Work orders"
        subtitle="What the factory is making, in the order it will actually run."
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          <FilterChips base={BASE} query={query} param="status" options={STATUSES} />
          <FilterChips
            base={BASE}
            query={query}
            param="open"
            options={[{ label: 'Open only', value: 'true' }]}
          />
          {/* Cuts across statuses — an order can be released or in progress and
              still be past its date — so it is its own filter. */}
          <FilterChips
            base={BASE}
            query={query}
            param="late"
            options={[{ label: 'Late', value: 'true' }]}
          />
        </div>
        <SearchBox base={BASE} query={query} placeholder="Order number or description…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['work order', 'work orders']}
            hint="Work orders come from a won tender, or are raised directly."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="number" current={result.sort} direction={result.direction}>
                  Number
                </SortTh>
                <SortTh base={BASE} query={query} column="createdAt" current={result.sort} direction={result.direction}>
                  What
                </SortTh>
                <SortTh base={BASE} query={query} column="status" current={result.sort} direction={result.direction}>
                  Status
                </SortTh>
                <SortTh base={BASE} query={query} column="priority" current={result.sort} direction={result.direction} numeric>
                  Priority
                </SortTh>
                <Th>Parts</Th>
                <SortTh base={BASE} query={query} column="plannedEndDate" current={result.sort} direction={result.direction}>
                  Due
                </SortTh>
              </tr>
            }
          >
            {result.rows.map((row) => (
              <tr key={row.id} className="hover:bg-(--color-canvas)">
                <Td>
                  <Link
                    href={`/production/orders/${row.id}`}
                    className="numeric text-(--color-accent) hover:underline"
                  >
                    {row.number ?? '—'}
                  </Link>
                </Td>
                <Td>
                  <span className="block">{row.description}</span>
                  <span className="text-xs text-(--color-muted)">
                    {[
                      row.projectCode,
                      row.routingCode ? `routing ${row.routingCode}` : null,
                      `${quantity(row.quantity)} off`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </Td>
                <Td>
                  <Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>
                    {row.status.replace(/_/g, ' ')}
                  </Badge>
                  {row.holdReason ? (
                    <span className="block text-xs text-(--color-bad)">{row.holdReason}</span>
                  ) : null}
                </Td>
                <Td numeric>
                  {/* Lower runs first. Shown because it is the field that
                      decides the queue when two orders want the same saw. */}
                  <span className="numeric">{integer(row.priority)}</span>
                </Td>
                <Td>
                  {row.partCount === 0 ? (
                    <span className="text-(--color-muted)">not planned</span>
                  ) : (
                    <>
                      <div className="w-32">
                        <ProgressBar value={row.progressPercent ?? 0} />
                      </div>
                      <span className="numeric text-xs text-(--color-muted)">
                        {/* PIECES against pieces. `partCount` is rows on the
                            cutting list and a list of 2 rows can be 72 pieces,
                            so counting completed pieces against rows produces
                            "18 of 2". Progress is in pieces, because pieces are
                            what the customer receives — not operations closed,
                            and not list rows. */}
                        {`${integer(row.partsCompleted)} of ${integer(row.partsPlanned)} pieces`}
                        {` · ${integer(row.partCount)} row${row.partCount === 1 ? '' : 's'}`}
                        {row.operationCount > 0
                          ? ` · ${integer(row.operationsDone)}/${integer(row.operationCount)} ops`
                          : ''}
                      </span>
                      {row.partsRejected > 0 ? (
                        <span className="block text-xs text-(--color-bad)">
                          {`${integer(row.partsRejected)} rejected`}
                        </span>
                      ) : null}
                    </>
                  )}
                </Td>
                <Td>
                  <span className={row.isLate ? 'text-(--color-bad)' : ''}>
                    {date(row.plannedEndDate)}
                    {row.isLate ? ' ⚠' : ''}
                  </span>
                  {row.releasedAt ? (
                    <span className="block text-xs text-(--color-muted)">
                      released {date(row.releasedAt)}
                    </span>
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['work order', 'work orders']} />
      </Card>
    </>
  );
}

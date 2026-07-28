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
import { date, quantity } from '@/lib/format';

interface CountRow {
  id: string;
  number: string | null;
  warehouseCode: string;
  warehouseName: string;
  status: string;
  countDate: string;
  postedAt: string | null;
  lineCount: number;
  countedLines: number;
  netVariance: string;
  grossVariance: string;
}

const BASE = '/inventory/counts';

const STATUSES = [
  { label: 'All', value: null },
  { label: 'Draft', value: 'draft' },
  { label: 'Counting', value: 'counting' },
  { label: 'Awaiting approval', value: 'pending_approval' },
  { label: 'Posted', value: 'posted' },
];

export default async function CountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);

  const result = await fetchList<CountRow>('/inventory/counts', query);

  return (
    <>
      <PageHeader
        title="Stock counts"
        subtitle="What was counted, what disagreed with the book, and by how much."
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          <FilterChips base={BASE} query={query} param="status" options={STATUSES} />
          {/* Spans three statuses — draft, counting and awaiting approval — so
              it is a filter rather than a status chip. "What is still open" is
              one question; which stage each one is at is another. */}
          <FilterChips
            base={BASE}
            query={query}
            param="open"
            options={[{ label: 'Open only', value: 'true' }]}
          />
        </div>
        <SearchBox base={BASE} query={query} placeholder="Count number or warehouse…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['stock count', 'stock counts']}
            hint="A count freezes the book quantity per line, so the variance means something."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="number" current={result.sort} direction={result.direction}>
                  Number
                </SortTh>
                <SortTh base={BASE} query={query} column="warehouseCode" current={result.sort} direction={result.direction}>
                  Warehouse
                </SortTh>
                <SortTh base={BASE} query={query} column="status" current={result.sort} direction={result.direction}>
                  Status
                </SortTh>
                <SortTh base={BASE} query={query} column="countDate" current={result.sort} direction={result.direction}>
                  Count date
                </SortTh>
                <Th>Counted</Th>
                <Th numeric>Net variance</Th>
                <Th numeric>Gross variance</Th>
              </tr>
            }
          >
            {result.rows.map((row) => {
              const net = Number(row.netVariance);
              const gross = Number(row.grossVariance);
              const progress = row.lineCount === 0 ? 0 : (row.countedLines / row.lineCount) * 100;

              return (
                <tr key={row.id} className="hover:bg-(--color-canvas)">
                  <Td>
                    <span className="numeric">{row.number ?? '—'}</span>
                  </Td>
                  <Td>
                    <span className="block">{row.warehouseName}</span>
                    <span className="numeric text-xs text-(--color-muted)">
                      {row.warehouseCode}
                    </span>
                  </Td>
                  <Td>
                    <Badge
                      tone={
                        row.status === 'posted'
                          ? 'good'
                          : row.status === 'cancelled'
                            ? 'bad'
                            : 'neutral'
                      }
                    >
                      {row.status.replace(/_/g, ' ')}
                    </Badge>
                  </Td>
                  <Td>
                    <span className="block">{date(row.countDate)}</span>
                    {row.postedAt ? (
                      <span className="text-xs text-(--color-muted)">
                        posted {date(row.postedAt)}
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    <div className="w-32">
                      <ProgressBar value={progress} />
                    </div>
                    <span className="numeric text-xs text-(--color-muted)">
                      {/* "1 of 1 lines" is the same slip as "1 open exceptions":
                          small, and it makes a reader wonder what else on the
                          screen was not checked. */}
                      {`${row.countedLines} of ${row.lineCount} line${row.lineCount === 1 ? '' : 's'}`}
                    </span>
                  </Td>
                  <Td numeric>
                    {/* Net answers "is the book value right". A count where one
                        bin is fifty over and another fifty short nets to zero,
                        which is why gross sits beside it rather than instead. */}
                    <span
                      className={
                        net === 0 ? 'text-(--color-muted)' : net > 0 ? '' : 'text-(--color-bad)'
                      }
                    >
                      {net > 0 ? `+${quantity(net)}` : quantity(net)}
                    </span>
                  </Td>
                  <Td numeric>
                    <span className={gross === 0 ? 'text-(--color-muted)' : 'text-(--color-warn)'}>
                      {quantity(gross)}
                    </span>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['stock count', 'stock counts']} />
      </Card>
    </>
  );
}

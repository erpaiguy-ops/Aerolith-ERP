import {
  EmptyList,
  FilterChips,
  Pager,
  SearchBox,
  SortTh,
  fetchList,
  listQuery,
} from '@/components/List';
import { Badge, Card, Money, PageHeader, Table, Td } from '@/components/ui';
import { date } from '@/lib/format';
import { getMe } from '@/lib/session';

interface RequisitionRow {
  id: string;
  number: string | null;
  title: string;
  status: string;
  priority: string;
  requiredBy: string | null;
  estimatedValue: number;
  projectCode: string | null;
}

const BASE = '/procurement/requisitions';

const STATUSES = [
  { label: 'All', value: null },
  { label: 'Draft', value: 'draft' },
  { label: 'Approved', value: 'approved' },
  { label: 'Sourcing', value: 'sourcing' },
  { label: 'Ordered', value: 'ordered' },
];

/** Whole days from today to a date. Negative once the date has passed. */
function daysUntil(value: string | null): number | null {
  if (!value) return null;
  const target = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(target)) return null;
  const today = new Date();
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((target - midnight) / 86_400_000);
}

export default async function RequisitionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();

  const result = await fetchList<RequisitionRow>('/procurement/requisitions', query);

  return (
    <>
      <PageHeader
        title="Requisitions"
        subtitle="What the site needs, and whether anybody has started buying it."
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterChips base={BASE} query={query} param="status" options={STATUSES} />
        <SearchBox base={BASE} query={query} placeholder="Number or title…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['requisition', 'requisitions']}
            hint="Anyone who needs something raises one; approval happens before a supplier is committed."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="number" current={result.sort} direction={result.direction}>
                  Number
                </SortTh>
                <SortTh base={BASE} query={query} column="title" current={result.sort} direction={result.direction}>
                  Wanted
                </SortTh>
                <SortTh base={BASE} query={query} column="status" current={result.sort} direction={result.direction}>
                  Status
                </SortTh>
                <SortTh base={BASE} query={query} column="estimatedValue" current={result.sort} direction={result.direction} numeric>
                  Estimated
                </SortTh>
                <SortTh base={BASE} query={query} column="requiredBy" current={result.sort} direction={result.direction}>
                  Needed by
                </SortTh>
              </tr>
            }
          >
            {result.rows.map((row) => {
              const days = daysUntil(row.requiredBy);
              // Only unsourced demand can still be late. Once it is ordered the
              // date that matters is the supplier's promise, which lives on the
              // order — flagging it here would be a second, quieter answer to
              // the same question.
              const outstanding = row.status === 'draft' || row.status === 'approved';
              const late = outstanding && days != null && days < 0;
              const soon = outstanding && days != null && days >= 0 && days <= 7;

              return (
                <tr key={row.id} className="hover:bg-(--color-canvas)">
                  <Td>
                    <span className="numeric">{row.number ?? '—'}</span>
                  </Td>
                  <Td>
                    <span className="flex items-center gap-2">
                      {row.title}
                      {row.priority !== 'routine' ? (
                        <Badge tone={row.priority === 'emergency' ? 'bad' : 'neutral'}>
                          {row.priority}
                        </Badge>
                      ) : null}
                    </span>
                    {row.projectCode ? (
                      <span className="text-xs text-(--color-muted)">{row.projectCode}</span>
                    ) : null}
                  </Td>
                  <Td>
                    <Badge
                      tone={
                        row.status === 'ordered'
                          ? 'good'
                          : row.status === 'rejected' || row.status === 'cancelled'
                            ? 'bad'
                            : 'neutral'
                      }
                    >
                      {row.status}
                    </Badge>
                  </Td>
                  <Td numeric>
                    <Money amount={row.estimatedValue} currency={me.tenant.currencyCode} />
                  </Td>
                  <Td>
                    <span className={late ? 'text-(--color-bad)' : soon ? 'font-medium' : ''}>
                      {date(row.requiredBy)}
                      {late ? ` · ${Math.abs(days!)}d late` : null}
                    </span>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['requisition', 'requisitions']} />
      </Card>
    </>
  );
}

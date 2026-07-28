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
import { date, integer, percent } from '@/lib/format';
import { getMe } from '@/lib/session';

interface CuttingPlanRow {
  id: string;
  workOrderId: string;
  workOrderNumber: string | null;
  workOrderDescription: string;
  version: number;
  sheetsUsed: number;
  offcutsUsed: number;
  grossYieldPercent: string | null;
  netYieldPercent: string | null;
  materialCost: string | null;
  isCommitted: boolean;
  committedAt: string | null;
  createdAt: string;
  offcutsConsumed: number;
}

const BASE = '/production/cutlist';

export default async function CuttingPlansPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();

  const result = await fetchList<CuttingPlanRow>('/production/cutting-plans', query);

  return (
    <>
      <PageHeader
        title="Cutting plans"
        subtitle="What each job was planned to cut from, and what the offcut rack saved."
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterChips
          base={BASE}
          query={query}
          param="committed"
          options={[
            { label: 'All', value: null },
            { label: 'Committed', value: 'yes' },
            { label: 'Not committed', value: 'no' },
          ]}
        />
        <SearchBox base={BASE} query={query} placeholder="Work order number or description…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['cutting plan', 'cutting plans']}
            hint="A plan is generated against live stock — the offcut rack first, then new sheets."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="workOrderNumber" current={result.sort} direction={result.direction}>
                  Work order
                </SortTh>
                <Th>Version</Th>
                <SortTh base={BASE} query={query} column="sheetsUsed" current={result.sort} direction={result.direction} numeric>
                  Boards
                </SortTh>
                <SortTh base={BASE} query={query} column="netYieldPercent" current={result.sort} direction={result.direction} numeric>
                  Yield
                </SortTh>
                <Th numeric>Material</Th>
                <SortTh base={BASE} query={query} column="createdAt" current={result.sort} direction={result.direction}>
                  Planned
                </SortTh>
              </tr>
            }
          >
            {result.rows.map((row) => (
              <tr key={row.id} className="hover:bg-(--color-canvas)">
                <Td>
                  <span className="numeric block">{row.workOrderNumber ?? '—'}</span>
                  <span className="text-xs text-(--color-muted)">{row.workOrderDescription}</span>
                </Td>
                <Td>
                  <span className="numeric block">v{row.version}</span>
                  {row.isCommitted ? (
                    <Badge tone="good">committed</Badge>
                  ) : (
                    // A plan that has not been committed has not consumed
                    // anything: the offcuts it names are still on the rack and
                    // still available to a different job.
                    <Badge tone="neutral">provisional</Badge>
                  )}
                </Td>
                <Td numeric>
                  <span className="numeric">{integer(row.sheetsUsed)}</span>
                  <span className="block text-xs text-(--color-muted)">
                    {row.offcutsUsed > 0
                      ? `+ ${integer(row.offcutsUsed)} off the rack`
                      : 'new sheets only'}
                  </span>
                </Td>
                <Td numeric>
                  {/* Net first. Gross treats a large reusable remnant as waste,
                      which is why opening a sheet to cut one plinth reads as 84%
                      waste on a gross figure and is nothing of the sort. */}
                  <span>{row.netYieldPercent ? percent(row.netYieldPercent) : '—'}</span>
                  <span className="block text-xs text-(--color-muted)">
                    {row.grossYieldPercent ? `${percent(row.grossYieldPercent)} gross` : ''}
                  </span>
                </Td>
                <Td numeric>
                  <Money amount={row.materialCost} currency={me.tenant.currencyCode} />
                </Td>
                <Td>
                  <span className="block">{date(row.createdAt)}</span>
                  {row.committedAt ? (
                    <span className="text-xs text-(--color-muted)">
                      committed {date(row.committedAt)}
                    </span>
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['cutting plan', 'cutting plans']} />
      </Card>
    </>
  );
}

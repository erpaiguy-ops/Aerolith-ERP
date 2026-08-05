import Link from 'next/link';

import { ActionForm, SubmitButton } from '@/components/Action';
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
import { can } from '@/lib/actions';
import { pageFetch } from '@/lib/api';
import { date, quantity } from '@/lib/format';
import { getMe } from '@/lib/session';

import { createStockCountAction } from './actions';

interface Warehouse {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

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
  const me = await getMe();
  const mayReconcile = can(me.permissions, 'inventory.stock_count.reconcile') || me.user.isOwner;

  const [result, warehouses] = await Promise.all([
    fetchList<CountRow>('/inventory/counts', query),
    mayReconcile
      ? (await pageFetch<{ warehouses: Warehouse[] }>('/inventory/warehouses')).warehouses.filter(
          (w) => w.isActive,
        )
      : [],
  ]);

  const field =
    'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-3 py-1.5 text-sm outline-none focus:border-(--color-accent)';

  return (
    <>
      <PageHeader
        title="Stock counts"
        subtitle="What was counted, what disagreed with the book, and by how much."
      />

      {mayReconcile ? (
        <Card className="mb-4">
          <details>
            <summary className="cursor-pointer text-sm font-medium">Raise a count</summary>
            <ActionForm action={createStockCountAction} className="mt-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label htmlFor="warehouseId" className="mb-1 block text-xs text-(--color-muted)">
                    Warehouse
                  </label>
                  <select id="warehouseId" name="warehouseId" className={field} defaultValue="">
                    <option value="" disabled>
                      Choose a warehouse…
                    </option>
                    {warehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {`${w.code} — ${w.name}`}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="countDate" className="mb-1 block text-xs text-(--color-muted)">
                    Count date
                  </label>
                  <input
                    id="countDate"
                    name="countDate"
                    type="date"
                    defaultValue={new Date().toISOString().slice(0, 10)}
                    className={field}
                  />
                </div>
                <div className="flex items-end">
                  <SubmitButton pendingLabel="Raising…">Raise count</SubmitButton>
                </div>
              </div>
              <p className="mt-2 text-xs text-(--color-muted)">
                Raising a count only creates the header — the book quantity per line is frozen when
                you generate the sheet, on the count&apos;s own screen, so a count sitting unopened
                overnight does not measure against a quantity that moved in the meantime.
              </p>
            </ActionForm>
          </details>
        </Card>
      ) : null}

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
                    <Link
                      href={`/inventory/counts/${row.id}`}
                      className="numeric text-(--color-accent) hover:underline"
                    >
                      {row.number ?? '—'}
                    </Link>
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

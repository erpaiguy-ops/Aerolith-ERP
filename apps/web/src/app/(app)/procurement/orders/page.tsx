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
import { Badge, Card, Money, PageHeader, Table, Td } from '@/components/ui';
import { date } from '@/lib/format';
import { getMe } from '@/lib/session';

interface OrderRow {
  id: string;
  number: string | null;
  status: string;
  supplierName: string | null;
  projectCode: string | null;
  currencyCode: string | null;
  grossValue: number;
  baseValue: number;
  promisedDeliveryDate: string | null;
  issuedOn: string | null;
  isOverdue: boolean;
}

const BASE = '/procurement/orders';

const STATUSES = [
  { label: 'All', value: null },
  { label: 'Draft', value: 'draft' },
  { label: 'Issued', value: 'issued' },
  { label: 'Part received', value: 'partially_received' },
  { label: 'Received', value: 'received' },
];

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();

  const result = await fetchList<OrderRow>('/procurement/orders', query);

  return (
    <>
      <PageHeader
        title="Purchase orders"
        subtitle="What has been ordered, what is late, and what it committed."
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          <FilterChips base={BASE} query={query} param="status" options={STATUSES} />
          {/* Its own chip rather than a status, because "late" cuts across
              statuses: an order can be issued or part-received and still be
              overdue, and it is the first question a buyer asks each morning. */}
          <FilterChips
            base={BASE}
            query={query}
            param="overdue"
            options={[{ label: 'Overdue only', value: 'true' }]}
          />
        </div>
        <SearchBox base={BASE} query={query} placeholder="Order number or supplier…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['purchase order', 'purchase orders']}
            hint="Orders are raised from an awarded quote, or directly."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="number" current={result.sort} direction={result.direction}>
                  Number
                </SortTh>
                <SortTh base={BASE} query={query} column="createdAt" current={result.sort} direction={result.direction}>
                  Supplier
                </SortTh>
                <SortTh base={BASE} query={query} column="status" current={result.sort} direction={result.direction}>
                  Status
                </SortTh>
                <SortTh base={BASE} query={query} column="grossValue" current={result.sort} direction={result.direction} numeric>
                  Value
                </SortTh>
                <SortTh base={BASE} query={query} column="promisedDeliveryDate" current={result.sort} direction={result.direction}>
                  Promised
                </SortTh>
                <SortTh base={BASE} query={query} column="issuedOn" current={result.sort} direction={result.direction}>
                  Issued
                </SortTh>
              </tr>
            }
          >
            {result.rows.map((row) => (
              <tr key={row.id} className="hover:bg-(--color-canvas)">
                <Td>
                  <Link
                    href={`/procurement/orders/${row.id}`}
                    className="numeric text-(--color-accent) hover:underline"
                  >
                    {row.number ?? '—'}
                  </Link>
                </Td>
                <Td>
                  <span className="block">{row.supplierName ?? '—'}</span>
                  {row.projectCode ? (
                    <span className="text-xs text-(--color-muted)">{row.projectCode}</span>
                  ) : null}
                </Td>
                <Td>
                  <Badge
                    tone={
                      row.status === 'received' || row.status === 'closed'
                        ? 'good'
                        : row.status === 'cancelled'
                          ? 'bad'
                          : 'neutral'
                    }
                  >
                    {row.status.replace(/_/g, ' ')}
                  </Badge>
                </Td>
                <Td numeric>
                  <Money
                    amount={row.grossValue}
                    currency={row.currencyCode ?? me.tenant.currencyCode}
                  />
                </Td>
                <Td>
                  <span className={row.isOverdue ? 'text-(--color-bad)' : ''}>
                    {date(row.promisedDeliveryDate)}
                    {row.isOverdue ? ' ⚠' : ''}
                  </span>
                </Td>
                <Td>{date(row.issuedOn)}</Td>
              </tr>
            ))}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['purchase order', 'purchase orders']} />
      </Card>
    </>
  );
}

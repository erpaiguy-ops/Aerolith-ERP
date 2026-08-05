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

interface InvoiceRow {
  id: string;
  number: string | null;
  supplierReference: string;
  status: string;
  supplierName: string | null;
  purchaseOrderNumber: string | null;
  invoiceDate: string;
  dueOn: string | null;
  currencyCode: string | null;
  grossValue: number;
  matchVariance: number | null;
  openExceptions: number;
  isOverdue: boolean;
}

const BASE = '/procurement/invoices';

const STATUSES = [
  { label: 'All', value: null },
  { label: 'Matched', value: 'matched' },
  { label: 'On hold', value: 'on_hold' },
  { label: 'Approved', value: 'approved' },
  { label: 'Paid', value: 'paid' },
];

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();

  const result = await fetchList<InvoiceRow>('/procurement/invoices', query);

  const heldValue = result.rows
    .filter((row) => row.status === 'on_hold')
    .reduce((total, row) => total + row.grossValue, 0);

  return (
    <>
      <PageHeader
        title="Supplier invoices"
        subtitle="Three-way matched against the order and what was actually received."
      />

      {/* Sorted by due date ascending by default, so this list reads as a
          payment run: the top of it is what goes late next. */}
      {heldValue > 0 ? (
        <div className="mb-4 rounded-lg border border-(--color-bad)/30 bg-(--color-bad)/5 p-3 text-sm">
          <span className="font-medium text-(--color-bad)">
            {result.rows.filter((r) => r.status === 'on_hold').length} held on this page
          </span>{' '}
          <span className="text-(--color-muted)">
            — {new Intl.NumberFormat('en-AE').format(Math.round(heldValue))}{' '}
            {me.tenant.currencyCode} not payable until the exceptions are answered.
          </span>
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterChips base={BASE} query={query} param="status" options={STATUSES} />
        <SearchBox base={BASE} query={query} placeholder="Invoice number or supplier…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['supplier invoice', 'supplier invoices']}
            hint="Invoices are registered against a purchase order and matched on arrival."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="supplierReference" current={result.sort} direction={result.direction}>
                  Invoice
                </SortTh>
                <SortTh base={BASE} query={query} column="createdAt" current={result.sort} direction={result.direction}>
                  Supplier
                </SortTh>
                <SortTh base={BASE} query={query} column="status" current={result.sort} direction={result.direction}>
                  Match
                </SortTh>
                <SortTh base={BASE} query={query} column="grossValue" current={result.sort} direction={result.direction} numeric>
                  Value
                </SortTh>
                <SortTh base={BASE} query={query} column="invoiceDate" current={result.sort} direction={result.direction}>
                  Dated
                </SortTh>
                <SortTh base={BASE} query={query} column="dueOn" current={result.sort} direction={result.direction}>
                  Due
                </SortTh>
              </tr>
            }
          >
            {result.rows.map((row) => (
              <tr key={row.id} className="hover:bg-(--color-canvas)">
                <Td>
                  {/* The SUPPLIER's number leads, not ours. It is what a chasing
                      phone call quotes, and what the paper on the desk says. */}
                  <Link
                    href={`/procurement/invoices/${row.id}`}
                    className="numeric block text-(--color-accent) hover:underline"
                  >
                    {row.supplierReference}
                  </Link>
                  {row.purchaseOrderNumber ? (
                    <span className="numeric text-xs text-(--color-muted)">
                      {row.purchaseOrderNumber}
                    </span>
                  ) : null}
                </Td>
                <Td>{row.supplierName ?? '—'}</Td>
                <Td>
                  <span className="flex items-center gap-1.5">
                    <Badge
                      tone={
                        row.status === 'on_hold'
                          ? 'bad'
                          : row.status === 'matched' || row.status === 'paid'
                            ? 'good'
                            : 'neutral'
                      }
                    >
                      {row.status.replace(/_/g, ' ')}
                    </Badge>
                    {/* The count is what makes the row actionable. "On hold" tells
                        you nothing about how much work answering it is. */}
                    {row.openExceptions > 0 ? (
                      <span className="numeric text-xs text-(--color-bad)">
                        {row.openExceptions} open
                      </span>
                    ) : null}
                  </span>
                </Td>
                <Td numeric>
                  <Money
                    amount={row.grossValue}
                    currency={row.currencyCode ?? me.tenant.currencyCode}
                  />
                </Td>
                <Td>{date(row.invoiceDate)}</Td>
                <Td>
                  <span className={row.isOverdue ? 'text-(--color-bad)' : ''}>
                    {date(row.dueOn)}
                    {row.isOverdue ? ' ⚠' : ''}
                  </span>
                </Td>
              </tr>
            ))}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['supplier invoice', 'supplier invoices']} />
      </Card>
    </>
  );
}

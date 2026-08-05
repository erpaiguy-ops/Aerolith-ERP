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

interface ReceiptRow {
  id: string;
  number: string | null;
  receivedOn: string;
  deliveryNoteReference: string | null;
  overDelivered: boolean;
  purchaseOrderId: string;
  purchaseOrderNumber: string | null;
  supplierName: string | null;
  projectCode: string | null;
  lineCount: number;
  accrualValue: number;
  inspectionNotes: string | null;
}

const BASE = '/procurement/receipts';

export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();

  const result = await fetchList<ReceiptRow>('/procurement/receipts', query);
  const flagged = result.rows.filter((row) => row.overDelivered);

  return (
    <>
      <PageHeader
        title="Goods receipts"
        subtitle="What arrived, what it charged the job, and what was queried at the gate."
      />

      {flagged.length > 0 ? (
        <div className="mb-4 rounded-lg border border-(--color-bad)/30 bg-(--color-bad)/5 p-3 text-sm">
          <span className="font-medium text-(--color-bad)">
            {flagged.length} over-delivered
          </span>{' '}
          <span className="text-(--color-muted)">
            — more arrived than was ordered, beyond tolerance. Accepted at the gate and still
            open as a commercial question.
          </span>
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterChips
          base={BASE}
          query={query}
          param="overDelivered"
          options={[
            { label: 'All', value: null },
            { label: 'Over-delivered', value: 'true' },
          ]}
        />
        <SearchBox base={BASE} query={query} placeholder="GRN, delivery note or supplier…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['goods receipt', 'goods receipts']}
            hint="Receive against a purchase order — the delivery is what takes stock in and charges the job."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="number" current={result.sort} direction={result.direction}>
                  GRN
                </SortTh>
                <SortTh base={BASE} query={query} column="createdAt" current={result.sort} direction={result.direction}>
                  Supplier
                </SortTh>
                <SortTh base={BASE} query={query} column="receivedOn" current={result.sort} direction={result.direction}>
                  Received
                </SortTh>
                <SortTh base={BASE} query={query} column="createdAt" current={result.sort} direction={result.direction} numeric>
                  Lines
                </SortTh>
                <SortTh base={BASE} query={query} column="createdAt" current={result.sort} direction={result.direction} numeric>
                  Charged to job
                </SortTh>
              </tr>
            }
          >
            {result.rows.map((row) => (
              <tr key={row.id} className="hover:bg-(--color-canvas)">
                <Td>
                  <span className="numeric block">{row.number ?? '—'}</span>
                  {/* The supplier's own delivery note, which is the number
                      written on the paper the driver handed over — and so the
                      one anybody chasing a delivery will quote. */}
                  {row.deliveryNoteReference ? (
                    <span className="numeric text-xs text-(--color-muted)">
                      DN {row.deliveryNoteReference}
                    </span>
                  ) : null}
                </Td>
                <Td>
                  <span className="block">{row.supplierName ?? '—'}</span>
                  <Link
                    href={`/procurement/orders/${row.purchaseOrderId}`}
                    className="numeric text-xs text-(--color-accent) hover:underline"
                  >
                    {row.purchaseOrderNumber ?? 'order'}
                  </Link>
                  {row.projectCode ? (
                    <span className="text-xs text-(--color-muted)"> · {row.projectCode}</span>
                  ) : null}
                </Td>
                <Td>
                  <span className="block">{date(row.receivedOn)}</span>
                  {row.overDelivered ? <Badge tone="bad">over-delivered</Badge> : null}
                </Td>
                <Td numeric>{row.lineCount}</Td>
                <Td numeric>
                  {/* The accrual. A receipt register without it says only that
                      something arrived; this is what the job was charged the day
                      it landed, months before the invoice. */}
                  <Money amount={row.accrualValue} currency={me.tenant.currencyCode} />
                </Td>
              </tr>
            ))}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['goods receipt', 'goods receipts']} />
      </Card>
    </>
  );
}

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
import { getMe } from '@/lib/session';

interface ExceptionRow {
  id: string;
  code: string;
  message: string;
  amount: number;
  isFavourable: boolean;
  resolution: string;
  supplierInvoiceId: string | null;
  supplierReference: string | null;
  supplierName: string | null;
  invoiceStatus: string | null;
  goodsReceiptId: string | null;
}

const BASE = '/procurement/exceptions';

const CODES = [
  { label: 'All', value: null },
  { label: 'Over-invoiced', value: 'over_invoiced_quantity' },
  { label: 'No receipt', value: 'no_receipt' },
  { label: 'Price variance', value: 'price_variance' },
  { label: 'Not on order', value: 'unmatched_line' },
  { label: 'Over-delivered', value: 'over_receipt' },
];

/** What each code actually means, in the words a buyer would use. */
const EXPLAINS: Record<string, string> = {
  over_invoiced_quantity: 'Billed for more than has been received and not already billed.',
  no_receipt: 'Billed for something with no goods receipt at all.',
  price_variance: 'Line total above the ordered price, outside tolerance.',
  unmatched_line: 'Billed for something that is not on the purchase order.',
  over_receipt: 'Delivered materially more than was ordered.',
};

export default async function ExceptionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();

  const result = await fetchList<ExceptionRow>('/procurement/exceptions', query);

  const atStake = result.rows.reduce((total, row) => total + Math.max(0, row.amount), 0);

  return (
    <>
      <PageHeader
        title="Match exceptions"
        subtitle="Invoices held because they do not agree with the order or the delivery."
      />

      {result.total > 0 ? (
        <div className="mb-4 rounded-lg border border-(--color-line) bg-(--color-surface) p-3 text-sm">
          <span className="numeric font-medium">{result.total}</span> open
          {result.rows.length > 0 ? (
            <span className="text-(--color-muted)">
              {' '}
              · <span className="numeric">
                {new Intl.NumberFormat('en-AE').format(Math.round(atStake))}
              </span>{' '}
              {me.tenant.currencyCode} at stake on this page
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterChips base={BASE} query={query} param="code" options={CODES} />
        <SearchBox base={BASE} query={query} placeholder="Invoice, supplier or text…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['exception', 'exceptions']}
            // The genuinely empty state here is good news, and should read that
            // way. Most empty states are a gap; this one is the control working.
            hint="Every invoice registered so far agreed with its order and its delivery."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="code" current={result.sort} direction={result.direction}>
                  Problem
                </SortTh>
                <SortTh base={BASE} query={query} column="createdAt" current={result.sort} direction={result.direction}>
                  Invoice
                </SortTh>
                <SortTh base={BASE} query={query} column="amount" current={result.sort} direction={result.direction} numeric>
                  At stake
                </SortTh>
              </tr>
            }
          >
            {result.rows.map((row) => (
              <tr key={row.id} className="hover:bg-(--color-canvas)">
                <Td>
                  <span className="flex items-center gap-2">
                    <Badge tone={row.isFavourable ? 'neutral' : 'bad'}>
                      {row.code.replace(/_/g, ' ')}
                    </Badge>
                  </span>
                  {/* The generated message, which names the actual quantities.
                      A code alone makes the buyer open the invoice to find out
                      whether it is worth opening. */}
                  <span className="mt-0.5 block text-xs text-(--color-muted)">
                    {row.message || EXPLAINS[row.code]}
                  </span>
                </Td>
                <Td>
                  <span className="numeric block">{row.supplierReference ?? '—'}</span>
                  <span className="text-xs text-(--color-muted)">{row.supplierName ?? '—'}</span>
                </Td>
                <Td numeric>
                  <Money
                    amount={row.amount}
                    currency={me.tenant.currencyCode}
                    tone={row.isFavourable ? 'good' : 'bad'}
                  />
                </Td>
              </tr>
            ))}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['open exception', 'open exceptions']} />
      </Card>
    </>
  );
}

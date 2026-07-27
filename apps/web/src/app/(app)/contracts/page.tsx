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
import { date, toneForVariance } from '@/lib/format';
import { getMe } from '@/lib/session';

interface ContractRow {
  id: string;
  number: string | null;
  name: string;
  side: string;
  status: string;
  currencyCode: string | null;
  originalSum: number;
  currentSum: number;
  variationValue: number;
  projectCode: string | null;
  counterpartyName: string | null;
  contractCompletionDate: string | null;
  externalReference: string | null;
}

const BASE = '/contracts';

const SIDES = [
  { label: 'All', value: null },
  // Receivable is money in, payable is money out. Both live in one register
  // because the arithmetic is identical in each direction — only the sign of the
  // cash flow differs — but they are almost never looked at together.
  { label: 'Receivable', value: 'receivable' },
  { label: 'Payable', value: 'payable' },
];

export default async function ContractsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();

  const result = await fetchList<ContractRow>('/contracts', query);

  return (
    <>
      <PageHeader title="Contracts" subtitle="Variations, payment applications and retention." />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterChips base={BASE} query={query} param="side" options={SIDES} />
        <SearchBox base={BASE} query={query} placeholder="Number, name or client ref…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['contract', 'contracts']}
            hint="A contract is created when a tender is won, or entered directly."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="number" current={result.sort} direction={result.direction}>
                  Number
                </SortTh>
                <SortTh base={BASE} query={query} column="name" current={result.sort} direction={result.direction}>
                  Contract
                </SortTh>
                <SortTh base={BASE} query={query} column="status" current={result.sort} direction={result.direction}>
                  Status
                </SortTh>
                <SortTh base={BASE} query={query} column="currentSum" current={result.sort} direction={result.direction} numeric>
                  Current sum
                </SortTh>
                <SortTh base={BASE} query={query} column="createdAt" current={result.sort} direction={result.direction} numeric>
                  Variations
                </SortTh>
                <SortTh base={BASE} query={query} column="contractCompletionDate" current={result.sort} direction={result.direction}>
                  Completion
                </SortTh>
              </tr>
            }
          >
            {result.rows.map((row) => (
              <tr key={row.id} className="hover:bg-(--color-canvas)">
                <Td>
                  <Link href={`/contracts/${row.id}`} className="numeric text-(--color-accent) hover:underline">
                    {row.number ?? '—'}
                  </Link>
                </Td>
                <Td>
                  <span className="block">{row.name}</span>
                  {/* Client and job beneath the name rather than in their own
                      columns: on a contract register these identify the row, and
                      three separate columns of names is unreadable at a glance. */}
                  <span className="text-xs text-(--color-muted)">
                    {[row.counterpartyName, row.projectCode].filter(Boolean).join(' · ') || '—'}
                  </span>
                </Td>
                <Td>
                  <Badge
                    tone={
                      row.status === 'active'
                        ? 'good'
                        : row.status === 'terminated'
                          ? 'bad'
                          : 'neutral'
                    }
                  >
                    {row.status.replace(/_/g, ' ')}
                  </Badge>
                </Td>
                <Td numeric>
                  <Money
                    amount={row.currentSum}
                    currency={row.currencyCode ?? me.tenant.currencyCode}
                  />
                </Td>
                <Td numeric>
                  {/* Approved variations only — this is current less original, and
                      only an approved variation moves the current sum. Instructed
                      but unapproved work is exposure, and it lives on the detail
                      screen where there is room to explain the difference. */}
                  {row.variationValue === 0 ? (
                    <span className="text-(--color-muted)">—</span>
                  ) : (
                    <Money
                      amount={row.variationValue}
                      currency={row.currencyCode ?? me.tenant.currencyCode}
                      tone={toneForVariance(-row.variationValue)}
                    />
                  )}
                </Td>
                <Td>{date(row.contractCompletionDate)}</Td>
              </tr>
            ))}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['contract', 'contracts']} />
      </Card>
    </>
  );
}

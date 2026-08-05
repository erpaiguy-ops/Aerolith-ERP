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

interface ApplicationRow {
  id: string;
  number: string | null;
  sequence: number;
  status: string;
  contractId: string;
  contractNumber: string | null;
  contractName: string;
  projectCode: string | null;
  counterpartyName: string | null;
  currencyCode: string | null;
  periodTo: string;
  dueOn: string | null;
  totalApplied: number;
  certifiedTotal: number | null;
  disallowed: number | null;
  isOverdue: boolean;
  awaitingCertificate: boolean;
}

const BASE = '/contracts/applications';

const STATUSES = [
  { label: 'All', value: null },
  { label: 'Draft', value: 'draft' },
  { label: 'Submitted', value: 'submitted' },
  { label: 'Certified', value: 'certified' },
  { label: 'Paid', value: 'paid' },
];

export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();

  const result = await fetchList<ApplicationRow>('/contracts/applications', query);

  const disallowed = result.rows.reduce((total, row) => total + Math.min(0, row.disallowed ?? 0), 0);
  const awaiting = result.rows.filter((row) => row.awaitingCertificate);

  return (
    <>
      <PageHeader
        title="Payment applications"
        subtitle="What has been applied for, what was certified, and what is still owed."
      />

      {awaiting.length > 0 || disallowed < 0 ? (
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          {awaiting.length > 0 ? (
            <div className="rounded-lg border border-(--color-line) bg-(--color-surface) p-3 text-sm">
              <span className="numeric font-medium">{awaiting.length}</span> awaiting a certificate
              <span className="text-(--color-muted)">
                {' '}
                ·{' '}
                <Money
                  amount={awaiting.reduce((total, row) => total + row.totalApplied, 0)}
                  currency={me.tenant.currencyCode}
                />{' '}
                with the client
              </span>
            </div>
          ) : null}
          {disallowed < 0 ? (
            <div className="rounded-lg border border-(--color-bad)/30 bg-(--color-bad)/5 p-3 text-sm">
              {/* The gap between applied and certified, on this page. A client
                  who trims every valuation is a pattern you can price against —
                  but only if somebody totals it. */}
              <span className="font-medium text-(--color-bad)">
                <Money amount={disallowed} currency={me.tenant.currencyCode} />
              </span>{' '}
              <span className="text-(--color-muted)">disallowed on certified applications</span>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          <FilterChips base={BASE} query={query} param="status" options={STATUSES} />
          {/* Spans two statuses — applied-and-uncertified plus
              certified-and-unpaid — so it cannot be a status chip. */}
          <FilterChips
            base={BASE}
            query={query}
            param="outstanding"
            options={[{ label: 'Outstanding only', value: 'true' }]}
          />
        </div>
        <SearchBox base={BASE} query={query} placeholder="Application or contract…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['payment application', 'payment applications']}
            hint="Applications are drafted from measured progress, or entered by a quantity surveyor."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="number" current={result.sort} direction={result.direction}>
                  Application
                </SortTh>
                <SortTh base={BASE} query={query} column="createdAt" current={result.sort} direction={result.direction}>
                  Contract
                </SortTh>
                <SortTh base={BASE} query={query} column="status" current={result.sort} direction={result.direction}>
                  Status
                </SortTh>
                <SortTh base={BASE} query={query} column="totalApplied" current={result.sort} direction={result.direction} numeric>
                  Applied
                </SortTh>
                <SortTh base={BASE} query={query} column="periodTo" current={result.sort} direction={result.direction} numeric>
                  Certified
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
                  <Link
                    href={`/contracts/applications/${row.id}`}
                    className="numeric text-(--color-accent) hover:underline"
                  >
                    {row.number ?? `IPC ${row.sequence}`}
                  </Link>
                  <span className="block text-xs text-(--color-muted)">
                    to {date(row.periodTo)}
                  </span>
                </Td>
                <Td>
                  <Link
                    href={`/contracts/${row.contractId}`}
                    className="block hover:underline"
                  >
                    {row.contractNumber ?? row.contractName}
                  </Link>
                  <span className="text-xs text-(--color-muted)">
                    {[row.counterpartyName, row.projectCode].filter(Boolean).join(' · ') || '—'}
                  </span>
                </Td>
                <Td>
                  <Badge
                    tone={
                      row.status === 'paid'
                        ? 'good'
                        : row.status === 'disputed'
                          ? 'bad'
                          : 'neutral'
                    }
                  >
                    {row.status}
                  </Badge>
                </Td>
                <Td numeric>
                  <Money
                    amount={row.totalApplied}
                    currency={row.currencyCode ?? me.tenant.currencyCode}
                  />
                </Td>
                <Td numeric>
                  {row.certifiedTotal == null ? (
                    <span className="text-(--color-muted)">—</span>
                  ) : (
                    <>
                      <Money
                        amount={row.certifiedTotal}
                        currency={row.currencyCode ?? me.tenant.currencyCode}
                      />
                      {/* The disallowance sits under the certified figure rather
                          than in its own column: it is only meaningful next to
                          the number it was cut from. */}
                      {row.disallowed != null && row.disallowed < 0 ? (
                        <span className="block text-xs text-(--color-bad)">
                          <Money
                            amount={row.disallowed}
                            currency={row.currencyCode ?? me.tenant.currencyCode}
                          />
                        </span>
                      ) : null}
                    </>
                  )}
                </Td>
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

        <Pager
          base={BASE}
          query={query}
          result={result}
          noun={['payment application', 'payment applications']}
        />
      </Card>
    </>
  );
}

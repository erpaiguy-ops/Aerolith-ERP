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

interface VariationRow {
  id: string;
  number: string | null;
  title: string;
  status: string;
  contractId: string;
  contractNumber: string | null;
  contractName: string;
  projectCode: string | null;
  currencyCode: string | null;
  instructedOn: string | null;
  approvedOn: string | null;
  quotedValue: number | null;
  approvedValue: number | null;
  percentExecuted: number;
  notice: {
    deadlineOn: string;
    daysRemaining: number;
    isGiven: boolean;
    isTimeBarred: boolean;
    wasLate: boolean;
  } | null;
}

const BASE = '/contracts/variations';

const STATUSES = [
  { label: 'All', value: null },
  { label: 'Identified', value: 'identified' },
  { label: 'Instructed', value: 'instructed' },
  { label: 'Quoted', value: 'quoted' },
  { label: 'Submitted', value: 'submitted' },
  { label: 'Approved', value: 'approved' },
];

/** The notice clock, said in the fewest words that are still true. */
function Notice({ notice }: { notice: VariationRow['notice'] }) {
  if (!notice) {
    return <span className="text-xs text-(--color-muted)">no instruction date</span>;
  }

  if (notice.isTimeBarred) {
    return (
      <span className="text-xs font-medium text-(--color-bad)">
        time-barred · deadline was {date(notice.deadlineOn)}
      </span>
    );
  }

  if (notice.isGiven) {
    return (
      <span className="text-xs text-(--color-muted)">
        notice given{notice.wasLate ? ' — late' : ''}
      </span>
    );
  }

  // Still running. Days remaining is the only number that matters here, and it
  // is stated rather than left as a date the reader has to subtract from today.
  return (
    <span
      className={`text-xs ${notice.daysRemaining <= 7 ? 'font-medium text-(--color-bad)' : 'text-(--color-muted)'}`}
    >
      {notice.daysRemaining} day{notice.daysRemaining === 1 ? '' : 's'} to give notice
    </span>
  );
}

export default async function VariationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();

  const result = await fetchList<VariationRow>('/contracts/variations', query);

  const barred = result.rows.filter((row) => row.notice?.isTimeBarred);
  const barredValue = barred.reduce(
    (total, row) => total + (row.approvedValue ?? row.quotedValue ?? 0),
    0,
  );
  const urgent = result.rows.filter(
    (row) => row.notice && !row.notice.isGiven && !row.notice.isTimeBarred && row.notice.daysRemaining <= 7,
  );

  return (
    <>
      <PageHeader
        title="Variations"
        subtitle="Instructed work, what it is worth, and whether notice was given in time."
      />

      {/* Above everything else, because it is the only thing on this page with a
          deadline attached. Entitlement lost to a missed notice is lost
          permanently, however good the claim was. */}
      {barred.length > 0 ? (
        <div className="mb-4 rounded-lg border border-(--color-bad)/30 bg-(--color-bad)/5 p-4">
          <p className="text-sm font-medium text-(--color-bad)">
            {barred.length} variation{barred.length === 1 ? '' : 's'} past the notice deadline —{' '}
            <Money amount={barredValue} currency={me.tenant.currencyCode} /> at risk
          </p>
          <ul className="mt-2 space-y-1 text-sm text-(--color-muted)">
            {barred.map((row) => (
              <li key={row.id}>
                <Link href={`/contracts/variations/${row.id}`} className="hover:underline">
                  <span className="numeric">{row.number}</span> · {row.title}
                </Link>{' '}
                — deadline {date(row.notice!.deadlineOn)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {urgent.length > 0 ? (
        <div className="mb-4 rounded-lg border border-(--color-line) bg-(--color-surface) p-3 text-sm">
          <span className="numeric font-medium">{urgent.length}</span> needing notice within a week
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          <FilterChips base={BASE} query={query} param="status" options={STATUSES} />
          {/* Instructed, no notice yet, not settled either way — everything whose
              clock is still running. Not a status: it spans several. */}
          <FilterChips
            base={BASE}
            query={query}
            param="atRisk"
            options={[{ label: 'Awaiting notice', value: 'true' }]}
          />
        </div>
        <SearchBox base={BASE} query={query} placeholder="Number, title or instruction…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['variation', 'variations']}
            hint="Raise one from the contract as soon as work is instructed — the notice clock starts then, not when it is priced."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="number" current={result.sort} direction={result.direction}>
                  Number
                </SortTh>
                <SortTh base={BASE} query={query} column="title" current={result.sort} direction={result.direction}>
                  Variation
                </SortTh>
                <SortTh base={BASE} query={query} column="status" current={result.sort} direction={result.direction}>
                  Status
                </SortTh>
                <SortTh base={BASE} query={query} column="instructedOn" current={result.sort} direction={result.direction}>
                  Instructed
                </SortTh>
                <SortTh base={BASE} query={query} column="quotedValue" current={result.sort} direction={result.direction} numeric>
                  Quoted
                </SortTh>
                <SortTh base={BASE} query={query} column="createdAt" current={result.sort} direction={result.direction} numeric>
                  Approved
                </SortTh>
              </tr>
            }
          >
            {result.rows.map((row) => (
              <tr key={row.id} className="hover:bg-(--color-canvas)">
                <Td>
                  <Link
                    href={`/contracts/variations/${row.id}`}
                    className="numeric text-(--color-accent) hover:underline"
                  >
                    {row.number ?? '—'}
                  </Link>
                </Td>
                <Td>
                  <span className="block">{row.title}</span>
                  <span className="text-xs text-(--color-muted)">
                    {row.contractNumber ?? row.contractName}
                    {row.projectCode ? ` · ${row.projectCode}` : ''}
                  </span>
                </Td>
                <Td>
                  <Badge
                    tone={
                      row.status === 'approved'
                        ? 'good'
                        : row.status === 'rejected'
                          ? 'bad'
                          : 'neutral'
                    }
                  >
                    {row.status}
                  </Badge>
                </Td>
                <Td>
                  <span className="block">{date(row.instructedOn)}</span>
                  <Notice notice={row.notice} />
                </Td>
                <Td numeric>
                  <Money
                    amount={row.quotedValue}
                    currency={row.currencyCode ?? me.tenant.currencyCode}
                  />
                </Td>
                <Td numeric>
                  {row.approvedValue == null ? (
                    <span className="text-(--color-muted)">—</span>
                  ) : (
                    <Money
                      amount={row.approvedValue}
                      currency={row.currencyCode ?? me.tenant.currencyCode}
                    />
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['variation', 'variations']} />
      </Card>
    </>
  );
}

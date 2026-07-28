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
import { Badge, Card, Money, PageHeader, Stat, Table, Td, Th } from '@/components/ui';
import { date, integer } from '@/lib/format';
import { getMe } from '@/lib/session';

interface RetentionRow {
  id: string;
  contractId: string;
  contractNumber: string | null;
  contractName: string;
  currencyCode: string | null;
  trigger: string;
  amount: string;
  dueOn: string | null;
  releasedOn: string | null;
  applicationId: string | null;
  applicationNumber: string | null;
  note: string | null;
  daysToDue: number | null;
  isOverdue: boolean;
}

interface RetentionSummary {
  heldValue: number;
  dueValue: number;
  releasedValue: number;
  currencyCode: string | null;
}

const BASE = '/contracts/retention';

export default async function RetentionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();

  const result = await fetchList<RetentionRow, { summary: RetentionSummary }>(
    '/contracts/retention',
    query,
  );

  const currency = result.summary.currencyCode ?? me.tenant.currencyCode;

  return (
    <>
      <PageHeader
        title="Retention"
        subtitle="Money the client is holding, when it falls due, and what has actually come back."
      />

      <Card className="mb-4">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          <Stat
            label="Held"
            value={<Money amount={result.summary.heldValue} currency={currency} />}
            hint="Not yet due for release."
          />
          <Stat
            label="Due now"
            value={<Money amount={result.summary.dueValue} currency={currency} />}
            // The number this register exists to produce. Retention is the
            // largest sum on a joinery job that nobody owns, and it is released
            // by somebody asking — not automatically.
            tone={result.summary.dueValue > 0 ? 'bad' : 'neutral'}
            hint={
              result.summary.dueValue > 0
                ? 'Claimable today. Nobody is going to offer it.'
                : 'Nothing outstanding.'
            }
          />
          <Stat
            label="Released"
            value={<Money amount={result.summary.releasedValue} currency={currency} />}
            tone="good"
          />
        </div>
      </Card>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterChips
          base={BASE}
          query={query}
          param="state"
          options={[
            { label: 'All', value: null },
            { label: 'Held', value: 'held' },
            { label: 'Due now', value: 'due' },
            { label: 'Released', value: 'released' },
          ]}
        />
        <SearchBox base={BASE} query={query} placeholder="Contract number or name…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['release', 'releases']}
            hint="A release is scheduled from the contract's terms — half at practical completion, half at the end of the defects period."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="contractNumber" current={result.sort} direction={result.direction}>
                  Contract
                </SortTh>
                <SortTh base={BASE} query={query} column="trigger" current={result.sort} direction={result.direction}>
                  Trigger
                </SortTh>
                <SortTh base={BASE} query={query} column="amount" current={result.sort} direction={result.direction} numeric>
                  Amount
                </SortTh>
                <SortTh base={BASE} query={query} column="dueOn" current={result.sort} direction={result.direction}>
                  Due
                </SortTh>
                <Th>Status</Th>
              </tr>
            }
          >
            {result.rows.map((row) => (
              <tr key={row.id} className="hover:bg-(--color-canvas)">
                <Td>
                  <Link
                    href={`/contracts/${row.contractId}`}
                    className="numeric block text-(--color-accent) hover:underline"
                  >
                    {row.contractNumber ?? '—'}
                  </Link>
                  <span className="text-xs text-(--color-muted)">{row.contractName}</span>
                </Td>
                <Td>
                  <span className="block">{row.trigger.replace(/_/g, ' ')}</span>
                  {row.note ? (
                    <span className="text-xs text-(--color-muted)">{row.note}</span>
                  ) : null}
                </Td>
                <Td numeric>
                  <Money amount={row.amount} currency={row.currencyCode ?? currency} />
                </Td>
                <Td>
                  <span className={row.isOverdue ? 'text-(--color-bad)' : ''}>
                    {date(row.dueOn)}
                  </span>
                  {row.isOverdue && row.daysToDue != null ? (
                    <span className="block text-xs text-(--color-bad)">
                      {`claimable ${integer(Math.abs(row.daysToDue))} days ago`}
                    </span>
                  ) : null}
                </Td>
                <Td>
                  {row.releasedOn ? (
                    <>
                      <Badge tone="good">released</Badge>
                      <span className="block text-xs text-(--color-muted)">
                        {row.applicationNumber
                          ? `${date(row.releasedOn)} · ${row.applicationNumber}`
                          : date(row.releasedOn)}
                      </span>
                    </>
                  ) : (
                    <Badge tone={row.isOverdue ? 'bad' : 'neutral'}>
                      {row.isOverdue ? 'due' : 'held'}
                    </Badge>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['release', 'releases']} />
      </Card>
    </>
  );
}

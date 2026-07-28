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
import { Badge, Card, PageHeader, Table, Td, Th } from '@/components/ui';
import { date, integer } from '@/lib/format';

interface CorrespondenceRow {
  id: string;
  contractId: string;
  contractNumber: string | null;
  contractName: string;
  type: string;
  reference: string;
  subject: string;
  direction: string;
  issuedOn: string;
  responseDueOn: string | null;
  respondedOn: string | null;
  status: string;
  isContractual: boolean;
  variationId: string | null;
  variationNumber: string | null;
  daysToResponse: number | null;
  isAtRisk: boolean;
}

const BASE = '/contracts/correspondence';

const TYPES = [
  { label: 'All', value: null },
  { label: 'RFI', value: 'rfi' },
  { label: 'Notice', value: 'notice' },
  { label: 'EOT claim', value: 'eot_claim' },
  { label: 'NCR', value: 'ncr' },
  { label: 'Instruction', value: 'instruction' },
];

export default async function CorrespondencePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);

  const result = await fetchList<CorrespondenceRow>('/contracts/correspondence', query);
  const atRisk = result.rows.filter((row) => row.isAtRisk).length;

  return (
    <>
      <PageHeader
        title="Notice register"
        subtitle="Everything issued and everything still waiting on an answer, across every contract."
      />

      {atRisk > 0 ? (
        // Above the table, because it is the only thing on this page with a
        // deadline attached — the same reasoning as the time-bar warning on the
        // contract screen.
        <p className="mb-3 rounded-md border border-(--color-bad)/40 bg-(--color-bad)/5 px-3 py-2 text-sm text-(--color-bad)">
          {`${integer(atRisk)} contractual item${atRisk === 1 ? '' : 's'} on this page ${atRisk === 1 ? 'is' : 'are'} past the response deadline with no reply. Entitlement depends on these.`}
        </p>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          <FilterChips base={BASE} query={query} param="type" options={TYPES} />
          <FilterChips
            base={BASE}
            query={query}
            param="open"
            options={[{ label: 'Awaiting a reply', value: 'true' }]}
          />
          {/* The distinction that matters. An unanswered RFI is an irritation;
              an unanswered notice on which an extension of time depends is a
              claim being lost while nobody watches. */}
          <FilterChips
            base={BASE}
            query={query}
            param="contractual"
            options={[{ label: 'Contractual only', value: 'true' }]}
          />
        </div>
        <SearchBox base={BASE} query={query} placeholder="Reference, subject or contract…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['item', 'items']}
            hint="Notices, RFIs and instructions are recorded against a contract as they are issued."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="reference" current={result.sort} direction={result.direction}>
                  Reference
                </SortTh>
                <SortTh base={BASE} query={query} column="type" current={result.sort} direction={result.direction}>
                  Type
                </SortTh>
                <Th>Subject</Th>
                <SortTh base={BASE} query={query} column="issuedOn" current={result.sort} direction={result.direction}>
                  Issued
                </SortTh>
                <SortTh base={BASE} query={query} column="responseDueOn" current={result.sort} direction={result.direction}>
                  Response due
                </SortTh>
                <SortTh base={BASE} query={query} column="status" current={result.sort} direction={result.direction}>
                  Status
                </SortTh>
              </tr>
            }
          >
            {result.rows.map((row) => {
              const waiting = row.respondedOn == null;
              const days = row.daysToResponse;
              const soon = waiting && days != null && days >= 0 && days <= 7;

              return (
                <tr key={row.id} className="hover:bg-(--color-canvas)">
                  <Td>
                    <span className="numeric block">{row.reference}</span>
                    <Link
                      href={`/contracts/${row.contractId}`}
                      className="numeric text-xs text-(--color-accent) hover:underline"
                    >
                      {row.contractNumber ?? row.contractName}
                    </Link>
                  </Td>
                  <Td>
                    <Badge tone={row.isAtRisk ? 'bad' : 'neutral'}>
                      {row.type.replace(/_/g, ' ')}
                    </Badge>
                    {row.isContractual ? (
                      <span className="block text-xs text-(--color-muted)">contractual</span>
                    ) : null}
                  </Td>
                  <Td>
                    <span className="block">{row.subject}</span>
                    <span className="text-xs text-(--color-muted)">
                      {row.direction}
                      {row.variationNumber ? ` · became ${row.variationNumber}` : ''}
                    </span>
                  </Td>
                  <Td>{date(row.issuedOn)}</Td>
                  <Td>
                    {row.responseDueOn == null ? (
                      <span className="text-(--color-muted)">—</span>
                    ) : (
                      <>
                        <span
                          className={
                            row.isAtRisk
                              ? 'text-(--color-bad)'
                              : soon
                                ? 'text-(--color-warn)'
                                : ''
                          }
                        >
                          {date(row.responseDueOn)}
                        </span>
                        {waiting && days != null ? (
                          <span
                            className={`block text-xs ${row.isAtRisk ? 'text-(--color-bad)' : 'text-(--color-muted)'}`}
                          >
                            {days < 0
                              ? `${integer(Math.abs(days))} days overdue`
                              : `${integer(days)} days left`}
                          </span>
                        ) : null}
                      </>
                    )}
                  </Td>
                  <Td>
                    {row.respondedOn ? (
                      <>
                        <Badge tone="good">answered</Badge>
                        <span className="block text-xs text-(--color-muted)">
                          {date(row.respondedOn)}
                        </span>
                      </>
                    ) : (
                      <Badge tone={row.isAtRisk ? 'bad' : 'neutral'}>{row.status}</Badge>
                    )}
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['item', 'items']} />
      </Card>
    </>
  );
}

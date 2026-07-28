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
import { Badge, Card, Money, PageHeader, Table, Td, Th } from '@/components/ui';
import { date, integer } from '@/lib/format';
import { getMe } from '@/lib/session';

interface SnagRow {
  id: string;
  projectId: string;
  projectCode: string | null;
  projectName: string | null;
  reference: string;
  location: string | null;
  description: string;
  severity: string;
  status: string;
  raisedOn: string;
  targetDate: string | null;
  closedOn: string | null;
  assignedToPartyName: string | null;
  wbsCode: string | null;
  backChargeAmount: string | null;
  photoCount: number;
  daysToTarget: number | null;
  isOverdue: boolean;
  blocksHandover: boolean;
}

const BASE = '/projects/snags';

const SEVERITIES = [
  { label: 'All', value: null },
  { label: 'Critical', value: 'critical' },
  { label: 'Major', value: 'major' },
  { label: 'Minor', value: 'minor' },
];

const SEVERITY_TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  critical: 'bad',
  major: 'neutral',
  minor: 'neutral',
};

export default async function SnagsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();

  const result = await fetchList<SnagRow>('/projects/snags', query);
  const blocking = result.rows.filter((row) => row.blocksHandover).length;

  return (
    <>
      <PageHeader
        title="Snags"
        subtitle="Defects raised across every project, who owns the fix, and what is stopping a handover."
      />

      {blocking > 0 ? (
        <p className="mb-3 rounded-md border border-(--color-bad)/40 bg-(--color-bad)/5 px-3 py-2 text-sm text-(--color-bad)">
          {`${integer(blocking)} critical snag${blocking === 1 ? '' : 's'} on this page ${blocking === 1 ? 'is' : 'are'} still open. Handover cannot complete until ${blocking === 1 ? 'it is' : 'they are'} closed.`}
        </p>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          <FilterChips base={BASE} query={query} param="severity" options={SEVERITIES} />
          <FilterChips
            base={BASE}
            query={query}
            param="open"
            options={[{ label: 'Open only', value: 'true' }]}
          />
          <FilterChips
            base={BASE}
            query={query}
            param="overdue"
            options={[{ label: 'Past target', value: 'true' }]}
          />
        </div>
        <SearchBox base={BASE} query={query} placeholder="Reference, description or location…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['snag', 'snags']}
            hint="Snags are raised against a project, and optionally against the WBS node that owns the work."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="reference" current={result.sort} direction={result.direction}>
                  Reference
                </SortTh>
                <Th>Defect</Th>
                <SortTh base={BASE} query={query} column="severity" current={result.sort} direction={result.direction}>
                  Severity
                </SortTh>
                <SortTh base={BASE} query={query} column="status" current={result.sort} direction={result.direction}>
                  Status
                </SortTh>
                <Th>Owner</Th>
                <SortTh base={BASE} query={query} column="targetDate" current={result.sort} direction={result.direction}>
                  Target
                </SortTh>
              </tr>
            }
          >
            {result.rows.map((row) => (
              <tr key={row.id} className="hover:bg-(--color-canvas)">
                <Td>
                  <span className="numeric block">{row.reference}</span>
                  <Link
                    href={`/projects/${row.projectId}`}
                    className="numeric text-xs text-(--color-accent) hover:underline"
                  >
                    {row.projectCode ?? row.projectName ?? '—'}
                  </Link>
                </Td>
                <Td>
                  <span className="block">{row.description}</span>
                  <span className="text-xs text-(--color-muted)">
                    {[
                      row.location,
                      row.wbsCode,
                      row.photoCount > 0
                        ? `${integer(row.photoCount)} photo${row.photoCount === 1 ? '' : 's'}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </Td>
                <Td>
                  <Badge tone={SEVERITY_TONE[row.severity] ?? 'neutral'}>{row.severity}</Badge>
                  {row.blocksHandover ? (
                    <span className="block text-xs text-(--color-bad)">blocks handover</span>
                  ) : null}
                </Td>
                <Td>
                  <Badge
                    tone={
                      row.status === 'closed'
                        ? 'good'
                        : row.status === 'rejected'
                          ? 'bad'
                          : 'neutral'
                    }
                  >
                    {row.status.replace(/_/g, ' ')}
                  </Badge>
                  {/* `rejected` is shown as a live state, not a closed one. A
                      snag the subcontractor disputes is still a snag, and
                      treating it as done is how it reappears at handover. */}
                  {row.closedOn ? (
                    <span className="block text-xs text-(--color-muted)">
                      {date(row.closedOn)}
                    </span>
                  ) : null}
                </Td>
                <Td>
                  <span className="block">{row.assignedToPartyName ?? '—'}</span>
                  {row.backChargeAmount ? (
                    <span className="text-xs text-(--color-muted)">
                      {/* Recoverable from whoever caused it. Unrecovered back
                          charges are the quietest leak on a joinery job. */}
                      back charge <Money amount={row.backChargeAmount} currency={me.tenant.currencyCode} />
                    </span>
                  ) : null}
                </Td>
                <Td>
                  <span className={row.isOverdue ? 'text-(--color-bad)' : ''}>
                    {date(row.targetDate)}
                  </span>
                  {row.isOverdue && row.daysToTarget != null ? (
                    <span className="block text-xs text-(--color-bad)">
                      {`${integer(Math.abs(row.daysToTarget))} days over`}
                    </span>
                  ) : (
                    <span className="block text-xs text-(--color-muted)">
                      raised {date(row.raisedOn)}
                    </span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['snag', 'snags']} />
      </Card>
    </>
  );
}

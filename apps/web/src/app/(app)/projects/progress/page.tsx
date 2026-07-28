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
import { Badge, Card, Money, PageHeader, ProgressBar, Table, Td, Th } from '@/components/ui';
import { date, percent, quantity } from '@/lib/format';
import { getMe } from '@/lib/session';

interface ProgressRow {
  id: string;
  projectId: string;
  projectCode: string | null;
  projectName: string | null;
  wbsCode: string | null;
  wbsName: string | null;
  periodEnd: string;
  ruleOfCredit: string;
  unitsComplete: string | null;
  unitsPlanned: string | null;
  started: boolean | null;
  finished: boolean | null;
  manualPercent: string | null;
  percentComplete: string;
  earnedValue: string;
  note: string | null;
  hasEvidence: boolean;
  isSelfAssessed: boolean;
}

const BASE = '/projects/progress';

/** What the percentage was actually derived from — the point of the whole system. */
function basis(row: ProgressRow): string {
  switch (row.ruleOfCredit) {
    case 'units':
      return row.unitsPlanned
        ? `${quantity(row.unitsComplete)} of ${quantity(row.unitsPlanned)} counted`
        : 'units counted';
    case 'started_finished':
    case 'binary':
      return row.finished ? 'finished' : row.started ? 'started' : 'not started';
    case 'milestone':
      return 'milestones ticked';
    case 'manual':
      return row.manualPercent ? `${percent(row.manualPercent)} typed` : 'typed';
    default:
      return row.ruleOfCredit.replace(/_/g, ' ');
  }
}

export default async function ProgressPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();

  const result = await fetchList<ProgressRow>('/projects/progress', query);

  return (
    <>
      <PageHeader
        title="Progress"
        subtitle="Every measurement taken, across every project, and what each one was measured from."
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterChips
          base={BASE}
          query={query}
          param="selfAssessed"
          options={[{ label: 'Self-assessed only', value: 'true' }]}
        />
        <SearchBox base={BASE} query={query} placeholder="Project or WBS code…" />
      </div>

      <Card
        footnote="A percentage is only as good as what produced it. Counted units and somebody's opinion are different claims, and this register keeps them distinguishable — which is the entire purpose of rules of credit."
      >
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['measurement', 'measurements']}
            hint="Progress is recorded against a WBS node for a period, under that node's rule of credit."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="periodEnd" current={result.sort} direction={result.direction}>
                  Period
                </SortTh>
                <SortTh base={BASE} query={query} column="projectCode" current={result.sort} direction={result.direction}>
                  Project
                </SortTh>
                <Th>Work</Th>
                <Th>Measured from</Th>
                <SortTh base={BASE} query={query} column="percentComplete" current={result.sort} direction={result.direction}>
                  Complete
                </SortTh>
                <SortTh base={BASE} query={query} column="earnedValue" current={result.sort} direction={result.direction} numeric>
                  Earned
                </SortTh>
              </tr>
            }
          >
            {result.rows.map((row) => (
              <tr key={row.id} className="hover:bg-(--color-canvas)">
                <Td>{date(row.periodEnd)}</Td>
                <Td>
                  <Link
                    href={`/projects/${row.projectId}`}
                    className="numeric block text-(--color-accent) hover:underline"
                  >
                    {row.projectCode ?? '—'}
                  </Link>
                  <span className="text-xs text-(--color-muted)">{row.projectName}</span>
                </Td>
                <Td>
                  <span className="numeric block">{row.wbsCode ?? '—'}</span>
                  <span className="text-xs text-(--color-muted)">{row.wbsName}</span>
                </Td>
                <Td>
                  <Badge tone={row.isSelfAssessed ? 'bad' : 'neutral'}>
                    {row.ruleOfCredit.replace(/_/g, ' ')}
                  </Badge>
                  <span className="block text-xs text-(--color-muted)">
                    {basis(row)}
                    {row.hasEvidence ? ' · evidence attached' : ''}
                  </span>
                </Td>
                <Td>
                  <div className="w-28">
                    {/* Hatched when the number was typed rather than counted. A
                        solid bar for an opinion is the UI telling exactly the
                        lie the rule-of-credit system exists to prevent. */}
                    <ProgressBar
                      value={Number(row.percentComplete)}
                      uncertain={row.isSelfAssessed}
                    />
                  </div>
                  {row.note ? (
                    <span className="block text-xs text-(--color-muted)">{row.note}</span>
                  ) : null}
                </Td>
                <Td numeric>
                  <Money amount={row.earnedValue} currency={me.tenant.currencyCode} />
                </Td>
              </tr>
            ))}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['measurement', 'measurements']} />
      </Card>
    </>
  );
}

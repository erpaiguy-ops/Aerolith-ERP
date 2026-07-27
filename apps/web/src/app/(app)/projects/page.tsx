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

interface ProjectRow {
  id: string;
  code: string;
  name: string;
  status: string;
  currencyCode: string | null;
  contractValue: number | null;
  startDate: string | null;
  endDate: string | null;
  healthStatus: string | null;
  forecastEndDate: string | null;
  scheduleVarianceDays: number | null;
}

const BASE = '/projects';

const STATUSES = [
  { label: 'All', value: null },
  { label: 'Tender', value: 'tender' },
  { label: 'Awarded', value: 'awarded' },
  { label: 'In progress', value: 'in_progress' },
  { label: 'DLP', value: 'dlp' },
  { label: 'Closed', value: 'closed' },
];

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();

  const result = await fetchList<ProjectRow>('/projects', query);

  return (
    <>
      <PageHeader title="Projects" subtitle="Delivery, budgets and job costing." />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterChips base={BASE} query={query} param="status" options={STATUSES} />
        <SearchBox base={BASE} query={query} placeholder="Code or name…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList query={query} noun={['project', 'projects']} hint="Projects appear here once a tender is won." />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="code" current={result.sort} direction={result.direction}>
                  Code
                </SortTh>
                <SortTh base={BASE} query={query} column="name" current={result.sort} direction={result.direction}>
                  Name
                </SortTh>
                <SortTh base={BASE} query={query} column="status" current={result.sort} direction={result.direction}>
                  Status
                </SortTh>
                <SortTh base={BASE} query={query} column="contractValue" current={result.sort} direction={result.direction} numeric>
                  Contract value
                </SortTh>
                <SortTh base={BASE} query={query} column="endDate" current={result.sort} direction={result.direction}>
                  Due
                </SortTh>
                <SortTh base={BASE} query={query} column="createdAt" current={result.sort} direction={result.direction} numeric>
                  Schedule
                </SortTh>
              </tr>
            }
          >
            {result.rows.map((row) => (
              <tr key={row.id} className="hover:bg-(--color-canvas)">
                <Td>
                  <Link href={`/projects/${row.id}`} className="numeric text-(--color-accent) hover:underline">
                    {row.code}
                  </Link>
                </Td>
                <Td>
                  <span className="flex items-center gap-2">
                    {row.name}
                    {/* The PM's own health flag. Shown next to the name because
                        it is the one thing on the row that is an opinion, and it
                        should not be mistaken for a computed figure. */}
                    {row.healthStatus && row.healthStatus !== 'green' ? (
                      <Badge tone={row.healthStatus === 'red' ? 'bad' : 'neutral'}>
                        {row.healthStatus}
                      </Badge>
                    ) : null}
                  </span>
                </Td>
                <Td>
                  <Badge tone={row.status === 'closed' ? 'neutral' : 'good'}>
                    {row.status.replace(/_/g, ' ')}
                  </Badge>
                </Td>
                <Td numeric>
                  <Money
                    amount={row.contractValue}
                    currency={row.currencyCode ?? me.tenant.currencyCode}
                  />
                </Td>
                <Td>{date(row.endDate)}</Td>
                <Td numeric>
                  {/* Days late against the baseline, not a date. A date makes the
                      reader do the subtraction; the number they want is "how
                      late", and its sign carries the whole meaning. */}
                  {row.scheduleVarianceDays == null ? (
                    <span className="text-(--color-muted)">—</span>
                  ) : (
                    <span className={row.scheduleVarianceDays > 0 ? 'text-(--color-bad)' : ''}>
                      {row.scheduleVarianceDays > 0 ? '+' : ''}
                      {row.scheduleVarianceDays}d
                    </span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['project', 'projects']} />
      </Card>
    </>
  );
}

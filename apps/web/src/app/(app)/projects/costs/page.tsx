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
import { date, quantity } from '@/lib/format';
import { getMe } from '@/lib/session';

interface CostRow {
  id: string;
  projectId: string;
  projectCode: string | null;
  projectName: string | null;
  wbsCode: string | null;
  wbsName: string | null;
  postedOn: string;
  category: string;
  description: string | null;
  sourceModule: string | null;
  amount: string;
  currencyCode: string | null;
  quantity: string | null;
  uomCode: string | null;
  isAccrual: boolean;
  reversesEntryId: string | null;
  isReversed: boolean;
}

interface CategoryTotal {
  category: string;
  actual: number;
  accrued: number;
}

const BASE = '/projects/costs';

const CATEGORIES = [
  { label: 'All', value: null },
  { label: 'Material', value: 'material' },
  { label: 'Labour', value: 'labour' },
  { label: 'Subcontract', value: 'subcontract' },
  { label: 'Plant', value: 'plant' },
  { label: 'Overhead', value: 'overhead' },
];

export default async function CostsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();

  const result = await fetchList<CostRow, { summary: CategoryTotal[] }>('/projects/costs', query);

  const actual = result.summary.reduce((total, row) => total + row.actual, 0);
  const accrued = result.summary.reduce((total, row) => total + row.accrued, 0);

  return (
    <>
      <PageHeader
        title="Job costing"
        subtitle="Every cost posted to a job, across every project, as it lands rather than when it is invoiced."
      />

      <Card className="mb-4">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          <Stat
            label="Actual"
            value={<Money amount={actual} currency={me.tenant.currencyCode} />}
            hint="Settled cost on the ledger."
          />
          <Stat
            label="Accrued"
            value={<Money amount={accrued} currency={me.tenant.currencyCode} />}
            // Kept apart from actual deliberately. An accrual is a cost the job
            // has incurred and not been invoiced for; merging the two makes a
            // job look cheaper or dearer than it is depending which way you read
            // it, and the whole point of accruing at delivery is that the cost
            // report is true DURING the job.
            hint="Incurred, not yet invoiced."
          />
          <Stat
            label="Committed to date"
            value={<Money amount={actual + accrued} currency={me.tenant.currencyCode} />}
            hint="Both together — the figure a cost report should be read against."
          />
        </div>
      </Card>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          <FilterChips base={BASE} query={query} param="category" options={CATEGORIES} />
          <FilterChips
            base={BASE}
            query={query}
            param="kind"
            options={[
              { label: 'All', value: null },
              { label: 'Actual', value: 'actual' },
              { label: 'Accrual', value: 'accrual' },
            ]}
          />
          <FilterChips
            base={BASE}
            query={query}
            param="hideReversed"
            options={[{ label: 'Hide reversed', value: 'true' }]}
          />
        </div>
        <SearchBox base={BASE} query={query} placeholder="Description or project…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['cost entry', 'cost entries']}
            hint="Costs post from goods receipt, from production scans, or directly."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="postedOn" current={result.sort} direction={result.direction}>
                  Posted
                </SortTh>
                <SortTh base={BASE} query={query} column="projectCode" current={result.sort} direction={result.direction}>
                  Project
                </SortTh>
                <Th>What</Th>
                <SortTh base={BASE} query={query} column="category" current={result.sort} direction={result.direction}>
                  Category
                </SortTh>
                <SortTh base={BASE} query={query} column="amount" current={result.sort} direction={result.direction} numeric>
                  Amount
                </SortTh>
              </tr>
            }
          >
            {result.rows.map((row) => (
              <tr key={row.id} className="hover:bg-(--color-canvas)">
                <Td>{date(row.postedOn)}</Td>
                <Td>
                  <Link
                    href={`/projects/${row.projectId}`}
                    className="numeric block text-(--color-accent) hover:underline"
                  >
                    {row.projectCode ?? '—'}
                  </Link>
                  {row.wbsCode ? (
                    <span className="numeric text-xs text-(--color-muted)">{row.wbsCode}</span>
                  ) : null}
                </Td>
                <Td>
                  <span className="block">{row.description ?? '—'}</span>
                  <span className="text-xs text-(--color-muted)">
                    {[
                      row.sourceModule,
                      row.quantity ? quantity(row.quantity, row.uomCode) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </Td>
                <Td>
                  <Badge tone="neutral">{row.category}</Badge>
                  {row.isAccrual ? (
                    <span className="block text-xs text-(--color-muted)">accrual</span>
                  ) : null}
                </Td>
                <Td numeric>
                  {/* A reversed entry stays on the ledger, struck through rather
                      than hidden — a cost is corrected by a compensating entry,
                      exactly as a ledger is, and deleting it would break the
                      audit trail the whole module rests on. */}
                  <span className={row.isReversed ? 'text-(--color-muted) line-through' : ''}>
                    <Money amount={row.amount} currency={row.currencyCode ?? me.tenant.currencyCode} />
                  </span>
                  {row.isReversed ? (
                    <span className="block text-xs text-(--color-muted)">reversed</span>
                  ) : row.reversesEntryId ? (
                    <span className="block text-xs text-(--color-muted)">reversal</span>
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['cost entry', 'cost entries']} />
      </Card>
    </>
  );
}

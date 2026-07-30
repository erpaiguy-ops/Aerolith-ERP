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
import { date, integer, percent } from '@/lib/format';
import { getMe } from '@/lib/session';

interface RateRow {
  id: string;
  code: string;
  description: string;
  uomCode: string | null;
  category: string | null;
  unitRate: string;
  directCost: string;
  isActive: boolean;
  lastActualCost: string | null;
  actualSampleSize: number;
  lastActualAt: string | null;
  actualVariancePercent: number | null;
}

interface RateLibrary {
  id: string;
  code: string;
  name: string;
  version: number;
  currencyCode: string | null;
  effectiveFrom: string | null;
}

const BASE = '/estimating/rates';

export default async function RatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();

  const result = await fetchList<RateRow, { library: RateLibrary | null }>(
    '/estimating/rates',
    query,
  );

  const currency = result.library?.currencyCode ?? me.tenant.currencyCode;

  return (
    <>
      <PageHeader
        title="Rate library"
        subtitle={
          result.library
            ? `${result.library.name} — version ${result.library.version}, effective ${result.library.effectiveFrom ?? 'immediately'}.`
            : 'The basis of every future tender.'
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterChips
          base={BASE}
          query={query}
          param="inactive"
          options={[{ label: 'Include retired', value: 'true' }]}
        />
        <SearchBox base={BASE} query={query} placeholder="Code or description…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['rate', 'rates']}
            hint="A rate is a build-up — board, tape, labour, spray — not a typed number."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="code" current={result.sort} direction={result.direction}>
                  Code
                </SortTh>
                <SortTh base={BASE} query={query} column="description" current={result.sort} direction={result.direction}>
                  Description
                </SortTh>
                <SortTh base={BASE} query={query} column="category" current={result.sort} direction={result.direction}>
                  Category
                </SortTh>
                <SortTh base={BASE} query={query} column="unitRate" current={result.sort} direction={result.direction} numeric>
                  Rate
                </SortTh>
                <Th numeric>Assumed cost</Th>
                <SortTh base={BASE} query={query} column="lastActualAt" current={result.sort} direction={result.direction} numeric>
                  Against actuals
                </SortTh>
              </tr>
            }
          >
            {result.rows.map((row) => {
              const variance = row.actualVariancePercent;
              // Cost against cost. Negative is the one that matters: the work
              // costs more than the build-up assumes, so every line priced from
              // this rate has been losing the difference.
              const tone = variance == null ? 'neutral' : variance < 0 ? 'bad' : 'good';

              return (
                <tr key={row.id} className="hover:bg-(--color-canvas)">
                  <Td>
                    <Link
                      href={`/estimating/rates/${row.id}`}
                      className="numeric text-(--color-accent) hover:underline"
                    >
                      {row.code}
                    </Link>
                  </Td>
                  <Td>
                    <span className="block">{row.description}</span>
                    {row.uomCode ? (
                      <span className="numeric text-xs text-(--color-muted)">
                        per {row.uomCode}
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    {row.category ? (
                      <Badge tone={row.isActive ? 'neutral' : 'bad'}>
                        {row.isActive ? row.category : `${row.category} · retired`}
                      </Badge>
                    ) : (
                      <span className="text-(--color-muted)">—</span>
                    )}
                  </Td>
                  <Td numeric>
                    <Money amount={row.unitRate} currency={currency} />
                  </Td>
                  <Td numeric>
                    <Money amount={row.directCost} currency={currency} />
                  </Td>
                  <Td numeric>
                    {/* The feedback loop, made visible. Jobs finishing feed
                        actuals back, and this column is what turns that into a
                        decision — it SUGGESTS, and an estimator overriding it is
                        exercising judgement. Nothing here changes a rate. */}
                    {variance == null ? (
                      <span className="text-(--color-muted)">no actuals yet</span>
                    ) : (
                      <>
                        <span
                          className={
                            tone === 'bad' ? 'text-(--color-bad)' : 'text-(--color-good)'
                          }
                        >
                          {variance > 0 ? `+${percent(variance)}` : percent(variance)}
                        </span>
                        <span className="block text-xs text-(--color-muted)">
                          {`${integer(row.actualSampleSize)} job${row.actualSampleSize === 1 ? '' : 's'}, ${date(row.lastActualAt)}`}
                        </span>
                      </>
                    )}
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['rate', 'rates']} />
      </Card>
    </>
  );
}

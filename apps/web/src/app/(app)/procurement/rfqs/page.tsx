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

interface RfqRow {
  id: string;
  number: string | null;
  title: string;
  status: string;
  projectCode: string | null;
  currencyCode: string | null;
  issuedOn: string | null;
  responseDueOn: string | null;
  awardedOn: string | null;
  awardRationale: string | null;
  lineCount: number;
  suppliers: number;
  quoted: number;
  declined: number;
  daysToClose: number | null;
  isUncompetitive: boolean;
}

const BASE = '/procurement/rfqs';

const STATUSES = [
  { label: 'All', value: null },
  { label: 'Draft', value: 'draft' },
  { label: 'Issued', value: 'issued' },
  { label: 'Closed', value: 'closed' },
  { label: 'Awarded', value: 'awarded' },
];

export default async function RfqsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);

  const result = await fetchList<RfqRow>('/procurement/rfqs', query);

  return (
    <>
      <PageHeader
        title="RFQs & quotes"
        subtitle="What is out to the market, who has come back, and what is still undecided."
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          <FilterChips base={BASE} query={query} param="status" options={STATUSES} />
          <FilterChips
            base={BASE}
            query={query}
            param="open"
            options={[{ label: 'Not yet awarded', value: 'true' }]}
          />
        </div>
        <SearchBox base={BASE} query={query} placeholder="Number or title…" />
      </div>

      <Card
        footnote="Comparison is on landed cost, not unit price — duty, freight and a minimum order quantity routinely reverse which quote is actually cheapest."
      >
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['enquiry', 'enquiries']}
            hint="An RFQ goes out from an approved requisition, or directly."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="number" current={result.sort} direction={result.direction}>
                  Number
                </SortTh>
                <SortTh base={BASE} query={query} column="title" current={result.sort} direction={result.direction}>
                  Enquiry
                </SortTh>
                <SortTh base={BASE} query={query} column="status" current={result.sort} direction={result.direction}>
                  Status
                </SortTh>
                <Th numeric>Responses</Th>
                <SortTh base={BASE} query={query} column="responseDueOn" current={result.sort} direction={result.direction}>
                  Closes
                </SortTh>
                <Th>Award</Th>
              </tr>
            }
          >
            {result.rows.map((row) => {
              const days = row.daysToClose;
              const open = row.status === 'issued';
              const soon = open && days != null && days >= 0 && days <= 3;

              return (
                <tr key={row.id} className="hover:bg-(--color-canvas)">
                  <Td>
                    <span className="numeric">{row.number ?? '—'}</span>
                  </Td>
                  <Td>
                    <span className="block">{row.title}</span>
                    <span className="text-xs text-(--color-muted)">
                      {[
                        row.projectCode,
                        `${integer(row.lineCount)} line${row.lineCount === 1 ? '' : 's'}`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </Td>
                  <Td>
                    <Badge
                      tone={
                        row.status === 'awarded'
                          ? 'good'
                          : row.status === 'cancelled'
                            ? 'bad'
                            : 'neutral'
                      }
                    >
                      {row.status}
                    </Badge>
                  </Td>
                  <Td numeric>
                    {/* Priced against suppliers on the enquiry, not a single
                        count — "3 quotes" says nothing about how many were
                        asked and declined. */}
                    <span className={row.isUncompetitive ? 'text-(--color-bad)' : ''}>
                      {`${integer(row.quoted)} of ${integer(row.suppliers)}`}
                    </span>
                    <span className="block text-xs text-(--color-muted)">
                      {row.declined > 0 ? `${integer(row.declined)} declined` : 'priced'}
                    </span>
                  </Td>
                  <Td>
                    <span
                      className={
                        row.isUncompetitive
                          ? 'text-(--color-bad)'
                          : soon
                            ? 'text-(--color-warn)'
                            : ''
                      }
                    >
                      {date(row.responseDueOn)}
                    </span>
                    {row.isUncompetitive ? (
                      // Two prices is where a comparison starts meaning
                      // something. One quote is not a market test, and an
                      // enquiry that closed last week with one price is how a
                      // job ends up paying whatever it was told.
                      <span className="block text-xs text-(--color-bad)">
                        closed with fewer than two prices
                      </span>
                    ) : open && days != null && days >= 0 ? (
                      <span className="block text-xs text-(--color-muted)">
                        {`${integer(days)} days left`}
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    {row.awardedOn ? (
                      <>
                        <span className="block">{date(row.awardedOn)}</span>
                        {row.awardRationale ? (
                          // Recorded because awarding anything other than the
                          // cheapest quote is a decision somebody will be asked
                          // to justify, possibly years later.
                          <span className="text-xs text-(--color-muted)">
                            {row.awardRationale}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-(--color-muted)">—</span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['enquiry', 'enquiries']} />
      </Card>
    </>
  );
}

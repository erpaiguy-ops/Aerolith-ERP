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

interface FinishingRow {
  id: string;
  number: string | null;
  workCentreCode: string;
  workCentreName: string;
  status: string;
  colourCode: string | null;
  sheenCode: string | null;
  coatNumber: number;
  totalCoats: number;
  cureMinutes: number;
  sprayedAt: string | null;
  cureCompletesAt: string | null;
  completedAt: string | null;
  isOnHold: boolean;
  holdReason: string | null;
  partCount: number;
  pieceCount: number;
  reworkCount: number;
  cureMinutesRemaining: number | null;
}

const BASE = '/production/finishing';

const STATUSES = [
  { label: 'All', value: null },
  { label: 'Queued', value: 'queued' },
  { label: 'Spraying', value: 'spraying' },
  { label: 'Curing', value: 'curing' },
  { label: 'Completed', value: 'completed' },
  { label: 'Rejected', value: 'rejected' },
];

/**
 * "3h 20m" rather than "200 minutes", which nobody converts in their head.
 *
 * Degrades to days past 48 hours. A load that has sat since May renders as
 * "1,948h 51m" otherwise — technically true, and unreadable.
 */
function duration(minutes: number): string {
  const abs = Math.abs(Math.round(minutes));
  if (abs >= 48 * 60) return `${integer(Math.round(abs / 60 / 24))}d`;
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  if (hours === 0) return `${integer(rest)}m`;
  return rest === 0 ? `${integer(hours)}h` : `${integer(hours)}h ${integer(rest)}m`;
}

export default async function FinishingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);

  const result = await fetchList<FinishingRow>('/production/finishing', query);

  return (
    <>
      <PageHeader
        title="Finishing"
        subtitle="Spray loads and the cure clock — the constraint generic MRP schedules as if it were not there."
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          <FilterChips base={BASE} query={query} param="status" options={STATUSES} />
          <FilterChips
            base={BASE}
            query={query}
            param="open"
            options={[{ label: 'In the booth', value: 'true' }]}
          />
        </div>
        <SearchBox base={BASE} query={query} placeholder="Batch number, colour or booth…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['spray load', 'spray loads']}
            hint="Everything in one load shares a finish — that is what makes it a batch."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="number" current={result.sort} direction={result.direction}>
                  Batch
                </SortTh>
                <Th>Booth</Th>
                <Th>Finish</Th>
                <SortTh base={BASE} query={query} column="status" current={result.sort} direction={result.direction}>
                  Status
                </SortTh>
                <Th numeric>Load</Th>
                <SortTh base={BASE} query={query} column="cureCompletesAt" current={result.sort} direction={result.direction}>
                  Out of the booth
                </SortTh>
              </tr>
            }
          >
            {result.rows.map((row) => {
              const remaining = row.cureMinutesRemaining;
              // Negative means the cure finished and nobody moved the load —
              // which is a booth standing idle, the most expensive thing here.
              const overdue = row.status === 'curing' && remaining != null && remaining < 0;

              return (
                <tr key={row.id} className="hover:bg-(--color-canvas)">
                  <Td>
                    <span className="numeric">{row.number ?? '—'}</span>
                  </Td>
                  <Td>
                    <span className="block">{row.workCentreName}</span>
                    <span className="numeric text-xs text-(--color-muted)">
                      {row.workCentreCode}
                    </span>
                  </Td>
                  <Td>
                    <span className="block">
                      {[row.colourCode, row.sheenCode].filter(Boolean).join(' · ') || '—'}
                    </span>
                    <span className="numeric text-xs text-(--color-muted)">
                      {`coat ${row.coatNumber} of ${row.totalCoats}`}
                    </span>
                  </Td>
                  <Td>
                    <Badge
                      tone={
                        row.status === 'completed'
                          ? 'good'
                          : row.status === 'rejected' || row.isOnHold
                            ? 'bad'
                            : 'neutral'
                      }
                    >
                      {row.status}
                    </Badge>
                    {row.isOnHold ? (
                      <span className="block text-xs text-(--color-bad)">
                        {/* Humidity or temperature outside spec. A held load is
                            not a queued one — spraying it produces rework. */}
                        {row.holdReason ?? 'on hold'}
                      </span>
                    ) : null}
                  </Td>
                  <Td numeric>
                    <span className="numeric">{integer(row.pieceCount)}</span>
                    <span className="block text-xs text-(--color-muted)">
                      {`${integer(row.partCount)} part${row.partCount === 1 ? '' : 's'}`}
                      {row.reworkCount > 0 ? ` · ${integer(row.reworkCount)} rework` : ''}
                    </span>
                  </Td>
                  <Td>
                    {row.completedAt ? (
                      <span className="text-(--color-muted)">
                        done {date(row.completedAt)}
                      </span>
                    ) : row.cureCompletesAt ? (
                      <>
                        <span className={overdue ? 'text-(--color-bad)' : ''}>
                          {date(row.cureCompletesAt)}
                        </span>
                        <span
                          className={`block text-xs ${overdue ? 'text-(--color-bad)' : 'text-(--color-muted)'}`}
                        >
                          {remaining == null
                            ? ''
                            : overdue
                              ? `ready ${duration(remaining)} ago`
                              : `${duration(remaining)} to go`}
                        </span>
                      </>
                    ) : (
                      <span className="text-(--color-muted)">
                        {/* Not sprayed yet, so there is no clock. Cure time is
                            still known and worth showing — it is what the load
                            will cost in booth hours. */}
                        {row.cureMinutes > 0 ? `${duration(row.cureMinutes)} cure` : 'not sprayed'}
                      </span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['spray load', 'spray loads']} />
      </Card>
    </>
  );
}

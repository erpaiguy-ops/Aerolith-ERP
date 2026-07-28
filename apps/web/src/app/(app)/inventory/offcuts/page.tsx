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
import { dimensions, quantity } from '@/lib/format';
import { getMe } from '@/lib/session';

interface OffcutRow {
  id: string;
  barcode: string;
  itemCode: string;
  itemName: string;
  batchCode: string | null;
  lengthMm: string;
  widthMm: string;
  thicknessMm: string | null;
  areaSqm: string | null;
  grainDirection: string | null;
  grainCode: string | null;
  colourCode: string | null;
  finishedEdges: number;
  warehouseCode: string;
  binCode: string | null;
  status: string;
  unitCost: string | null;
  consumedAt: string | null;
  scrappedReason: string | null;
}

interface OffcutSummary {
  status: string;
  pieces: number;
  areaSqm: number;
  value: number;
}

const BASE = '/inventory/offcuts';

const STATUSES = [
  { label: 'All', value: null },
  { label: 'Available', value: 'available' },
  { label: 'Reserved', value: 'reserved' },
  { label: 'Consumed', value: 'consumed' },
  { label: 'Scrapped', value: 'scrapped' },
];

const STATUS_TONE = {
  available: 'good',
  reserved: 'neutral',
  consumed: 'neutral',
  scrapped: 'bad',
} as const;

export default async function OffcutsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();

  const result = await fetchList<OffcutRow, { summary: OffcutSummary[] }>(
    '/inventory/offcuts',
    query,
  );

  const summary = new Map(result.summary.map((group) => [group.status, group]));

  const available = summary.get('available');
  const scrapped = summary.get('scrapped');

  return (
    <>
      <PageHeader
        title="Offcut register"
        subtitle="Remnants are material, not waste. This is what is on the rack and what it cost."
      />

      {/* The summary spans the whole register, not the page, because "what is on
          the rack worth" must not change as somebody pages through it. */}
      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          <Stat
            label="Available pieces"
            value={available ? quantity(available.pieces) : '0'}
            tone="good"
          />
          <Stat
            label="Available area"
            value={available ? `${quantity(available.areaSqm)} m²` : '—'}
            hint="Usable material back on the rack."
          />
          <Stat
            label="Available value"
            value={<Money amount={available?.value ?? 0} currency={me.tenant.currencyCode} />}
            tone="good"
          />
          {/* Kept beside the good number on purpose: scrapped value is the
              running cost of the minimum-usable-size rule, and a tenant tuning
              that rule is entitled to see what it threw away. */}
          <Stat
            label="Scrapped value"
            value={<Money amount={scrapped?.value ?? 0} currency={me.tenant.currencyCode} />}
            tone={scrapped && scrapped.value > 0 ? 'bad' : 'neutral'}
            hint={scrapped ? `${quantity(scrapped.pieces)} pieces below usable size` : 'None yet.'}
          />
        </div>
      </Card>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterChips base={BASE} query={query} param="status" options={STATUSES} />
        <SearchBox base={BASE} query={query} placeholder="Barcode or item…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['offcut', 'offcuts']}
            hint="Offcuts are registered when a cutting issue declares its remnants."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="barcode" current={result.sort} direction={result.direction}>
                  Barcode
                </SortTh>
                <SortTh base={BASE} query={query} column="itemCode" current={result.sort} direction={result.direction}>
                  Material
                </SortTh>
                <Th>Size (mm)</Th>
                <SortTh base={BASE} query={query} column="areaSqm" current={result.sort} direction={result.direction} numeric>
                  Area
                </SortTh>
                <Th>Grain</Th>
                <Th>Location</Th>
                <SortTh base={BASE} query={query} column="status" current={result.sort} direction={result.direction}>
                  Status
                </SortTh>
                <Th numeric>Cost</Th>
              </tr>
            }
          >
            {result.rows.map((row) => (
              <tr key={row.id} className="hover:bg-(--color-canvas)">
                <Td>
                  <span className="numeric">{row.barcode}</span>
                </Td>
                <Td>
                  <span className="numeric block">{row.itemCode}</span>
                  <span className="text-xs text-(--color-muted)">
                    {[row.itemName, row.batchCode].filter(Boolean).join(' · ')}
                  </span>
                </Td>
                <Td>
                  <span className="numeric">
                    {dimensions(row.lengthMm, row.widthMm, row.thicknessMm)}
                  </span>
                  {row.finishedEdges > 0 ? (
                    <span className="block text-xs text-(--color-muted)">
                      {`${row.finishedEdges} edge${row.finishedEdges === 1 ? '' : 's'} banded`}
                    </span>
                  ) : null}
                </Td>
                <Td numeric>{row.areaSqm ? `${quantity(row.areaSqm)} m²` : '—'}</Td>
                <Td>
                  {/* Grain direction is what decides whether a part can be taken
                      from this piece at all, so it is a column rather than a
                      detail — a remnant that cannot be rotated is not a
                      substitute for one that can. */}
                  {row.grainDirection ? (
                    <>
                      <span className="block">along {row.grainDirection}</span>
                      <span className="text-xs text-(--color-muted)">
                        {[row.grainCode, row.colourCode].filter(Boolean).join(' · ')}
                      </span>
                    </>
                  ) : (
                    <span className="text-(--color-muted)">—</span>
                  )}
                </Td>
                <Td>
                  <span className="numeric">
                    {[row.warehouseCode, row.binCode].filter(Boolean).join(' · ')}
                  </span>
                </Td>
                <Td>
                  <Badge tone={STATUS_TONE[row.status as keyof typeof STATUS_TONE] ?? 'neutral'}>
                    {row.status}
                  </Badge>
                  {row.scrappedReason ? (
                    <span className="block text-xs text-(--color-muted)">{row.scrappedReason}</span>
                  ) : null}
                </Td>
                <Td numeric>
                  <Money amount={row.unitCost} currency={me.tenant.currencyCode} />
                </Td>
              </tr>
            ))}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['offcut', 'offcuts']} />
      </Card>
    </>
  );
}

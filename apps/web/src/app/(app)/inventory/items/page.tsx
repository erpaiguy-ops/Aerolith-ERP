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
import { dimensions, quantity } from '@/lib/format';
import { getMe } from '@/lib/session';

interface ItemRow {
  id: string;
  code: string;
  name: string;
  type: string;
  categoryName: string | null;
  uomCode: string | null;
  lengthMm: string | null;
  widthMm: string | null;
  thicknessMm: string | null;
  hasGrainDirection: boolean;
  isStocked: boolean;
  isBatchTracked: boolean;
  isActive: boolean;
  standardCost: string | null;
  onHand: string | null;
}

const BASE = '/inventory/items';

const TYPES = [
  { label: 'All', value: null },
  { label: 'Panel', value: 'panel' },
  { label: 'Hardware', value: 'hardware' },
  { label: 'Raw material', value: 'raw_material' },
  { label: 'Consumable', value: 'consumable' },
];

export default async function ItemsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();

  const result = await fetchList<ItemRow>('/inventory/items', query);

  return (
    <>
      <PageHeader
        title="Items"
        subtitle="The catalogue everything else refers to — bought, estimated, cut and stocked."
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          <FilterChips base={BASE} query={query} param="type" options={TYPES} />
          {/* Discontinued items are hidden by default and findable on purpose:
              they cannot be deleted — the stock ledger still refers to them —
              but they should not clutter the list somebody picks from. */}
          <FilterChips
            base={BASE}
            query={query}
            param="inactive"
            options={[{ label: 'Include discontinued', value: 'true' }]}
          />
        </div>
        <SearchBox base={BASE} query={query} placeholder="Code, name or barcode…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['item', 'items']}
            hint="Items are shared across the whole system, not owned by one module."
          />
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
                <SortTh base={BASE} query={query} column="type" current={result.sort} direction={result.direction}>
                  Type
                </SortTh>
                <Th>Size (mm)</Th>
                <SortTh base={BASE} query={query} column="standardCost" current={result.sort} direction={result.direction} numeric>
                  Standard cost
                </SortTh>
                <SortTh base={BASE} query={query} column="onHand" current={result.sort} direction={result.direction} numeric>
                  On hand
                </SortTh>
              </tr>
            }
          >
            {result.rows.map((row) => (
              <tr key={row.id} className="hover:bg-(--color-canvas)">
                <Td>
                  <span className="numeric">{row.code}</span>
                </Td>
                <Td>
                  <span className="block">{row.name}</span>
                  <span className="text-xs text-(--color-muted)">
                    {[
                      row.categoryName,
                      row.hasGrainDirection ? 'grain direction' : null,
                      row.isBatchTracked ? 'batch tracked' : null,
                      row.isActive ? null : 'discontinued',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </Td>
                <Td>
                  <Badge tone={row.isActive ? 'neutral' : 'bad'}>
                    {row.type.replace(/_/g, ' ')}
                  </Badge>
                </Td>
                <Td>
                  <span className="numeric">
                    {dimensions(row.lengthMm, row.widthMm, row.thicknessMm)}
                  </span>
                </Td>
                <Td numeric>
                  <Money amount={row.standardCost} currency={me.tenant.currencyCode} />
                </Td>
                <Td numeric>
                  {/* Null means the item has never been stocked anywhere, which
                      is a different fact from a balance of zero. */}
                  {row.onHand == null ? (
                    <span className="text-(--color-muted)">—</span>
                  ) : (
                    <span className="numeric">{quantity(row.onHand, row.uomCode)}</span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['item', 'items']} />
      </Card>
    </>
  );
}

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
import { can } from '@/lib/actions';
import { date, quantity } from '@/lib/format';
import { getMe } from '@/lib/session';

interface StockRow {
  id: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  uomCode: string | null;
  warehouseCode: string;
  warehouseName: string;
  binCode: string | null;
  batchCode: string | null;
  quantity: string;
  reservedQuantity: string;
  availableQuantity: string | null;
  averageCost: string;
  value: string;
  lastMovementAt: string | null;
  minimumQuantity: string | null;
  belowReorder: boolean;
}

const BASE = '/inventory/stock';

const HOLDING = [
  { label: 'All', value: null },
  { label: 'In stock', value: 'in_stock' },
  { label: 'Zero', value: 'zero' },
];

export default async function StockPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();
  const mayPost = can(me.permissions, 'inventory.stock_movement.create') || me.user.isOwner;

  const result = await fetchList<StockRow>('/inventory/stock', query);

  return (
    <>
      <PageHeader
        title="Stock on hand"
        subtitle="What is where, what it is worth, and what is short. Quantities are the ledger's answer, not an editable field — they change by posting a movement."
        actions={
          // The figures on this screen are derived from posted movements, so
          // there is deliberately nothing to edit here. That is only defensible
          // if the way to change them is visible: without this the screen reads
          // as read-only with no way forward, and the movement form — which has
          // existed all along — was reachable only by knowing it was there.
          mayPost ? (
            <Link
              href="/inventory/movements"
              className="rounded bg-(--color-accent) px-3 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              Record a movement
            </Link>
          ) : null
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {/* A zero row and a missing row are different facts — one says this
              item has been stocked here and currently is not — so zero rows show
              by default and excluding them is a deliberate choice. */}
          <FilterChips base={BASE} query={query} param="holding" options={HOLDING} />
          <FilterChips
            base={BASE}
            query={query}
            param="belowReorder"
            options={[{ label: 'Below reorder', value: 'true' }]}
          />
        </div>
        <SearchBox base={BASE} query={query} placeholder="Item code, name or batch…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['stock line', 'stock lines']}
            hint="Stock appears here once a movement is posted against a warehouse. Adding an item to the catalogue does not create stock on its own — receive some against a warehouse and it will show up here."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="itemCode" current={result.sort} direction={result.direction}>
                  Item
                </SortTh>
                <SortTh base={BASE} query={query} column="warehouseCode" current={result.sort} direction={result.direction}>
                  Location
                </SortTh>
                <Th>Batch</Th>
                <SortTh base={BASE} query={query} column="quantity" current={result.sort} direction={result.direction} numeric>
                  On hand
                </SortTh>
                <SortTh base={BASE} query={query} column="availableQuantity" current={result.sort} direction={result.direction} numeric>
                  Available
                </SortTh>
                <SortTh base={BASE} query={query} column="value" current={result.sort} direction={result.direction} numeric>
                  Value
                </SortTh>
                <SortTh base={BASE} query={query} column="lastMovementAt" current={result.sort} direction={result.direction}>
                  Last moved
                </SortTh>
              </tr>
            }
          >
            {result.rows.map((row) => (
              <tr key={row.id} className="hover:bg-(--color-canvas)">
                <Td>
                  <span className="numeric block">{row.itemCode}</span>
                  <span className="text-xs text-(--color-muted)">{row.itemName}</span>
                </Td>
                <Td>
                  <span className="block">{row.warehouseName}</span>
                  <span className="numeric text-xs text-(--color-muted)">
                    {[row.warehouseCode, row.binCode].filter(Boolean).join(' · ')}
                  </span>
                </Td>
                <Td>
                  {row.batchCode ? (
                    <span className="numeric">{row.batchCode}</span>
                  ) : (
                    <span className="text-(--color-muted)">—</span>
                  )}
                </Td>
                <Td numeric>
                  <span className={row.belowReorder ? 'text-(--color-bad)' : ''}>
                    {quantity(row.quantity, row.uomCode)}
                  </span>
                  {row.belowReorder ? (
                    <span className="mt-0.5 block">
                      <Badge tone="bad">
                        {`below ${quantity(row.minimumQuantity)}`}
                      </Badge>
                    </span>
                  ) : null}
                </Td>
                <Td numeric>
                  {/* Available is quantity less what is reserved, generated in
                      the database so it cannot drift from the two figures it is
                      derived from. Shown separately because issuing against
                      reserved stock is how a job gets short. */}
                  <span className={Number(row.reservedQuantity) > 0 ? 'font-medium' : ''}>
                    {quantity(row.availableQuantity, row.uomCode)}
                  </span>
                  {Number(row.reservedQuantity) > 0 ? (
                    <span className="block text-xs text-(--color-muted)">
                      {`${quantity(row.reservedQuantity)} reserved`}
                    </span>
                  ) : null}
                </Td>
                <Td numeric>
                  <Money amount={row.value} currency={me.tenant.currencyCode} />
                  <span className="block text-xs text-(--color-muted)">
                    <Money amount={row.averageCost} currency={me.tenant.currencyCode} /> avg
                  </span>
                </Td>
                <Td>{date(row.lastMovementAt)}</Td>
              </tr>
            ))}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['stock line', 'stock lines']} />
      </Card>
    </>
  );
}

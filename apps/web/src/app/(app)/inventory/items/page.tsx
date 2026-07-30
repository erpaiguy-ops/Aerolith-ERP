import Link from 'next/link';

import { ActionForm, SubmitButton } from '@/components/Action';
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
import { dimensions, quantity } from '@/lib/format';
import { getMe } from '@/lib/session';

import { createItemAction } from './actions';

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

const ADD_TYPES = [
  { label: 'Panel', value: 'panel' },
  { label: 'Hardware', value: 'hardware' },
  { label: 'Raw material', value: 'raw_material' },
  { label: 'Consumable', value: 'consumable' },
  { label: 'Finished good', value: 'finished_good' },
  { label: 'Sub-assembly', value: 'sub_assembly' },
  { label: 'Service', value: 'service' },
  { label: 'Asset', value: 'asset' },
];

const field =
  'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1 text-sm outline-none focus:border-(--color-accent)';

export default async function ItemsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();
  const mayManage = can(me.permissions, 'inventory.item.write') || me.user.isOwner;

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
                  <Link
                    href={`/inventory/items/${row.id}`}
                    className="numeric text-(--color-accent) hover:underline"
                  >
                    {row.code}
                  </Link>
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

      {mayManage ? (
        <Card title="Add an item">
          <ActionForm action={createItemAction} className="grid gap-3 sm:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Code</span>
              <input name="code" placeholder="MEL-16-WHT" className={field} />
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-xs text-(--color-muted)">Name</span>
              <input name="name" dir="auto" placeholder="16mm White Melamine" className={field} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Type</span>
              <select name="type" defaultValue="panel" className={field}>
                {ADD_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Length (mm)</span>
              <input type="number" step="any" name="lengthMm" className={`${field} numeric`} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Width (mm)</span>
              <input type="number" step="any" name="widthMm" className={`${field} numeric`} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Thickness (mm)</span>
              <input type="number" step="any" name="thicknessMm" className={`${field} numeric`} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Colour code</span>
              <input name="colourCode" className={field} />
            </label>
            <div>
              <SubmitButton pendingLabel="Adding…">Add item</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      ) : null}
    </>
  );
}

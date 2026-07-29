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
import { apiFetch } from '@/lib/api';
import { date, integer, quantity } from '@/lib/format';
import { getMe } from '@/lib/session';

import { recordMovementAction } from './actions';
import { MOVEMENT_TYPES } from './types';

interface MovementRow {
  id: string;
  number: string | null;
  type: string;
  status: string;
  movementDate: string;
  reference: string | null;
  projectCode: string | null;
  partyName: string | null;
  sourceModule: string | null;
  postedAt: string | null;
  postedByName: string | null;
  notes: string | null;
  lineCount: number;
  totalQuantity: string;
  totalCost: string;
  isReversed: boolean;
  reversesMovementId: string | null;
}

interface Warehouse {
  id: string;
  code: string;
  name: string;
  type: string;
  isActive: boolean;
}

interface ItemRow {
  id: string;
  code: string;
  name: string;
  uomCode: string | null;
  isStocked: boolean;
}

const BASE = '/inventory/movements';

const TYPE_FILTERS = [
  { label: 'All', value: null },
  { label: 'Receipts', value: 'receipt' },
  { label: 'Issues', value: 'issue' },
  { label: 'Transfers', value: 'transfer' },
  { label: 'Adjustments', value: 'adjustment' },
  { label: 'Returns', value: 'return' },
  { label: 'Scrap', value: 'scrap' },
  { label: 'Production', value: 'production_output' },
];

/** Whether a type takes stock out, puts it in, or both. Drives the badge tone. */
const TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  receipt: 'good',
  return: 'good',
  production_output: 'good',
  issue: 'bad',
  scrap: 'bad',
  transfer: 'neutral',
  adjustment: 'neutral',
};

/**
 * The stock ledger.
 *
 * Every change to stock is a row here — there is no other way for a quantity to
 * move — which is what makes the four other Inventory registers reconcilable:
 * any figure on them can be walked back to the movements that produced it.
 *
 * Nothing is ever edited or deleted. A movement posted in error is corrected by
 * a compensating one, and the ledger shows both, with the earlier row marked
 * `reversed`. That is why this screen has no row actions.
 */
export default async function MovementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();
  const mayRecord = can(me.permissions, 'inventory.stock_movement.create');

  // The pickers are only fetched for a user who can actually post, so a
  // read-only user's page is one request lighter and never loads a catalogue it
  // has nothing to do with.
  const [result, pickers] = await Promise.all([
    fetchList<MovementRow>('/inventory/movements', query),
    mayRecord
      ? Promise.all([
          apiFetch<{ warehouses: Warehouse[] }>('/inventory/warehouses'),
          fetchList<ItemRow>('/inventory/items', {
            sort: 'code',
            direction: 'asc',
            pageSize: '200',
            stocked: 'true',
          }),
        ])
      : null,
  ]);

  const warehouses = (pickers?.[0].warehouses ?? []).filter((w) => w.isActive);
  const items = pickers?.[1];

  const field =
    'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-3 py-1.5 text-sm outline-none focus:border-(--color-accent)';
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader
        title="Stock movements"
        subtitle="Every change to stock, what it was worth, and who made it."
      />

      {mayRecord ? (
        <Card className="mb-4">
          {/* `<details>` rather than a toggle, so the form collapses without a
              line of client JavaScript and stays open on the server-rendered
              page a failed submission returns to. */}
          <details>
            <summary className="cursor-pointer text-sm font-medium">Record a movement</summary>

            <ActionForm action={recordMovementAction} className="mt-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <label htmlFor="type" className="mb-1 block text-xs text-(--color-muted)">
                    Movement
                  </label>
                  <select id="type" name="type" className={field} defaultValue="receipt">
                    {MOVEMENT_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="movementDate" className="mb-1 block text-xs text-(--color-muted)">
                    Date
                  </label>
                  <input
                    id="movementDate"
                    name="movementDate"
                    type="date"
                    defaultValue={today}
                    className={field}
                  />
                </div>

                <div className="lg:col-span-2">
                  <label htmlFor="itemId" className="mb-1 block text-xs text-(--color-muted)">
                    Item
                  </label>
                  <select id="itemId" name="itemId" className={field} defaultValue="">
                    <option value="" disabled>
                      Choose an item…
                    </option>
                    {(items?.rows ?? []).map((item) => (
                      <option key={item.id} value={item.id}>
                        {`${item.code} — ${item.name}`}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="quantity" className="mb-1 block text-xs text-(--color-muted)">
                    Quantity
                  </label>
                  <input
                    id="quantity"
                    name="quantity"
                    type="number"
                    step="0.001"
                    min="0"
                    inputMode="decimal"
                    className={field}
                  />
                </div>

                <div>
                  <label htmlFor="unitCost" className="mb-1 block text-xs text-(--color-muted)">
                    {`Unit cost (${me.tenant.currencyCode ?? 'base'})`}
                  </label>
                  <input
                    id="unitCost"
                    name="unitCost"
                    type="number"
                    step="0.01"
                    min="0"
                    inputMode="decimal"
                    className={field}
                  />
                </div>

                <div>
                  <label
                    htmlFor="fromWarehouseId"
                    className="mb-1 block text-xs text-(--color-muted)"
                  >
                    From
                  </label>
                  <select id="fromWarehouseId" name="fromWarehouseId" className={field} defaultValue="">
                    <option value="">—</option>
                    {warehouses.map((warehouse) => (
                      <option key={warehouse.id} value={warehouse.id}>
                        {`${warehouse.code} — ${warehouse.name}`}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="toWarehouseId" className="mb-1 block text-xs text-(--color-muted)">
                    Into
                  </label>
                  <select id="toWarehouseId" name="toWarehouseId" className={field} defaultValue="">
                    <option value="">—</option>
                    {warehouses.map((warehouse) => (
                      <option key={warehouse.id} value={warehouse.id}>
                        {`${warehouse.code} — ${warehouse.name}`}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="lg:col-span-2">
                  <label htmlFor="reference" className="mb-1 block text-xs text-(--color-muted)">
                    Reference
                  </label>
                  <input
                    id="reference"
                    name="reference"
                    dir="auto"
                    placeholder="Delivery note, requisition, count sheet…"
                    className={field}
                  />
                </div>

                <div className="lg:col-span-2">
                  <label htmlFor="notes" className="mb-1 block text-xs text-(--color-muted)">
                    Notes
                  </label>
                  <input id="notes" name="notes" dir="auto" className={field} />
                </div>
              </div>

              {/* Said once, plainly, rather than as four tooltips nobody opens.
                  Each of these is a rule the API enforces, so a user who ignores
                  them gets a refusal rather than a wrong posting — but being
                  refused after typing eight fields is its own kind of bad. */}
              <ul className="mt-3 space-y-1 text-xs text-(--color-muted)">
                <li>A receipt needs a unit cost and a destination — this is where value enters the ledger.</li>
                <li>An issue or scrap needs a source; a transfer needs both.</li>
                <li>
                  An adjustment sets stock TO the quantity you type, it does not add it. To write an
                  item off entirely, scrap it.
                </li>
                <li>Everything except a receipt is valued at the cost the stock is already carrying.</li>
              </ul>

              {items && items.total > items.rows.length ? (
                <p className="mt-2 text-xs text-(--color-warn)">
                  {`Showing the first ${integer(items.rows.length)} of ${integer(items.total)} stocked items.`}
                </p>
              ) : null}

              <div className="mt-3">
                <SubmitButton pendingLabel="Posting…">Post movement</SubmitButton>
              </div>
            </ActionForm>
          </details>
        </Card>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterChips base={BASE} query={query} param="type" options={TYPE_FILTERS} />
        <SearchBox base={BASE} query={query} placeholder="Movement number or reference…" />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['movement', 'movements']}
            hint="Nothing has moved yet. Receiving material against a warehouse writes the first row."
          />
        ) : (
          <Table
            head={
              <tr>
                <SortTh base={BASE} query={query} column="number" current={result.sort} direction={result.direction}>
                  Movement
                </SortTh>
                <SortTh base={BASE} query={query} column="type" current={result.sort} direction={result.direction}>
                  Type
                </SortTh>
                <SortTh base={BASE} query={query} column="movementDate" current={result.sort} direction={result.direction}>
                  Date
                </SortTh>
                <Th>Against</Th>
                <Th numeric>Lines</Th>
                <Th numeric>Quantity</Th>
                <Th numeric>Value</Th>
                <SortTh base={BASE} query={query} column="postedAt" current={result.sort} direction={result.direction}>
                  Posted by
                </SortTh>
              </tr>
            }
          >
            {result.rows.map((row) => (
              <tr key={row.id} className="hover:bg-(--color-canvas)">
                <Td>
                  <span className="numeric block">{row.number ?? '—'}</span>
                  {row.reference ? (
                    <span className="block text-xs text-(--color-muted)">{row.reference}</span>
                  ) : null}
                </Td>
                <Td>
                  <Badge tone={TONE[row.type] ?? 'neutral'}>{row.type.replace(/_/g, ' ')}</Badge>
                  {/* A reversed movement is still a true record of what was
                      posted — it is marked, never hidden, because the audit
                      question is "what did we do", not "what do we now think". */}
                  {row.isReversed ? (
                    <span className="mt-0.5 block">
                      <Badge tone="bad">reversed</Badge>
                    </span>
                  ) : null}
                  {row.reversesMovementId ? (
                    <span className="mt-0.5 block text-xs text-(--color-muted)">reversal</span>
                  ) : null}
                </Td>
                <Td>{date(row.movementDate)}</Td>
                <Td>
                  {row.projectCode ? <span className="numeric block">{row.projectCode}</span> : null}
                  {row.partyName ? (
                    <span className="block text-xs text-(--color-muted)">{row.partyName}</span>
                  ) : null}
                  {!row.projectCode && !row.partyName ? (
                    <span className="text-(--color-muted)">—</span>
                  ) : null}
                </Td>
                <Td numeric>{integer(row.lineCount)}</Td>
                <Td numeric>{quantity(row.totalQuantity)}</Td>
                <Td numeric>
                  <Money amount={row.totalCost} currency={me.tenant.currencyCode} />
                </Td>
                <Td>
                  {/* Who, not which module. `sourceModule` is shown underneath
                      because a movement raised by Production and one keyed by
                      hand are different facts about how the stock came to move. */}
                  <span className="block">{row.postedByName ?? '—'}</span>
                  <span className="block text-xs text-(--color-muted)">
                    {row.sourceModule ? `via ${row.sourceModule}` : 'keyed'}
                  </span>
                </Td>
              </tr>
            ))}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['movement', 'movements']} />
      </Card>
    </>
  );
}

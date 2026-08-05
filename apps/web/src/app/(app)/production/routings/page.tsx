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
import { Badge, Card, Empty, PageHeader, Table, Td, Th } from '@/components/ui';
import { can } from '@/lib/actions';
import { pageFetch } from '@/lib/api';
import { integer } from '@/lib/format';
import { getMe } from '@/lib/session';

import { createRoutingAction, createWorkCentreAction, setWorkCentreActiveAction } from './actions';

interface RoutingRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  isActive: boolean;
  operationCount: number;
  plannedMinutes: number | null;
  workCentres: string | null;
  workOrdersUsing: number;
}

interface WorkCentreRow {
  id: string;
  code: string;
  name: string;
  type: string;
  setupMinutes: string;
  runMinutesPerUnit: string;
  isBatchProcess: boolean;
  isActive: boolean;
}

const BASE = '/production/routings';

const WORK_CENTRE_TYPES = [
  'beam_saw',
  'cnc',
  'edgebander',
  'drilling',
  'sanding',
  'spray_booth',
  'assembly',
  'quality',
  'packing',
  'other',
];

const field =
  'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1 text-sm outline-none focus:border-(--color-accent)';

/**
 * Routings and the work centres they route through.
 *
 * Two catalogues on one screen, the same shape as cost codes and cost
 * centres: a work centre is what a routing operation points at, so there is
 * no screen for one without the other. Full field-by-field editing lives on
 * a routing's own detail page (its operations need the room); here it is
 * create-and-retire, which is what a station's code and rates realistically
 * need after the day it was set up.
 */
export default async function RoutingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const me = await getMe();
  const mayManage = can(me.permissions, 'production.routing.manage') || me.user.isOwner;

  const [result, workCentres] = await Promise.all([
    fetchList<RoutingRow>('/production/routings', query),
    pageFetch<{ workCentres: WorkCentreRow[] }>('/production/work-centres'),
  ]);

  return (
    <>
      <PageHeader
        title="Routings"
        subtitle="The path a job takes through the factory, and what it is planned to take."
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterChips
          base={BASE}
          query={query}
          param="inactive"
          options={[{ label: 'Include retired', value: 'true' }]}
        />
        <SearchBox base={BASE} query={query} placeholder="Code or name…" />
      </div>

      <Card
        className="mb-6"
        footnote="Editing a routing does not change work orders already on the floor: the rates and times are snapshotted onto the order when it is created, for the same reason an estimate pins its rate library."
      >
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['routing', 'routings']}
            hint="A routing is a sequence of operations, each at a work centre."
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
                <Th>Path</Th>
                <SortTh base={BASE} query={query} column="operationCount" current={result.sort} direction={result.direction} numeric>
                  Operations
                </SortTh>
                <Th numeric>Planned</Th>
                <Th numeric>In use</Th>
              </tr>
            }
          >
            {result.rows.map((row) => (
              <tr key={row.id} className="hover:bg-(--color-canvas)">
                <Td>
                  <Link href={`/production/routings/${row.id}`} className="numeric text-(--color-accent) hover:underline">
                    {row.code}
                  </Link>
                </Td>
                <Td>
                  <span className="block">{row.name}</span>
                  {row.description ? (
                    <span className="text-xs text-(--color-muted)">{row.description}</span>
                  ) : null}
                </Td>
                <Td>
                  {/* The stations in sequence. A routing is easier to recognise
                      by its path than by its name — "SAW → EB → CNC → SPRAY" is
                      what a foreman actually pictures. */}
                  <span className="numeric text-xs">{row.workCentres ?? '—'}</span>
                </Td>
                <Td numeric>
                  <span className="numeric">{integer(row.operationCount)}</span>
                </Td>
                <Td numeric>
                  {row.plannedMinutes == null ? (
                    <span className="text-(--color-muted)">—</span>
                  ) : (
                    <>
                      <span className="numeric">{`${integer(row.plannedMinutes)} min`}</span>
                      <span className="block text-xs text-(--color-muted)">
                        {/* Setup plus run per unit. Not a job duration — the run
                            time scales with quantity and the setup does not. */}
                        setup + run per unit
                      </span>
                    </>
                  )}
                </Td>
                <Td numeric>
                  <span className="numeric">{integer(row.workOrdersUsing)}</span>
                  <span className="mt-0.5 block">
                    {row.isDefault ? <Badge tone="good">default</Badge> : null}
                    {!row.isActive ? <Badge tone="bad">retired</Badge> : null}
                  </span>
                </Td>
              </tr>
            ))}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['routing', 'routings']} />

        {mayManage ? (
          <ActionForm action={createRoutingAction} className="mt-4 grid gap-3 border-t border-(--color-line) pt-4 sm:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Code</span>
              <input name="code" placeholder="STD-DOOR" className={field} />
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-xs text-(--color-muted)">Name</span>
              <input name="name" dir="auto" placeholder="Standard door" className={field} />
            </label>
            <label className="flex items-end gap-1.5 pb-1.5 text-sm">
              <input type="checkbox" name="isDefault" value="true" className="accent-current" />
              Default
            </label>
            <label className="block sm:col-span-4">
              <span className="mb-1 block text-xs text-(--color-muted)">Description (optional)</span>
              <input name="description" dir="auto" className={field} />
            </label>
            <div>
              <SubmitButton pendingLabel="Adding…">Add routing</SubmitButton>
            </div>
          </ActionForm>
        ) : null}
      </Card>

      <Card title="Work centres" footnote="Every routing operation runs at one of these. Rates set here are the defaults an operation can override.">
        {workCentres.workCentres.length === 0 ? (
          <Empty title="No work centres yet" detail="Add the first station below." />
        ) : (
          <Table
            head={
              <tr>
                <Th>Code</Th>
                <Th>Name</Th>
                <Th>Type</Th>
                <Th numeric>Setup / run</Th>
                <Th>Status</Th>
                {mayManage ? <Th /> : null}
              </tr>
            }
          >
            {workCentres.workCentres.map((row) => (
              <tr key={row.id}>
                <Td>
                  <span className="numeric">{row.code}</span>
                </Td>
                <Td>{row.name}</Td>
                <Td>{row.type.replace(/_/g, ' ')}</Td>
                <Td numeric>
                  <span className="numeric text-xs">
                    {`${row.setupMinutes} min + ${row.runMinutesPerUnit} min/unit`}
                    {row.isBatchProcess ? ' (batch)' : ''}
                  </span>
                </Td>
                <Td>
                  <Badge tone={row.isActive ? 'good' : 'bad'}>{row.isActive ? 'active' : 'retired'}</Badge>
                </Td>
                {mayManage ? (
                  <Td>
                    <ActionForm action={setWorkCentreActiveAction}>
                      <input type="hidden" name="workCentreId" value={row.id} />
                      <input type="hidden" name="isActive" value={(!row.isActive).toString()} />
                      <SubmitButton pendingLabel="Saving…">
                        {row.isActive ? 'Retire' : 'Reactivate'}
                      </SubmitButton>
                    </ActionForm>
                  </Td>
                ) : null}
              </tr>
            ))}
          </Table>
        )}

        {mayManage ? (
          <ActionForm action={createWorkCentreAction} className="mt-4 grid gap-3 border-t border-(--color-line) pt-4 sm:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Code</span>
              <input name="code" placeholder="CNC-1" className={field} />
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-xs text-(--color-muted)">Name</span>
              <input name="name" dir="auto" placeholder="CNC Router" className={field} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Type</span>
              <select name="type" defaultValue="other" className={field}>
                {WORK_CENTRE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Setup (min)</span>
              <input type="number" step="any" name="setupMinutes" className={`${field} numeric`} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Run (min/unit)</span>
              <input type="number" step="any" name="runMinutesPerUnit" className={`${field} numeric`} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Cost / hour</span>
              <input type="number" step="any" name="costPerHour" className={`${field} numeric`} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Capacity units</span>
              <input type="number" step="1" name="capacityUnits" defaultValue={1} className={`${field} numeric`} />
            </label>
            <label className="flex items-end gap-1.5 pb-1.5 text-sm">
              <input type="checkbox" name="isBatchProcess" value="true" className="accent-current" />
              Batch process
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Batch capacity</span>
              <input type="number" step="1" name="batchCapacityUnits" className={`${field} numeric`} />
            </label>
            <div className="flex items-end">
              <SubmitButton pendingLabel="Adding…">Add work centre</SubmitButton>
            </div>
          </ActionForm>
        ) : null}
      </Card>
    </>
  );
}

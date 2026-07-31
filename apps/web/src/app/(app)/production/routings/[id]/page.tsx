import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, PageHeader, Table, Td, Th } from '@/components/ui';
import { can } from '@/lib/actions';
import { ApiError, pageFetch } from '@/lib/api';
import { getMe } from '@/lib/session';

import {
  addOperationAction,
  removeOperationAction,
  updateOperationAction,
  updateRoutingAction,
} from './actions';

interface RoutingOperationRow {
  id: string;
  sequence: number;
  name: string;
  workCentreId: string;
  workCentreCode: string;
  workCentreName: string;
  setupMinutes: string | null;
  runMinutesPerUnit: string | null;
  cureMinutes: number;
  isQualityGate: boolean;
  instructions: string | null;
}

interface RoutingDetail {
  routing: {
    id: string;
    code: string;
    name: string;
    itemId: string | null;
    description: string | null;
    isDefault: boolean;
    isActive: boolean;
  };
  operations: RoutingOperationRow[];
}

interface WorkCentreRow {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

const field =
  'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1.5 text-sm outline-none focus:border-(--color-accent)';

/**
 * A routing's steps — the detail view its list page has no room for.
 *
 * Reordering is done by editing an operation's own sequence number rather
 * than drag-and-drop: the write path (`updateRoutingOperation`) already
 * refuses a sequence already in use, so typing a new number IS the reorder,
 * validated the same way whichever client drives it.
 */
export default async function RoutingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const me = await getMe();
  const mayManage = can(me.permissions, 'production.routing.manage') || me.user.isOwner;

  let detail: RoutingDetail;
  try {
    detail = await pageFetch<RoutingDetail>(`/production/routings/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) notFound();
    throw error;
  }

  const workCentres = mayManage
    ? await pageFetch<{ workCentres: WorkCentreRow[] }>('/production/work-centres')
    : null;
  const activeCentres = workCentres?.workCentres.filter((c) => c.isActive) ?? [];

  const { routing } = detail;
  const operations = [...detail.operations].sort((a, b) => a.sequence - b.sequence);

  return (
    <>
      <PageHeader title={`${routing.code} — ${routing.name}`} subtitle={routing.description ?? undefined} />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Link href="/production/routings" className="text-(--color-accent) hover:underline">
          ← All routings
        </Link>
        {routing.isDefault ? <Badge tone="good">default</Badge> : null}
        {!routing.isActive ? <Badge tone="bad">retired</Badge> : null}
      </div>

      {mayManage ? (
        <Card title="Details" className="mb-6">
          <ActionForm action={updateRoutingAction} className="space-y-3">
            <input type="hidden" name="routingId" value={routing.id} />
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-xs text-(--color-muted)">Name</span>
                <input name="name" dir="auto" defaultValue={routing.name} className={field} />
              </label>
              <label className="block sm:col-span-3">
                <span className="mb-1 block text-xs text-(--color-muted)">Description</span>
                <textarea
                  name="description"
                  dir="auto"
                  rows={2}
                  defaultValue={routing.description ?? ''}
                  className={field}
                />
              </label>
            </div>
            <fieldset>
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" name="isDefault" value="true" defaultChecked={routing.isDefault} className="accent-current" />
                  Default routing
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" name="isActive" value="true" defaultChecked={routing.isActive} className="accent-current" />
                  Active
                </label>
              </div>
            </fieldset>
            <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
          </ActionForm>
        </Card>
      ) : null}

      <Card
        title="Operations"
        className="mb-6"
        footnote="A work order copies these onto its own operations when it is created. Editing them here never changes a job already on the floor."
      >
        {operations.length === 0 ? (
          <p className="text-sm text-(--color-muted)">No operations yet. Add the first step below.</p>
        ) : (
          <Table
            head={
              <tr>
                <Th numeric>Seq</Th>
                <Th>Operation</Th>
                <Th>Work centre</Th>
                <Th numeric>Setup</Th>
                <Th numeric>Run / unit</Th>
                <Th numeric>Cure</Th>
                <Th>Gate</Th>
              </tr>
            }
          >
            {operations.map((op) => (
              <tr key={op.id}>
                <Td numeric>
                  <span className="numeric">{op.sequence}</span>
                </Td>
                <Td>
                  <span className="block">{op.name}</span>
                  {op.instructions ? (
                    <span className="block text-xs text-(--color-muted)">{op.instructions}</span>
                  ) : null}
                </Td>
                <Td>
                  <span className="block">{op.workCentreName}</span>
                  <span className="numeric text-xs text-(--color-muted)">{op.workCentreCode}</span>
                </Td>
                <Td numeric>
                  <span className="numeric">{op.setupMinutes ?? '—'}</span>
                </Td>
                <Td numeric>
                  <span className="numeric">{op.runMinutesPerUnit ?? '—'}</span>
                </Td>
                <Td numeric>
                  <span className="numeric">{op.cureMinutes}</span>
                </Td>
                <Td>{op.isQualityGate ? <Badge tone="neutral">QC</Badge> : '—'}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {mayManage ? (
        <>
          {operations.map((op) => (
            <Card key={op.id} title={`Edit — sequence ${op.sequence}: ${op.name}`} className="mb-4">
              <ActionForm action={updateOperationAction} className="space-y-3">
                <input type="hidden" name="routingId" value={routing.id} />
                <input type="hidden" name="operationId" value={op.id} />
                <div className="grid gap-3 sm:grid-cols-4">
                  <label className="block">
                    <span className="mb-1 block text-xs text-(--color-muted)">Sequence</span>
                    <input type="number" step="1" name="sequence" defaultValue={op.sequence} className={`${field} numeric`} />
                  </label>
                  <label className="block sm:col-span-2">
                    <span className="mb-1 block text-xs text-(--color-muted)">Name</span>
                    <input name="name" dir="auto" defaultValue={op.name} className={field} />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-(--color-muted)">Work centre</span>
                    <select name="workCentreId" defaultValue={op.workCentreId} className={field}>
                      {activeCentres.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.code} — {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-(--color-muted)">Setup override (min)</span>
                    <input type="number" step="any" name="setupMinutes" defaultValue={op.setupMinutes ?? ''} className={`${field} numeric`} />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-(--color-muted)">Run override (min/unit)</span>
                    <input type="number" step="any" name="runMinutesPerUnit" defaultValue={op.runMinutesPerUnit ?? ''} className={`${field} numeric`} />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-(--color-muted)">Cure (min)</span>
                    <input type="number" step="1" name="cureMinutes" defaultValue={op.cureMinutes} className={`${field} numeric`} />
                  </label>
                  <label className="flex items-end gap-1.5 pb-1.5 text-sm">
                    <input type="checkbox" name="isQualityGate" value="true" defaultChecked={op.isQualityGate} className="accent-current" />
                    Quality gate
                  </label>
                  <label className="block sm:col-span-4">
                    <span className="mb-1 block text-xs text-(--color-muted)">Instructions</span>
                    <input name="instructions" dir="auto" defaultValue={op.instructions ?? ''} className={field} />
                  </label>
                </div>
                <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
              </ActionForm>

              <ActionForm action={removeOperationAction} className="mt-3 border-t border-(--color-line) pt-3">
                <input type="hidden" name="routingId" value={routing.id} />
                <input type="hidden" name="operationId" value={op.id} />
                <SubmitButton pendingLabel="Removing…">Remove this operation</SubmitButton>
              </ActionForm>
            </Card>
          ))}

          <Card title="Add an operation">
            <ActionForm action={addOperationAction} className="grid gap-3 sm:grid-cols-4">
              <input type="hidden" name="routingId" value={routing.id} />
              <label className="block">
                <span className="mb-1 block text-xs text-(--color-muted)">Sequence</span>
                <input type="number" step="1" name="sequence" defaultValue={operations.length + 1} className={`${field} numeric`} />
              </label>
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-xs text-(--color-muted)">Name</span>
                <input name="name" dir="auto" placeholder="Cut" className={field} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-(--color-muted)">Work centre</span>
                <select name="workCentreId" defaultValue="" className={field}>
                  <option value="" disabled>
                    — Choose —
                  </option>
                  {activeCentres.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} — {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-(--color-muted)">Setup override (min)</span>
                <input type="number" step="any" name="setupMinutes" className={`${field} numeric`} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-(--color-muted)">Run override (min/unit)</span>
                <input type="number" step="any" name="runMinutesPerUnit" className={`${field} numeric`} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-(--color-muted)">Cure (min)</span>
                <input type="number" step="1" name="cureMinutes" defaultValue={0} className={`${field} numeric`} />
              </label>
              <label className="flex items-end gap-1.5 pb-1.5 text-sm">
                <input type="checkbox" name="isQualityGate" value="true" className="accent-current" />
                Quality gate
              </label>
              <label className="block sm:col-span-4">
                <span className="mb-1 block text-xs text-(--color-muted)">Instructions (optional)</span>
                <input name="instructions" dir="auto" className={field} />
              </label>
              <div>
                <SubmitButton pendingLabel="Adding…">Add operation</SubmitButton>
              </div>
            </ActionForm>
          </Card>
        </>
      ) : null}
    </>
  );
}

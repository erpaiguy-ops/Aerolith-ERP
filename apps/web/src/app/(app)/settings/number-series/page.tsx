import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, Empty, PageHeader, Table, Td, Th } from '@/components/ui';
import { can } from '@/lib/actions';
import { pageFetch } from '@/lib/api';
import { integer } from '@/lib/format';
import { getMe } from '@/lib/session';

import {
  makeGaplessAction,
  setNextValueAction,
  setSeriesActiveAction,
  updateSeriesShapeAction,
} from './actions';

interface SeriesRow {
  id: string;
  entityType: string;
  code: string;
  name: string;
  pattern: string;
  prefix: string | null;
  suffix: string | null;
  padding: number;
  startValue: number;
  increment: number;
  nextValue: number;
  resetFrequency: string;
  lastResetPeriod: string | null;
  isGapless: boolean;
  isDefault: boolean;
  isActive: boolean;
  allocatedCount: number;
  lastFormatted: string | null;
}

const field =
  'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1 text-sm outline-none focus:border-(--color-accent)';

/**
 * Document numbering — the shape of every reference this workspace prints.
 *
 * `kernel.number_series.manage` was declared from the start and gated nothing,
 * because a series could be created (from a module's manifest, when the module
 * was enabled) and consumed (by `allocateNumber`) but never edited. A tenant
 * who wanted "INV-" instead of "IPC-" had no way to say so.
 *
 * The code and entity type are shown but not editable: they are the identity
 * `allocateNumber` looks a series up by, and renaming one here would detach
 * the series from the documents that ask for it.
 */
export default async function NumberSeriesPage() {
  const me = await getMe();
  const mayManage = can(me.permissions, 'kernel.number_series.manage') || me.user.isOwner;

  const { series } = await pageFetch<{ series: SeriesRow[] }>('/admin/number-series');

  return (
    <>
      <PageHeader
        title="Document numbering"
        subtitle="How every reference this workspace issues is built, and what each series has issued so far."
      />

      {series.length === 0 ? (
        <Card>
          <Empty
            title="No number series yet"
            detail="Series are created from each module's own declarations when that module is enabled."
          />
        </Card>
      ) : (
        <div className="grid gap-4">
          {series.map((row) => {
            const used = row.allocatedCount > 0;

            return (
              <Card key={row.id}>
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <span className="numeric font-medium">{row.code}</span>
                    <span className="ml-2 text-sm text-(--color-muted)">{row.name}</span>
                    <span className="numeric ml-2 text-xs text-(--color-muted)">
                      {row.entityType}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {row.isGapless ? <Badge tone="good">gapless</Badge> : null}
                    {row.isDefault ? <Badge tone="neutral">default</Badge> : null}
                    <Badge tone={row.isActive ? 'neutral' : 'bad'}>
                      {row.isActive ? 'active' : 'retired'}
                    </Badge>
                  </div>
                </div>

                <Table
                  head={
                    <tr>
                      <Th>Issued so far</Th>
                      <Th>Last number</Th>
                      <Th>Next number</Th>
                      <Th>Resets</Th>
                    </tr>
                  }
                >
                  <tr>
                    <Td numeric>{integer(row.allocatedCount)}</Td>
                    <Td>
                      {row.lastFormatted ? (
                        <span className="numeric">{row.lastFormatted}</span>
                      ) : (
                        <span className="text-(--color-muted)">—</span>
                      )}
                    </Td>
                    <Td numeric>{integer(row.nextValue)}</Td>
                    <Td>
                      {row.resetFrequency.replace(/_/g, ' ')}
                      {row.lastResetPeriod ? (
                        <span className="numeric block text-xs text-(--color-muted)">
                          {row.lastResetPeriod}
                        </span>
                      ) : null}
                    </Td>
                  </tr>
                </Table>

                {mayManage ? (
                  <div className="mt-4 grid gap-4 border-t border-(--color-line) pt-4">
                    <ActionForm
                      action={updateSeriesShapeAction.bind(null, row.id)}
                      className="grid gap-3 sm:grid-cols-5"
                    >
                      <label className="block sm:col-span-2">
                        <span className="mb-1 block text-xs text-(--color-muted)">Name</span>
                        <input name="name" defaultValue={row.name} dir="auto" className={field} />
                      </label>
                      <label className="block sm:col-span-2">
                        <span className="mb-1 block text-xs text-(--color-muted)">
                          Pattern — must contain {'{SEQ}'}
                        </span>
                        <input name="pattern" defaultValue={row.pattern} className={field} />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-xs text-(--color-muted)">Padding</span>
                        <input
                          type="number"
                          name="padding"
                          min={1}
                          max={12}
                          defaultValue={row.padding}
                          className={field}
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-xs text-(--color-muted)">Prefix</span>
                        <input name="prefix" defaultValue={row.prefix ?? ''} className={field} />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-xs text-(--color-muted)">Suffix</span>
                        <input name="suffix" defaultValue={row.suffix ?? ''} className={field} />
                      </label>
                      <div className="flex items-end sm:col-span-3">
                        <SubmitButton pendingLabel="Saving…">Save shape</SubmitButton>
                      </div>
                    </ActionForm>

                    <div className="flex flex-wrap items-end gap-3">
                      <ActionForm
                        action={setNextValueAction.bind(null, row.id)}
                        className="flex items-end gap-2"
                      >
                        <label className="block">
                          <span className="mb-1 block text-xs text-(--color-muted)">
                            Next number to issue
                          </span>
                          <input
                            type="number"
                            name="nextValue"
                            min={1}
                            defaultValue={row.nextValue}
                            className={`${field} w-40`}
                          />
                        </label>
                        <SubmitButton pendingLabel="Setting…">Set</SubmitButton>
                      </ActionForm>

                      {!row.isGapless ? (
                        <ActionForm action={makeGaplessAction.bind(null, row.id)}>
                          <SubmitButton pendingLabel="…">Make gapless</SubmitButton>
                        </ActionForm>
                      ) : null}

                      <ActionForm
                        action={setSeriesActiveAction.bind(null, row.id, !row.isActive)}
                      >
                        <SubmitButton pendingLabel="…">
                          {row.isActive ? 'Retire' : 'Reactivate'}
                        </SubmitButton>
                      </ActionForm>
                    </div>

                    {used ? (
                      // Stated where the edit happens rather than in a help
                      // page: the numbers already on a client's paperwork keep
                      // the shape they were issued with, and only the next one
                      // changes.
                      <p className="text-xs text-(--color-muted)">
                        {`${integer(row.allocatedCount)} already issued under this series. Changing the pattern
                          affects future numbers only — what is printed on documents already sent stays as it was.`}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}

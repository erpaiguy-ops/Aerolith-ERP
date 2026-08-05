import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, Empty, PageHeader, Table, Td, Th } from '@/components/ui';
import { can } from '@/lib/actions';
import { pageFetch } from '@/lib/api';
import { getMe } from '@/lib/session';

import {
  createCostCentreAction,
  createCostCodeAction,
  setCostCentreActiveAction,
  setCostCodeActiveAction,
} from './actions';

interface CostCodeRow {
  id: string;
  code: string;
  name: string;
  costType: string;
  parentId: string | null;
  isActive: boolean;
}

interface CostCentreRow {
  id: string;
  code: string;
  name: string;
  legalEntityId: string | null;
  parentId: string | null;
  ownerId: string | null;
  isActive: boolean;
}

const COST_TYPES = ['material', 'labour', 'machine', 'subcontract', 'overhead', 'other'];

const field =
  'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1 text-sm outline-none focus:border-(--color-accent)';

/**
 * Cost codes and cost centres — the breakdown structure every cost booking
 * across every module resolves to. Both had a foreign key referencing them
 * (`costCodeId` on a stock movement, `costCentreId` on a requisition and an
 * order) and no screen anywhere that could create the row on the other end —
 * a tenant could reference an id but never mint one.
 *
 * Neither carries custom fields, so unlike parties and items this is the
 * whole slice: a flat catalogue, listed and retired, the same shape as the
 * custom fields page rather than the party/item detail-screen pattern —
 * there is no second tab's worth of fields to justify a page of its own per
 * row.
 */
export default async function CostCodesPage() {
  const me = await getMe();
  const mayManage = can(me.permissions, 'kernel.master_data.manage') || me.user.isOwner;

  const [costCodes, costCentres] = await Promise.all([
    pageFetch<{ rows: CostCodeRow[] }>('/master-data/cost-codes?includeInactive=true&pageSize=200'),
    pageFetch<{ rows: CostCentreRow[] }>('/master-data/cost-centres?includeInactive=true&pageSize=200'),
  ]);

  const codeById = new Map(costCodes.rows.map((c) => [c.id, c]));

  return (
    <>
      <PageHeader
        title="Cost codes & cost centres"
        subtitle="The breakdown structure every cost — material, labour, machine, subcontract — books to, and where every job's spend is centred."
      />

      <Card title="Cost codes" className="mb-6">
        {costCodes.rows.length === 0 ? (
          <Empty title="No cost codes yet" detail="Add the first one below." />
        ) : (
          <Table
            head={
              <tr>
                <Th>Code</Th>
                <Th>Name</Th>
                <Th>Type</Th>
                <Th>Parent</Th>
                <Th>Status</Th>
                {mayManage ? <Th /> : null}
              </tr>
            }
          >
            {costCodes.rows.map((row) => (
              <tr key={row.id}>
                <Td>
                  <span className="numeric">{row.code}</span>
                </Td>
                <Td>{row.name}</Td>
                <Td>{row.costType}</Td>
                <Td>
                  {row.parentId ? (
                    <span className="numeric text-xs text-(--color-muted)">
                      {codeById.get(row.parentId)?.code ?? '—'}
                    </span>
                  ) : (
                    '—'
                  )}
                </Td>
                <Td>
                  <Badge tone={row.isActive ? 'good' : 'bad'}>
                    {row.isActive ? 'active' : 'retired'}
                  </Badge>
                </Td>
                {mayManage ? (
                  <Td>
                    <ActionForm action={setCostCodeActiveAction}>
                      <input type="hidden" name="costCodeId" value={row.id} />
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
          <ActionForm action={createCostCodeAction} className="mt-4 grid gap-3 border-t border-(--color-line) pt-4 sm:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Code</span>
              <input name="code" placeholder="MAT-JOINERY" className={field} />
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-xs text-(--color-muted)">Name</span>
              <input name="name" dir="auto" placeholder="Joinery materials" className={field} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Type</span>
              <select name="costType" defaultValue="material" className={field}>
                {COST_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-xs text-(--color-muted)">Parent (optional)</span>
              <select name="parentId" defaultValue="" className={field}>
                <option value="">— None —</option>
                {costCodes.rows
                  .filter((c) => c.isActive)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} — {c.name}
                    </option>
                  ))}
              </select>
            </label>
            <div className="flex items-end">
              <SubmitButton pendingLabel="Adding…">Add cost code</SubmitButton>
            </div>
          </ActionForm>
        ) : null}
      </Card>

      <Card title="Cost centres">
        {costCentres.rows.length === 0 ? (
          <Empty title="No cost centres yet" detail="Add the first one below." />
        ) : (
          <Table
            head={
              <tr>
                <Th>Code</Th>
                <Th>Name</Th>
                <Th>Status</Th>
                {mayManage ? <Th /> : null}
              </tr>
            }
          >
            {costCentres.rows.map((row) => (
              <tr key={row.id}>
                <Td>
                  <span className="numeric">{row.code}</span>
                </Td>
                <Td>{row.name}</Td>
                <Td>
                  <Badge tone={row.isActive ? 'good' : 'bad'}>
                    {row.isActive ? 'active' : 'retired'}
                  </Badge>
                </Td>
                {mayManage ? (
                  <Td>
                    <ActionForm action={setCostCentreActiveAction}>
                      <input type="hidden" name="costCentreId" value={row.id} />
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
          <ActionForm action={createCostCentreAction} className="mt-4 grid gap-3 border-t border-(--color-line) pt-4 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Code</span>
              <input name="code" placeholder="SITE-DXB01" className={field} />
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-xs text-(--color-muted)">Name</span>
              <input name="name" dir="auto" placeholder="Downtown Villa Site" className={field} />
            </label>
            <div>
              <SubmitButton pendingLabel="Adding…">Add cost centre</SubmitButton>
            </div>
          </ActionForm>
        ) : null}
      </Card>
    </>
  );
}

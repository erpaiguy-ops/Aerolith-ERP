import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, Empty, PageHeader, Table, Td, Th } from '@/components/ui';
import { can } from '@/lib/actions';
import { pageFetch } from '@/lib/api';
import { date } from '@/lib/format';
import { getMe } from '@/lib/session';

import { qualifySupplierAction, setSupplierQualificationStatusAction } from './actions';

interface SupplierQualificationRow {
  id: string;
  partyId: string;
  partyCode: string | null;
  partyName: string | null;
  status: 'pending' | 'approved' | 'suspended';
  reason: string | null;
  reviewDate: string | null;
}

interface PartyOption {
  id: string;
  code: string;
  name: string;
}

const field =
  'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1 text-sm outline-none focus:border-(--color-accent)';

const STATUS_TONE = { pending: 'neutral', approved: 'good', suspended: 'bad' } as const;

/**
 * The approved supplier list — the fact `kernel.party.isSupplier` cannot carry.
 *
 * A party's supplier role flag says a company COULD be bought from. It says
 * nothing about whether procurement has actually vetted them, which is why
 * `procurement.supplier.manage` exists and why this screen is separate from
 * the party record itself: qualifying and suspending a supplier are decisions
 * that need their own record, on their own timeline, independent of anyone
 * editing the party's name or address.
 *
 * A flat register rather than a detail screen per supplier — like cost codes
 * and cost centres, there is no second tab's worth of fields to justify one.
 */
export default async function SuppliersPage() {
  const me = await getMe();
  const mayManage = can(me.permissions, 'procurement.supplier.manage') || me.user.isOwner;

  const [qualifications, suppliers] = await Promise.all([
    pageFetch<{ rows: SupplierQualificationRow[] }>('/procurement/suppliers?pageSize=200'),
    pageFetch<{ rows: PartyOption[] }>('/master-data/parties?role=supplier&pageSize=200'),
  ]);

  // Only a party not already carrying a global qualification is offered in the
  // add form — the API's unique constraint would refuse a second one anyway,
  // and there is no reason to let a user hit that the hard way.
  const alreadyQualified = new Set(qualifications.rows.map((row) => row.partyId));
  const eligible = suppliers.rows.filter((party) => !alreadyQualified.has(party.id));

  return (
    <>
      <PageHeader
        title="Approved suppliers"
        subtitle="Who procurement has actually vetted — separate from who the party record merely says can trade with us."
      />

      <Card title="Supplier qualifications">
        {qualifications.rows.length === 0 ? (
          <Empty
            title="No suppliers qualified yet"
            detail="Add one below — every supplier starts pending until it is approved."
          />
        ) : (
          <Table
            head={
              <tr>
                <Th>Supplier</Th>
                <Th>Status</Th>
                <Th>Reason</Th>
                <Th>Review date</Th>
                {mayManage ? <Th /> : null}
              </tr>
            }
          >
            {qualifications.rows.map((row) => (
              <tr key={row.id}>
                <Td>
                  <span className="numeric">{row.partyCode ?? '—'}</span>
                  {row.partyName ? (
                    <span className="ml-2 text-(--color-muted)">{row.partyName}</span>
                  ) : null}
                </Td>
                <Td>
                  <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>
                </Td>
                <Td>{row.reason ?? '—'}</Td>
                <Td>{row.reviewDate ? date(row.reviewDate) : '—'}</Td>
                {mayManage ? (
                  <Td>
                    <div className="flex flex-wrap items-start gap-3">
                      {row.status !== 'approved' ? (
                        <ActionForm action={setSupplierQualificationStatusAction}>
                          <input type="hidden" name="qualificationId" value={row.id} />
                          <input type="hidden" name="status" value="approved" />
                          <SubmitButton pendingLabel="Saving…">Approve</SubmitButton>
                        </ActionForm>
                      ) : null}
                      {row.status !== 'suspended' ? (
                        <ActionForm action={setSupplierQualificationStatusAction} className="flex items-end gap-2">
                          <input type="hidden" name="qualificationId" value={row.id} />
                          <input type="hidden" name="status" value="suspended" />
                          <label>
                            <span className="mb-1 block text-xs text-(--color-muted)">Why…</span>
                            <input name="reason" dir="auto" placeholder="Reason" className={field} />
                          </label>
                          <SubmitButton tone="danger" pendingLabel="Saving…">
                            Suspend
                          </SubmitButton>
                        </ActionForm>
                      ) : null}
                    </div>
                  </Td>
                ) : null}
              </tr>
            ))}
          </Table>
        )}

        {mayManage ? (
          <ActionForm
            action={qualifySupplierAction}
            className="mt-4 grid gap-3 border-t border-(--color-line) pt-4 sm:grid-cols-4"
          >
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-xs text-(--color-muted)">Supplier</span>
              <select name="partyId" defaultValue="" className={field}>
                <option value="" disabled>
                  — Choose —
                </option>
                {eligible.map((party) => (
                  <option key={party.id} value={party.id}>
                    {party.code} — {party.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Review date (optional)</span>
              <input type="date" name="reviewDate" className={field} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Reason (optional)</span>
              <input name="reason" dir="auto" placeholder="Why they're being added" className={field} />
            </label>
            <div className="flex items-end">
              <SubmitButton pendingLabel="Adding…">Add to the list</SubmitButton>
            </div>
          </ActionForm>
        ) : null}
      </Card>
    </>
  );
}

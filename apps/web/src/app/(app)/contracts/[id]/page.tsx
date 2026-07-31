import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, Empty, Money, PageHeader, Stat, Table, Td, Th } from '@/components/ui';
import { can, requiredText, runAction, type ActionState } from '@/lib/actions';
import { ApiError, apiFetchOptional, pageFetch } from '@/lib/api';
import { date, money, percent, toneForVariance } from '@/lib/format';
import { getMe } from '@/lib/session';

/**
 * Values a cumulative payment application from measured site progress.
 *
 * The last link in the chain and the one no generic ERP joins: the WBS roll-up
 * values every contract BOQ line at its measured percentage, and the total
 * becomes this month's application. Contract lines with no WBS link are NAMED in
 * the result rather than counted, because an unvalued BOQ line is unbilled work
 * and "3 lines skipped" is a number nobody investigates.
 */
async function valueFromProgress(
  contractId: string,
  projectId: string,
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  'use server';

  const periodTo = String(form.get('periodTo') ?? '');
  if (!periodTo) return { status: 'error', error: 'Choose the period this application covers.' };

  const materials = Number(form.get('materialsOnSite') ?? 0);

  let skipped: string[] = [];

  const state = await runAction(
    async () => {
      const created = await pageFetch<{
        number: string;
        valuedFromProgress: { linesValued: number; linesUnlinked: string[]; workDoneToDate: number };
      }>(`/contracts/${contractId}/applications/from-progress`, {
        method: 'POST',
        body: {
          projectId,
          periodTo,
          materialsOnSite: Number.isFinite(materials) && materials > 0 ? materials : undefined,
        },
      });
      skipped = created.valuedFromProgress.linesUnlinked;
      return created;
    },
    {
      revalidate: [`/contracts/${contractId}`, '/contracts'],
      success: 'Application drafted from measured progress.',
    },
  );

  // Success with a warning is still success, but the warning is the useful part:
  // every named line is work that has been done and is not being billed for.
  if (state.status === 'success' && skipped.length > 0) {
    return {
      status: 'success',
      message: `${state.message} Not valued — no WBS link: ${skipped.join(', ')}. That work is unbilled until the BOQ is linked.`,
    };
  }

  return state;
}

const BACK_CHARGE_CATEGORIES = ['damage', 'attendance', 'rectification', 'materials', 'other'] as const;

/**
 * Raises a back charge against this contract.
 *
 * `reference` is chosen by whoever is raising it, not allocated — a back
 * charge is usually numbered against the subcontractor's own correspondence
 * ("BC-04"), not the contractor's sequence.
 */
async function addBackCharge(contractId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  'use server';

  const reference = requiredText(form, 'reference');
  const description = requiredText(form, 'description');
  const amount = Number(form.get('amount') ?? NaN);
  const incurredOn = requiredText(form, 'incurredOn');

  if (!reference) return { status: 'error', error: 'Give the back charge a reference.' };
  if (!description) return { status: 'error', error: 'Describe the back charge.' };
  if (!Number.isFinite(amount) || amount <= 0) {
    return { status: 'error', error: 'Enter the amount claimed.' };
  }
  if (!incurredOn) return { status: 'error', error: 'Choose the date it was incurred.' };

  return runAction(
    () =>
      pageFetch(`/contracts/${contractId}/back-charges`, {
        method: 'POST',
        body: {
          reference,
          description,
          amount,
          incurredOn,
          category: form.get('category') || undefined,
        },
      }),
    { revalidate: [`/contracts/${contractId}`], success: `Back charge ${reference} raised.` },
  );
}

/**
 * Moves a back charge to 'agreed', recording the amount actually accepted —
 * which is what `sumAgreedBackCharges` deducts from the next application,
 * and is frequently less than what was originally claimed.
 */
async function agreeBackCharge(
  contractId: string,
  backChargeId: string,
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  'use server';

  const agreedAmount = Number(form.get('agreedAmount') ?? NaN);
  if (!Number.isFinite(agreedAmount) || agreedAmount < 0) {
    return { status: 'error', error: 'Enter the amount agreed.' };
  }

  return runAction(
    () =>
      pageFetch(`/contracts/back-charges/${backChargeId}`, {
        method: 'PATCH',
        body: { status: 'agreed', agreedAmount },
      }),
    { revalidate: [`/contracts/${contractId}`], success: 'Back charge agreed.' },
  );
}

async function setBackChargeStatus(
  contractId: string,
  backChargeId: string,
  status: string,
  _state: ActionState,
  _form: FormData,
): Promise<ActionState> {
  'use server';

  return runAction(
    () => pageFetch(`/contracts/back-charges/${backChargeId}`, { method: 'PATCH', body: { status } }),
    { revalidate: [`/contracts/${contractId}`], success: `Back charge marked ${status.replace(/_/g, ' ')}.` },
  );
}

interface Position {
  projectId: string | null;
  number: string | null;
  originalSum: number;
  currentSum: number;
  grossValuedToDate: number;
  certifiedToDate: number;
  uncertified: number;
  retentionHeld: number;
  retentionReleased: number;
  advanceOutstanding: number;
  backChargesOutstanding: number;
  overdueAmount: number;
  anticipatedFinalValue: number;
  variations: {
    approvedValue: number;
    exposureValue: number;
    exposureCost: number;
    pendingValue: number;
    rejectedValue: number;
    oldestUnapprovedDays: number | null;
    counts: Record<string, number>;
  };
}

interface VariationRow {
  id: string;
  number: string | null;
  title: string;
  status: string;
  basis: string;
  instructedOn: string | null;
  approvedOn: string | null;
  quotedValue: string | null;
  approvedValue: string | null;
  percentExecuted: string;
}

interface NoticeExposure {
  atRisk: {
    variationId: string;
    number: string | null;
    title: string;
    value: number;
    status: { deadlineOn: string; daysRemaining: number; isTimeBarred: boolean; isGiven: boolean };
  }[];
  timeBarredCount: number;
  timeBarredValue: number;
}

interface BackChargeRow {
  id: string;
  reference: string;
  description: string;
  category: string;
  amount: string;
  incurredOn: string;
  status: string;
  agreedAmount: string | null;
}

const BACK_CHARGE_TERMINAL = new Set(['recovered', 'written_off']);

const BACK_CHARGE_TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  recovered: 'good',
  agreed: 'good',
  disputed: 'bad',
  written_off: 'neutral',
  raised: 'neutral',
  notified: 'neutral',
};

export default async function ContractPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getMe();
  const currency = me.tenant.currencyCode;
  const mayApply = can(me.permissions, 'contracts.application.write');
  const mayManageBackCharges = can(me.permissions, 'contracts.back_charge.manage') || me.user.isOwner;

  let position: Position;
  try {
    position = await pageFetch<Position>(`/contracts/${id}/position`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) notFound();
    throw error;
  }

  const [variations, notices, backCharges] = await Promise.all([
    apiFetchOptional<{ variations: VariationRow[] }>(`/contracts/${id}/variations`),
    apiFetchOptional<NoticeExposure>(`/contracts/${id}/notice-exposure`),
    apiFetchOptional<{ rows: BackChargeRow[] }>(
      `/contracts/back-charges?contractId=${id}&pageSize=100`,
    ),
  ]);

  return (
    <>
      <PageHeader
        title={position.number ?? 'Contract'}
        subtitle={`${money(position.originalSum, currency)} original · ${money(
          position.currentSum,
          currency,
        )} current`}
      />

      {/* The time-bar warning goes ABOVE everything else, because it is the one
          fact on this page with a deadline attached. Entitlement lost to a
          missed notice is lost permanently. */}
      {notices && notices.timeBarredCount > 0 ? (
        <div className="mb-6 rounded-lg border border-(--color-bad)/30 bg-(--color-bad)/5 p-4">
          <p className="text-sm font-medium text-(--color-bad)">
            {notices.timeBarredCount} variation{notices.timeBarredCount === 1 ? '' : 's'} past the
            notice deadline — {money(notices.timeBarredValue, currency)} at risk
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {notices.atRisk
              .filter((r) => r.status.isTimeBarred)
              .map((r) => (
                <li key={r.variationId} className="text-(--color-muted)">
                  <span className="numeric">{r.number}</span> · {r.title} · deadline{' '}
                  {date(r.status.deadlineOn)}
                </li>
              ))}
          </ul>
        </div>
      ) : null}

      <div className="mb-6 grid gap-4 md:grid-cols-2">
        <Card title="Commercial position">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat label="Current sum" value={money(position.currentSum, currency)} />
            <Stat
              label="Valued to date"
              value={money(position.grossValuedToDate, currency)}
              hint={percent(
                position.currentSum > 0
                  ? (position.grossValuedToDate / position.currentSum) * 100
                  : 0,
              )}
            />
            <Stat label="Certified to date" value={money(position.certifiedToDate, currency)} />
            <Stat
              label="Applied, not certified"
              value={money(position.uncertified, currency)}
              tone={position.uncertified > 0 ? 'neutral' : 'neutral'}
            />
            <Stat label="Retention held" value={money(position.retentionHeld, currency)} />
            <Stat
              label="Overdue"
              value={money(position.overdueAmount, currency)}
              tone={position.overdueAmount > 0 ? 'bad' : 'neutral'}
            />
            <Stat
              label="Back charges outstanding"
              value={money(position.backChargesOutstanding, currency)}
              tone={position.backChargesOutstanding > 0 ? 'bad' : 'neutral'}
              hint="raised, notified, agreed or disputed — not yet recovered"
            />
          </div>
        </Card>

        <Card
          title="Variations"
          footnote="Exposure is instructed work already built and not yet approved. Pending is claimed but never instructed — a much weaker position, so it is counted separately."
        >
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat
              label="Approved"
              value={money(position.variations.approvedValue, currency)}
              hint="the only thing that moves the sum"
            />
            <Stat
              label="Exposure"
              value={money(position.variations.exposureValue, currency)}
              tone={position.variations.exposureValue > 0 ? 'bad' : 'neutral'}
              hint={`${money(position.variations.exposureCost, currency)} already spent`}
            />
            <Stat label="Pending" value={money(position.variations.pendingValue, currency)} />
            <Stat
              label="Anticipated final"
              value={money(position.anticipatedFinalValue, currency)}
              hint="approved + executed exposure"
            />
            {position.variations.oldestUnapprovedDays != null ? (
              <Stat
                label="Oldest unapproved"
                value={`${position.variations.oldestUnapprovedDays} days`}
                tone={position.variations.oldestUnapprovedDays > 60 ? 'bad' : 'neutral'}
              />
            ) : null}
          </div>
        </Card>
      </div>

      {/* Only offered when both halves of the chain are present: a contract
          linked to a job, and a user who may prepare an application. Without
          Projects the API refuses with an explanation, and a QS enters measured
          quantities directly — which is how it is done today. */}
      {position.projectId && mayApply ? (
        <Card
          title="Value from progress"
          className="mb-6"
          footnote="Cumulative, like every valuation here: this is the value to date, and the certificate is the difference against what was last certified."
        >
          <ActionForm action={valueFromProgress.bind(null, id, position.projectId)}>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label htmlFor="periodTo" className="mb-1 block text-xs text-(--color-muted)">
                  Period ending
                </label>
                <input
                  id="periodTo"
                  name="periodTo"
                  type="date"
                  required
                  defaultValue={new Date().toISOString().slice(0, 10)}
                  className="rounded-md border border-(--color-line) bg-(--color-surface) px-3 py-1.5 text-sm outline-none focus:border-(--color-accent)"
                />
              </div>
              <div>
                <label
                  htmlFor="materialsOnSite"
                  className="mb-1 block text-xs text-(--color-muted)"
                >
                  Materials on site (optional)
                </label>
                <input
                  id="materialsOnSite"
                  name="materialsOnSite"
                  type="number"
                  step="any"
                  min={0}
                  className="w-40 rounded-md border border-(--color-line) bg-(--color-surface) px-3 py-1.5 text-sm outline-none focus:border-(--color-accent)"
                />
              </div>
              <SubmitButton pendingLabel="Valuing…">Draft application</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      ) : null}

      <Card title="Variation register">
        {!variations || variations.variations.length === 0 ? (
          <Empty title="No variations" detail="Nothing has changed on this contract yet." />
        ) : (
          <Table
            head={
              <tr>
                <Th>Number</Th>
                <Th>Title</Th>
                <Th>Status</Th>
                <Th>Instructed</Th>
                <Th numeric>Quoted</Th>
                <Th numeric>Approved</Th>
                <Th numeric>Variance</Th>
              </tr>
            }
          >
            {variations.variations.map((v) => {
              const quoted = v.quotedValue == null ? null : Number(v.quotedValue);
              const approved = v.approvedValue == null ? null : Number(v.approvedValue);
              const variance = quoted != null && approved != null ? approved - quoted : null;

              return (
                <tr key={v.id}>
                  <Td>
                    <Link
                      href={`/contracts/variations/${v.id}`}
                      className="numeric text-(--color-accent) hover:underline"
                    >
                      {v.number}
                    </Link>
                  </Td>
                  <Td>{v.title}</Td>
                  <Td>
                    <Badge
                      tone={
                        v.status === 'approved'
                          ? 'good'
                          : v.status === 'rejected'
                            ? 'bad'
                            : 'neutral'
                      }
                    >
                      {v.status.replace(/_/g, ' ')}
                    </Badge>
                  </Td>
                  <Td>{date(v.instructedOn)}</Td>
                  <Td numeric>
                    <Money amount={quoted} currency={currency} />
                  </Td>
                  <Td numeric>
                    <Money amount={approved} currency={currency} />
                  </Td>
                  <Td numeric>
                    {/* The gap between what was claimed and what was agreed. A
                        client who settles everything at 90% is a pattern you can
                        price against — but only if the quote survives approval. */}
                    <Money amount={variance} currency={currency} tone={toneForVariance(variance)} />
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <Card
        title="Back charges"
        className="mt-6"
        footnote="What is deducted from the next application is whatever sits here 'agreed' or 'recovered' — see Back charges outstanding above for the rest."
      >
        {!backCharges || backCharges.rows.length === 0 ? (
          <Empty title="No back charges" detail="Nothing has been raised against this contract." />
        ) : (
          <Table
            head={
              <tr>
                <Th>Reference</Th>
                <Th>Description</Th>
                <Th>Category</Th>
                <Th>Status</Th>
                <Th numeric>Claimed</Th>
                <Th numeric>Agreed</Th>
                {mayManageBackCharges ? <Th /> : null}
              </tr>
            }
          >
            {backCharges.rows.map((bc) => (
              <tr key={bc.id}>
                <Td>
                  <span className="numeric">{bc.reference}</span>
                  <span className="block text-xs text-(--color-muted)">{date(bc.incurredOn)}</span>
                </Td>
                <Td>{bc.description}</Td>
                <Td>{bc.category.replace(/_/g, ' ')}</Td>
                <Td>
                  <Badge tone={BACK_CHARGE_TONE[bc.status] ?? 'neutral'}>
                    {bc.status.replace(/_/g, ' ')}
                  </Badge>
                </Td>
                <Td numeric>
                  <Money amount={bc.amount} currency={currency} />
                </Td>
                <Td numeric>
                  <Money amount={bc.agreedAmount} currency={currency} />
                </Td>
                {mayManageBackCharges ? (
                  <Td>
                    {!BACK_CHARGE_TERMINAL.has(bc.status) ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <ActionForm
                          action={agreeBackCharge.bind(null, id, bc.id)}
                          className="flex items-center gap-1"
                        >
                          <input
                            type="number"
                            name="agreedAmount"
                            step="0.01"
                            min={0}
                            placeholder="Amount"
                            defaultValue={bc.agreedAmount ?? undefined}
                            className="w-24 rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1 text-xs outline-none focus:border-(--color-accent)"
                          />
                          <SubmitButton pendingLabel="…">Agree</SubmitButton>
                        </ActionForm>
                        {bc.status === 'agreed' ? (
                          <ActionForm action={setBackChargeStatus.bind(null, id, bc.id, 'recovered')}>
                            <SubmitButton pendingLabel="…">Recovered</SubmitButton>
                          </ActionForm>
                        ) : null}
                        {bc.status !== 'disputed' ? (
                          <ActionForm action={setBackChargeStatus.bind(null, id, bc.id, 'disputed')}>
                            <SubmitButton tone="danger" pendingLabel="…">
                              Dispute
                            </SubmitButton>
                          </ActionForm>
                        ) : null}
                        <ActionForm action={setBackChargeStatus.bind(null, id, bc.id, 'written_off')}>
                          <SubmitButton tone="danger" pendingLabel="…">
                            Write off
                          </SubmitButton>
                        </ActionForm>
                      </div>
                    ) : null}
                  </Td>
                ) : null}
              </tr>
            ))}
          </Table>
        )}

        {mayManageBackCharges ? (
          <ActionForm
            action={addBackCharge.bind(null, id)}
            className="mt-4 grid gap-3 border-t border-(--color-line) pt-4 sm:grid-cols-5"
          >
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Reference</span>
              <input
                name="reference"
                dir="auto"
                placeholder="BC-04"
                className="w-full rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1 text-sm outline-none focus:border-(--color-accent)"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-xs text-(--color-muted)">Description</span>
              <input
                name="description"
                dir="auto"
                placeholder="Rework of Level 3 skirting"
                className="w-full rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1 text-sm outline-none focus:border-(--color-accent)"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Category</span>
              <select
                name="category"
                defaultValue="other"
                className="w-full rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1 text-sm outline-none focus:border-(--color-accent)"
              >
                {BACK_CHARGE_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Amount</span>
              <input
                type="number"
                name="amount"
                step="0.01"
                min={0}
                className="w-full rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1 text-sm outline-none focus:border-(--color-accent)"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Incurred on</span>
              <input
                type="date"
                name="incurredOn"
                defaultValue={new Date().toISOString().slice(0, 10)}
                className="w-full rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1 text-sm outline-none focus:border-(--color-accent)"
              />
            </label>
            <div className="flex items-end">
              <SubmitButton pendingLabel="Raising…">Raise back charge</SubmitButton>
            </div>
          </ActionForm>
        ) : null}
      </Card>
    </>
  );
}

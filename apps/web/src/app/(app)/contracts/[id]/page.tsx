import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, Empty, Money, PageHeader, Stat, Table, Td, Th } from '@/components/ui';
import { can, runAction, type ActionState } from '@/lib/actions';
import { ApiError, apiFetch, apiFetchOptional } from '@/lib/api';
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
      const created = await apiFetch<{
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

export default async function ContractPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getMe();
  const currency = me.tenant.currencyCode;
  const mayApply = can(me.permissions, 'contracts.application.write');

  let position: Position;
  try {
    position = await apiFetch<Position>(`/contracts/${id}/position`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) notFound();
    throw error;
  }

  const [variations, notices] = await Promise.all([
    apiFetchOptional<{ variations: VariationRow[] }>(`/contracts/${id}/variations`),
    apiFetchOptional<NoticeExposure>(`/contracts/${id}/notice-exposure`),
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
    </>
  );
}

import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, Empty, Money, PageHeader, Stat, Table, Td, Th } from '@/components/ui';
import { can, requiredText, runAction, type ActionState } from '@/lib/actions';
import { ApiError, pageFetch } from '@/lib/api';
import { date, toneForVariance } from '@/lib/format';
import { getMe } from '@/lib/session';

interface VariationDetail {
  variation: {
    id: string;
    contractId: string;
    number: string | null;
    title: string;
    description: string | null;
    status: string;
    basis: string;
    instructionReference: string | null;
    instructedOn: string | null;
    instructedBy: string | null;
    noticeGivenOn: string | null;
    noticeReference: string | null;
    quotedValue: string | null;
    quotedCost: string | null;
    approvedValue: string | null;
    approvedOn: string | null;
    approvedReference: string | null;
    rejectedReason: string | null;
    percentExecuted: string;
    eotClaimedDays: number | null;
    eotGrantedDays: number | null;
  };
  contract: {
    id: string;
    number: string | null;
    name: string;
    currencyCode: string | null;
    noticePeriodDays: number | null;
  } | null;
  lines: {
    id: string;
    lineNumber: number;
    description: string;
    quantity: string;
    uomCode: string | null;
    unitRate: string;
    lineValue: string;
  }[];
  notice: {
    deadlineOn: string;
    daysRemaining: number;
    isGiven: boolean;
    isTimeBarred: boolean;
    wasLate: boolean;
  } | null;
}

const num = (value: string | null | undefined): number => (value == null ? 0 : Number(value));

/**
 * Records that written notice was given.
 *
 * Late notice is recorded rather than refused — it is still evidence, still
 * worth having on file, and refusing it would leave the strongest available fact
 * out of the record to keep a status column tidy. The response says whether it
 * was late, and the screen repeats that.
 */
async function giveNotice(id: string, _state: ActionState, form: FormData): Promise<ActionState> {
  'use server';

  const noticeGivenOn = String(form.get('noticeGivenOn') ?? '');
  if (!noticeGivenOn) return { status: 'error', error: 'Give the date notice was served.' };

  // No special-casing of a late notice here, deliberately. Recording one
  // revalidates the page, `notice.isGiven` becomes true, and this whole panel —
  // form and status element together — is replaced by the durable card below,
  // which states the lateness itself. A message written here could never be
  // read by anyone.
  return runAction(
    () =>
      pageFetch(`/contracts/variations/${id}/notice`, {
        method: 'POST',
        body: {
          noticeGivenOn,
          noticeReference: requiredText(form, 'noticeReference') ?? undefined,
        },
      }),
    {
      revalidate: [`/contracts/variations/${id}`, '/contracts/variations'],
      success: 'Notice recorded.',
    },
  );
}

/** Approves the variation. The only thing that moves the contract sum. */
async function approve(id: string, _state: ActionState, form: FormData): Promise<ActionState> {
  'use server';

  const approvedOn = String(form.get('approvedOn') ?? '');
  const raw = form.get('approvedValue');
  const approvedValue = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;

  if (!approvedOn) return { status: 'error', error: 'Give the date it was approved.' };
  if (!Number.isFinite(approvedValue)) {
    return { status: 'error', error: 'Give the value the client actually approved.' };
  }

  const eotRaw = form.get('eotGrantedDays');
  const eotGrantedDays =
    typeof eotRaw === 'string' && eotRaw.trim() !== '' ? Number(eotRaw) : undefined;

  return runAction(
    () =>
      pageFetch(`/contracts/variations/${id}/approve`, {
        method: 'POST',
        body: {
          approvedValue,
          approvedOn,
          reference: requiredText(form, 'reference') ?? undefined,
          eotGrantedDays: Number.isFinite(eotGrantedDays) ? eotGrantedDays : undefined,
        },
      }),
    {
      revalidate: [
        `/contracts/variations/${id}`,
        '/contracts/variations',
        '/contracts',
      ],
      success: 'Approved. The contract sum has moved.',
    },
  );
}

const field =
  'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-3 py-1.5 text-sm outline-none focus:border-(--color-accent)';

export default async function VariationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getMe();

  let detail: VariationDetail;
  try {
    detail = await pageFetch<VariationDetail>(`/contracts/variations/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) notFound();
    throw error;
  }

  const { variation, contract, lines, notice } = detail;
  const currency = contract?.currencyCode ?? me.tenant.currencyCode;

  const quoted = variation.quotedValue == null ? null : num(variation.quotedValue);
  const approved = variation.approvedValue == null ? null : num(variation.approvedValue);
  const settlement = quoted != null && approved != null ? approved - quoted : null;

  const isApproved = variation.status === 'approved';
  const isSettled = isApproved || variation.status === 'rejected' || variation.status === 'withdrawn';
  const mayWrite = can(me.permissions, 'contracts.variation.write');
  const mayApprove = can(me.permissions, 'contracts.variation.approve');

  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader
        title={variation.number ?? 'Variation'}
        subtitle={`${variation.title}${contract ? ` · ${contract.number ?? contract.name}` : ''}`}
      />

      {/* The clock, above everything. Entitlement lost to a missed notice is
          lost permanently however good the claim was, so this outranks the
          money on the page. */}
      {notice && !notice.isGiven ? (
        <div
          className={`mb-6 rounded-lg border p-4 ${
            notice.isTimeBarred
              ? 'border-(--color-bad)/30 bg-(--color-bad)/5'
              : 'border-(--color-line) bg-(--color-surface)'
          }`}
        >
          <p
            className={`text-sm font-medium ${notice.isTimeBarred ? 'text-(--color-bad)' : ''}`}
          >
            {notice.isTimeBarred
              ? `Past the notice deadline — it was ${date(notice.deadlineOn)}`
              : `${notice.daysRemaining} day${notice.daysRemaining === 1 ? '' : 's'} to give notice, by ${date(notice.deadlineOn)}`}
          </p>
          <p className="mt-1 text-sm text-(--color-muted)">
            {notice.isTimeBarred
              ? 'Record the notice anyway if one was served — it is still evidence, and a late notice on file is better than none.'
              : 'Written notice preserves the entitlement. Record it here as soon as it goes out.'}
          </p>

          {mayWrite ? (
            <ActionForm action={giveNotice.bind(null, id)} className="mt-3">
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label htmlFor="noticeGivenOn" className="mb-1 block text-xs text-(--color-muted)">
                    Notice served on
                  </label>
                  <input
                    id="noticeGivenOn"
                    name="noticeGivenOn"
                    type="date"
                    required
                    defaultValue={today}
                    className={field}
                  />
                </div>
                <div>
                  <label
                    htmlFor="noticeReference"
                    className="mb-1 block text-xs text-(--color-muted)"
                  >
                    Reference
                  </label>
                  <input id="noticeReference" name="noticeReference" className={field} />
                </div>
                <SubmitButton pendingLabel="Recording…">Record notice</SubmitButton>
              </div>
            </ActionForm>
          ) : null}
        </div>
      ) : null}

      {notice?.isGiven ? (
        <Card className="mb-6">
          <p className="text-sm font-medium">
            Notice given {date(variation.noticeGivenOn)}
            {notice.wasLate ? ' — after the deadline' : ''}
          </p>
          <p className="mt-1 text-sm text-(--color-muted)">
            {notice.wasLate
              ? `The deadline was ${date(notice.deadlineOn)}. The notice is on file; expect the entitlement to be argued.`
              : `Served within the ${contract?.noticePeriodDays}-day period. Entitlement preserved.`}
            {variation.noticeReference ? ` Reference ${variation.noticeReference}.` : ''}
          </p>
        </Card>
      ) : null}

      <div className="mb-6 grid gap-4 md:grid-cols-2">
        <Card title="Position">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat label="Quoted" value={<Money amount={quoted} currency={currency} />} />
            <Stat label="Approved" value={<Money amount={approved} currency={currency} />} />
            <Stat
              label="Settlement"
              value={<Money amount={settlement} currency={currency} />}
              tone={toneForVariance(settlement)}
              hint={settlement == null ? 'not yet agreed' : 'approved less quoted'}
            />
            <Stat
              label="Status"
              value={
                <Badge tone={isApproved ? 'good' : variation.status === 'rejected' ? 'bad' : 'neutral'}>
                  {variation.status}
                </Badge>
              }
            />
            <Stat label="Executed" value={`${num(variation.percentExecuted)}%`} />
            <Stat
              label="EOT"
              value={
                variation.eotGrantedDays != null
                  ? `${variation.eotGrantedDays} days`
                  : variation.eotClaimedDays != null
                    ? `${variation.eotClaimedDays} claimed`
                    : '—'
              }
            />
          </div>
        </Card>

        <Card title="Instruction">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-(--color-muted)">Reference</dt>
              <dd className="numeric">{variation.instructionReference ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-(--color-muted)">Instructed</dt>
              <dd>{date(variation.instructedOn)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-(--color-muted)">By</dt>
              <dd>{variation.instructedBy ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-(--color-muted)">Basis</dt>
              <dd>{variation.basis.replace(/_/g, ' ')}</dd>
            </div>
          </dl>
          {variation.description ? (
            <p className="mt-3 border-t border-(--color-line) pt-3 text-sm">
              {variation.description}
            </p>
          ) : null}
        </Card>
      </div>

      {!isSettled ? (
        <Card title="Record the client's decision" className="mb-6">
          <p className="mb-3 text-sm text-(--color-muted)">
            Approving is the only thing that moves the contract sum. Until then this work is
            exposure — instructed and built, with no agreement behind it.
          </p>

          {mayApprove ? (
            <ActionForm action={approve.bind(null, id)}>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <label htmlFor="approvedValue" className="mb-1 block text-xs text-(--color-muted)">
                    Approved value
                  </label>
                  <input
                    id="approvedValue"
                    name="approvedValue"
                    type="number"
                    step="any"
                    required
                    // Defaulted to what was quoted, because most are agreed as
                    // submitted and retyping the figure is how a digit is lost.
                    defaultValue={quoted ?? undefined}
                    className={field}
                  />
                </div>
                <div>
                  <label htmlFor="approvedOn" className="mb-1 block text-xs text-(--color-muted)">
                    Approved on
                  </label>
                  <input
                    id="approvedOn"
                    name="approvedOn"
                    type="date"
                    required
                    defaultValue={today}
                    className={field}
                  />
                </div>
                <div>
                  <label htmlFor="reference" className="mb-1 block text-xs text-(--color-muted)">
                    Client reference
                  </label>
                  <input id="reference" name="reference" className={field} />
                </div>
                <div>
                  <label
                    htmlFor="eotGrantedDays"
                    className="mb-1 block text-xs text-(--color-muted)"
                  >
                    EOT granted (days)
                  </label>
                  <input
                    id="eotGrantedDays"
                    name="eotGrantedDays"
                    type="number"
                    min={0}
                    className={field}
                  />
                </div>
              </div>
              <div className="mt-3">
                <SubmitButton tone="danger" pendingLabel="Approving…">
                  Record approval
                </SubmitButton>
              </div>
            </ActionForm>
          ) : (
            <p className="text-sm text-(--color-muted)">
              You do not have permission to record a variation approval.
            </p>
          )}
        </Card>
      ) : null}

      <Card title="Priced lines">
        {lines.length === 0 ? (
          <Empty
            title="No priced detail"
            detail="This variation carries a lump sum rather than measured lines."
          />
        ) : (
          <Table
            head={
              <tr>
                <Th>Description</Th>
                <Th numeric>Quantity</Th>
                <Th numeric>Rate</Th>
                <Th numeric>Value</Th>
              </tr>
            }
          >
            {lines.map((line) => (
              <tr key={line.id}>
                <Td>{line.description}</Td>
                <Td numeric>
                  {Number(line.quantity)}
                  {line.uomCode ? ` ${line.uomCode}` : ''}
                </Td>
                <Td numeric>{Number(line.unitRate)}</Td>
                <Td numeric>
                  <Money amount={num(line.lineValue)} currency={currency} />
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {contract ? (
        <p className="mt-4 text-sm">
          <Link href={`/contracts/${contract.id}`} className="text-(--color-accent) hover:underline">
            ← {contract.number ?? contract.name}
          </Link>
        </p>
      ) : null}
    </>
  );
}

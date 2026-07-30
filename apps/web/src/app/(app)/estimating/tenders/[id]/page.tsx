import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, Empty, Money, PageHeader, Table, Td, Th } from '@/components/ui';
import { can } from '@/lib/actions';
import { ApiError, pageFetch } from '@/lib/api';
import { date } from '@/lib/format';
import { getMe } from '@/lib/session';

import { recordBidDecisionAction, recordOutcomeAction } from './actions';

interface TenderEstimate {
  id: string;
  version: number;
  label: string;
  status: string;
  totalValue: string;
  isSubmitted: boolean;
}

interface TenderDetail {
  tender: {
    id: string;
    number: string | null;
    name: string;
    status: string;
    currencyCode: string | null;
    submissionDueAt: string | null;
    submittedAt: string | null;
    validityDays: number | null;
    bidDecision: string | null;
    bidDecisionReason: string | null;
    outcomeValue: string | null;
    winningValue: string | null;
    lostReason: string | null;
    notes: string | null;
  };
  clientName: string | null;
  consultantName: string | null;
  mainContractorName: string | null;
  estimates: TenderEstimate[];
}

const STATUS_TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  won: 'good',
  lost: 'bad',
  abandoned: 'bad',
  cancelled: 'bad',
};

const ESTIMATE_STATUS_TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  approved: 'good',
  superseded: 'neutral',
};

const field =
  'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1 text-sm outline-none focus:border-(--color-accent)';

/**
 * A tender, with the parties it actually involves.
 *
 * A client, a consultant and a main contractor are frequently three different
 * organisations — the survey found the detail endpoint returning only a
 * `clientPartyId` others could not read, the same gap closed for work orders
 * and estimates before this. All three are resolved here.
 *
 * Bid/no-bid and won/lost are DECISIONS, not status edits — each one asks for
 * the reason, because "why did we not bid the Marina job" is a question that
 * gets asked six months later, by someone who was not in the room.
 */
export default async function TenderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getMe();
  const mayDecide = can(me.permissions, 'estimation.tender.decide') || me.user.isOwner;

  let detail: TenderDetail;
  try {
    detail = await pageFetch<TenderDetail>(`/estimating/tenders/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) notFound();
    throw error;
  }

  const { tender } = detail;
  const currency = tender.currencyCode ?? me.tenant.currencyCode;
  // 'abandoned' and 'cancelled' are terminal in the other direction — a tender
  // that was no-bid or pulled never went out, so it cannot then be won or lost.
  const closed = ['won', 'lost', 'abandoned', 'cancelled'].includes(tender.status);
  const canDecideBid = mayDecide && !closed && !tender.bidDecision;
  const canRecordOutcome = mayDecide && !closed;

  return (
    <>
      <PageHeader
        title={tender.number ?? 'Unnumbered tender'}
        subtitle={[tender.name, detail.clientName].filter(Boolean).join(' · ')}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Link href="/estimating/tenders" className="text-(--color-accent) hover:underline">
          ← All tenders
        </Link>
        <Badge tone={STATUS_TONE[tender.status] ?? 'neutral'}>
          {tender.status.replace(/_/g, ' ')}
        </Badge>
        {tender.bidDecision === 'no_bid' ? <Badge tone="bad">no-bid</Badge> : null}
      </div>

      <Card title="Details" className="mb-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-(--color-muted)">Consultant</dt>
            <dd>{detail.consultantName ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-(--color-muted)">Main contractor</dt>
            <dd>{detail.mainContractorName ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-(--color-muted)">Submission</dt>
            <dd>
              {date(tender.submissionDueAt)}
              {tender.submittedAt ? (
                <span className="block text-xs text-(--color-muted)">
                  {`submitted ${date(tender.submittedAt)}`}
                </span>
              ) : null}
            </dd>
          </div>
          {tender.bidDecisionReason ? (
            <div className="col-span-2 sm:col-span-3">
              <dt className="text-xs text-(--color-muted)">
                {tender.bidDecision === 'no_bid' ? 'Why we did not bid' : 'Bid decision'}
              </dt>
              <dd>{tender.bidDecisionReason}</dd>
            </div>
          ) : null}
          {tender.status === 'won' || tender.status === 'lost' ? (
            <div className="col-span-2 sm:col-span-3">
              <dt className="text-xs text-(--color-muted)">Outcome</dt>
              <dd>
                <Money amount={tender.outcomeValue} currency={currency} />
                {tender.status === 'lost' && tender.winningValue ? (
                  <span className="ms-2 text-xs text-(--color-muted)">
                    {`won at `}
                    <Money amount={tender.winningValue} currency={currency} />
                  </span>
                ) : null}
                {tender.lostReason ? (
                  <span className="mt-0.5 block text-xs text-(--color-muted)">
                    {tender.lostReason}
                  </span>
                ) : null}
              </dd>
            </div>
          ) : null}
          {tender.notes ? (
            <div className="col-span-2 sm:col-span-3">
              <dt className="text-xs text-(--color-muted)">Notes</dt>
              <dd className="whitespace-pre-wrap">{tender.notes}</dd>
            </div>
          ) : null}
        </dl>
      </Card>

      {canDecideBid || canRecordOutcome ? (
        <div className="mb-4 grid gap-4 sm:grid-cols-2">
          {canDecideBid ? (
            <Card title="Bid or no-bid">
              <ActionForm action={recordBidDecisionAction} className="space-y-2">
                <input type="hidden" name="tenderId" value={tender.id} />
                <select name="decision" className={field} defaultValue="bid">
                  <option value="bid">Bid</option>
                  <option value="no_bid">No-bid</option>
                </select>
                <input name="reason" dir="auto" placeholder="Why…" className={field} />
                <SubmitButton pendingLabel="Recording…">Record decision</SubmitButton>
              </ActionForm>
            </Card>
          ) : null}

          {canRecordOutcome ? (
            <Card title="Won or lost">
              <ActionForm action={recordOutcomeAction} className="space-y-2">
                <input type="hidden" name="tenderId" value={tender.id} />
                <select name="outcome" className={field} defaultValue="won">
                  <option value="won">Won</option>
                  <option value="lost">Lost</option>
                </select>
                <input
                  name="outcomeValue"
                  className={field}
                  placeholder={`Value (optional, defaults to what was submitted)`}
                />
                <input
                  name="lostReason"
                  dir="auto"
                  className={field}
                  placeholder="Why, if lost (optional)"
                />
                <SubmitButton pendingLabel="Recording…">Record outcome</SubmitButton>
              </ActionForm>
            </Card>
          ) : null}
        </div>
      ) : null}

      <Card title="Estimates">
        {detail.estimates.length === 0 ? (
          <Empty
            title="Not priced yet"
            detail="An estimate prices this tender against the rate library."
          />
        ) : (
          <Table
            head={
              <tr>
                <Th>Version</Th>
                <Th>Status</Th>
                <Th numeric>Value</Th>
              </tr>
            }
          >
            {detail.estimates.map((est) => (
              <tr key={est.id}>
                <Td>
                  <Link
                    href={`/estimating/estimates/${est.id}`}
                    className="numeric text-(--color-accent) hover:underline"
                  >
                    {`v${est.version}`}
                  </Link>
                  <span className="ms-2 text-xs text-(--color-muted)">{est.label}</span>
                </Td>
                <Td>
                  <Badge tone={ESTIMATE_STATUS_TONE[est.status] ?? 'neutral'}>
                    {est.status.replace(/_/g, ' ')}
                  </Badge>
                  {est.isSubmitted ? (
                    <span className="ms-1">
                      <Badge tone="good">submitted</Badge>
                    </span>
                  ) : null}
                </Td>
                <Td numeric>
                  <Money amount={est.totalValue} currency={currency} />
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

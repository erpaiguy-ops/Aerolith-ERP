import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, Empty, PageHeader, Table, Td, Th } from '@/components/ui';
import { can, requiredText, runAction, type ActionState } from '@/lib/actions';
import { ApiError, pageFetch } from '@/lib/api';
import { date } from '@/lib/format';
import { getMe } from '@/lib/session';

interface SubmittalRevisionRow {
  id: string;
  revision: number;
  documentId: string | null;
  submittedOn: string;
  dueOn: string | null;
  reviewedOn: string | null;
  decision: string | null;
  reviewComments: string | null;
}

interface SubmittalDetail {
  id: string;
  contractId: string;
  contractNumber: string | null;
  contractName: string;
  number: string | null;
  title: string;
  submittalType: string;
  specSection: string | null;
  status: string;
  ballInCourt: string;
  currentRevision: number;
  revisions: SubmittalRevisionRow[];
}

const STATUS_TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  draft: 'neutral',
  under_review: 'neutral',
  approved: 'good',
  approved_as_noted: 'good',
  revise_resubmit: 'bad',
  rejected: 'bad',
};

const CLOSED_STATUSES = new Set(['approved', 'approved_as_noted']);

const field =
  'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-3 py-1.5 text-sm outline-none focus:border-(--color-accent)';

/**
 * Bound server actions, the same reasoning as every other detail screen this
 * session: `.bind(null, id)` fixes which submittal a plain form on this page
 * acts on, without a client component to hold the id in state.
 */
async function submitRevision(submittalId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  'use server';
  const submittedOn = requiredText(form, 'submittedOn');
  if (!submittedOn) return { status: 'error', error: 'Choose the date it was submitted.' };

  return runAction(
    () =>
      pageFetch(`/contracts/submittals/${submittalId}/revisions`, {
        method: 'POST',
        body: { submittedOn, dueOn: requiredText(form, 'dueOn') },
      }),
    {
      revalidate: [`/contracts/submittals/${submittalId}`, '/contracts/submittals'],
      success: 'Submitted for review.',
    },
  );
}

async function recordReview(submittalId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  'use server';
  const decision = form.get('decision');
  const reviewedOn = requiredText(form, 'reviewedOn');

  const decisions = new Set(['approved', 'approved_as_noted', 'revise_resubmit', 'rejected']);
  if (typeof decision !== 'string' || !decisions.has(decision)) {
    return { status: 'error', error: 'Choose a decision.' };
  }
  if (!reviewedOn) return { status: 'error', error: 'Choose the date it was reviewed.' };

  return runAction(
    () =>
      pageFetch(`/contracts/submittals/${submittalId}/review`, {
        method: 'POST',
        body: { decision, reviewedOn, reviewComments: requiredText(form, 'reviewComments') },
      }),
    {
      revalidate: [`/contracts/submittals/${submittalId}`, '/contracts/submittals'],
      success: 'Review recorded.',
    },
  );
}

export default async function SubmittalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const me = await getMe();
  const mayManage = can(me.permissions, 'contracts.submittal.manage') || me.user.isOwner;

  let detail: SubmittalDetail;
  try {
    detail = await pageFetch<SubmittalDetail>(`/contracts/submittals/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const isClosed = CLOSED_STATUSES.has(detail.status);
  const currentRevision = detail.revisions.find((r) => r.revision === detail.currentRevision);
  const awaitingReview = detail.status === 'under_review' && currentRevision?.decision == null;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Link href="/contracts/submittals" className="text-(--color-accent) hover:underline">
          ← Submittal register
        </Link>
        <Badge tone={STATUS_TONE[detail.status] ?? 'neutral'}>{detail.status.replace(/_/g, ' ')}</Badge>
      </div>

      <PageHeader
        title={`${detail.number ?? 'Submittal'} — ${detail.title}`}
        subtitle={[
          detail.submittalType.replace(/_/g, ' '),
          detail.specSection ? `spec ${detail.specSection}` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      />

      <Card className="mb-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <span className="mb-1 block text-xs text-(--color-muted)">Contract</span>
            <Link
              href={`/contracts/${detail.contractId}`}
              className="text-(--color-accent) hover:underline"
            >
              {detail.contractNumber ?? detail.contractName}
            </Link>
          </div>
          <div>
            <span className="mb-1 block text-xs text-(--color-muted)">Ball in court</span>
            <span>{detail.ballInCourt === 'consultant' ? 'Consultant' : 'Contractor'}</span>
          </div>
          <div>
            <span className="mb-1 block text-xs text-(--color-muted)">Current revision</span>
            <span className="numeric">{detail.currentRevision || '—'}</span>
          </div>
        </div>
      </Card>

      {mayManage && !isClosed ? (
        <Card title={awaitingReview ? 'Record the review decision' : 'Submit for review'} className="mb-6">
          {awaitingReview ? (
            <ActionForm action={recordReview.bind(null, detail.id)} className="grid gap-3 sm:grid-cols-4">
              <label className="block">
                <span className="mb-1 block text-xs text-(--color-muted)">Decision</span>
                <select name="decision" defaultValue="approved" className={field}>
                  <option value="approved">Approved</option>
                  <option value="approved_as_noted">Approved as noted</option>
                  <option value="revise_resubmit">Revise and resubmit</option>
                  <option value="rejected">Rejected</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-(--color-muted)">Reviewed on</span>
                <input
                  type="date"
                  name="reviewedOn"
                  defaultValue={new Date().toISOString().slice(0, 10)}
                  className={field}
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-xs text-(--color-muted)">Comments (optional)</span>
                <input name="reviewComments" dir="auto" className={field} />
              </label>
              <div className="sm:col-span-4">
                <SubmitButton pendingLabel="Recording…">Record decision</SubmitButton>
              </div>
            </ActionForm>
          ) : (
            <ActionForm action={submitRevision.bind(null, detail.id)} className="grid gap-3 sm:grid-cols-4">
              <label className="block">
                <span className="mb-1 block text-xs text-(--color-muted)">Submitted on</span>
                <input
                  type="date"
                  name="submittedOn"
                  defaultValue={new Date().toISOString().slice(0, 10)}
                  className={field}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-(--color-muted)">Due date (optional)</span>
                <input type="date" name="dueOn" className={field} />
              </label>
              <div className="sm:col-span-2 flex items-end">
                <SubmitButton pendingLabel="Submitting…">
                  {detail.currentRevision === 0 ? 'Submit for review' : 'Resubmit for review'}
                </SubmitButton>
              </div>
            </ActionForm>
          )}
        </Card>
      ) : null}

      <Card title="Revision history">
        {detail.revisions.length === 0 ? (
          <Empty title="Nothing submitted yet" detail="Submit the first revision above." />
        ) : (
          <Table
            head={
              <tr>
                <Th>Revision</Th>
                <Th>Submitted</Th>
                <Th>Due</Th>
                <Th>Reviewed</Th>
                <Th>Decision</Th>
                <Th>Comments</Th>
              </tr>
            }
          >
            {detail.revisions.map((row) => (
              <tr key={row.id}>
                <Td numeric>{row.revision}</Td>
                <Td>{date(row.submittedOn)}</Td>
                <Td>{date(row.dueOn)}</Td>
                <Td>{date(row.reviewedOn)}</Td>
                <Td>
                  {row.decision ? (
                    <Badge tone={STATUS_TONE[row.decision] ?? 'neutral'}>
                      {row.decision.replace(/_/g, ' ')}
                    </Badge>
                  ) : (
                    <span className="text-(--color-muted)">awaiting review</span>
                  )}
                </Td>
                <Td>{row.reviewComments ?? '—'}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

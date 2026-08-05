import Link from 'next/link';

import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, Empty, Money, PageHeader, Table, Td, Th } from '@/components/ui';
import { pageFetch } from '@/lib/api';
import { date, integer } from '@/lib/format';

import { recallAction } from '../actions';

interface SubmittedRequest {
  id: string;
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  moduleKey: string | null;
  state: string;
  amount: string | null;
  currencyCode: string | null;
  requestedAt: string;
  completedAt: string | null;
  dueAt: string | null;
  waitingOn: {
    approverId: string;
    approverName: string | null;
    stepName: string;
    isOverdue: boolean;
  }[];
}

const STATE_TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  approved: 'good',
  rejected: 'bad',
  cancelled: 'bad',
  recalled: 'neutral',
};

/**
 * What I have asked for, and where it has got to.
 *
 * The column that matters is "waiting on" — a requester whose purchase order has
 * sat for a week needs a name to go and chase, and an approval system that
 * cannot answer that question is one people route around with a phone call.
 */
export default async function SubmittedPage() {
  const { requests } = await pageFetch<{ requests: SubmittedRequest[] }>('/approvals/submitted');
  const open = requests.filter((request) => request.state === 'pending').length;

  return (
    <>
      <PageHeader
        title="I requested"
        subtitle={
          requests.length === 0
            ? 'You have not sent anything for approval.'
            : `${integer(open)} of ${integer(requests.length)} still open.`
        }
      />

      {requests.length === 0 ? (
        <Empty
          title="Nothing sent for approval"
          detail="Requests appear here when something you do needs somebody else's decision — issuing an order over your limit, releasing a held invoice, writing off stock."
        />
      ) : (
        <Card>
          <Table
            head={
              <tr>
                <Th>Request</Th>
                <Th>State</Th>
                <Th>Waiting on</Th>
                <Th numeric>Amount</Th>
                <Th>Sent</Th>
                <Th />
              </tr>
            }
          >
            {requests.map((request) => (
              <tr key={request.id} className="hover:bg-(--color-canvas)">
                <Td>
                  <Link
                    href={`/approvals/${request.id}`}
                    className="block text-(--color-accent) hover:underline"
                  >
                    {request.entityLabel ?? request.entityType.replace(/[._]/g, ' ')}
                  </Link>
                  {request.moduleKey ? (
                    <span className="text-xs text-(--color-muted)">{request.moduleKey}</span>
                  ) : null}
                </Td>
                <Td>
                  <Badge tone={STATE_TONE[request.state] ?? 'neutral'}>{request.state}</Badge>
                  {request.completedAt ? (
                    <span className="block text-xs text-(--color-muted)">
                      {date(request.completedAt)}
                    </span>
                  ) : null}
                </Td>
                <Td>
                  {request.waitingOn.length === 0 ? (
                    <span className="text-(--color-muted)">—</span>
                  ) : (
                    request.waitingOn.map((who) => (
                      <span key={`${who.approverId}-${who.stepName}`} className="block">
                        <span className={who.isOverdue ? 'text-(--color-bad)' : ''}>
                          {who.approverName ?? 'unassigned'}
                        </span>
                        <span className="block text-xs text-(--color-muted)">{who.stepName}</span>
                      </span>
                    ))
                  )}
                </Td>
                <Td numeric>
                  {request.amount ? (
                    <Money amount={request.amount} currency={request.currencyCode} />
                  ) : (
                    <span className="text-(--color-muted)">—</span>
                  )}
                </Td>
                <Td>{date(request.requestedAt)}</Td>
                <Td>
                  {/* Withdrawing is only offered while it is still open. A
                      recall button beside an already-approved request invites
                      somebody to try to undo a decision, which is not what
                      recall does and not something the engine allows. */}
                  {request.state === 'pending' ? (
                    <ActionForm action={recallAction} className="flex items-end gap-2">
                      <input type="hidden" name="instanceId" value={request.id} />
                      <input
                        type="text"
                        name="reason"
                        dir="auto"
                        placeholder="Reason…"
                        className="w-32 rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1 text-xs outline-none focus:border-(--color-accent)"
                      />
                      <SubmitButton pendingLabel="Withdrawing…">Withdraw</SubmitButton>
                    </ActionForm>
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </>
  );
}

import { notFound } from 'next/navigation';

import { Badge, Card, Money, PageHeader, Stat, Table, Td, Th } from '@/components/ui';
import { ApiError, pageFetch } from '@/lib/api';
import { date, integer } from '@/lib/format';

interface History {
  instance: {
    id: string;
    entityType: string;
    entityId: string;
    entityLabel: string | null;
    moduleKey: string | null;
    state: string;
    currentSequence: number;
    amount: string | null;
    currencyCode: string | null;
    requestedBy: string;
    requestedAt: string;
    completedAt: string | null;
    dueAt: string | null;
  };
  actions: {
    id: string;
    sequence: number;
    actorId: string;
    actorName: string | null;
    decision: string;
    comment: string | null;
    actedAt: string;
    delegatedTo: string | null;
  }[];
  tasks: {
    id: string;
    sequence: number;
    stepName: string;
    approverId: string;
    approverName: string | null;
    state: string;
    openedAt: string;
    dueAt: string | null;
    respondedAt: string | null;
    delegatedFrom: string | null;
  }[];
}

const STATE_TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  approved: 'good',
  rejected: 'bad',
  cancelled: 'bad',
  recalled: 'neutral',
};

/**
 * The decision trail for one request.
 *
 * This is the screen that makes an approval defensible a year later: who was
 * asked, in what order, what each of them said, and when. It is deliberately
 * append-only in appearance as well as in storage — nothing here offers to edit
 * a decision, because a recorded decision is evidence and correcting it is a new
 * decision, not an amendment.
 */
export default async function ApprovalHistoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let history: History;
  try {
    history = await pageFetch<History>(`/approvals/${id}/history`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) notFound();
    throw error;
  }

  const { instance, actions, tasks } = history;
  const decided = actions.length;

  return (
    <>
      <PageHeader
        title={instance.entityLabel ?? instance.entityType.replace(/[._]/g, ' ')}
        subtitle={`Requested ${date(instance.requestedAt)}${instance.moduleKey ? ` · ${instance.moduleKey}` : ''}`}
      />

      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          <Stat
            label="State"
            value={<Badge tone={STATE_TONE[instance.state] ?? 'neutral'}>{instance.state}</Badge>}
          />
          <Stat
            label="Amount"
            value={
              instance.amount ? (
                <Money amount={instance.amount} currency={instance.currencyCode} />
              ) : (
                '—'
              )
            }
          />
          <Stat
            label="Decisions taken"
            value={`${integer(decided)} of ${integer(tasks.length)}`}
            hint="Every approver asked, whether they have answered or not."
          />
          <Stat
            label="Completed"
            value={instance.completedAt ? date(instance.completedAt) : '—'}
            hint={instance.completedAt ? undefined : 'Still open.'}
          />
        </div>
      </Card>

      <Card title="Who was asked" className="mb-4">
        <Table
          head={
            <tr>
              <Th numeric>Step</Th>
              <Th>Approver</Th>
              <Th>State</Th>
              <Th>Opened</Th>
              <Th>Answered</Th>
            </tr>
          }
        >
          {tasks.map((task) => (
            <tr key={task.id}>
              <Td numeric>
                <span className="numeric">{integer(task.sequence)}</span>
              </Td>
              <Td>
                <span className="block">{task.approverName ?? 'unassigned'}</span>
                <span className="text-xs text-(--color-muted)">{task.stepName}</span>
                {task.delegatedFrom ? (
                  <span className="block text-xs text-(--color-warn)">acting under delegation</span>
                ) : null}
              </Td>
              <Td>
                <Badge
                  tone={
                    task.state === 'approved'
                      ? 'good'
                      : task.state === 'rejected'
                        ? 'bad'
                        : 'neutral'
                  }
                >
                  {task.state}
                </Badge>
              </Td>
              <Td>{date(task.openedAt)}</Td>
              <Td>
                {task.respondedAt ? (
                  date(task.respondedAt)
                ) : (
                  <span className="text-(--color-muted)">—</span>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card
        title="What they said"
        footnote="Append-only, in the database as well as on this screen. A decision is evidence; correcting one is a new decision, not an edit."
      >
        {actions.length === 0 ? (
          <p className="text-sm text-(--color-muted)">
            Nobody has decided yet.
          </p>
        ) : (
          <ol className="space-y-3">
            {actions.map((action) => (
              <li key={action.id} className="border-s-2 border-(--color-line) ps-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    tone={
                      action.decision === 'approved'
                        ? 'good'
                        : action.decision === 'rejected'
                          ? 'bad'
                          : 'neutral'
                    }
                  >
                    {action.decision}
                  </Badge>
                  <span className="text-sm font-medium">{action.actorName ?? 'unknown'}</span>
                  <span className="text-xs text-(--color-muted)">{date(action.actedAt)}</span>
                </div>
                {action.comment ? (
                  <p className="mt-1 text-sm">{action.comment}</p>
                ) : (
                  <p className="mt-1 text-sm text-(--color-muted)">No comment given.</p>
                )}
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}

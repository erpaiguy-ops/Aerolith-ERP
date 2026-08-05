import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, Empty, Money, PageHeader } from '@/components/ui';
import { pageFetch } from '@/lib/api';
import { date, integer } from '@/lib/format';

import { decideAction } from './actions';

interface InboxTask {
  taskId: string;
  stepName: string;
  openedAt: string;
  dueAt: string | null;
  isOverdue: boolean;
  delegatedFrom: string | null;
  request: {
    instanceId: string;
    entityType: string;
    entityId: string;
    entityLabel: string | null;
    moduleKey: string | null;
    amount: string | null;
    currencyCode: string | null;
    requestedBy: string;
    requestedByName: string | null;
    requestedAt: string;
  };
}

/**
 * The approval inbox.
 *
 * Deliberately NOT a paged register, and not a table. Every other list in this
 * app answers "find the one I am looking for"; this one answers "what is waiting
 * on me", which is a queue to be worked through and emptied — and each item
 * needs a decision taken on the spot rather than a link to somewhere else.
 *
 * It is also entirely generic. This file names no module and no document type:
 * the engine does not know what a purchase order is either, which is what lets a
 * module registered next year appear here without a line of UI being written.
 */
export default async function ApprovalInboxPage() {
  const { tasks } = await pageFetch<{ tasks: InboxTask[] }>('/approvals/inbox');
  const overdue = tasks.filter((task) => task.isOverdue).length;

  return (
    <>
      <PageHeader
        title="My inbox"
        subtitle={
          tasks.length === 0
            ? 'Nothing is waiting on you.'
            : `${integer(tasks.length)} decision${tasks.length === 1 ? '' : 's'} waiting on you.`
        }
      />

      {overdue > 0 ? (
        <p className="mb-4 rounded-md border border-(--color-bad)/40 bg-(--color-bad)/5 px-3 py-2 text-sm text-(--color-bad)">
          {`${integer(overdue)} ${overdue === 1 ? 'is' : 'are'} past the response time. Somebody is waiting on each of these to do their job.`}
        </p>
      ) : null}

      {tasks.length === 0 ? (
        <Empty
          title="Nothing waiting on you"
          detail="Requests appear here when a workflow routes one to you — or when somebody delegates their authority while they are away."
        />
      ) : (
        <div className="space-y-3">
          {tasks.map((task) => (
            <Card key={task.taskId}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {/* The label the requesting module supplied. The engine
                          stores it precisely so this screen never has to know
                          what an `inventory.stock_write_off` is. */}
                      {task.request.entityLabel ?? task.request.entityType.replace(/[._]/g, ' ')}
                    </span>
                    {task.request.moduleKey ? (
                      <Badge tone="neutral">{task.request.moduleKey}</Badge>
                    ) : null}
                    {task.isOverdue ? <Badge tone="bad">overdue</Badge> : null}
                  </div>

                  <p className="mt-1 text-sm text-(--color-muted)">
                    {[
                      `${task.stepName}`,
                      `requested by ${task.request.requestedByName ?? 'someone no longer listed'}`,
                      date(task.request.requestedAt),
                    ].join(' · ')}
                  </p>

                  {task.delegatedFrom ? (
                    // Deciding on somebody else's behalf is a different act from
                    // deciding on your own, and the trail records it that way.
                    <p className="mt-1 text-xs text-(--color-warn)">
                      Delegated to you. Your decision is recorded as acting for them.
                    </p>
                  ) : null}

                  {task.dueAt ? (
                    <p
                      className={`mt-1 text-xs ${task.isOverdue ? 'text-(--color-bad)' : 'text-(--color-muted)'}`}
                    >
                      {task.isOverdue ? 'Was due ' : 'Due '}
                      {date(task.dueAt)}
                    </p>
                  ) : null}
                </div>

                {task.request.amount ? (
                  <div className="text-end">
                    <div className="text-xs text-(--color-muted)">Amount</div>
                    <div className="numeric text-lg font-medium">
                      <Money amount={task.request.amount} currency={task.request.currencyCode} />
                    </div>
                  </div>
                ) : null}
              </div>

              {/* Approve and reject are separate forms, not one form with a
                  toggle. A single submit button whose meaning depends on a radio
                  the user set thirty seconds ago is how the wrong decision gets
                  recorded on a screen full of them. */}
              <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-(--color-line) pt-3">
                <ActionForm action={decideAction} className="flex flex-1 items-end gap-2">
                  <input type="hidden" name="taskId" value={task.taskId} />
                  <input type="hidden" name="decision" value="approved" />
                  <label className="flex-1">
                    <span className="mb-1 block text-xs text-(--color-muted)">
                      Comment (required to reject)
                    </span>
                    <input
                      type="text"
                      name="comment"
                      dir="auto"
                      placeholder="Optional when approving…"
                      className="w-full rounded-md border border-(--color-line) bg-(--color-surface) px-3 py-1.5 text-sm outline-none focus:border-(--color-accent)"
                    />
                  </label>
                  <SubmitButton pendingLabel="Approving…">Approve</SubmitButton>
                </ActionForm>

                <ActionForm action={decideAction}>
                  <input type="hidden" name="taskId" value={task.taskId} />
                  <input type="hidden" name="decision" value="rejected" />
                  {/* The reject form carries its own comment field. Sharing one
                      with the approve form would mean the browser posting an
                      empty string from whichever form was not filled in. */}
                  <label className="block">
                    <span className="mb-1 block text-xs text-(--color-muted)">Reason</span>
                    <input
                      type="text"
                      name="comment"
                      dir="auto"
                      placeholder="Why it cannot go ahead…"
                      className="w-56 rounded-md border border-(--color-line) bg-(--color-surface) px-3 py-1.5 text-sm outline-none focus:border-(--color-accent)"
                    />
                  </label>
                  <div className="mt-2">
                    <SubmitButton tone="danger" pendingLabel="Rejecting…">
                      Reject
                    </SubmitButton>
                  </div>
                </ActionForm>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

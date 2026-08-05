'use server';

import { apiFetch } from '@/lib/api';
import { runAction, requiredText, type ActionState } from '@/lib/actions';

/**
 * Deciding an approval.
 *
 * The authorisation is the task assignment itself — the engine checks that the
 * caller owns the task and that it has not already been decided — so there is no
 * permission to test here. That is deliberate in the engine and worth not
 * second-guessing in the UI: an approver's authority IS having been asked.
 */
export async function decideAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const taskId = form.get('taskId');
  const decision = form.get('decision');

  if (typeof taskId !== 'string' || (decision !== 'approved' && decision !== 'rejected')) {
    return { status: 'error', error: 'That decision could not be read. Reload and try again.' };
  }

  const comment = requiredText(form, 'comment');

  // Rejecting without saying why is how an approval queue becomes a mystery: the
  // requester gets a "no" and has to go and ask a human what to change. The
  // engine enforces a comment only where the workflow step demands one; this
  // asks for it on every rejection, which is a stricter rule and the right one.
  if (decision === 'rejected' && !comment) {
    return { status: 'error', error: 'Say why you are rejecting it. The requester has to act on this.' };
  }

  return runAction(
    () =>
      apiFetch(`/approvals/tasks/${taskId}/decide`, {
        method: 'POST',
        body: { decision, comment: comment ?? undefined },
      }),
    {
      revalidate: ['/approvals', '/approvals/submitted'],
      success: decision === 'approved' ? 'Approved.' : 'Rejected.',
    },
  );
}

/** Withdrawing a request of your own. */
export async function recallAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const instanceId = form.get('instanceId');
  if (typeof instanceId !== 'string') {
    return { status: 'error', error: 'That request could not be read. Reload and try again.' };
  }

  const reason = requiredText(form, 'reason');

  return runAction(
    () =>
      apiFetch(`/approvals/${instanceId}/recall`, {
        method: 'POST',
        body: { reason: reason ?? undefined },
      }),
    { revalidate: ['/approvals/submitted', '/approvals'], success: 'Withdrawn.' },
  );
}

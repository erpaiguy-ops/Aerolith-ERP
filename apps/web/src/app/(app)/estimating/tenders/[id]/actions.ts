'use server';

import { requiredText, runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

const REVALIDATE = (tenderId: string) => [`/estimating/tenders/${tenderId}`, '/estimating/tenders'];

export async function recordBidDecisionAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const tenderId = form.get('tenderId');
  const decision = form.get('decision');
  if (typeof tenderId !== 'string' || (decision !== 'bid' && decision !== 'no_bid')) {
    return { status: 'error', error: 'That tender could not be read. Reload and try again.' };
  }

  const reason = requiredText(form, 'reason');
  if (!reason) return { status: 'error', error: 'Say why — this is the record six months from now.' };

  return runAction(
    () =>
      apiFetch(`/estimating/tenders/${tenderId}/bid-decision`, {
        method: 'POST',
        body: { decision, reason },
      }),
    {
      revalidate: REVALIDATE(tenderId),
      success: decision === 'bid' ? 'Bidding. Moved to estimating.' : 'Recorded as no-bid.',
    },
  );
}

export async function recordOutcomeAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const tenderId = form.get('tenderId');
  const outcome = form.get('outcome');
  if (typeof tenderId !== 'string' || (outcome !== 'won' && outcome !== 'lost')) {
    return { status: 'error', error: 'That tender could not be read. Reload and try again.' };
  }

  const rawValue = form.get('outcomeValue');
  const outcomeValue =
    typeof rawValue === 'string' && rawValue.trim() !== '' ? Number(rawValue) : undefined;
  if (outcomeValue !== undefined && !Number.isFinite(outcomeValue)) {
    return { status: 'error', error: 'That value is not a number.' };
  }

  return runAction(
    () =>
      apiFetch(`/estimating/tenders/${tenderId}/outcome`, {
        method: 'POST',
        body: {
          outcome,
          outcomeValue,
          lostReason: outcome === 'lost' ? requiredText(form, 'lostReason') : undefined,
        },
      }),
    {
      revalidate: REVALIDATE(tenderId),
      success: outcome === 'won' ? 'Won. Ready to raise a work order.' : 'Recorded as lost.',
    },
  );
}

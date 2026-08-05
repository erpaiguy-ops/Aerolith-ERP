'use server';

import { requiredText, runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

/** Adds a party to the approved supplier list. Always starts `pending`. */
export async function qualifySupplierAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const partyId = requiredText(form, 'partyId');
  if (!partyId) {
    return { status: 'error', error: 'Choose which supplier to qualify.' };
  }

  return runAction(
    () =>
      apiFetch('/procurement/suppliers', {
        method: 'POST',
        body: {
          partyId,
          reason: requiredText(form, 'reason'),
          reviewDate: requiredText(form, 'reviewDate'),
        },
      }),
    { revalidate: ['/procurement/suppliers'], success: 'Added to the approved supplier list.' },
  );
}

/**
 * Approves or suspends a supplier already on the list.
 *
 * Mirrors `setBlockedAction` on the party detail page: suspending needs a
 * reason, checked here before the round trip, because the API's rejection is
 * the control and this is only the courtesy of not making the user wait for it.
 */
export async function setSupplierQualificationStatusAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const qualificationId = form.get('qualificationId');
  const status = form.get('status');
  if (typeof qualificationId !== 'string' || typeof status !== 'string') {
    return { status: 'error', error: 'That supplier could not be read. Reload and try again.' };
  }

  const reason = requiredText(form, 'reason');
  if (status === 'suspended' && !reason) {
    return {
      status: 'error',
      error: 'Say why — suspending stops procurement placing orders with them.',
    };
  }

  return runAction(
    () =>
      apiFetch(`/procurement/suppliers/${qualificationId}`, {
        method: 'PATCH',
        body: { status, reason: reason ?? undefined },
      }),
    {
      revalidate: ['/procurement/suppliers'],
      success: status === 'approved' ? 'Approved.' : 'Suspended.',
    },
  );
}

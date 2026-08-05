'use server';

import { runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

/**
 * One click, no confirmation — deliberately. Nothing is committed to a
 * supplier until an order is issued, so approving a requisition is reversible
 * in the sense that matters, and a confirmation dialogue on a routine
 * authorisation only trains people to click through dialogues.
 */
export async function approveRequisitionAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const requisitionId = form.get('requisitionId');
  if (typeof requisitionId !== 'string') {
    return { status: 'error', error: 'That requisition could not be read. Reload and try again.' };
  }

  return runAction(
    () => apiFetch(`/procurement/requisitions/${requisitionId}/approve`, { method: 'POST' }),
    {
      revalidate: [`/procurement/requisitions/${requisitionId}`, '/procurement/requisitions'],
      success: 'Approved.',
    },
  );
}

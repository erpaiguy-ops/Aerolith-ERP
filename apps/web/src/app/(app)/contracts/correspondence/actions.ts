'use server';

import { requiredText, runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

const TYPES = new Set(['rfi', 'notice', 'eot_claim', 'ncr', 'instruction', 'letter']);

export async function createCorrespondenceAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const contractId = requiredText(form, 'contractId');
  const type = form.get('type');
  const reference = requiredText(form, 'reference');
  const subject = requiredText(form, 'subject');
  const issuedOn = requiredText(form, 'issuedOn');

  if (!contractId) return { status: 'error', error: 'Choose which contract this is against.' };
  if (typeof type !== 'string' || !TYPES.has(type)) {
    return { status: 'error', error: 'Choose a type.' };
  }
  if (!reference) return { status: 'error', error: 'Give it a reference.' };
  if (!subject) return { status: 'error', error: 'Describe what it is about.' };
  if (!issuedOn) return { status: 'error', error: 'Choose the date it was issued.' };

  return runAction(
    () =>
      apiFetch(`/contracts/${contractId}/correspondence`, {
        method: 'POST',
        body: {
          type,
          reference,
          subject,
          issuedOn,
          responseDueOn: requiredText(form, 'responseDueOn'),
          isContractual: form.get('isContractual') === 'on',
        },
      }),
    { revalidate: ['/contracts/correspondence'], success: `${reference} raised.` },
  );
}

export async function respondCorrespondenceAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const correspondenceId = form.get('correspondenceId');
  const respondedOn = requiredText(form, 'respondedOn');

  if (typeof correspondenceId !== 'string') {
    return { status: 'error', error: 'That item could not be read. Reload and try again.' };
  }
  if (!respondedOn) return { status: 'error', error: 'Choose the date it was answered.' };

  return runAction(
    () =>
      apiFetch(`/contracts/correspondence/${correspondenceId}`, {
        method: 'PATCH',
        body: { respondedOn },
      }),
    { revalidate: ['/contracts/correspondence'], success: 'Response recorded.' },
  );
}

export async function closeCorrespondenceAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const correspondenceId = form.get('correspondenceId');

  if (typeof correspondenceId !== 'string') {
    return { status: 'error', error: 'That item could not be read. Reload and try again.' };
  }

  return runAction(
    () =>
      apiFetch(`/contracts/correspondence/${correspondenceId}`, {
        method: 'PATCH',
        body: { status: 'closed' },
      }),
    { revalidate: ['/contracts/correspondence'], success: 'Closed — no response needed.' },
  );
}

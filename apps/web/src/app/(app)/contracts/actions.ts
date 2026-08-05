'use server';

import { requiredText, runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

export async function createContractAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const name = requiredText(form, 'name');
  const countryCode = requiredText(form, 'countryCode');
  const originalSumRaw = form.get('originalSum');
  const originalSum = Number(originalSumRaw);

  if (!name) return { status: 'error', error: 'Give the contract a name.' };
  if (!countryCode) return { status: 'error', error: 'Choose the country whose rules apply.' };
  if (typeof originalSumRaw !== 'string' || originalSumRaw === '' || !Number.isFinite(originalSum) || originalSum < 0) {
    return { status: 'error', error: 'Enter the original contract sum.' };
  }

  return runAction(
    () =>
      apiFetch('/contracts', {
        method: 'POST',
        body: {
          name,
          side: form.get('side') || undefined,
          countryCode,
          originalSum,
          projectId: requiredText(form, 'projectId'),
          counterpartyId: requiredText(form, 'counterpartyId'),
          externalReference: requiredText(form, 'externalReference'),
          awardedOn: requiredText(form, 'awardedOn'),
        },
      }),
    {
      revalidate: ['/contracts'],
      // Retention, payment terms and DLP come from the country pack the
      // contract was just given — worth saying so, since none of them were
      // typed in and a user should know where they came from.
      success: `${name} created, on that country's contract terms. Activate it to start valuing it.`,
    },
  );
}

export async function activateContractAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const contractId = form.get('contractId');
  if (typeof contractId !== 'string') {
    return { status: 'error', error: 'That contract could not be read. Reload and try again.' };
  }

  return runAction(
    () =>
      apiFetch(`/contracts/${contractId}/activate`, {
        method: 'POST',
        body: { commencedOn: requiredText(form, 'commencedOn') },
      }),
    { revalidate: ['/contracts'], success: 'Activated. Variations and applications can now be raised.' },
  );
}

'use server';

import { requiredText, runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

const ROLE_KEYS = ['isCustomer', 'isSupplier', 'isSubcontractor', 'isConsultant', 'isEmployee'] as const;

export async function updatePartyAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const partyId = form.get('partyId');
  if (typeof partyId !== 'string') {
    return { status: 'error', error: 'That party could not be read. Reload and try again.' };
  }

  const roles = Object.fromEntries(ROLE_KEYS.map((key) => [key, form.get(key) === 'true']));

  return runAction(
    () =>
      apiFetch(`/master-data/parties/${partyId}`, {
        method: 'PATCH',
        body: {
          name: requiredText(form, 'name') ?? undefined,
          countryCode: requiredText(form, 'countryCode'),
          email: requiredText(form, 'email'),
          phone: requiredText(form, 'phone'),
          website: requiredText(form, 'website'),
          taxRegistrationNumber: requiredText(form, 'taxRegistrationNumber'),
          ...roles,
        },
      }),
    { revalidate: [`/master-data/parties/${partyId}`], success: 'Saved.' },
  );
}

export async function setBlockedAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const partyId = form.get('partyId');
  const isBlocked = form.get('isBlocked') === 'true';
  if (typeof partyId !== 'string') {
    return { status: 'error', error: 'That party could not be read. Reload and try again.' };
  }

  const blockReason = requiredText(form, 'blockReason');
  if (isBlocked && !blockReason) {
    return { status: 'error', error: 'Say why — blocking stops every module trading with them.' };
  }

  return runAction(
    () =>
      apiFetch(`/master-data/parties/${partyId}`, {
        method: 'PATCH',
        body: { isBlocked, blockReason: blockReason ?? undefined },
      }),
    {
      revalidate: [`/master-data/parties/${partyId}`],
      success: isBlocked ? 'Blocked.' : 'Unblocked.',
    },
  );
}

export async function addContactAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const partyId = form.get('partyId');
  const name = requiredText(form, 'name');
  if (typeof partyId !== 'string') {
    return { status: 'error', error: 'That party could not be read. Reload and try again.' };
  }
  if (!name) return { status: 'error', error: 'A contact needs a name.' };

  return runAction(
    () =>
      apiFetch(`/master-data/parties/${partyId}/contacts`, {
        method: 'POST',
        body: {
          name,
          jobTitle: requiredText(form, 'jobTitle'),
          email: requiredText(form, 'email'),
          phone: requiredText(form, 'phone'),
          isPrimary: form.get('isPrimary') === 'true',
        },
      }),
    { revalidate: [`/master-data/parties/${partyId}`], success: `${name} added.` },
  );
}

export async function removeContactAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const partyId = form.get('partyId');
  const contactId = form.get('contactId');
  if (typeof partyId !== 'string' || typeof contactId !== 'string') {
    return { status: 'error', error: 'That contact could not be read. Reload and try again.' };
  }

  return runAction(
    () =>
      apiFetch(`/master-data/parties/${partyId}/contacts/${contactId}/remove`, {
        method: 'POST',
      }),
    { revalidate: [`/master-data/parties/${partyId}`], success: 'Removed.' },
  );
}

export async function saveCustomFieldsAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const partyId = form.get('partyId');
  if (typeof partyId !== 'string') {
    return { status: 'error', error: 'That party could not be read. Reload and try again.' };
  }

  const values: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (key === 'partyId' || typeof value !== 'string') continue;
    values[key] = value;
  }

  return runAction(
    () => apiFetch(`/master-data/parties/${partyId}/custom-fields`, { method: 'PATCH', body: values }),
    { revalidate: [`/master-data/parties/${partyId}`], success: 'Custom fields saved.' },
  );
}

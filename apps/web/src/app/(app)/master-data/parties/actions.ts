'use server';

import { requiredText, runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

const ROLE_KEYS = ['isCustomer', 'isSupplier', 'isSubcontractor', 'isConsultant', 'isEmployee'] as const;

export async function createPartyAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const code = requiredText(form, 'code');
  const name = requiredText(form, 'name');
  if (!code || !name) {
    return { status: 'error', error: 'A party needs a code and a name.' };
  }

  const roles = Object.fromEntries(ROLE_KEYS.map((key) => [key, form.get(key) === 'true']));

  return runAction(
    () =>
      apiFetch('/master-data/parties', {
        method: 'POST',
        body: {
          code,
          name,
          countryCode: requiredText(form, 'countryCode'),
          email: requiredText(form, 'email'),
          ...roles,
        },
      }),
    { revalidate: ['/master-data/parties'], success: `"${name}" added.` },
  );
}

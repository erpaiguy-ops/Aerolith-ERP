'use server';

import { requiredText, runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

const ROLE_KEYS = ['isCustomer', 'isSupplier', 'isSubcontractor', 'isConsultant', 'isEmployee'] as const;

export async function createPartyAction(_state: ActionState, form: FormData): Promise<ActionState> {
  // The code field is only rendered for somebody allowed to choose one, and is
  // optional even then — so a missing or blank value is the normal case, not a
  // validation failure. It has to be OMITTED rather than sent as `''`: the API
  // distinguishes "no code, allocate one" from "this code", and refuses a
  // supplied code from a caller without permission. Sending an empty string
  // would turn every ordinary create into a 403.
  const code = requiredText(form, 'code');
  const name = requiredText(form, 'name');
  if (!name) {
    return { status: 'error', error: 'A party needs a name.' };
  }

  const roles = Object.fromEntries(ROLE_KEYS.map((key) => [key, form.get(key) === 'true']));

  return runAction(
    () =>
      apiFetch('/master-data/parties', {
        method: 'POST',
        body: {
          ...(code ? { code } : {}),
          name,
          countryCode: requiredText(form, 'countryCode'),
          email: requiredText(form, 'email'),
          ...roles,
        },
      }),
    { revalidate: ['/master-data/parties'], success: `"${name}" added.` },
  );
}

'use server';

import { requiredText, runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

/**
 * Adopting a country.
 *
 * This is the one action in the application that writes a whole configuration
 * rather than a record: the country's requirements, tax codes and holidays are
 * COPIED into the tenant's own tables so they can be edited without touching
 * anyone else's. That is the "country specifics are data, not code" claim made
 * operable — until this runs, the tenant has no requirement set, no tax codes,
 * and `/localisation/rules` answers 409.
 *
 * `refresh` re-copies from an updated country pack. It is offered separately and
 * described plainly, because it can overwrite edits: a tenant that has tuned its
 * own requirement set should know that before pressing it, not afterwards.
 */
export async function adoptCountryAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const countryCode = requiredText(form, 'countryCode');
  if (!countryCode || countryCode.length !== 2) {
    return { status: 'error', error: 'Choose a country.' };
  }

  const refresh = form.get('refresh') === 'true';

  return runAction(
    () =>
      apiFetch('/localisation/adopt', {
        method: 'POST',
        body: {
          countryCode,
          isPrimary: true,
          refresh,
          // Only sent when the admin actually typed something. An empty string
          // here would overwrite the country pack's default with nothing, which
          // is a worse outcome than leaving the field alone.
          overrides: {
            ...(requiredText(form, 'currencyCode')
              ? { currencyCode: requiredText(form, 'currencyCode')!.toUpperCase() }
              : {}),
            ...(requiredText(form, 'timezone') ? { timezone: requiredText(form, 'timezone')! } : {}),
            ...(requiredText(form, 'taxRegistrationNumber')
              ? { taxRegistrationNumber: requiredText(form, 'taxRegistrationNumber')! }
              : {}),
          },
        },
      }),
    {
      // The whole shell changes: navigation, currency, formatting. Everything
      // that reads `/me` has to be refetched, and `/` is the layout's own path.
      revalidate: ['/settings', '/settings/rules', '/'],
      success: refresh
        ? 'Refreshed from the country pack.'
        : 'Adopted. Requirements, tax codes and holidays are now yours to edit.',
    },
  );
}

/**
 * Overriding one rule for this tenant.
 *
 * The value arrives as a string from a text input and has to become whatever the
 * rule's declared type says it is — the API validates against a JSON Schema
 * fragment and will refuse a mismatch, but "expected number, received string"
 * is a message about our form, not about the admin's decision.
 */
export async function overrideRuleAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const key = form.get('key');
  const valueType = form.get('valueType');
  if (typeof key !== 'string' || typeof valueType !== 'string') {
    return { status: 'error', error: 'That rule could not be read. Reload and try again.' };
  }

  const raw = requiredText(form, 'value');
  if (raw === null) {
    return { status: 'error', error: 'Enter a value.' };
  }

  let value: unknown;
  switch (valueType) {
    case 'number':
    case 'percent':
    case 'money':
      value = Number(raw);
      if (!Number.isFinite(value as number)) {
        return { status: 'error', error: `“${raw}” is not a number.` };
      }
      break;
    case 'boolean':
      // Not `Boolean(raw)`: every non-empty string is truthy, so "false" would
      // set the rule to true.
      if (raw !== 'true' && raw !== 'false') {
        return { status: 'error', error: 'Choose true or false.' };
      }
      value = raw === 'true';
      break;
    case 'json':
    case 'list':
      try {
        value = JSON.parse(raw);
      } catch {
        return { status: 'error', error: 'That is not valid JSON.' };
      }
      break;
    default:
      value = raw;
  }

  return runAction(
    () =>
      apiFetch(`/localisation/rules/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: { value, reason: requiredText(form, 'reason') ?? undefined },
      }),
    { revalidate: ['/settings/rules'], success: 'Saved. This rule is now yours.' },
  );
}

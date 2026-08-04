'use server';

import { requiredText, runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

/**
 * A number field that may legitimately be left alone.
 *
 * Returns undefined for an empty box so the PATCH omits the key entirely
 * rather than sending null — the API treats an absent field as "unchanged"
 * and a present one as "set to this", and a blank padding box means the
 * former.
 */
function optionalInteger(form: FormData, field: string): number | undefined {
  const raw = form.get(field);
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

export async function updateSeriesShapeAction(
  seriesId: string,
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const name = requiredText(form, 'name');
  const pattern = requiredText(form, 'pattern');

  if (!name) return { status: 'error', error: 'A series needs a name.' };
  if (!pattern) return { status: 'error', error: 'A series needs a pattern.' };
  // Checked here as well as in the API, so the round trip is not how somebody
  // learns the one rule a pattern has.
  if (!pattern.includes('{SEQ}')) {
    return { status: 'error', error: 'The pattern must contain {SEQ}, or every document numbers the same.' };
  }

  return runAction(
    () =>
      apiFetch(`/admin/number-series/${seriesId}`, {
        method: 'PATCH',
        body: {
          name,
          pattern,
          prefix: requiredText(form, 'prefix'),
          suffix: requiredText(form, 'suffix'),
          padding: optionalInteger(form, 'padding'),
        },
      }),
    { revalidate: ['/settings/number-series'], success: `${name} updated.` },
  );
}

export async function setNextValueAction(
  seriesId: string,
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const nextValue = optionalInteger(form, 'nextValue');
  if (nextValue === undefined || nextValue < 1) {
    return { status: 'error', error: 'Give the next number to issue.' };
  }

  return runAction(
    () => apiFetch(`/admin/number-series/${seriesId}`, { method: 'PATCH', body: { nextValue } }),
    { revalidate: ['/settings/number-series'], success: `Next number set to ${nextValue}.` },
  );
}

export async function setSeriesActiveAction(
  seriesId: string,
  isActive: boolean,
  _state: ActionState,
  _form: FormData,
): Promise<ActionState> {
  return runAction(
    () => apiFetch(`/admin/number-series/${seriesId}`, { method: 'PATCH', body: { isActive } }),
    {
      revalidate: ['/settings/number-series'],
      success: isActive ? 'Series reactivated.' : 'Series retired.',
    },
  );
}

export async function makeGaplessAction(
  seriesId: string,
  _state: ActionState,
  _form: FormData,
): Promise<ActionState> {
  return runAction(
    () => apiFetch(`/admin/number-series/${seriesId}`, { method: 'PATCH', body: { isGapless: true } }),
    {
      revalidate: ['/settings/number-series'],
      // Said plainly because it cannot be undone — the API refuses to narrow
      // a gapless series back, and a one-way door should read like one.
      success: 'Series is now gapless. This cannot be reversed.',
    },
  );
}

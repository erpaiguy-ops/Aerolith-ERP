'use server';

import { requiredText, runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

const numberOrUndefined = (form: FormData, field: string): number | undefined => {
  const raw = requiredText(form, field);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
};

export async function updateItemAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const itemId = form.get('itemId');
  if (typeof itemId !== 'string') {
    return { status: 'error', error: 'That item could not be read. Reload and try again.' };
  }

  return runAction(
    () =>
      apiFetch(`/inventory/items/${itemId}`, {
        method: 'PATCH',
        body: {
          name: requiredText(form, 'name') ?? undefined,
          nativeName: requiredText(form, 'nativeName'),
          description: requiredText(form, 'description'),
          lengthMm: numberOrUndefined(form, 'lengthMm') ?? null,
          widthMm: numberOrUndefined(form, 'widthMm') ?? null,
          thicknessMm: numberOrUndefined(form, 'thicknessMm') ?? null,
          hasGrainDirection: form.get('hasGrainDirection') === 'true',
          finishCode: requiredText(form, 'finishCode'),
          colourCode: requiredText(form, 'colourCode'),
          barcode: requiredText(form, 'barcode'),
          standardCost: numberOrUndefined(form, 'standardCost') ?? null,
          wastagePercent: numberOrUndefined(form, 'wastagePercent'),
          isStocked: form.get('isStocked') === 'true',
          isBatchTracked: form.get('isBatchTracked') === 'true',
          isSerialTracked: form.get('isSerialTracked') === 'true',
          isActive: form.get('isActive') === 'true',
        },
      }),
    { revalidate: [`/inventory/items/${itemId}`], success: 'Saved.' },
  );
}

export async function saveItemCustomFieldsAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const itemId = form.get('itemId');
  if (typeof itemId !== 'string') {
    return { status: 'error', error: 'That item could not be read. Reload and try again.' };
  }

  const values: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (key === 'itemId' || typeof value !== 'string') continue;
    values[key] = value;
  }

  return runAction(
    () => apiFetch(`/inventory/items/${itemId}/custom-fields`, { method: 'PATCH', body: values }),
    { revalidate: [`/inventory/items/${itemId}`], success: 'Custom fields saved.' },
  );
}

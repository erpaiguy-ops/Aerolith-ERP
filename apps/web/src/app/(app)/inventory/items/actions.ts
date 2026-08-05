'use server';

import { requiredText, runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

const ITEM_TYPES = new Set([
  'raw_material',
  'panel',
  'hardware',
  'consumable',
  'finished_good',
  'sub_assembly',
  'service',
  'asset',
]);

export async function createItemAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const code = requiredText(form, 'code');
  const name = requiredText(form, 'name');
  const type = form.get('type');
  if (!code || !name) {
    return { status: 'error', error: 'An item needs a code and a name.' };
  }
  if (typeof type !== 'string' || !ITEM_TYPES.has(type)) {
    return { status: 'error', error: 'Choose what kind of item this is.' };
  }

  const lengthMm = requiredText(form, 'lengthMm');
  const widthMm = requiredText(form, 'widthMm');
  const thicknessMm = requiredText(form, 'thicknessMm');

  return runAction(
    () =>
      apiFetch('/inventory/items', {
        method: 'POST',
        body: {
          code,
          name,
          type,
          lengthMm: lengthMm === null ? undefined : Number(lengthMm),
          widthMm: widthMm === null ? undefined : Number(widthMm),
          thicknessMm: thicknessMm === null ? undefined : Number(thicknessMm),
          colourCode: requiredText(form, 'colourCode'),
        },
      }),
    { revalidate: ['/inventory/items'], success: `"${name}" added.` },
  );
}

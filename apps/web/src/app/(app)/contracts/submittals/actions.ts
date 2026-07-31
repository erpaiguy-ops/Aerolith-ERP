'use server';

import { requiredText, runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

const TYPES = new Set([
  'shop_drawing',
  'material_sample',
  'method_statement',
  'product_data',
  'mock_up',
  'other',
]);

export async function createSubmittalAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const contractId = requiredText(form, 'contractId');
  const title = requiredText(form, 'title');
  const submittalType = form.get('submittalType');

  if (!contractId) return { status: 'error', error: 'Choose which contract this is against.' };
  if (!title) return { status: 'error', error: 'Describe what is being submitted.' };
  if (typeof submittalType !== 'string' || !TYPES.has(submittalType)) {
    return { status: 'error', error: 'Choose a submittal type.' };
  }

  return runAction(
    () =>
      apiFetch(`/contracts/${contractId}/submittals`, {
        method: 'POST',
        body: { title, submittalType, specSection: requiredText(form, 'specSection') },
      }),
    { revalidate: ['/contracts/submittals'], success: `${title} raised.` },
  );
}

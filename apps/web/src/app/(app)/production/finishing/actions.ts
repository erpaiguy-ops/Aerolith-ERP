'use server';

import { requiredText, runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

function numberOrUndefined(form: FormData, field: string): number | undefined {
  const raw = requiredText(form, field);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export async function createFinishingBatchAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const workCentreId = requiredText(form, 'workCentreId');
  const partId = requiredText(form, 'partId');
  const quantity = numberOrUndefined(form, 'quantity');
  if (!workCentreId || !partId || !quantity) {
    return { status: 'error', error: 'A load needs a booth, a part and a quantity.' };
  }

  return runAction(
    () =>
      apiFetch('/production/finishing', {
        method: 'POST',
        body: {
          workCentreId,
          colourCode: requiredText(form, 'colourCode'),
          sheenCode: requiredText(form, 'sheenCode'),
          coatNumber: numberOrUndefined(form, 'coatNumber'),
          totalCoats: numberOrUndefined(form, 'totalCoats'),
          cureMinutes: numberOrUndefined(form, 'cureMinutes'),
          parts: [{ partId, quantity, isRework: form.get('isRework') === 'true' }],
        },
      }),
    { revalidate: ['/production/finishing'], success: 'Load queued.' },
  );
}

export async function setFinishingBatchStatusAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const batchId = form.get('batchId');
  const status = form.get('status');
  if (typeof batchId !== 'string' || typeof status !== 'string') {
    return { status: 'error', error: 'That batch could not be read. Reload and try again.' };
  }

  return runAction(
    () => apiFetch(`/production/finishing/${batchId}/status`, { method: 'POST', body: { status } }),
    { revalidate: ['/production/finishing'], success: `Batch marked ${status}.` },
  );
}

'use server';

import { requiredText, runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

export async function createStockCountAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const warehouseId = requiredText(form, 'warehouseId');
  if (!warehouseId) return { status: 'error', error: 'Choose which warehouse this counts.' };

  return runAction(
    () =>
      apiFetch('/inventory/counts', {
        method: 'POST',
        body: {
          warehouseId,
          countDate: requiredText(form, 'countDate'),
        },
      }),
    { revalidate: ['/inventory/counts'], success: 'Count raised. Generate the sheet to start counting.' },
  );
}

export async function generateCountSheetAction(
  countId: string,
  _state: ActionState,
  _form: FormData,
): Promise<ActionState> {
  return runAction(
    () => apiFetch(`/inventory/counts/${countId}/generate`, { method: 'POST' }),
    {
      revalidate: [`/inventory/counts/${countId}`, '/inventory/counts'],
      success: 'Count sheet generated — the book quantity is frozen per line.',
    },
  );
}

export async function recordCountLineAction(
  countId: string,
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const countLineId = form.get('countLineId');
  const rawQuantity = form.get('countedQuantity');

  if (typeof countLineId !== 'string') {
    return { status: 'error', error: 'That line could not be read. Reload and try again.' };
  }
  const countedQuantity = Number(rawQuantity);
  if (typeof rawQuantity !== 'string' || rawQuantity === '' || !Number.isFinite(countedQuantity) || countedQuantity < 0) {
    return { status: 'error', error: 'Enter what was actually counted, zero if the shelf is empty.' };
  }

  return runAction(
    () =>
      apiFetch(`/inventory/counts/lines/${countLineId}`, {
        method: 'PATCH',
        body: { countedQuantity, varianceReason: requiredText(form, 'varianceReason') },
      }),
    { revalidate: [`/inventory/counts/${countId}`], success: 'Recorded.' },
  );
}

export async function reconcileStockCountAction(
  countId: string,
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  return runAction(
    () =>
      apiFetch(`/inventory/counts/${countId}/reconcile`, {
        method: 'POST',
        body: { notes: requiredText(form, 'notes') },
      }),
    {
      revalidate: [`/inventory/counts/${countId}`, '/inventory/counts', '/inventory/stock', '/inventory/movements'],
      success: 'Reconciled. The variance is now on the ledger.',
    },
  );
}

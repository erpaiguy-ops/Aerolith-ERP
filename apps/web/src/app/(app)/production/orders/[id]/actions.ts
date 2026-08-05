'use server';

import { runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

/** Releasing to the floor is the one write this screen offers — scans come from the shop floor, not this screen. */
export async function releaseWorkOrderAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const workOrderId = form.get('workOrderId');
  if (typeof workOrderId !== 'string') {
    return { status: 'error', error: 'That work order could not be read. Reload and try again.' };
  }

  return runAction(
    () => apiFetch(`/production/work-orders/${workOrderId}/release`, { method: 'POST' }),
    {
      revalidate: [`/production/orders/${workOrderId}`, '/production/orders', '/production/board'],
      success: 'Released to the shop floor.',
    },
  );
}

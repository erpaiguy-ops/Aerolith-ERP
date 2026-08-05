'use server';

import { runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

/**
 * Marking one notification read.
 *
 * No permission to check, same reasoning as deciding an approval: a
 * notification is addressed to the signed-in user specifically, and the API
 * scopes the update to `recipientId` itself rather than trusting a role.
 */
export async function markReadAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const notificationId = form.get('notificationId');
  if (typeof notificationId !== 'string') {
    return { status: 'error', error: 'That notification could not be read. Reload and try again.' };
  }

  return runAction(
    () => apiFetch(`/notifications/${notificationId}/read`, { method: 'POST' }),
    { revalidate: ['/notifications'], success: 'Marked read.' },
  );
}

export async function markAllReadAction(
  _state: ActionState,
  _form: FormData,
): Promise<ActionState> {
  return runAction(() => apiFetch('/notifications/read-all', { method: 'POST' }), {
    revalidate: ['/notifications'],
    success: 'Everything is marked read.',
  });
}

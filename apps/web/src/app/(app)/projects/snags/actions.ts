'use server';

import { requiredText, runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

const SEVERITIES = new Set(['minor', 'major', 'critical']);
const CLOSE_STATUSES = new Set(['closed', 'rejected']);

export async function createSnagAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const projectId = requiredText(form, 'projectId');
  const description = requiredText(form, 'description');
  const severity = form.get('severity');

  if (!projectId) {
    return { status: 'error', error: 'Choose which project this snag is against.' };
  }
  if (!description) {
    return { status: 'error', error: 'Describe the defect.' };
  }
  if (typeof severity !== 'string' || !SEVERITIES.has(severity)) {
    return { status: 'error', error: 'Choose a severity.' };
  }

  return runAction(
    () =>
      apiFetch('/projects/snags', {
        method: 'POST',
        body: {
          projectId,
          description,
          severity,
          location: requiredText(form, 'location'),
          targetDate: requiredText(form, 'targetDate'),
        },
      }),
    { revalidate: ['/projects/snags'], success: 'Snag raised.' },
  );
}

export async function closeSnagAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const snagId = form.get('snagId');
  const closedBy = form.get('closedBy');
  const status = form.get('status');

  if (typeof snagId !== 'string' || typeof closedBy !== 'string') {
    return { status: 'error', error: 'That snag could not be read. Reload and try again.' };
  }
  if (typeof status !== 'string' || !CLOSE_STATUSES.has(status)) {
    return { status: 'error', error: 'Choose whether the snag is closed or rejected.' };
  }

  return runAction(
    () =>
      apiFetch(`/projects/snags/${snagId}/close`, {
        method: 'POST',
        body: { closedBy, status },
      }),
    {
      revalidate: ['/projects/snags'],
      success: status === 'closed' ? 'Snag closed.' : 'Snag rejected.',
    },
  );
}

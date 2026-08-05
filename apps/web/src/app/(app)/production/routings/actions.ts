'use server';

import { requiredText, runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

function numberOrUndefined(form: FormData, field: string): number | undefined {
  const raw = requiredText(form, field);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export async function createRoutingAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const code = requiredText(form, 'code');
  const name = requiredText(form, 'name');
  if (!code || !name) {
    return { status: 'error', error: 'A routing needs a code and a name.' };
  }

  return runAction(
    () =>
      apiFetch('/production/routings', {
        method: 'POST',
        body: {
          code,
          name,
          description: requiredText(form, 'description'),
          isDefault: form.get('isDefault') === 'true',
        },
      }),
    { revalidate: ['/production/routings'], success: `"${code}" added.` },
  );
}

export async function createWorkCentreAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const code = requiredText(form, 'code');
  const name = requiredText(form, 'name');
  const type = form.get('type');
  if (!code || !name) {
    return { status: 'error', error: 'A work centre needs a code and a name.' };
  }
  if (typeof type !== 'string' || type === '') {
    return { status: 'error', error: 'Choose what kind of station this is.' };
  }

  return runAction(
    () =>
      apiFetch('/production/work-centres', {
        method: 'POST',
        body: {
          code,
          name,
          type,
          setupMinutes: numberOrUndefined(form, 'setupMinutes'),
          runMinutesPerUnit: numberOrUndefined(form, 'runMinutesPerUnit'),
          costPerHour: numberOrUndefined(form, 'costPerHour'),
          capacityUnits: numberOrUndefined(form, 'capacityUnits'),
          isBatchProcess: form.get('isBatchProcess') === 'true',
          batchCapacityUnits: numberOrUndefined(form, 'batchCapacityUnits'),
        },
      }),
    { revalidate: ['/production/routings'], success: `"${code}" added.` },
  );
}

export async function setWorkCentreActiveAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const workCentreId = form.get('workCentreId');
  const isActive = form.get('isActive');
  if (typeof workCentreId !== 'string') {
    return { status: 'error', error: 'That work centre could not be read. Reload and try again.' };
  }

  return runAction(
    () =>
      apiFetch(`/production/work-centres/${workCentreId}`, {
        method: 'PATCH',
        body: { isActive: isActive === 'true' },
      }),
    {
      revalidate: ['/production/routings'],
      success: isActive === 'true' ? 'Work centre reactivated.' : 'Work centre retired.',
    },
  );
}

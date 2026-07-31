'use server';

import { requiredText, runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

function numberOrUndefined(form: FormData, field: string): number | undefined {
  const raw = requiredText(form, field);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export async function updateRoutingAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const routingId = form.get('routingId');
  if (typeof routingId !== 'string') {
    return { status: 'error', error: 'That routing could not be read. Reload and try again.' };
  }

  return runAction(
    () =>
      apiFetch(`/production/routings/${routingId}`, {
        method: 'PATCH',
        body: {
          name: requiredText(form, 'name') ?? undefined,
          description: requiredText(form, 'description'),
          isDefault: form.get('isDefault') === 'true',
          isActive: form.get('isActive') === 'true',
        },
      }),
    { revalidate: [`/production/routings/${routingId}`], success: 'Saved.' },
  );
}

export async function addOperationAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const routingId = form.get('routingId');
  if (typeof routingId !== 'string') {
    return { status: 'error', error: 'That routing could not be read. Reload and try again.' };
  }

  const sequence = numberOrUndefined(form, 'sequence');
  const name = requiredText(form, 'name');
  const workCentreId = requiredText(form, 'workCentreId');
  if (sequence == null || !name || !workCentreId) {
    return { status: 'error', error: 'An operation needs a sequence, a name and a work centre.' };
  }

  return runAction(
    () =>
      apiFetch(`/production/routings/${routingId}/operations`, {
        method: 'POST',
        body: {
          sequence,
          name,
          workCentreId,
          setupMinutes: numberOrUndefined(form, 'setupMinutes'),
          runMinutesPerUnit: numberOrUndefined(form, 'runMinutesPerUnit'),
          cureMinutes: numberOrUndefined(form, 'cureMinutes'),
          isQualityGate: form.get('isQualityGate') === 'true',
          instructions: requiredText(form, 'instructions'),
        },
      }),
    { revalidate: [`/production/routings/${routingId}`], success: 'Operation added.' },
  );
}

export async function updateOperationAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const routingId = form.get('routingId');
  const operationId = form.get('operationId');
  if (typeof routingId !== 'string' || typeof operationId !== 'string') {
    return { status: 'error', error: 'That operation could not be read. Reload and try again.' };
  }

  return runAction(
    () =>
      apiFetch(`/production/routings/${routingId}/operations/${operationId}`, {
        method: 'PATCH',
        body: {
          sequence: numberOrUndefined(form, 'sequence'),
          name: requiredText(form, 'name') ?? undefined,
          workCentreId: requiredText(form, 'workCentreId') ?? undefined,
          setupMinutes: numberOrUndefined(form, 'setupMinutes') ?? null,
          runMinutesPerUnit: numberOrUndefined(form, 'runMinutesPerUnit') ?? null,
          cureMinutes: numberOrUndefined(form, 'cureMinutes'),
          isQualityGate: form.get('isQualityGate') === 'true',
          instructions: requiredText(form, 'instructions'),
        },
      }),
    { revalidate: [`/production/routings/${routingId}`], success: 'Operation saved.' },
  );
}

export async function removeOperationAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const routingId = form.get('routingId');
  const operationId = form.get('operationId');
  if (typeof routingId !== 'string' || typeof operationId !== 'string') {
    return { status: 'error', error: 'That operation could not be read. Reload and try again.' };
  }

  return runAction(
    () =>
      apiFetch(`/production/routings/${routingId}/operations/${operationId}/remove`, {
        method: 'POST',
      }),
    { revalidate: [`/production/routings/${routingId}`], success: 'Operation removed.' },
  );
}

'use server';

import { requiredText, runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

const COST_TYPES = new Set(['material', 'labour', 'machine', 'subcontract', 'overhead', 'other']);

export async function createCostCodeAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const code = requiredText(form, 'code');
  const name = requiredText(form, 'name');
  const costType = form.get('costType');
  if (!code || !name) {
    return { status: 'error', error: 'A cost code needs a code and a name.' };
  }
  if (typeof costType !== 'string' || !COST_TYPES.has(costType)) {
    return { status: 'error', error: 'Choose what kind of cost this is.' };
  }

  return runAction(
    () =>
      apiFetch('/master-data/cost-codes', {
        method: 'POST',
        body: { code, name, costType, parentId: requiredText(form, 'parentId') },
      }),
    { revalidate: ['/settings/cost-codes'], success: `"${code}" added.` },
  );
}

export async function setCostCodeActiveAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const costCodeId = form.get('costCodeId');
  const isActive = form.get('isActive');
  if (typeof costCodeId !== 'string') {
    return { status: 'error', error: 'That cost code could not be read. Reload and try again.' };
  }

  return runAction(
    () =>
      apiFetch(`/master-data/cost-codes/${costCodeId}`, {
        method: 'PATCH',
        body: { isActive: isActive === 'true' },
      }),
    {
      revalidate: ['/settings/cost-codes'],
      success: isActive === 'true' ? 'Cost code reactivated.' : 'Cost code retired.',
    },
  );
}

export async function createCostCentreAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const code = requiredText(form, 'code');
  const name = requiredText(form, 'name');
  if (!code || !name) {
    return { status: 'error', error: 'A cost centre needs a code and a name.' };
  }

  return runAction(
    () => apiFetch('/master-data/cost-centres', { method: 'POST', body: { code, name } }),
    { revalidate: ['/settings/cost-codes'], success: `"${code}" added.` },
  );
}

export async function setCostCentreActiveAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const costCentreId = form.get('costCentreId');
  const isActive = form.get('isActive');
  if (typeof costCentreId !== 'string') {
    return { status: 'error', error: 'That cost centre could not be read. Reload and try again.' };
  }

  return runAction(
    () =>
      apiFetch(`/master-data/cost-centres/${costCentreId}`, {
        method: 'PATCH',
        body: { isActive: isActive === 'true' },
      }),
    {
      revalidate: ['/settings/cost-codes'],
      success: isActive === 'true' ? 'Cost centre reactivated.' : 'Cost centre retired.',
    },
  );
}

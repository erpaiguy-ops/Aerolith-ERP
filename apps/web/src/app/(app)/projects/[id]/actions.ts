'use server';

import { revalidatePath } from 'next/cache';

import { runAction, type ActionState } from '@/lib/actions';
import { ApiError, apiFetch } from '@/lib/api';

/**
 * Saves every defined custom field in one call.
 *
 * The form always renders one input per active definition — booleans as a
 * Yes/No select rather than a checkbox, specifically so every field has a
 * FormData entry whether or not the user touched it. That means this can
 * just collect every entry except `projectId` rather than needing to know
 * which keys exist and which type each one is.
 */
export async function saveCustomFieldsAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const projectId = form.get('projectId');
  if (typeof projectId !== 'string') {
    return { status: 'error', error: 'That project could not be read. Reload and try again.' };
  }

  const values: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (key === 'projectId' || typeof value !== 'string') continue;
    values[key] = value;
  }

  return runAction(
    () => apiFetch(`/projects/${projectId}/custom-fields`, { method: 'PATCH', body: values }),
    { revalidate: [`/projects/${projectId}`], success: 'Custom fields saved.' },
  );
}

export interface BudgetLineDraft {
  wbsCode: string | null;
  category: string;
  description: string;
  quantity: number;
  uomCode: string | null;
  unitCost: number;
  lineCost: number;
  lineValue: number;
}

export interface CreateBudgetInput {
  projectId: string;
  contingencyAmount: number | null;
  note: string | null;
  lines: BudgetLineDraft[];
}

export type CreateBudgetResult = { ok: true } | { ok: false; error: string };

/**
 * A whole budget version in one call — there is no way to add a line to one
 * afterward, only to raise a new version, so this either lands complete or
 * not at all. Called directly from `BudgetLinesForm` (a client component),
 * not through `ActionForm`: a repeating grid of costed lines needs real
 * state, the same reasoning the rate build-up grid already established.
 */
export async function createBudgetAction(input: CreateBudgetInput): Promise<CreateBudgetResult> {
  try {
    await apiFetch(`/projects/${input.projectId}/budgets`, {
      method: 'POST',
      body: {
        contingencyAmount: input.contingencyAmount ?? undefined,
        note: input.note,
        lines: input.lines,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return {
        ok: false,
        error: error.isUnauthenticated ? 'Your session has expired. Sign in again.' : error.message,
      };
    }
    console.error('budget creation failed', error);
    return { ok: false, error: 'Something went wrong. The failure has been logged.' };
  }

  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true };
}

export async function approveBudgetAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const budgetId = form.get('budgetId');
  const projectId = form.get('projectId');
  if (typeof budgetId !== 'string' || typeof projectId !== 'string') {
    return { status: 'error', error: 'That budget could not be read. Reload and try again.' };
  }

  return runAction(
    () => apiFetch(`/projects/budgets/${budgetId}/approve`, { method: 'POST' }),
    {
      revalidate: [`/projects/${projectId}`],
      success: 'Approved. This is now the baseline the roll-up weighs progress against.',
    },
  );
}

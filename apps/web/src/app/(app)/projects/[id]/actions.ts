'use server';

import { runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

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

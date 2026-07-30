'use server';

import { requiredText, runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

const ENTITY_TYPES = new Set(['party', 'item', 'project']);

/** Parses "Value one, Value two" into option rows where the value is its own label. */
function parseOptions(raw: string | null): { value: string; label: string }[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((value) => ({ value, label: value }));
}

export async function createCustomFieldAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const entityType = form.get('entityType');
  const key = requiredText(form, 'key');
  const label = requiredText(form, 'label');
  const type = form.get('type');

  if (typeof entityType !== 'string' || !ENTITY_TYPES.has(entityType)) {
    return { status: 'error', error: 'That entity type could not be read. Reload and try again.' };
  }
  if (!key || !label || typeof type !== 'string') {
    return { status: 'error', error: 'A field needs a key, a label and a type.' };
  }

  return runAction(
    () =>
      apiFetch('/admin/custom-fields', {
        method: 'POST',
        body: {
          entityType,
          key,
          label,
          type,
          isRequired: form.get('isRequired') === 'true',
          options: parseOptions(requiredText(form, 'options')),
        },
      }),
    {
      revalidate: [`/settings/custom-fields?entityType=${entityType}`, '/settings/custom-fields'],
      success: `"${label}" added.`,
    },
  );
}

export async function setCustomFieldActiveAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const fieldId = form.get('fieldId');
  const entityType = form.get('entityType');
  const isActive = form.get('isActive');

  if (typeof fieldId !== 'string' || typeof entityType !== 'string') {
    return { status: 'error', error: 'That field could not be read. Reload and try again.' };
  }

  return runAction(
    () =>
      apiFetch(`/admin/custom-fields/${fieldId}`, {
        method: 'PATCH',
        body: { isActive: isActive === 'true' },
      }),
    {
      revalidate: [`/settings/custom-fields?entityType=${entityType}`, '/settings/custom-fields'],
      success: isActive === 'true' ? 'Field reactivated.' : 'Field retired.',
    },
  );
}

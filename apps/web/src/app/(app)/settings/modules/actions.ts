'use server';

import { runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

export async function enableModuleAction(
  moduleKey: string,
  _state: ActionState,
  _form: FormData,
): Promise<ActionState> {
  return runAction(
    () => apiFetch('/admin/modules/enable', { method: 'POST', body: { moduleKey } }),
    {
      // The navigation is built from entitlements, so the whole shell changes
      // shape on this write — revalidating only this page would leave the
      // sidebar showing the world as it was before the click.
      revalidate: ['/settings/modules', '/'],
      success: 'Module enabled.',
    },
  );
}

export async function disableModuleAction(
  moduleKey: string,
  _state: ActionState,
  _form: FormData,
): Promise<ActionState> {
  return runAction(
    () => apiFetch('/admin/modules/disable', { method: 'POST', body: { moduleKey } }),
    { revalidate: ['/settings/modules', '/'], success: 'Module disabled.' },
  );
}

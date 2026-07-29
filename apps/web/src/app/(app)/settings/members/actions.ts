'use server';

import { requiredText, runAction, type ActionState } from '@/lib/actions';
import { apiFetch } from '@/lib/api';

/** Every form that changes people refreshes the same three screens. */
const REVALIDATE = ['/settings/members', '/settings/roles', '/'];

/**
 * Adding somebody to the workspace.
 *
 * The password is set here and handed over, rather than emailed as an invitation
 * link. That is a consequence of the deployment having no mail transport, not a
 * preference — a token nobody can be sent is a flow that cannot complete — and
 * the screen says so rather than pretending an email went out.
 *
 * If the email already has an account anywhere in the deployment, the API
 * attaches that account and ignores the password and the name. The message here
 * therefore does not claim an account was created.
 */
export async function addMemberAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const email = requiredText(form, 'email');
  const name = requiredText(form, 'name');
  const password = requiredText(form, 'password');

  if (!email || !email.includes('@')) return { status: 'error', error: 'Enter an email address.' };
  if (!name) return { status: 'error', error: 'Enter their name.' };
  if (!password || password.length < 12) {
    return { status: 'error', error: 'Set an initial password of at least 12 characters.' };
  }

  const roleIds = form.getAll('roleIds').filter((v): v is string => typeof v === 'string');

  return runAction(
    () =>
      apiFetch('/admin/members', {
        method: 'POST',
        body: { email, name, password, roleIds },
      }),
    { revalidate: REVALIDATE, success: `${name} can now sign in. Give them the password you set.` },
  );
}

/** Suspend, reinstate or remove. */
export async function setStatusAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const userId = form.get('userId');
  const status = form.get('status');
  if (
    typeof userId !== 'string' ||
    (status !== 'active' && status !== 'suspended' && status !== 'removed')
  ) {
    return { status: 'error', error: 'That change could not be read. Reload and try again.' };
  }

  return runAction(
    () => apiFetch(`/admin/members/${userId}`, { method: 'PATCH', body: { status } }),
    {
      revalidate: REVALIDATE,
      success:
        status === 'active'
          ? 'Reinstated.'
          : // Said plainly: this ends their session now, it is not a note for later.
            `${status === 'suspended' ? 'Suspended' : 'Removed'}. Their session has been revoked.`,
    },
  );
}

/** Replace a member's roles with exactly what is ticked. */
export async function setRolesAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const userId = form.get('userId');
  if (typeof userId !== 'string') {
    return { status: 'error', error: 'That member could not be read. Reload and try again.' };
  }

  const roleIds = form.getAll('roleIds').filter((v): v is string => typeof v === 'string');

  return runAction(
    () => apiFetch(`/admin/members/${userId}`, { method: 'PATCH', body: { roleIds } }),
    { revalidate: REVALIDATE, success: 'Roles saved.' },
  );
}

/** Hand somebody the keys, or take them back. */
export async function setOwnerAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const userId = form.get('userId');
  const isOwner = form.get('isOwner') === 'true';
  if (typeof userId !== 'string') {
    return { status: 'error', error: 'That member could not be read. Reload and try again.' };
  }

  return runAction(
    () => apiFetch(`/admin/members/${userId}`, { method: 'PATCH', body: { isOwner } }),
    {
      revalidate: REVALIDATE,
      success: isOwner
        ? 'Made an owner. They now bypass the permission matrix entirely.'
        : 'No longer an owner. Their access is now whatever their roles allow.',
    },
  );
}

/** Create a role, optionally with its permissions already ticked. */
export async function createRoleAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const code = requiredText(form, 'code');
  const name = requiredText(form, 'name');
  if (!code) return { status: 'error', error: 'Enter a short code, e.g. STOREKEEPER.' };
  if (!name) return { status: 'error', error: 'Enter a name for the role.' };

  return runAction(
    () =>
      apiFetch('/admin/roles', {
        method: 'POST',
        body: {
          code,
          name,
          description: requiredText(form, 'description'),
          isApprovalTarget: form.get('isApprovalTarget') === 'true',
        },
      }),
    { revalidate: REVALIDATE, success: `${name} created. Tick what it may do below.` },
  );
}

/** Replace a role's permissions with exactly what is ticked. */
export async function setRolePermissionsAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const roleId = form.get('roleId');
  if (typeof roleId !== 'string') {
    return { status: 'error', error: 'That role could not be read. Reload and try again.' };
  }

  const permissionKeys = form
    .getAll('permissionKeys')
    .filter((v): v is string => typeof v === 'string');

  return runAction(
    () => apiFetch(`/admin/roles/${roleId}`, { method: 'PATCH', body: { permissionKeys } }),
    {
      revalidate: REVALIDATE,
      success: `Saved. This role now grants ${permissionKeys.length} permission${
        permissionKeys.length === 1 ? '' : 's'
      }.`,
    },
  );
}

/**
 * Server actions: the shared result shape and the error mapping.
 *
 * Two things this exists to stop happening.
 *
 * **Leaking an internal error into the UI.** An `ApiError` carries the API's own
 * message, which is written for a user (`"Releasing a held invoice requires a
 * recorded reason."`). Anything else — a socket failure, a JSON parse error, a
 * bug — is not, and rendering it verbatim gives a user a stack-flavoured string
 * they can neither act on nor report usefully. Those become one honest sentence
 * and the detail goes to the server log.
 *
 * **Forgetting to revalidate.** A write that succeeds and leaves the screen
 * showing the old figures is worse than one that fails: the user believes the
 * system did nothing and does it again. Every action goes through `runAction`,
 * which revalidates on success and cannot be forgotten.
 */
import 'server-only';

import { revalidatePath } from 'next/cache';

import { IDLE, type ActionState } from './action-state';
import { ApiError } from './api';

export { IDLE, type ActionState };

export interface RunActionOptions {
  /** Paths to refresh once the write lands. The screen the user is on, at least. */
  revalidate: string[];
  /** What to say when it worked. Shown, so it should name what changed. */
  success: string;
}

/**
 * Runs a write and turns any outcome into something renderable.
 *
 * Never throws. A server action that throws in Next renders the error boundary
 * and loses the page the user was on, which for a form is a much worse outcome
 * than an inline message beside the button they just pressed.
 */
export async function runAction(
  work: () => Promise<unknown>,
  options: RunActionOptions,
): Promise<ActionState> {
  try {
    await work();
  } catch (error) {
    if (error instanceof ApiError) {
      // 401 is the one case where an inline message is useless: the session is
      // gone, so every subsequent action fails the same way. Say what to do.
      if (error.isUnauthenticated) {
        return { status: 'error', error: 'Your session has expired. Sign in again.' };
      }
      return { status: 'error', error: error.message };
    }

    console.error('action failed', error);
    return { status: 'error', error: 'Something went wrong. The failure has been logged.' };
  }

  for (const path of options.revalidate) revalidatePath(path);
  return { status: 'success', message: options.success };
}

/**
 * A required text field, trimmed.
 *
 * Returns null rather than throwing, so the caller reports it as a field error
 * instead of a page crash. Checked here as well as in the API — not because the
 * API's check is untrusted, but because a round trip to be told "this is
 * required" is a slow way to learn something the form already knew.
 */
export function requiredText(form: FormData, field: string): string | null {
  const value = form.get(field);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Whether the signed-in user holds a permission. */
export function can(permissions: readonly string[], permission: string): boolean {
  return permissions.includes(permission);
}

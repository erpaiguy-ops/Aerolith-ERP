'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { IDLE, type ActionState } from '@/lib/action-state';

/**
 * The only client-side JavaScript in the application, and it is here for one
 * reason: a destructive action needs to show that it is working.
 *
 * Everything degrades. Without JavaScript the form still posts and the server
 * action still runs — that is what Server Actions give you for free — the user
 * simply gets a full page render instead of an inline message. So this is a
 * genuine enhancement rather than a dependency.
 *
 * Double submission is guarded on the server as well: releasing an invoice that
 * is no longer held, approving an approved requisition and issuing an issued
 * order are all rejected or ignored by the service. The disabled button is a
 * courtesy, not the control.
 */

export function ActionForm({
  action,
  children,
  className,
}: {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  children: React.ReactNode;
  className?: string;
}) {
  const [state, formAction] = useActionState(action, IDLE);

  return (
    <form action={formAction} className={className}>
      {children}
      <ActionMessage state={state} />
    </form>
  );
}

export function ActionMessage({ state }: { state: ActionState }) {
  if (state.status === 'idle') return null;

  const failed = state.status === 'error';
  return (
    <p
      // `role="status"` rather than `alert`: this is announced politely after
      // the action, not interrupting whatever the user is reading.
      role="status"
      className={`mt-2 text-sm ${failed ? 'text-(--color-bad)' : 'text-(--color-good)'}`}
    >
      {/* `<bdi>` rather than the `Bidi` from `ui.tsx`, which this client module
          cannot import: it reaches `lib/locale`, which is `server-only`. The
          isolation matters most here — these messages are sentences, and an
          untranslated sentence in an RTL page renders with its full stop
          leading, which on an ERROR message reads as a broken screen. */}
      <bdi>{failed ? state.error : state.message}</bdi>
    </p>
  );
}

export function SubmitButton({
  children,
  tone = 'normal',
  /** Shown while the action is in flight, in place of the label. */
  pendingLabel,
}: {
  children: React.ReactNode;
  tone?: 'normal' | 'danger';
  pendingLabel?: string;
}) {
  const { pending } = useFormStatus();

  const tones = {
    normal: 'border-(--color-line) hover:bg-(--color-canvas)',
    // A dangerous action looks dangerous. Releasing a held invoice defeats the
    // control that stops the company paying for goods it never received, and it
    // should not look like "Save".
    danger: 'border-(--color-bad)/40 text-(--color-bad) hover:bg-(--color-bad)/5',
  };

  return (
    <button
      type="submit"
      disabled={pending}
      className={`rounded-md border px-3 py-1.5 text-sm disabled:opacity-50 ${tones[tone]}`}
    >
      <bdi>{pending ? (pendingLabel ?? 'Working…') : children}</bdi>
    </button>
  );
}

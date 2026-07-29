'use client';

import { useActionState, useEffect, useRef } from 'react';
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
  const form = useRef<HTMLFormElement>(null);
  // What was typed, captured on submit. React 19 resets an uncontrolled form
  // once its action settles, which is right after a success and destructive
  // after a failure.
  const submitted = useRef<[string, FormDataEntryValue][]>([]);

  /**
   * Restores what the user typed when the action refused it.
   *
   * Without this, an eight-field form that comes back "set a password of at
   * least 12 characters" comes back EMPTY, and the user retypes the seven
   * fields that were fine. Reset-on-success is the behaviour you want — post a
   * movement, get a fresh form — so this restores only on error.
   *
   * Checkboxes and radios need clearing first: an absent key means unticked, and
   * without the sweep a box the user cleared before submitting would come back
   * ticked.
   */
  useEffect(() => {
    if (state.status !== 'error' || !form.current) return;

    const entries = submitted.current;
    if (entries.length === 0) return;

    for (const element of form.current.elements) {
      if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
        element.checked = false;
      }
    }

    for (const [name, value] of entries) {
      if (typeof value !== 'string') continue;
      const field = form.current.elements.namedItem(name);
      const list =
        field instanceof RadioNodeList ? [...field] : field instanceof Element ? [field] : [];

      for (const element of list) {
        if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
          if (element.value === value) element.checked = true;
        } else if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement
        ) {
          element.value = value;
        }
      }
    }
  }, [state]);

  return (
    <form
      ref={form}
      action={(data: FormData) => {
        submitted.current = [...data.entries()];
        return formAction(data);
      }}
      className={className}
    >
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

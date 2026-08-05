'use client';

/**
 * Root error boundary.
 *
 * `(app)/error.tsx` handles a screen that failed to load its own data, and does
 * it inside the shell so the navigation survives. This one exists for the case
 * that boundary structurally cannot catch: an error thrown by `(app)/layout.tsx`
 * itself. A Next error boundary does not catch errors from the layout it sits
 * beside — only from the segments below it — and that layout calls `/me` on
 * every single navigation to establish who is signed in. So the one API call
 * made on literally every page was also the one whose failure had no handler.
 *
 * Deliberately standalone rather than shell-shaped: if the layout is what threw,
 * there is no `me`, which means no tenant, no locale and no navigation tree to
 * render around this. Anything borrowed from the shell here would be a second
 * crash inside the error page.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <div className="mb-1 text-lg font-semibold tracking-tight">Aerolith</div>
          <p className="text-sm text-(--color-muted)">Something went wrong.</p>
        </div>

        <div className="space-y-4 rounded-lg border border-(--color-line) bg-(--color-surface) p-6">
          <p className="text-sm">
            The server could not be reached. This is usually temporary — try again in a moment.
          </p>

          <button
            type="button"
            onClick={reset}
            className="w-full rounded bg-(--color-accent) px-3 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            Try again
          </button>

          {error.digest ? (
            <p className="text-xs text-(--color-muted)">Reference: {error.digest}</p>
          ) : null}
        </div>
      </div>
    </main>
  );
}

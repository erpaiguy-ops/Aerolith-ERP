'use client';

/**
 * Error boundary for the application shell.
 *
 * Every screen in the `(app)` group reads its data from the API on the server.
 * `pageFetch` turns two of the ways that can fail into a rendered page — 404 and
 * 403 both become `not-found.tsx` — and until this file existed, every OTHER
 * failure propagated to Next's built-in handler: a bare "Application error: a
 * server-side exception has occurred", a hex digest, and no way forward but the
 * back button. The digest is deliberately opaque (it must not leak an internal
 * message to the browser), which is correct and also means the screen tells the
 * person reading it nothing at all.
 *
 * Which failures actually reach here, all of them transient and none of them the
 * user's doing: the API refusing a burst of requests, a deploy restarting it
 * mid-render, a cold start on an instance that had spun down, a dropped
 * connection. "Try again" genuinely fixes every one of them, which is why
 * `reset()` is the primary action rather than decoration.
 *
 * Boundary placement matches `not-found.tsx` deliberately: inside the shell, so
 * the navigation stays beside the message and somebody who hits a failure on one
 * screen can go to another instead of losing the application.
 *
 * The markup is written out rather than borrowed from `@/components/ui`, and it
 * has to be: an error boundary is a client component by definition, while that
 * module reaches `lib/locale` through `lib/format` and is `server-only`.
 * Importing `PageHeader` and `Empty` here fails the production build outright —
 * `next build` catches it even though typecheck and lint both pass.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <>
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
      </div>

      <div className="rounded-lg border border-dashed border-(--color-line) p-8 text-center">
        <p className="text-sm font-medium">This screen could not load its data</p>
        <p className="mt-1 text-sm text-(--color-muted)">
          The server did not answer in time. This is usually temporary — try again, and if it keeps
          happening, the API may be restarting or briefly refusing requests.
        </p>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded bg-(--color-accent) px-3 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          Try again
        </button>
        {/* The digest is the only handle on which failure this was: it is what
            correlates this screen with the real error in the server log, where
            the message actually is. Useless to the person reading it, essential
            to whoever they report it to — so it is shown, quietly. */}
        {error.digest ? (
          <span className="text-xs text-(--color-muted)">Reference: {error.digest}</span>
        ) : null}
      </div>
    </>
  );
}

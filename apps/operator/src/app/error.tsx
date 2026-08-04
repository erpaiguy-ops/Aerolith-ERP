'use client';

/**
 * Every page here reads the platform database directly, so the realistic
 * failures are the database being unreachable and DATABASE_PLATFORM_URL being
 * wrong or missing. Next's default screen is an opaque digest; this at least
 * says which of those to check.
 */
export default function OperatorError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md">
        <h1 className="mb-1 text-lg font-semibold">Something went wrong</h1>
        <p className="mb-4 text-sm text-(--color-muted)">
          The platform database could not be read. Check that DATABASE_PLATFORM_URL is set and
          points at the SELECT-only platform role.
        </p>
        <button
          type="button"
          onClick={reset}
          className="rounded bg-(--color-accent) px-3 py-2 text-sm font-medium text-black hover:opacity-90"
        >
          Try again
        </button>
        {error.digest ? (
          <p className="mt-3 text-xs text-(--color-muted)">Reference: {error.digest}</p>
        ) : null}
      </div>
    </main>
  );
}

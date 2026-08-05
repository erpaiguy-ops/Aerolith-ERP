import Link from 'next/link';

/**
 * The root not-found: the fallback for an address outside the application shell.
 *
 * Anything signed in resolves to `(app)/not-found.tsx` instead, which renders
 * with the navigation still beside it — verified for a page nested below the
 * group (`/projects`), for a settings screen, and for a nonsense address. This
 * one covers what is left: an unmatched route reached before the shell exists.
 *
 * It names both readings for the same reason the in-shell one does. A screen
 * your role does not reach answers exactly like a screen that does not exist,
 * deliberately — the same choice the API makes for a module a tenant has not
 * bought — and being told only "not found" when the real answer is "ask for a
 * role" wastes an afternoon.
 */
export default function NotFound() {
  return (
    <main className="mx-auto max-w-md p-10 text-center">
      <h1 className="text-lg font-semibold">There is nothing at this address</h1>
      <p className="mt-2 text-sm text-(--color-muted)">
        Either the address is wrong, or your account has no role that reaches this screen. An
        administrator can check your roles on the People page.
      </p>
      <p className="mt-6 text-sm">
        <Link href="/" className="text-(--color-accent) underline">
          Back to the application
        </Link>
      </p>
    </main>
  );
}

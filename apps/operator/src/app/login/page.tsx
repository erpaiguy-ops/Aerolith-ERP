import { OperatorAuthError, operatorLogin } from '@aerolith/kernel';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { database, setOperatorSessionCookie } from '@/lib/session';

/**
 * Signing in as the vendor.
 *
 * Three fields, not two. The second factor is not optional on this surface and
 * never becomes optional: it is the difference between a leaked password
 * exposing one vendor employee's mailbox and exposing every customer's
 * commercial position.
 *
 * The error handling deliberately does not improve on the message the kernel
 * returns. `operatorLogin` gives one message for a wrong address, a wrong
 * password and a wrong code — reporting which part failed would confirm a
 * working password to whoever is guessing, turning a credential-stuffing list
 * into a list of confirmed hits even when the second factor holds.
 */
async function signIn(formData: FormData): Promise<{ error: string } | never> {
  'use server';

  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const totpCode = String(formData.get('totpCode') ?? '');

  // Opens the pool and asserts the connection really is the read-only platform
  // role before any credential is checked against it.
  await database();

  const headerList = await headers();

  try {
    const session = await operatorLogin({
      email,
      password,
      totpCode,
      ipAddress: headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: headerList.get('user-agent'),
    });
    await setOperatorSessionCookie(session.token, session.expiresAt);
  } catch (error) {
    // Locked and unenrolled are told plainly: neither is an attacker, and
    // neither is fixable by guessing again. Everything else is the one message.
    if (error instanceof OperatorAuthError) {
      return { error: error.message };
    }
    console.error('operator sign-in failed', error);
    return { error: 'Could not reach the platform database. Try again.' };
  }

  redirect('/');
}

export default async function OperatorLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <div className="mb-1 text-lg font-semibold tracking-tight">Aerolith Platform</div>
          <p className="text-sm text-(--color-muted)">
            Vendor operations. This is not a customer workspace.
          </p>
        </div>

        <form
          action={async (formData: FormData) => {
            'use server';
            const result = await signIn(formData);
            if (result?.error) redirect(`/login?error=${encodeURIComponent(result.error)}`);
          }}
          className="space-y-4 rounded-lg border border-(--color-line) bg-(--color-surface) p-6"
        >
          {error ? (
            <p
              role="alert"
              className="rounded border border-(--color-bad)/30 bg-(--color-bad)/10 px-3 py-2 text-sm text-(--color-bad)"
            >
              {error}
            </p>
          ) : null}

          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="username"
              className="w-full rounded border border-(--color-line) bg-(--color-canvas) px-3 py-2 text-sm outline-none focus:border-(--color-accent)"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="w-full rounded border border-(--color-line) bg-(--color-canvas) px-3 py-2 text-sm outline-none focus:border-(--color-accent)"
            />
          </div>

          <div>
            <label htmlFor="totpCode" className="mb-1 block text-sm font-medium">
              Authenticator code
            </label>
            <input
              id="totpCode"
              name="totpCode"
              // `inputMode` and `autoComplete="one-time-code"` between them get a
              // phone to show a number pad and offer the code from the
              // clipboard. A six-digit field that opens a full keyboard is the
              // small friction people route around by disabling the factor.
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              className="numeric w-full rounded border border-(--color-line) bg-(--color-canvas) px-3 py-2 text-sm tracking-[0.3em] outline-none focus:border-(--color-accent)"
            />
          </div>

          <button
            type="submit"
            className="w-full rounded bg-(--color-accent) px-3 py-2 text-sm font-medium text-black hover:opacity-90"
          >
            Sign in
          </button>
        </form>

        <p className="mt-4 text-xs text-(--color-muted)">
          Every sign-in, and everything opened afterwards, is recorded against your account.
        </p>
      </div>
    </main>
  );
}

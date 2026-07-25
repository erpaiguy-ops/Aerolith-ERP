import { redirect } from 'next/navigation';

import { ApiError, apiFetch } from '@/lib/api';
import { landingPath, type Me } from '@/lib/navigation';
import { setSessionCookie } from '@/lib/session';

interface LoginResponse {
  token: string;
  expiresAt: string;
  tenantId: string;
  memberships: { tenantId: string; name: string; slug: string; isOwner: boolean }[];
}

/**
 * Sign in.
 *
 * A server action, so the password is posted to this server and forwarded to the
 * API without ever being held in client state, and the session token comes back
 * into an httpOnly cookie that browser JavaScript cannot read.
 *
 * The error handling deliberately does not improve on the API's message. The API
 * returns one message for a bad email and a bad password on purpose; making the
 * form more "helpful" here would undo that and turn it into a directory of who
 * holds an account.
 */
async function signIn(_state: { error?: string }, formData: FormData) {
  'use server';

  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');

  let result: LoginResponse;
  try {
    result = await apiFetch<LoginResponse>('/auth/login', {
      method: 'POST',
      anonymous: true,
      body: { email, password },
    });
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    return { error: 'Could not reach the server. Try again.' };
  }

  await setSessionCookie(result.token, result.expiresAt);

  // Land on the first thing this user can actually open, rather than a
  // dashboard a single-module tenant has no use for.
  const me = await apiFetch<Me>('/me');
  redirect(landingPath(me.navigation));
}

export default function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  return <LoginForm searchParamsPromise={searchParams} />;
}

async function LoginForm({
  searchParamsPromise,
}: {
  searchParamsPromise: Promise<{ error?: string }>;
}) {
  const { error } = await searchParamsPromise;

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <div className="mb-1 text-lg font-semibold tracking-tight">Aerolith</div>
          <p className="text-sm text-(--color-muted)">Sign in to your workspace.</p>
        </div>

        <form
          action={async (formData: FormData) => {
            'use server';
            const result = await signIn({}, formData);
            if (result?.error) redirect(`/login?error=${encodeURIComponent(result.error)}`);
          }}
          className="space-y-4 rounded-lg border border-(--color-line) bg-(--color-surface) p-6"
        >
          {error ? (
            <p
              role="alert"
              className="rounded border border-(--color-bad)/30 bg-(--color-bad)/5 px-3 py-2 text-sm text-(--color-bad)"
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
              className="w-full rounded border border-(--color-line) px-3 py-2 text-sm outline-none focus:border-(--color-accent)"
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
              className="w-full rounded border border-(--color-line) px-3 py-2 text-sm outline-none focus:border-(--color-accent)"
            />
          </div>

          <button
            type="submit"
            className="w-full rounded bg-(--color-accent) px-3 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}

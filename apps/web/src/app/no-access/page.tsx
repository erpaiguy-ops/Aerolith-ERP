import { accessState } from '@/lib/navigation';
import { getMe } from '@/lib/session';

/**
 * The three ways a user reaches an empty application.
 *
 * They look identical and have completely different fixes — buy the module,
 * grant the role, upgrade the deployment. An unexplained empty sidebar is the
 * single most common way a permissioned ERP wastes an administrator's afternoon.
 */
export default async function NoAccessPage() {
  const me = await getMe();
  const state = accessState(me);

  const message = {
    ready: 'You have access. Use the navigation to continue.',
    no_modules:
      'This workspace has no modules enabled yet. An administrator needs to enable at least one.',
    no_permissions:
      'This workspace has modules enabled, but your account has no role granting access to any screen in them. An administrator can assign you a role.',
    unavailable:
      'This workspace is entitled to modules that this deployment does not ship. It needs upgrading, or the entitlement removing.',
  }[state.kind];

  return (
    <main className="mx-auto max-w-md p-10 text-center">
      <h1 className="text-lg font-semibold">Nothing to show yet</h1>
      <p className="mt-2 text-sm text-(--color-muted)">{message}</p>
      {state.kind === 'unavailable' ? (
        <p className="numeric mt-3 text-xs text-(--color-muted)">{state.keys.join(', ')}</p>
      ) : null}
      <form action="/api/logout" method="post" className="mt-6">
        <button type="submit" className="text-sm text-(--color-accent) underline">
          Sign out
        </button>
      </form>
    </main>
  );
}

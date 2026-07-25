import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { Shell } from '@/components/Shell';
import { ApiError } from '@/lib/api';
import { getMe } from '@/lib/session';

/**
 * The authenticated layout.
 *
 * One `/me` call per navigation, which is also the authorisation check: if the
 * session is gone the API says 401 and the user goes to the login page. There is
 * no client-side "is logged in" flag to get out of sync with the server.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  let me;
  try {
    me = await getMe();
  } catch (error) {
    if (error instanceof ApiError && error.isUnauthenticated) redirect('/login');
    throw error;
  }

  // Set by the middleware. A server component cannot read the current URL, and
  // the alternative — making the shell a client component for `usePathname()` —
  // would ship the whole navigation tree to the browser.
  const currentPath = (await headers()).get('x-pathname') ?? '';

  return (
    <Shell me={me} currentPath={currentPath}>
      {children}
    </Shell>
  );
}

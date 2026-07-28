import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { Shell } from '@/components/Shell';
import { ApiError } from '@/lib/api';
import { formattingLocale, setLocale } from '@/lib/locale';
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

  // Established here, before the children render, so every formatting helper
  // beneath — including the ones in shared components that never see the
  // session — renders in the user's own locale rather than the `en-AE` fallback.
  setLocale(formattingLocale(me.user.locale, me.tenant.countryCode));

  return (
    <Shell me={me} currentPath={currentPath}>
      {children}
    </Shell>
  );
}

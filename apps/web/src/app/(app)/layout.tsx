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

  // The sidebar reads the current path itself, via `usePathname()` in
  // `SidebarNav`. It used to be passed down from the middleware's `x-pathname`
  // header, read here — and that was the bug: a header is resolved when this
  // layout renders, Next preserves a layout across client-side navigations
  // rather than re-rendering it, so the highlight stopped tracking the router
  // and only caught up when some action forced a re-render.

  // Established here, before the children render, so every formatting helper
  // beneath — including the ones in shared components that never see the
  // session — renders in the user's own locale rather than the `en-AE` fallback.
  setLocale(formattingLocale(me.user.locale, me.tenant.countryCode));

  return <Shell me={me}>{children}</Shell>;
}

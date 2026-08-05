import { NextResponse, type NextRequest } from 'next/server';

import { SESSION_COOKIE } from '@/lib/api';

/**
 * Two jobs, both of which have to happen before a page renders.
 *
 * **Publishes the pathname to server components.** A server component cannot
 * read the current URL, and the sidebar needs it to mark the active item. The
 * alternative is making the whole shell a client component to get
 * `usePathname()`, which would ship the navigation tree to the browser and lose
 * the reason for rendering it on the server.
 *
 * **Bounces anonymous requests before they hit the API.** Not a security
 * boundary — the API authenticates every request itself and is the only thing
 * that decides — but it turns a redirect chain into a single hop, and keeps
 * unauthenticated traffic off the backend entirely.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const headers = new Headers(request.headers);
  headers.set('x-pathname', pathname);

  const isPublic = pathname.startsWith('/login') || pathname.startsWith('/api/');

  if (!isPublic && !request.cookies.get(SESSION_COOKIE)) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    // Deliberately no `?next=`: an open redirect parameter on a login page is a
    // phishing primitive, and the landing path is decided from entitlements
    // anyway, so it would buy nothing.
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Everything except Next's own assets. Cheap, because it does no I/O.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

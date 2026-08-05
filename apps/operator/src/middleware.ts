import { NextResponse, type NextRequest } from 'next/server';

import { OPERATOR_SESSION_COOKIE } from '@/lib/cookie';

/**
 * Bounces cookie-less requests before they reach a page.
 *
 * Not the security boundary, and worth being clear about that: this only checks
 * a cookie EXISTS. `requireOperator` resolves it against the database, checks
 * expiry and confirms the account is still active, and that is what decides. A
 * revoked session whose cookie is still in the browser sails past here and
 * stops there.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic = pathname.startsWith('/login') || pathname.startsWith('/api/');

  if (!isPublic && !request.cookies.get(OPERATOR_SESSION_COOKIE)) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    // No `?next=`: an open redirect on a login page is a phishing primitive,
    // and there is one landing page here anyway.
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

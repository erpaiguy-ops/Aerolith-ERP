/**
 * Session cookie handling. Server-only.
 *
 * `httpOnly` is the point. The token never reaches client JavaScript, so an XSS
 * bug in any component cannot read it — which is what makes it acceptable to
 * hold a bearer token in a browser at all.
 */
import 'server-only';

import { cookies } from 'next/headers';

import { SESSION_COOKIE, apiFetch } from './api';
import type { Me } from './navigation';

export interface Membership {
  tenantId: string;
  name: string;
  slug: string;
  isOwner: boolean;
}

export async function setSessionCookie(token: string, expiresAt: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Off in development so the app works over plain HTTP on localhost; on
    // everywhere else, because a session cookie sent in the clear is not a
    // session cookie.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: new Date(expiresAt),
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

export async function currentToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
}

/** The signed-in user's world. Every authed page starts here. */
export async function getMe(): Promise<Me> {
  return apiFetch<Me>('/me');
}

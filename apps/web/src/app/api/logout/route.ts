import { NextResponse } from 'next/server';

import { apiFetch } from '@/lib/api';
import { clearSessionCookie } from '@/lib/session';

/**
 * Sign out.
 *
 * Revokes server-side first, then clears the cookie. The other order leaves a
 * live session behind if the API call fails — the user believes they are signed
 * out and the token still works, which is the worst of both.
 */
export async function POST(request: Request) {
  try {
    await apiFetch('/auth/logout', { method: 'POST' });
  } catch {
    // Already invalid, or the API is unreachable. Clearing the cookie locally is
    // still the right thing to do and must not be blocked by it.
  }

  await clearSessionCookie();
  return NextResponse.redirect(new URL('/login', request.url), { status: 303 });
}

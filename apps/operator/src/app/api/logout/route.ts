import { operatorLogout } from '@aerolith/kernel';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import {
  OPERATOR_SESSION_COOKIE,
  clearOperatorSessionCookie,
  database,
} from '@/lib/session';

/**
 * Sign out.
 *
 * POST, not GET: a GET logout can be triggered by any image tag on any page,
 * which is a nuisance rather than a vulnerability but an avoidable one.
 *
 * The session is revoked in the database as well as cleared from the browser.
 * Clearing the cookie alone would leave a live token that anything holding a
 * copy could keep using for the rest of its eight hours.
 */
export async function POST(request: Request) {
  const token = (await cookies()).get(OPERATOR_SESSION_COOKIE)?.value;
  if (token) {
    await database();
    await operatorLogout(token);
  }
  await clearOperatorSessionCookie();
  return NextResponse.redirect(new URL('/login', request.url), { status: 303 });
}

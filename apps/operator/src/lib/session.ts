import 'server-only';

import {
  authenticateOperator,
  closeDatabase,
  createDatabase,
  getDatabase,
  recordOperatorAction,
  type AuthenticatedOperator,
} from '@aerolith/kernel';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * Re-exported so pages have one import for everything session-shaped. The
 * constant itself lives in `./cookie`, which imports nothing — see the note
 * there about the edge runtime.
 */
export { OPERATOR_SESSION_COOKIE } from './cookie';
import { OPERATOR_SESSION_COOKIE } from './cookie';

/**
 * Connects as the platform role, and nothing else.
 *
 * Not DATABASE_URL and not DATABASE_APP_URL. This process holds a credential
 * that can read every tenant, so it must hold one that can write none of them:
 * `aerolith_platform` has SELECT across the tenant schemas and write access to
 * exactly two tables in its own. Pointing this at another role would produce a
 * working application with a silently enormous blast radius, which is why
 * `assertPlatformRole` is not optional below.
 */
const url = process.env.DATABASE_PLATFORM_URL;

let ready: Promise<void> | undefined;

/**
 * Initialised once per process, lazily.
 *
 * `createDatabase` sets a module-level singleton in the kernel, so calling it
 * per request would leak a pool on every page view. The promise is cached
 * rather than a boolean because two concurrent requests during a cold start
 * would otherwise both see "not initialised" and both create one.
 */
async function connect(): Promise<void> {
  if (!url) {
    throw new Error(
      'DATABASE_PLATFORM_URL is not set. The operator surface reads the estate through ' +
        'the SELECT-only platform role — see docs/07-platform-operations.md.',
    );
  }
  ready ??= (async () => {
    createDatabase({ connectionString: url, maxConnections: 4 });
    const { assertPlatformRole } = await import('@aerolith/kernel');
    await getDatabase().transaction(assertPlatformRole);
  })().catch((error: unknown) => {
    // Cleared on failure, or the FIRST failure becomes permanent.
    //
    // A cached rejected promise is still cached: every later request would
    // re-await the same rejection and the process would serve nothing but the
    // error boundary until it restarted, with no further connection attempts in
    // the log to explain why. That is not hypothetical on a free tier — the
    // service wakes from idle on demand, and a managed database that is still
    // accepting connections a second later would otherwise take the whole
    // application down until somebody redeployed it.
    //
    // The message is logged here rather than left to Next's digest, because the
    // digest is the only thing the user-facing boundary can show and it is not
    // searchable against anything meaningful. This line is.
    // Ends the pool the failed attempt opened. `createDatabase` assigns a
    // module-level singleton, so a retry replaces it — and without this the
    // displaced pool keeps its sockets and its reconnect timers for the life of
    // the process, one leak per failed attempt.
    ready = undefined;
    void closeDatabase().catch(() => {});
    console.error('operator: platform database unavailable —', error);
    throw error;
  });
  return ready;
}

export async function database() {
  await connect();
  return getDatabase();
}

/** The signed-in operator, or null. Does not redirect. */
export async function currentOperator(): Promise<AuthenticatedOperator | null> {
  const token = (await cookies()).get(OPERATOR_SESSION_COOKIE)?.value;
  if (!token) return null;
  await connect();
  return authenticateOperator(token);
}

/**
 * The signed-in operator, or a redirect to the login page.
 *
 * Every page under `(operator)` calls this. The middleware also bounces
 * cookie-less requests, but that is a convenience: the middleware only checks
 * that a cookie EXISTS, and only this resolves it against the database, checks
 * expiry and confirms the account is still active. A revoked session with a
 * cookie still in the browser gets past the middleware and stops here.
 */
export async function requireOperator(): Promise<AuthenticatedOperator> {
  const operator = await currentOperator();
  if (!operator) redirect('/login');
  return operator;
}

export async function setOperatorSessionCookie(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(OPERATOR_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  });
}

export async function clearOperatorSessionCookie(): Promise<void> {
  (await cookies()).delete(OPERATOR_SESSION_COOKIE);
}

/**
 * Records what an operator looked at.
 *
 * Called from the pages themselves rather than from the read model, so the
 * entry describes the SCREEN somebody opened rather than each query it happened
 * to run — "opened the estate list" is the fact a customer would want answered,
 * not "ran three selects".
 *
 * Reads are audited here on purpose. In an ordinary application that is
 * overkill; on a surface where an employee can open any customer's commercial
 * position it is the entire point, and it is what makes an honest answer
 * possible when a customer asks whether anyone at the vendor has been in their
 * data.
 */
export async function audit(
  operator: AuthenticatedOperator,
  action: string,
  detail: {
    tenantId?: string | null;
    tenantSlug?: string | null;
    tenantCount?: number | null;
    detail?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const headerList = await headers();
  await connect();
  await recordOperatorAction({
    operatorId: operator.operatorId,
    operatorEmail: operator.email,
    action,
    tenantId: detail.tenantId ?? null,
    tenantSlug: detail.tenantSlug ?? null,
    tenantCount: detail.tenantCount ?? null,
    detail: detail.detail ?? {},
    // Behind a proxy the socket address is the proxy's. The forwarded header is
    // spoofable by a direct client, which is why it is recorded as evidence
    // rather than trusted for a decision — nothing here authorises on it.
    ipAddress: headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: headerList.get('user-agent'),
  });
}

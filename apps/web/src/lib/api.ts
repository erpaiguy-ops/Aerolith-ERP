/**
 * Server-side API client.
 *
 * Every function here runs on the server — in a server component or a route
 * handler — never in the browser. That is the whole point: the session token
 * lives in an httpOnly cookie, so client JavaScript cannot read it and an XSS
 * bug cannot exfiltrate it. A component that needs data asks the server; the
 * browser never holds a credential.
 */
import { cookies } from 'next/headers';

export const SESSION_COOKIE = 'aerolith_session';

const baseUrl = (): string =>
  process.env.AEROLITH_API_URL ?? 'http://localhost:3001';

export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }

  /** The session is gone or was never valid — the caller should redirect. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /**
   * The tenant is not entitled to this module.
   *
   * 404 rather than 403, deliberately, and mirrored here: an unentitled module
   * must not confirm it exists. The UI shows "not found", not "upgrade to see
   * this", because the second one is a sales pitch that leaks the catalogue.
   */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Skip the session cookie — only for login itself. */
  anonymous?: boolean;
  /** Next.js cache behaviour. ERP data is never statically cached. */
  revalidate?: number | false;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};

  // Only when there is actually a body. Declaring `application/json` and then
  // sending nothing makes Fastify reject the request outright — which silently
  // broke logout: the cookie cleared, the caller swallowed the error, and the
  // session stayed live on the server. The user believes they are signed out
  // and the token still works, which is the worst of both.
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  if (!options.anonymous) {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!token) throw new ApiError(401, 'No session.');
    headers.authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${baseUrl()}/api/v1${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    // ERP figures change constantly and a stale payment application is worse
    // than a slow one. Nothing here is cacheable by default.
    cache: 'no-store',
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload !== null && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `Request failed with ${response.status}.`;
    throw new ApiError(response.status, message, payload);
  }

  return payload as T;
}

/**
 * Fetches, and returns null instead of throwing when the tenant is not entitled.
 *
 * Lets a page render the parts a tenant does have rather than failing whole
 * because one panel needs a module they never bought. Graceful degradation is
 * the behaviour the architecture promises; this is where it becomes real.
 */
export async function apiFetchOptional<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T | null> {
  try {
    return await apiFetch<T>(path, options);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) return null;
    throw error;
  }
}

/**
 * Authentication endpoints.
 *
 * The only unauthenticated write surface in the API, so it is also the only one
 * with a rate limit in front of it. Everything security-relevant lives in
 * `@aerolith/kernel/auth`; this file is the HTTP shape and nothing else.
 */
import { AuthError, login, logout, switchTenant } from '@aerolith/kernel';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(1024),
  tenantId: z.string().uuid().nullish(),
});

/**
 * A small in-process limiter on the login endpoint.
 *
 * Deliberately keyed on IP, not on email: an email-keyed limiter is itself a
 * denial-of-service tool, because anyone can lock a known address out by
 * spamming it. Account lockout in the kernel handles the per-account case; this
 * handles the spray-across-many-accounts case that lockout cannot see.
 *
 * In-process is honest about what this deployment is — one API instance on one
 * box. It becomes wrong the moment there are two, and the fix then is the shared
 * counter in Valkey the tech stack already anticipates, not a bigger map.
 */
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS_PER_WINDOW = 20;
const attempts = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const existing = attempts.get(ip);

  if (!existing || existing.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });

    // Opportunistic sweep so the map cannot grow without bound under a
    // distributed attack. Cheap because it only runs on window rollover.
    if (attempts.size > 10_000) {
      for (const [key, value] of attempts) if (value.resetAt < now) attempts.delete(key);
    }
    return false;
  }

  existing.count += 1;
  return existing.count > MAX_ATTEMPTS_PER_WINDOW;
}

/** Exposed so tests can start from a clean slate rather than sleeping a minute. */
export function resetLoginRateLimit(): void {
  attempts.clear();
}

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', async (request, reply) => {
    if (rateLimited(request.ip)) {
      return reply.code(429).send({ error: 'Too many sign-in attempts. Try again shortly.' });
    }

    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) {
      // Not the validation detail: which field failed on a login form is a hint
      // about what the server considers a well-formed account.
      return reply.code(401).send({ error: 'Email or password is incorrect.' });
    }

    try {
      const result = await login({
        ...parsed.data,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return {
        token: result.token,
        expiresAt: result.expiresAt.toISOString(),
        tenantId: result.tenantId,
        memberships: result.memberships,
      };
    } catch (error) {
      if (error instanceof AuthError) {
        // 423 for a locked account so a client can tell "wait" from "retry",
        // 401 for everything else. The MESSAGE for a bad email and a bad
        // password is identical either way — see the kernel service.
        return reply.code(error.code === 'locked' ? 423 : 401).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post('/auth/logout', async (request, reply) => {
    const token = bearer(request);
    // Idempotent, and never says whether the token was real. A logout endpoint
    // that 404s on an unknown token is a token oracle.
    if (token) await logout(token);
    return reply.code(204).send();
  });

  /** Moves a live session to another of the user's workspaces, rotating the token. */
  app.post('/auth/switch-tenant', async (request, reply) => {
    const token = bearer(request);
    if (!token) return reply.code(401).send({ error: 'No session token supplied.' });

    const parsed = z.object({ tenantId: z.string().uuid() }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'A workspace id is required.' });
    }

    try {
      const result = await switchTenant({ token, tenantId: parsed.data.tenantId });
      return { token: result.token, expiresAt: result.expiresAt.toISOString() };
    } catch (error) {
      if (error instanceof AuthError) {
        return reply.code(401).send({ error: error.message });
      }
      throw error;
    }
  });
}

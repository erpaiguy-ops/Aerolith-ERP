/**
 * Login, logout and tenant switching.
 *
 * Three properties this file exists to guarantee, each of which is easy to get
 * subtly wrong and expensive to discover later:
 *
 *  1. **A wrong password and an unknown email are indistinguishable** — same
 *     message, and comparable work done, because a login that returns in 2ms for
 *     an unknown address and 60ms for a known one is a user-enumeration oracle
 *     regardless of what the message says.
 *  2. **The token is never stored.** Only its SHA-256 is, exactly as
 *     `authenticate` reads it. A database leak hands over no live sessions.
 *  3. **Failed attempts are counted and lock the account**, so an offline-quality
 *     guessing rate cannot be achieved online.
 *
 * These run outside the tenant guard: at login there is no tenant yet, and the
 * user's memberships are what decide which tenants exist for them.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { withTenantId, withoutTenantGuard, type Transaction } from '../db';
import { appUser, membership, session, tenant } from '../db/schema';
import { hashPassword, needsRehash, verifyPassword } from './password';

export class AuthError extends Error {
  override readonly name = 'AuthError';
  constructor(
    message: string,
    /** Distinguishes "try again" from "you are locked out" for the caller. */
    readonly code: 'invalid_credentials' | 'locked' | 'no_tenant' | 'not_a_member' = 'invalid_credentials',
  ) {
    super(message);
  }
}

/**
 * The one message returned for a bad email and a bad password alike.
 *
 * Deliberately identical. Anything that distinguishes them turns the login form
 * into a directory of who holds an account here.
 */
const INVALID = 'Email or password is incorrect.';

export const MAX_FAILED_ATTEMPTS = 8;
export const LOCKOUT_MINUTES = 15;
export const SESSION_DAYS = 14;

/**
 * A real argon2id hash of a value nobody knows, used to spend the same work on
 * an unknown email as on a known one.
 *
 * Computed lazily once per process rather than per request — hashing it every
 * time would double the cost of every genuine login to defend a case that only
 * needs the *duration* to match, not the work to be repeated.
 */
let decoyHash: string | null = null;
async function decoy(): Promise<string> {
  decoyHash ??= await hashPassword(randomBytes(32).toString('hex'));
  return decoyHash;
}

function tokenHashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface LoginInput {
  email: string;
  password: string;
  /** Which tenant to act in. Defaults to the user's only membership. */
  tenantId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface LoginResult {
  token: string;
  expiresAt: Date;
  userId: string;
  tenantId: string;
  /** Every tenant this user may switch to, for the tenant picker. */
  memberships: { tenantId: string; name: string; slug: string; isOwner: boolean }[];
}

/**
 * Authenticates and issues a session.
 *
 * Note the ordering: the password is verified BEFORE membership is considered.
 * Checking membership first would let an unauthenticated caller discover which
 * tenants an email belongs to by watching which requests are slower.
 */
export async function login(input: LoginInput): Promise<LoginResult> {
  const email = input.email.trim().toLowerCase();

  const user = await withoutTenantGuard(async (tx) => {
    const [row] = await tx
      .select()
      .from(appUser)
      .where(and(eq(appUser.email, email), isNull(appUser.deletedAt)))
      .limit(1);
    return row;
  });

  const now = new Date();

  if (user?.lockedUntil && user.lockedUntil > now) {
    // Distinct from INVALID, and that is a deliberate trade-off: it confirms the
    // address exists. The alternative silently rejects the correct password for
    // fifteen minutes, which generates support tickets and teaches users that
    // the login form is unreliable. An attacker who triggered the lockout
    // already knows the address they targeted.
    throw new AuthError(
      `Too many failed attempts. Try again after ${user.lockedUntil.toISOString()}.`,
      'locked',
    );
  }

  // Always hash something. An early return here on an unknown email is the
  // enumeration oracle this whole function is arranged to avoid.
  const stored = user?.passwordHash ?? (await decoy());
  const ok = await verifyPassword(input.password, stored);

  if (!user || !user.passwordHash || !ok) {
    if (user) await recordFailedAttempt(user.id, user.failedLoginCount + 1);
    throw new AuthError(INVALID, 'invalid_credentials');
  }

  const memberships = await loadMemberships(user.id);
  if (memberships.length === 0) {
    throw new AuthError('This account is not a member of any active workspace.', 'no_tenant');
  }

  const tenantId = input.tenantId ?? memberships[0]!.tenantId;
  if (!memberships.some((m) => m.tenantId === tenantId)) {
    throw new AuthError('You are not a member of that workspace.', 'not_a_member');
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  await withoutTenantGuard(async (tx) => {
    await tx.insert(session).values({
      userId: user.id,
      tenantId,
      tokenHash: tokenHashOf(token),
      expiresAt,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });

    await tx
      .update(appUser)
      .set({
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: now,
        // The only moment the plaintext exists to re-hash with. Skipping this is
        // why most systems never raise their cost factor.
        passwordHash: needsRehash(user.passwordHash!)
          ? await hashPassword(input.password)
          : user.passwordHash,
        updatedAt: now,
      })
      .where(eq(appUser.id, user.id));
  });

  return { token, expiresAt, userId: user.id, tenantId, memberships };
}

async function recordFailedAttempt(userId: string, count: number): Promise<void> {
  const lock = count >= MAX_FAILED_ATTEMPTS;
  await withoutTenantGuard(async (tx) => {
    await tx
      .update(appUser)
      .set({
        failedLoginCount: count,
        lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) : null,
        updatedAt: new Date(),
      })
      .where(eq(appUser.id, userId));
  });
}

/**
 * The tenants a user may act in.
 *
 * `membership` and `tenant` are both tenant-scoped, so each read needs its own
 * guard set to the tenant being read. Without it RLS correctly returns nothing
 * and the user appears to belong nowhere.
 */
async function loadMemberships(
  userId: string,
): Promise<{ tenantId: string; name: string; slug: string; isOwner: boolean }[]> {
  const rows = await withoutTenantGuard(async (tx) =>
    tx
      .select({ tenantId: membership.tenantId, isOwner: membership.isOwner })
      .from(membership)
      .where(and(eq(membership.userId, userId), eq(membership.status, 'active'))),
  );

  const result: { tenantId: string; name: string; slug: string; isOwner: boolean }[] = [];

  // Sequential rather than concurrent: these share one pool and one connection
  // per guard, and a handful of memberships is not worth the contention.
  for (const row of rows) {
    const found = await withTenantId(row.tenantId, async (tx) => {
      const [t] = await tx
        .select({ id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status })
        .from(tenant)
        .where(and(eq(tenant.id, row.tenantId), isNull(tenant.deletedAt)))
        .limit(1);
      return t;
    });

    // A suspended workspace is not a workspace you can log into.
    if (found && found.status === 'active') {
      result.push({
        tenantId: found.id,
        name: found.name,
        slug: found.slug,
        isOwner: row.isOwner,
      });
    }
  }

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** Revokes a session. Idempotent: logging out twice is not an error. */
export async function logout(token: string): Promise<void> {
  await withoutTenantGuard(async (tx) => {
    await tx
      .update(session)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(session.tokenHash, tokenHashOf(token)), isNull(session.revokedAt)));
  });
}

/**
 * Moves a live session to another of the user's tenants.
 *
 * The token is ROTATED rather than reused. A token that has acted in two tenants
 * is a token whose audit trail spans two tenants, and if it leaks the blast
 * radius is both of them.
 */
export async function switchTenant(input: {
  token: string;
  tenantId: string;
}): Promise<{ token: string; expiresAt: Date }> {
  const existing = await withoutTenantGuard(async (tx) => {
    const [row] = await tx
      .select()
      .from(session)
      .where(
        and(
          eq(session.tokenHash, tokenHashOf(input.token)),
          gt(session.expiresAt, new Date()),
          isNull(session.revokedAt),
        ),
      )
      .limit(1);
    return row;
  });

  if (!existing) throw new AuthError('Session is invalid or expired.', 'invalid_credentials');

  const memberships = await loadMemberships(existing.userId);
  if (!memberships.some((m) => m.tenantId === input.tenantId)) {
    // Same message whether the tenant does not exist or the user is simply not
    // in it — otherwise this endpoint enumerates workspaces.
    throw new AuthError('You are not a member of that workspace.', 'not_a_member');
  }

  const token = randomBytes(32).toString('base64url');

  await withoutTenantGuard(async (tx) => {
    await tx
      .update(session)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(session.id, existing.id));

    await tx.insert(session).values({
      userId: existing.userId,
      tenantId: input.tenantId,
      tokenHash: tokenHashOf(token),
      // Switching workspace does not extend the session. Otherwise a session
      // could be kept alive indefinitely by switching back and forth.
      expiresAt: existing.expiresAt,
      ipAddress: existing.ipAddress,
      userAgent: existing.userAgent,
    });
  });

  return { token, expiresAt: existing.expiresAt };
}

/** Sets or replaces a user's password. Used by seeding, invites and reset. */
export async function setPassword(
  tx: Transaction,
  input: { userId: string; password: string },
): Promise<void> {
  await tx
    .update(appUser)
    .set({
      passwordHash: await hashPassword(input.password),
      failedLoginCount: 0,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(appUser.id, input.userId));
}

/**
 * Removes expired and long-revoked sessions.
 *
 * Run from a scheduled job. Revoked rows are kept for a grace period rather than
 * deleted immediately, so "was this token valid last Tuesday" stays answerable
 * during an incident.
 */
export async function pruneSessions(graceDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);

  return withoutTenantGuard(async (tx) => {
    const deleted = await tx
      .delete(session)
      .where(sql`${session.expiresAt} < ${cutoff}`)
      .returning({ id: session.id });
    return deleted.length;
  });
}

/** Constant-time string comparison, for callers comparing opaque tokens. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

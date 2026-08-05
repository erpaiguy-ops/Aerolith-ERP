/**
 * Signing in as the vendor.
 *
 * A deliberately separate implementation from `auth/service.ts`, not a
 * parameterised version of it. Sharing that code would mean one change made for
 * a tenant reason silently altering how the vendor authenticates, and the two
 * have genuinely different requirements: a second factor is mandatory here,
 * sessions do not slide, and there is no tenant to resolve.
 *
 * Runs as `aerolith_platform`, which holds SELECT across the tenant schemas and
 * write access to exactly two tables in its own — `operator_session` and
 * `operator_action`. It cannot create an operator, change a password, or enrol
 * a second factor: a compromised operator session therefore cannot mint another
 * operator. Those are `scripts/operator.ts`, run as the owner.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';

import { getDatabase, type Transaction } from '../db';
import { operator, operatorAction, operatorSession } from '../db/schema/platform';
import { hashPassword, verifyPassword } from '../auth/password';
import { verifyTotp } from './totp';

export class OperatorAuthError extends Error {
  override readonly name = 'OperatorAuthError';
  constructor(
    message: string,
    readonly code: 'invalid' | 'locked' | 'inactive' | 'unenrolled',
  ) {
    super(message);
  }
}

/** One message for a wrong email, a wrong password and a wrong code. */
const INVALID = 'Those credentials are not valid.';

export const OPERATOR_MAX_FAILED_ATTEMPTS = 5;
export const OPERATOR_LOCKOUT_MINUTES = 15;

/**
 * Eight hours, and it does not slide.
 *
 * Shorter than the tenant application's fourteen days by two orders of
 * magnitude, because the two are not comparable risks: a stale tenant session
 * exposes one company's own data to someone who already worked there, and a
 * stale operator session exposes every customer to whoever finds the laptop.
 * Roughly a working day, so it does not interrupt the work it is protecting.
 */
export const OPERATOR_SESSION_HOURS = 8;

function tokenHashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface OperatorLoginInput {
  email: string;
  password: string;
  /** Six digits from the authenticator. */
  totpCode: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface OperatorSessionResult {
  token: string;
  expiresAt: Date;
  operatorId: string;
  email: string;
  name: string;
}

/**
 * Verifies a password AND a current TOTP code, then issues a session.
 *
 * Both factors are checked before either result is used, and the failure
 * message is identical for every cause. Reporting "password correct, code
 * wrong" would confirm a working password to whoever is guessing — turning a
 * compromised password list into a list of confirmed hits even when the second
 * factor holds.
 */
export async function operatorLogin(
  input: OperatorLoginInput,
): Promise<OperatorSessionResult> {
  const email = input.email.trim().toLowerCase();
  const database = getDatabase();

  const [found] = await database
    .select()
    .from(operator)
    .where(eq(operator.email, email))
    .limit(1);

  const now = new Date();

  if (found?.lockedUntil && found.lockedUntil > now) {
    // Distinct from INVALID for the same reason the tenant path makes that
    // trade: silently rejecting a correct password for fifteen minutes
    // generates support tickets and teaches people the login is unreliable,
    // and whoever triggered the lockout already knows the address exists.
    throw new OperatorAuthError(
      `Too many failed attempts. Try again after ${found.lockedUntil.toISOString()}.`,
      'locked',
    );
  }

  // Always hash something, even with no such operator, so a missing account and
  // a wrong password take the same time. Otherwise the login form is an
  // enumeration oracle for who works at the vendor.
  const passwordOk = found
    ? await verifyPassword(input.password, found.passwordHash)
    : await verifyPassword(input.password, await decoyHash());

  const totpOk = found ? verifyTotp(found.totpSecret, input.totpCode, now.getTime()) : false;

  if (!found || !passwordOk || !totpOk) {
    if (found) await recordFailure(found.id, found.failedLoginCount + 1);
    throw new OperatorAuthError(INVALID, 'invalid');
  }

  if (!found.isActive) throw new OperatorAuthError(INVALID, 'inactive');
  if (!found.totpConfirmedAt) {
    // Enrolled but never proved. Named plainly rather than folded into INVALID:
    // this one is not an attack, it is an operator whose setup was not finished,
    // and telling them so is how it gets finished.
    throw new OperatorAuthError(
      'This account has not confirmed its authenticator yet. Complete enrolment first.',
      'unenrolled',
    );
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + OPERATOR_SESSION_HOURS * 60 * 60 * 1000);

  await database.insert(operatorSession).values({
    operatorId: found.id,
    tokenHash: tokenHashOf(token),
    expiresAt,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });

  await database
    .update(operator)
    .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: now, updatedAt: now })
    .where(eq(operator.id, found.id));

  await recordOperatorAction({
    operatorId: found.id,
    operatorEmail: found.email,
    action: 'auth.login',
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });

  return { token, expiresAt, operatorId: found.id, email: found.email, name: found.name };
}

let cachedDecoy: string | undefined;
async function decoyHash(): Promise<string> {
  cachedDecoy ??= await hashPassword(randomBytes(32).toString('hex'));
  return cachedDecoy;
}

async function recordFailure(operatorId: string, count: number): Promise<void> {
  const lock = count >= OPERATOR_MAX_FAILED_ATTEMPTS;
  await getDatabase()
    .update(operator)
    .set({
      failedLoginCount: count,
      lockedUntil: lock
        ? new Date(Date.now() + OPERATOR_LOCKOUT_MINUTES * 60 * 1000)
        : null,
      updatedAt: new Date(),
    })
    .where(eq(operator.id, operatorId));
}

export interface AuthenticatedOperator {
  operatorId: string;
  email: string;
  name: string;
  sessionId: string;
  expiresAt: Date;
}

/**
 * Resolves a session token, or null.
 *
 * Expiry is checked in SQL against `now()` rather than in JavaScript against
 * `Date.now()`: the database's clock is the one that wrote the row, and a
 * container whose clock has drifted would otherwise honour sessions the
 * database considers dead.
 */
export async function authenticateOperator(
  token: string,
): Promise<AuthenticatedOperator | null> {
  if (!token) return null;

  const [row] = await getDatabase()
    .select({
      sessionId: operatorSession.id,
      expiresAt: operatorSession.expiresAt,
      operatorId: operator.id,
      email: operator.email,
      name: operator.name,
      isActive: operator.isActive,
    })
    .from(operatorSession)
    .innerJoin(operator, eq(operator.id, operatorSession.operatorId))
    .where(
      and(
        eq(operatorSession.tokenHash, tokenHashOf(token)),
        isNull(operatorSession.revokedAt),
        sql`${operatorSession.expiresAt} > now()`,
      ),
    )
    .limit(1);

  // Deactivating an operator takes effect on their next request rather than
  // needing every session hunted down — the join checks it every time.
  if (!row || !row.isActive) return null;

  return {
    operatorId: row.operatorId,
    email: row.email,
    name: row.name,
    sessionId: row.sessionId,
    expiresAt: row.expiresAt,
  };
}

export async function operatorLogout(token: string): Promise<void> {
  if (!token) return;
  await getDatabase()
    .update(operatorSession)
    .set({ revokedAt: new Date() })
    .where(eq(operatorSession.tokenHash, tokenHashOf(token)));
}

export interface RecordOperatorActionInput {
  operatorId: string;
  operatorEmail: string;
  action: string;
  tenantId?: string | null;
  tenantSlug?: string | null;
  tenantCount?: number | null;
  detail?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Writes the operator trail.
 *
 * Failure is logged and swallowed, which is the opposite of what a tenant audit
 * write does and is the right call here for one narrow reason: this table is
 * append-only at the grant level and never updated, so the realistic failure is
 * the database being unreachable — in which case the action it describes did
 * not happen either. Letting it throw would turn a logging outage into a total
 * outage of the operator surface. The one case that matters is deliberate
 * suppression, and an attacker who can drop this table's inserts already holds
 * the platform credential.
 */
export async function recordOperatorAction(
  input: RecordOperatorActionInput,
  tx?: Transaction,
): Promise<void> {
  try {
    const runner = tx ?? getDatabase();
    await runner.insert(operatorAction).values({
      operatorId: input.operatorId,
      operatorEmail: input.operatorEmail,
      action: input.action,
      tenantId: input.tenantId ?? null,
      tenantSlug: input.tenantSlug ?? null,
      tenantCount: input.tenantCount ?? null,
      detail: input.detail ?? {},
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });
  } catch (error) {
    console.error('! failed to record operator action', input.action, error);
  }
}

/** Expired and revoked sessions, cleared out. Safe to run on a schedule. */
export async function pruneOperatorSessions(graceDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);
  const deleted = await getDatabase()
    .delete(operatorSession)
    .where(sql`${operatorSession.expiresAt} < ${cutoff}`)
    .returning({ id: operatorSession.id });
  return deleted.length;
}

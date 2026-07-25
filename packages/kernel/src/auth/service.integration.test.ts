/**
 * Login against a real database.
 *
 * The properties under test are security properties, and every one of them is
 * the kind that passes a code review and fails in production: enumeration by
 * error message, enumeration by timing, a lockout that never engages, a token
 * stored in plaintext, a tenant switch that keeps the old token alive.
 *
 * Skipped when TEST_DATABASE_URL is unset.
 */
import { createHash } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase, createDatabase, getDatabase, withoutTenantGuard } from '../db';
import { appUser, membership, session, tenant } from '../db/schema';
import { DEFAULT_PARAMS, hashPassword, needsRehash } from './password';
import {
  AuthError,
  MAX_FAILED_ATTEMPTS,
  login,
  logout,
  setPassword,
  switchTenant,
} from './service';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const TENANT_A = 'a0000000-0000-4000-8000-00000000000a';
const TENANT_B = 'b0000000-0000-4000-8000-00000000000b';
const TENANT_SUSPENDED = 'c0000000-0000-4000-8000-00000000000c';
const USER = 'e0000000-0000-4000-8000-00000000000e';
const LONELY = 'e0000000-0000-4000-8000-00000000000f';
const TIMED = 'e0000000-0000-4000-8000-000000000010';

const PASSWORD = 'a perfectly ordinary passphrase';

/**
 * Users are seeded with deliberately weak Argon2 parameters.
 *
 * Two reasons, and the second is the better one. It keeps the suite from
 * spending twenty seconds proving that a KDF is slow — which is the KDF's job,
 * tested in `password.test.ts`. And it puts every login on the UPGRADE path, so
 * the silent rehash that runs when a stored hash is behind policy is exercised
 * by every test here rather than by none of them.
 */
const WEAK = { ln: 12, r: 8, p: 1 };

suite('authentication', () => {
  beforeAll(async () => {
    createDatabase({ connectionString: url! });
    const db = getDatabase();

    await db.insert(tenant).values([
      { id: TENANT_A, slug: 'auth-alpha', name: 'Alpha Joinery', status: 'active', primaryCountryCode: 'AE', baseCurrencyCode: 'AED' },
      { id: TENANT_B, slug: 'auth-beta', name: 'Beta Interiors', status: 'active', primaryCountryCode: 'QA', baseCurrencyCode: 'QAR' },
      { id: TENANT_SUSPENDED, slug: 'auth-gamma', name: 'Gamma Suspended', status: 'suspended', primaryCountryCode: 'AE', baseCurrencyCode: 'AED' },
    ]);

    await db.insert(appUser).values([
      { id: USER, email: 'multi@auth.test', name: 'Multi Tenant User', passwordHash: await hashPassword(PASSWORD, WEAK) },
      { id: LONELY, email: 'lonely@auth.test', name: 'No Memberships', passwordHash: await hashPassword(PASSWORD, WEAK) },
      // The one user held at PRODUCTION parameters. The timing comparison below
      // is only meaningful against a hash as expensive as the decoy, which is
      // sized for production — a weak hash would make an unknown email look
      // dramatically slower than a known one and invert the very signal the
      // decoy exists to erase.
      { id: TIMED, email: 'timed@auth.test', name: 'Realistic Cost', passwordHash: await hashPassword(PASSWORD) },
    ]);

    await db.insert(membership).values([
      { tenantId: TENANT_A, userId: USER, status: 'active', isOwner: true },
      { tenantId: TENANT_B, userId: USER, status: 'active', isOwner: false },
      { tenantId: TENANT_SUSPENDED, userId: USER, status: 'active', isOwner: false },
      { tenantId: TENANT_A, userId: TIMED, status: 'active', isOwner: false },
    ]);
  });

  afterAll(async () => {
    const db = getDatabase();
    await db.delete(session).where(eq(session.userId, USER));
    await db.delete(session).where(eq(session.userId, LONELY));
    await db.delete(session).where(eq(session.userId, TIMED));
    await db.delete(membership).where(eq(membership.userId, USER));
    await db.delete(membership).where(eq(membership.userId, TIMED));
    await db.delete(appUser).where(eq(appUser.id, USER));
    await db.delete(appUser).where(eq(appUser.id, LONELY));
    await db.delete(appUser).where(eq(appUser.id, TIMED));
    await db.delete(tenant).where(eq(tenant.id, TENANT_A));
    await db.delete(tenant).where(eq(tenant.id, TENANT_B));
    await db.delete(tenant).where(eq(tenant.id, TENANT_SUSPENDED));
    await closeDatabase();
  });

  // Also restores the weak hash, because a successful login upgrades it to the
  // current policy — which is the behaviour under test, not an inconvenience.
  const reset = async () => {
    const db = getDatabase();
    await db
      .update(appUser)
      .set({
        failedLoginCount: 0,
        lockedUntil: null,
        passwordHash: await hashPassword(PASSWORD, WEAK),
      })
      .where(eq(appUser.id, USER));
  };

  // -------------------------------------------------------------------------

  describe('credentials', () => {
    it('signs in and issues a session bound to a tenant', async () => {
      await reset();
      const result = await login({ email: 'multi@auth.test', password: PASSWORD });

      expect(result.userId).toBe(USER);
      expect(result.token).toHaveLength(43); // 32 random bytes, base64url
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
      // Defaults to the first membership by name: Alpha before Beta.
      expect(result.tenantId).toBe(TENANT_A);
    });

    it('is case and whitespace insensitive about the email', async () => {
      await reset();
      const result = await login({ email: '  MULTI@Auth.Test  ', password: PASSWORD });
      expect(result.userId).toBe(USER);
    });

    it('never stores the token, only its hash', async () => {
      await reset();
      const { token } = await login({ email: 'multi@auth.test', password: PASSWORD });

      const rows = await withoutTenantGuard(async (tx) =>
        tx
          .select()
          .from(session)
          .where(eq(session.tokenHash, createHash('sha256').update(token).digest('hex'))),
      );

      expect(rows).toHaveLength(1);
      // A database leak must not hand over live sessions.
      expect(rows[0]!.tokenHash).not.toBe(token);
      expect(JSON.stringify(rows[0])).not.toContain(token);
    });

    it('gives the identical message for an unknown email and a wrong password', async () => {
      await reset();

      const unknown = await login({ email: 'nobody@auth.test', password: PASSWORD }).catch(
        (e: AuthError) => e,
      );
      const wrong = await login({ email: 'multi@auth.test', password: 'not the password' }).catch(
        (e: AuthError) => e,
      );

      expect(unknown).toBeInstanceOf(AuthError);
      expect(wrong).toBeInstanceOf(AuthError);
      // Anything that distinguishes these turns the login form into a directory
      // of who holds an account here.
      expect((unknown as AuthError).message).toBe((wrong as AuthError).message);
      expect((unknown as AuthError).code).toBe((wrong as AuthError).code);
    });

    it('spends comparable time on an unknown email as on a known one', async () => {
      const time = async (email: string) => {
        const started = process.hrtime.bigint();
        await login({ email, password: 'definitely the wrong password' }).catch(() => undefined);
        return Number(process.hrtime.bigint() - started) / 1e6;
      };

      // Warm the lazily-built decoy hash first, or the very first unknown-email
      // login pays for it and the measurement is meaningless.
      await time('warmup@auth.test');

      const unknown = await time('nobody@auth.test');
      const known = await time('timed@auth.test');

      // An early return for an unknown email shows up as roughly zero against
      // tens of milliseconds of argon2. Generous bounds: this asserts the same
      // ORDER of work, not a constant-time guarantee, which is not achievable
      // across a database round trip anyway.
      expect(unknown).toBeGreaterThan(known / 4);
      expect(unknown).toBeLessThan(known * 4);
    });

    it('refuses a user who is a member of nothing, without a generic error', async () => {
      const error = await login({ email: 'lonely@auth.test', password: PASSWORD }).catch(
        (e: AuthError) => e,
      );
      // Past authentication, so being specific is safe and useful.
      expect((error as AuthError).code).toBe('no_tenant');
    });

    it('does not offer a suspended workspace', async () => {
      await reset();
      const result = await login({ email: 'multi@auth.test', password: PASSWORD });
      const ids = result.memberships.map((m) => m.tenantId);

      expect(ids).toContain(TENANT_A);
      expect(ids).toContain(TENANT_B);
      expect(ids).not.toContain(TENANT_SUSPENDED);
    });

    it('refuses to sign in directly to a workspace the user is not in', async () => {
      await reset();
      const error = await login({
        email: 'multi@auth.test',
        password: PASSWORD,
        tenantId: '00000000-0000-4000-8000-000000000000',
      }).catch((e: AuthError) => e);

      expect((error as AuthError).code).toBe('not_a_member');
    });
  });

  // -------------------------------------------------------------------------

  describe('lockout', () => {
    it('counts failures and locks the account, then refuses the CORRECT password', async () => {
      await reset();

      for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
        await login({ email: 'multi@auth.test', password: 'wrong' }).catch(() => undefined);
      }

      const db = getDatabase();
      const [row] = await db.select().from(appUser).where(eq(appUser.id, USER));
      expect(row!.failedLoginCount).toBe(MAX_FAILED_ATTEMPTS);
      expect(row!.lockedUntil).not.toBeNull();

      // The part that actually matters: a lockout that still admits the right
      // password is not a lockout at all, and online guessing continues.
      const error = await login({ email: 'multi@auth.test', password: PASSWORD }).catch(
        (e: AuthError) => e,
      );
      expect((error as AuthError).code).toBe('locked');

      await reset();
    });

    it('clears the failure count on a successful sign-in', async () => {
      await reset();
      await login({ email: 'multi@auth.test', password: 'wrong' }).catch(() => undefined);
      await login({ email: 'multi@auth.test', password: 'wrong' }).catch(() => undefined);

      await login({ email: 'multi@auth.test', password: PASSWORD });

      const db = getDatabase();
      const [row] = await db.select().from(appUser).where(eq(appUser.id, USER));
      expect(row!.failedLoginCount).toBe(0);
      expect(row!.lastLoginAt).not.toBeNull();
    });

    it('does not lock an account that does not exist', async () => {
      // Nothing to update, and no error either — an unknown email must behave
      // exactly like a wrong password all the way down.
      await expect(
        login({ email: 'nobody@auth.test', password: 'wrong' }),
      ).rejects.toBeInstanceOf(AuthError);
    });
  });

  // -------------------------------------------------------------------------

  describe('session lifecycle', () => {
    it('revokes on logout, and is idempotent', async () => {
      await reset();
      const { token } = await login({ email: 'multi@auth.test', password: PASSWORD });

      await logout(token);
      await logout(token);

      const rows = await withoutTenantGuard(async (tx) =>
        tx
          .select()
          .from(session)
          .where(eq(session.tokenHash, createHash('sha256').update(token).digest('hex'))),
      );

      expect(rows[0]!.revokedAt).not.toBeNull();
    });

    it('rotates the token when switching workspace, killing the old one', async () => {
      await reset();
      const first = await login({ email: 'multi@auth.test', password: PASSWORD });
      expect(first.tenantId).toBe(TENANT_A);

      const second = await switchTenant({ token: first.token, tenantId: TENANT_B });
      expect(second.token).not.toBe(first.token);

      const hashOf = (t: string) => createHash('sha256').update(t).digest('hex');
      const rows = await withoutTenantGuard(async (tx) => ({
        old: await tx.select().from(session).where(eq(session.tokenHash, hashOf(first.token))),
        fresh: await tx.select().from(session).where(eq(session.tokenHash, hashOf(second.token))),
      }));

      // A token that has acted in two tenants spans two audit trails, and if it
      // leaks the blast radius is both.
      expect(rows.old[0]!.revokedAt).not.toBeNull();
      expect(rows.fresh[0]!.revokedAt).toBeNull();
      expect(rows.fresh[0]!.tenantId).toBe(TENANT_B);
    });

    it('does not extend the session by switching workspace', async () => {
      await reset();
      const first = await login({ email: 'multi@auth.test', password: PASSWORD });
      const second = await switchTenant({ token: first.token, tenantId: TENANT_B });

      // Otherwise a session is kept alive forever by switching back and forth.
      expect(second.expiresAt.getTime()).toBe(first.expiresAt.getTime());
    });

    it('refuses to switch into a workspace the user is not a member of', async () => {
      await reset();
      const { token } = await login({ email: 'multi@auth.test', password: PASSWORD });

      const error = await switchTenant({
        token,
        tenantId: '00000000-0000-4000-8000-000000000000',
      }).catch((e: AuthError) => e);

      expect((error as AuthError).code).toBe('not_a_member');
    });

    it('refuses to switch using a revoked token', async () => {
      await reset();
      const { token } = await login({ email: 'multi@auth.test', password: PASSWORD });
      await logout(token);

      await expect(switchTenant({ token, tenantId: TENANT_B })).rejects.toBeInstanceOf(AuthError);
    });
  });

  // -------------------------------------------------------------------------

  describe('cost factor upgrades', () => {
    it('silently rehashes a below-policy password on successful sign-in', async () => {
      await reset(); // seeds a deliberately weak hash

      const db = getDatabase();
      const [before] = await db.select().from(appUser).where(eq(appUser.id, USER));
      expect(before!.passwordHash).toContain('ln=12,r=8,p=1');
      expect(needsRehash(before!.passwordHash!)).toBe(true);

      await login({ email: 'multi@auth.test', password: PASSWORD });

      const [after] = await db.select().from(appUser).where(eq(appUser.id, USER));

      // Successful login is the only moment the plaintext exists to re-hash
      // with. Systems that skip this can never raise their cost factor without
      // forcing a password reset on everyone, so in practice they never do.
      expect(after!.passwordHash).not.toBe(before!.passwordHash);
      expect(after!.passwordHash).toContain(`ln=${DEFAULT_PARAMS.ln},r=${DEFAULT_PARAMS.r},p=${DEFAULT_PARAMS.p}`);
      expect(needsRehash(after!.passwordHash!)).toBe(false);

      // And the password still works afterwards, which is the part that would
      // lock out every user if the upgrade wrote a hash of the wrong thing.
      await expect(
        login({ email: 'multi@auth.test', password: PASSWORD }),
      ).resolves.toMatchObject({ userId: USER });
    });

    it('leaves an at-policy hash untouched', async () => {
      const db = getDatabase();
      await db
        .update(appUser)
        .set({ passwordHash: await hashPassword(PASSWORD), failedLoginCount: 0, lockedUntil: null })
        .where(eq(appUser.id, USER));

      const [before] = await db.select().from(appUser).where(eq(appUser.id, USER));
      await login({ email: 'multi@auth.test', password: PASSWORD });
      const [after] = await db.select().from(appUser).where(eq(appUser.id, USER));

      // Rehashing on every login would double the cost of the login path for
      // no benefit, and rewrite a row on every request.
      expect(after!.passwordHash).toBe(before!.passwordHash);
    });
  });

  describe('password rotation', () => {
    it('replaces the password and unlocks the account', async () => {
      const db = getDatabase();
      await db
        .update(appUser)
        .set({ failedLoginCount: MAX_FAILED_ATTEMPTS, lockedUntil: new Date(Date.now() + 60_000) })
        .where(eq(appUser.id, USER));

      await withoutTenantGuard((tx) => setPassword(tx, { userId: USER, password: 'a brand new passphrase' }));

      const result = await login({ email: 'multi@auth.test', password: 'a brand new passphrase' });
      expect(result.userId).toBe(USER);

      await expect(
        login({ email: 'multi@auth.test', password: PASSWORD }),
      ).rejects.toBeInstanceOf(AuthError);

      // Put it back for any test ordering that follows.
      await withoutTenantGuard((tx) => setPassword(tx, { userId: USER, password: PASSWORD }));
    });
  });

  // -------------------------------------------------------------------------

  describe('membership isolation', () => {
    it('reads memberships under the right tenant guard', async () => {
      // `membership` and `tenant` are both RLS-protected. Loading them without
      // setting the guard returns nothing and every login fails with
      // "not a member of any workspace" — a bug this asserts against directly.
      await reset();
      const result = await login({ email: 'multi@auth.test', password: PASSWORD });

      expect(result.memberships).toHaveLength(2);
      expect(result.memberships.map((m) => m.name)).toEqual([
        'Alpha Joinery',
        'Beta Interiors',
      ]);
      expect(result.memberships.find((m) => m.tenantId === TENANT_A)!.isOwner).toBe(true);
      expect(result.memberships.find((m) => m.tenantId === TENANT_B)!.isOwner).toBe(false);

      const stillThere = await withoutTenantGuard(async (tx) =>
        tx
          .select()
          .from(membership)
          .where(and(eq(membership.userId, USER), eq(membership.tenantId, TENANT_A))),
      );
      expect(stillThere).toHaveLength(1);
    });
  });
});

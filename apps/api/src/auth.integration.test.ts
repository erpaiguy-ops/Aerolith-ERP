/**
 * Authentication over HTTP.
 *
 * The kernel's own suite covers the security logic. This covers what only the
 * HTTP layer can get wrong: status codes a client branches on, the rate limit,
 * and the fact that a freshly issued token actually opens the rest of the API.
 *
 * Skipped when TEST_DATABASE_URL is unset.
 */
import { closeDatabase, createDatabase, getDatabase, hashPassword, schema } from '@aerolith/kernel';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { invalidateTenantModules, syncModules } from './bootstrap';
import { resetLoginRateLimit } from './routes/auth';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

// Distinct from every other suite's ids: these tests run alongside the rest,
// against one database, and a shared tenant id is a duplicate-key failure in
// whichever suite happens to insert second.
const TENANT = 'aaaa7777-7777-4777-8777-777777777777';
const OTHER = 'bbbb8888-8888-4888-8888-888888888888';
const USER = '11111111-2222-4222-8222-111111111111';

const PASSWORD = 'a perfectly ordinary passphrase';
const WEAK = { ln: 12, r: 8, p: 1 };

suite('auth over HTTP', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    createDatabase({ connectionString: url! });
    await syncModules();
    const db = getDatabase();

    await db.insert(schema.tenant).values([
      { id: TENANT, slug: 'http-auth', name: 'HTTP Auth Co', status: 'active', primaryCountryCode: 'AE', baseCurrencyCode: 'AED' },
      { id: OTHER, slug: 'http-auth-two', name: 'Second Workspace', status: 'active', primaryCountryCode: 'QA', baseCurrencyCode: 'QAR' },
    ]);

    await db.insert(schema.appUser).values({
      id: USER,
      email: 'user@http.test',
      name: 'HTTP User',
      passwordHash: await hashPassword(PASSWORD, WEAK),
    });

    await db.insert(schema.membership).values([
      { tenantId: TENANT, userId: USER, status: 'active', isOwner: true },
      { tenantId: OTHER, userId: USER, status: 'active', isOwner: true },
    ]);

    await db
      .insert(schema.tenantModule)
      .values({ tenantId: TENANT, moduleKey: 'inventory', status: 'enabled' });
    invalidateTenantModules();

    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    const db = getDatabase();
    await db.delete(schema.session).where(eq(schema.session.userId, USER));
    await db.delete(schema.tenantModule).where(eq(schema.tenantModule.tenantId, TENANT));
    await db.delete(schema.membership).where(eq(schema.membership.userId, USER));
    await db.delete(schema.appUser).where(eq(schema.appUser.id, USER));
    await db.delete(schema.tenant).where(eq(schema.tenant.id, TENANT));
    await db.delete(schema.tenant).where(eq(schema.tenant.id, OTHER));
    await app.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    resetLoginRateLimit();
    const db = getDatabase();
    await db
      .update(schema.appUser)
      .set({
        failedLoginCount: 0,
        lockedUntil: null,
        passwordHash: await hashPassword(PASSWORD, WEAK),
      })
      .where(eq(schema.appUser.id, USER));
  });

  const post = (url: string, payload?: unknown, token?: string) =>
    app.inject({
      method: 'POST',
      url,
      payload: payload as never,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  // -------------------------------------------------------------------------

  it('issues a token that opens the rest of the API', async () => {
    const response = await post('/api/v1/auth/login', {
      email: 'user@http.test',
      password: PASSWORD,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.token).toBeTruthy();
    expect(body.memberships).toHaveLength(2);

    // The point of the endpoint: the token has to actually work.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${body.token}` },
    });

    expect(me.statusCode).toBe(200);
    expect(me.json().user.id).toBe(USER);
    expect(me.json().modules.map((m: { key: string }) => m.key)).toEqual(['inventory']);
  });

  it('returns 401 with the same message for a bad password and an unknown email', async () => {
    const wrong = await post('/api/v1/auth/login', {
      email: 'user@http.test',
      password: 'not the password',
    });
    const unknown = await post('/api/v1/auth/login', {
      email: 'nobody@http.test',
      password: PASSWORD,
    });

    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error).toBe(unknown.json().error);
  });

  it('does not leak validation detail from the login form', async () => {
    // Which field the server considered malformed is a hint about what it
    // thinks a well-formed account looks like.
    const response = await post('/api/v1/auth/login', { email: 'not-an-email', password: 'x' });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('Email or password is incorrect.');
    expect(response.json().issues).toBeUndefined();
  });

  it('answers 423 rather than 401 once the account is locked', async () => {
    for (let i = 0; i < 8; i += 1) {
      await post('/api/v1/auth/login', { email: 'user@http.test', password: 'wrong' });
    }

    const response = await post('/api/v1/auth/login', {
      email: 'user@http.test',
      password: PASSWORD,
    });

    // A distinct code so a client can say "wait" instead of "try again", which
    // is the difference between a useful form and a support ticket.
    expect(response.statusCode).toBe(423);
  });

  it('rate limits by IP, catching the spray that account lockout cannot see', async () => {
    // Lockout is per account, so an attacker trying one password against a
    // thousand accounts never trips it. This is the case that does.
    //
    // The bodies are deliberately malformed. The limiter runs BEFORE the body
    // is parsed and before any key derivation, which is the behaviour that
    // matters — a limiter placed after the KDF would let an attacker spend the
    // server's CPU twenty times before it engaged. It also keeps this test off
    // the 250ms-per-attempt path, which is what makes it finish in a second
    // instead of blowing the timeout.
    const statuses: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      statuses.push((await post('/api/v1/auth/login', { email: `spray-${i}` })).statusCode);
    }

    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses).toContain(429);
  });

  it('revokes on logout, and says nothing about whether the token was real', async () => {
    const { token } = (
      await post('/api/v1/auth/login', { email: 'user@http.test', password: PASSWORD })
    ).json();

    expect((await post('/api/v1/auth/logout', undefined, token)).statusCode).toBe(204);

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(401);

    // Nonsense token, no token at all: still 204. A logout that 404s on an
    // unknown token is a token oracle.
    expect((await post('/api/v1/auth/logout', undefined, 'garbage')).statusCode).toBe(204);
    expect((await post('/api/v1/auth/logout')).statusCode).toBe(204);
  });

  it('switches workspace, rotating the token so the old one dies', async () => {
    const first = (
      await post('/api/v1/auth/login', { email: 'user@http.test', password: PASSWORD })
    ).json();

    const switched = await post('/api/v1/auth/switch-tenant', { tenantId: OTHER }, first.token);
    expect(switched.statusCode).toBe(200);

    const next = switched.json().token;
    expect(next).not.toBe(first.token);

    const oldToken = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${first.token}` },
    });
    expect(oldToken.statusCode).toBe(401);

    const newToken = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${next}` },
    });
    expect(newToken.statusCode).toBe(200);
    expect(newToken.json().tenant.id).toBe(OTHER);
  });

  it('refuses to switch into a workspace the user is not in', async () => {
    const { token } = (
      await post('/api/v1/auth/login', { email: 'user@http.test', password: PASSWORD })
    ).json();

    const response = await post(
      '/api/v1/auth/switch-tenant',
      { tenantId: '00000000-0000-4000-8000-000000000000' },
      token,
    );
    expect(response.statusCode).toBe(401);
  });
});

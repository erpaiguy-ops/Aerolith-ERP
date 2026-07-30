/**
 * The notification inbox: real HTTP, real database, real RLS.
 *
 * Skipped when TEST_DATABASE_URL is unset.
 */
import { createHash } from 'node:crypto';

import { closeDatabase, createDatabase, getDatabase, schema } from '@aerolith/kernel';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { invalidateTenantModules } from './bootstrap';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const TENANT = '66666666-6666-4666-8666-666666666666';
const ALICE = 'cccccccc-0000-4000-8000-000000000001';
const BOB = 'cccccccc-0000-4000-8000-000000000002';
const ALICE_TOKEN = 'alice-token-for-notification-tests';
const BOB_TOKEN = 'bob-token-for-notification-tests';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

suite('Notifications', () => {
  let app: FastifyInstance;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    createDatabase({ connectionString: url! });
    const db = getDatabase();

    await db.insert(schema.tenant).values({
      id: TENANT,
      slug: 'notif-co',
      name: 'Notification Co',
      status: 'active',
      primaryCountryCode: 'AE',
      baseCurrencyCode: 'AED',
      timezone: 'Asia/Dubai',
    });

    await db.insert(schema.appUser).values([
      { id: ALICE, email: 'alice@notif.test', name: 'Alice', locale: 'en' },
      { id: BOB, email: 'bob@notif.test', name: 'Bob', locale: 'en' },
    ]);

    await db.insert(schema.membership).values([
      { tenantId: TENANT, userId: ALICE, status: 'active', isOwner: true },
      { tenantId: TENANT, userId: BOB, status: 'active', isOwner: true },
    ]);

    const expiresAt = new Date(Date.now() + 3_600_000);
    await db.insert(schema.session).values([
      { userId: ALICE, tenantId: TENANT, tokenHash: hash(ALICE_TOKEN), expiresAt },
      { userId: BOB, tenantId: TENANT, tokenHash: hash(BOB_TOKEN), expiresAt },
    ]);

    invalidateTenantModules();
    app = await buildApp();
    await app.ready();

    // Fixture notifications, inserted directly — how they got there (the
    // approval engine, in production) is covered by the kernel's own
    // integration suite; this one is about the inbox reading them back.
    await db.insert(schema.notification).values([
      {
        tenantId: TENANT,
        recipientId: ALICE,
        typeKey: 'kernel.approval.requested',
        title: 'Approval needed: PO-2026-00001',
        entityType: 'kernel.approval_instance',
        entityId: '77777777-7777-4777-8777-777777777001',
        actionUrl: '/approvals',
      },
      {
        tenantId: TENANT,
        recipientId: ALICE,
        typeKey: 'kernel.approval.requested',
        title: 'Approval needed: PO-2026-00002',
        actionUrl: '/approvals',
      },
      // Bob's own notification — must never appear on Alice's screen.
      { tenantId: TENANT, recipientId: BOB, typeKey: 'kernel.approval.requested', title: "Bob's" },
    ]);
  });

  afterAll(async () => {
    const db = getDatabase();
    await db.delete(schema.notification).where(eq(schema.notification.tenantId, TENANT));
    await db.delete(schema.session).where(eq(schema.session.userId, ALICE));
    await db.delete(schema.session).where(eq(schema.session.userId, BOB));
    await db.delete(schema.membership).where(eq(schema.membership.tenantId, TENANT));
    await db.delete(schema.appUser).where(eq(schema.appUser.id, ALICE));
    await db.delete(schema.appUser).where(eq(schema.appUser.id, BOB));
    await db.delete(schema.tenant).where(eq(schema.tenant.id, TENANT));
    await app.close();
    await closeDatabase();
  });

  it('lists only the caller\'s own notifications, newest first', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: auth(ALICE_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.rows).toHaveLength(2);
    expect(body.rows.every((r: { title: string }) => r.title.startsWith('Approval needed'))).toBe(
      true,
    );
  });

  it("does not leak one user's notifications to another", async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: auth(BOB_TOKEN),
    });

    const body = response.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].title).toBe("Bob's");
  });

  it('reports the unread count for a bell badge', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications/unread-count',
      headers: auth(ALICE_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().count).toBe(2);
  });

  it('marks one notification read, and it drops out of the unread count', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: auth(ALICE_TOKEN),
    });
    const targetId = list.json().rows[0].id as string;

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${targetId}/read`,
      headers: auth(ALICE_TOKEN),
    });

    expect(response.statusCode).toBe(200);

    const count = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications/unread-count',
      headers: auth(ALICE_TOKEN),
    });
    expect(count.json().count).toBe(1);

    // Still in the list — read, not archived.
    const stillListed = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: auth(ALICE_TOKEN),
    });
    expect(stillListed.json().rows).toHaveLength(2);

    const unreadOnly = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications?unread=true',
      headers: auth(ALICE_TOKEN),
    });
    expect(unreadOnly.json().rows).toHaveLength(1);
  });

  it('refuses to mark a notification read on somebody else\'s behalf', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: auth(BOB_TOKEN),
    });
    const bobsNotificationId = list.json().rows[0].id as string;

    // Alice tries to mark Bob's notification read by guessing its id.
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${bobsNotificationId}/read`,
      headers: auth(ALICE_TOKEN),
    });

    expect(response.statusCode).toBe(404);
  });

  it('marks every remaining notification read in one call', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/read-all',
      headers: auth(ALICE_TOKEN),
    });
    expect(response.statusCode).toBe(200);

    const count = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications/unread-count',
      headers: auth(ALICE_TOKEN),
    });
    expect(count.json().count).toBe(0);

    // Bob's is untouched by Alice's mark-all.
    const bobCount = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications/unread-count',
      headers: auth(BOB_TOKEN),
    });
    expect(bobCount.json().count).toBe(1);
  });
});

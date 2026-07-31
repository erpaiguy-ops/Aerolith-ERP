/**
 * Documents end to end: real HTTP, real database, real RLS.
 *
 * No R2 environment variables are set in this environment on purpose — this
 * suite exists to prove the split the design makes: every function that only
 * touches metadata (folders, the register, linking, locking) keeps working
 * with zero storage configuration, and only the two calls that genuinely need
 * to reach R2 (minting the presigned upload URL, minting the presigned
 * download URL) fail, and fail with a clear 503 rather than a stack trace or
 * a misleading 409. Nothing here uploads a real file or reaches real R2.
 *
 * Skipped when TEST_DATABASE_URL is unset.
 */
import { createHash } from 'node:crypto';

import { closeDatabase, createDatabase, getDatabase, schema } from '@aerolith/kernel';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { invalidateTenantModules } from './bootstrap';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

// Deliberately distinct from every other integration test file's fixture
// ids (checked against api, auth, cutlist, delivery, estimation, inventory,
// notifications, procurement and production) — inventory and notifications
// once collided on the identical tenant/user uuid, which raced the insert
// in `beforeAll` and produced arbitrary 401s in whichever file lost, mistaken
// for CI flakiness rather than the fixture bug it was.
const TENANT = '12121212-1212-4212-8212-121212121212';
const ALICE = '34343434-0000-4000-8000-000000000001';
const BOB = '34343434-0000-4000-8000-000000000002';
const ALICE_TOKEN = 'alice-token-for-document-tests';
const BOB_TOKEN = 'bob-token-for-document-tests';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

suite('Documents', () => {
  let app: FastifyInstance;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    createDatabase({ connectionString: url! });
    const db = getDatabase();

    await db.insert(schema.tenant).values({
      id: TENANT,
      slug: 'documents-test',
      name: 'Documents Test Joinery',
      status: 'active',
      primaryCountryCode: 'AE',
      baseCurrencyCode: 'AED',
    });

    await db.insert(schema.appUser).values([
      { id: ALICE, email: 'alice@docs.test', name: 'Alice' },
      { id: BOB, email: 'bob@docs.test', name: 'Bob' },
    ]);

    // Both owners: the tests care about the document-level lock rule ("only
    // the lock holder may unlock"), which is enforced by the service, not by
    // RBAC — making both owners keeps the permission check out of the way of
    // what these tests are actually pinning.
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
  });

  afterAll(async () => {
    const db = getDatabase();
    // `document_version`, `document_link` and `document_lock` all cascade
    // from `document`, so deleting the documents is enough to take them with
    // it.
    await db.delete(schema.document).where(eq(schema.document.tenantId, TENANT));
    await db.delete(schema.folder).where(eq(schema.folder.tenantId, TENANT));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.tenantId, TENANT));
    await db.delete(schema.eventOutbox).where(eq(schema.eventOutbox.tenantId, TENANT));
    await db.delete(schema.session).where(eq(schema.session.tenantId, TENANT));
    await db.delete(schema.membership).where(eq(schema.membership.tenantId, TENANT));
    await db.delete(schema.appUser).where(eq(schema.appUser.id, ALICE));
    await db.delete(schema.appUser).where(eq(schema.appUser.id, BOB));
    await db.delete(schema.tenant).where(eq(schema.tenant.id, TENANT));
    await app.close();
    await closeDatabase();
  });

  describe('folders', () => {
    let projectsId: string;

    it('creates a root folder, whose path is just its name', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/folders',
        headers: auth(ALICE_TOKEN),
        payload: { name: 'Projects' },
      });

      expect(response.statusCode).toBe(200);
      projectsId = response.json().id;
      expect(projectsId).toBeTruthy();

      const [row] = await getDatabase().select().from(schema.folder).where(eq(schema.folder.id, projectsId));
      expect(row!.path).toBe('/Projects');
      expect(row!.parentId).toBeNull();
    });

    it('rejects a second folder at the same path', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/folders',
        headers: auth(ALICE_TOKEN),
        payload: { name: 'Projects' },
      });

      expect(response.statusCode).toBe(409);
    });

    it('nests a folder under its parent, composing the path', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/folders',
        headers: auth(ALICE_TOKEN),
        payload: { name: 'P-001', parentId: projectsId },
      });

      expect(response.statusCode).toBe(200);
      const [row] = await getDatabase()
        .select()
        .from(schema.folder)
        .where(eq(schema.folder.id, response.json().id));
      expect(row!.path).toBe('/Projects/P-001');
      expect(row!.parentId).toBe(projectsId);
    });

    it('nests a third level, composing from the nested parent', async () => {
      const parent = await app.inject({
        method: 'GET',
        url: '/api/v1/documents/folders?parentId=' + projectsId,
        headers: auth(ALICE_TOKEN),
      });
      const p001 = parent.json().rows.find((r: { name: string }) => r.name === 'P-001');

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/folders',
        headers: auth(ALICE_TOKEN),
        payload: { name: 'Drawings', parentId: p001.id },
      });

      expect(response.statusCode).toBe(200);
      const [row] = await getDatabase()
        .select()
        .from(schema.folder)
        .where(eq(schema.folder.id, response.json().id));
      expect(row!.path).toBe('/Projects/P-001/Drawings');
    });

    it('lists only root folders when asked for the root', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/documents/folders?parentId=root',
        headers: auth(ALICE_TOKEN),
      });

      expect(response.statusCode).toBe(200);
      const names = response.json().rows.map((r: { name: string }) => r.name);
      expect(names).toContain('Projects');
      expect(names).not.toContain('P-001');
    });
  });

  describe('the register, filtered by an entity link', () => {
    let documentId: string;
    let linkId: string;

    beforeAll(async () => {
      const db = getDatabase();
      const [doc] = await db
        .insert(schema.document)
        .values({
          tenantId: TENANT,
          name: 'Fit-out Contract.pdf',
          status: 'available',
          documentType: 'contract',
        })
        .returning({ id: schema.document.id });
      documentId = doc!.id;

      // A second, unrelated document — proves the entity filter actually
      // filters rather than returning the whole tenant's register.
      await db.insert(schema.document).values({
        tenantId: TENANT,
        name: 'Unrelated memo.pdf',
        status: 'available',
      });
    });

    it('links a document to a record in another module', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/documents/${documentId}/link`,
        headers: auth(ALICE_TOKEN),
        payload: {
          entityType: 'project',
          entityId: '00000000-0000-4000-8000-0000000000aa',
          moduleKey: 'projects',
          linkType: 'primary',
        },
      });

      expect(response.statusCode).toBe(200);
      linkId = response.json().id;
      expect(linkId).toBeTruthy();
    });

    it('rejects a duplicate link of the same type to the same record', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/documents/${documentId}/link`,
        headers: auth(ALICE_TOKEN),
        payload: {
          entityType: 'project',
          entityId: '00000000-0000-4000-8000-0000000000aa',
          moduleKey: 'projects',
          linkType: 'primary',
        },
      });

      expect(response.statusCode).toBe(409);
    });

    it('lists only documents linked to that entity, not the whole register', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/documents?entityType=project&entityId=00000000-0000-4000-8000-0000000000aa',
        headers: auth(ALICE_TOKEN),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.rows).toHaveLength(1);
      expect(body.rows[0].id).toBe(documentId);
      expect(body.rows[0].name).toBe('Fit-out Contract.pdf');
    });

    it('removes the link', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/documents/${documentId}/link/${linkId}/remove`,
        headers: auth(ALICE_TOKEN),
      });

      expect(response.statusCode).toBe(200);

      const after = await app.inject({
        method: 'GET',
        url: '/api/v1/documents?entityType=project&entityId=00000000-0000-4000-8000-0000000000aa',
        headers: auth(ALICE_TOKEN),
      });
      expect(after.json().rows).toHaveLength(0);
    });

    it('refuses to remove a link that no longer exists', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/documents/${documentId}/link/${linkId}/remove`,
        headers: auth(ALICE_TOKEN),
      });

      expect(response.statusCode).toBe(409);
    });
  });

  describe('upload, with no R2 configured', () => {
    it('answers 503, not a stack trace and not a 409, when starting an upload', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/upload',
        headers: auth(ALICE_TOKEN),
        payload: {
          name: 'Shop Drawing 01.dwg',
          fileName: 'shop-drawing-01.dwg',
          mimeType: 'application/octet-stream',
          sizeBytes: 1024,
        },
      });

      expect(response.statusCode).toBe(503);
      // Names the missing variable — this is a deployment that has not been
      // configured yet, not a generic failure.
      expect(response.json().error).toMatch(/S3_ENDPOINT/);
    });

    it('confirms an upload — pure metadata, so it works with no R2 configured at all', async () => {
      // `confirmDocumentUpload` never calls storage: it only flips rows this
      // process already has, which is exactly the class of function this
      // suite exists to prove keeps working. Seeded directly, the way
      // `initiateDocumentUpload` would have left them had R2 been configured.
      const db = getDatabase();
      const [doc] = await db
        .insert(schema.document)
        .values({ tenantId: TENANT, name: 'Seeded Upload.pdf', status: 'uploading' })
        .returning({ id: schema.document.id });
      const [version] = await db
        .insert(schema.documentVersion)
        .values({
          tenantId: TENANT,
          documentId: doc!.id,
          version: 1,
          storageKey: `${TENANT}/${doc!.id}/v1/seeded-upload.pdf`,
          fileName: 'seeded-upload.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 2048,
          checksum: '',
        })
        .returning({ id: schema.documentVersion.id });

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/documents/${doc!.id}/confirm`,
        headers: auth(ALICE_TOKEN),
        payload: { versionId: version!.id, checksum: 'deadbeef'.repeat(8) },
      });

      expect(response.statusCode).toBe(200);

      const [after] = await db.select().from(schema.document).where(eq(schema.document.id, doc!.id));
      expect(after!.status).toBe('available');
      expect(after!.currentVersionId).toBe(version!.id);
      expect(after!.versionCount).toBe(1);

      const [afterVersion] = await db
        .select()
        .from(schema.documentVersion)
        .where(eq(schema.documentVersion.id, version!.id));
      expect(afterVersion!.checksum).toBe('deadbeef'.repeat(8));
    });

    it('answers a clear error confirming a document that does not exist', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/00000000-0000-4000-8000-000000000000/confirm',
        headers: auth(ALICE_TOKEN),
        payload: { versionId: '00000000-0000-4000-8000-000000000000', checksum: 'x' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/not found/i);
    });

    it('answers 503 minting a download URL too — the other side of the same gap', async () => {
      const db = getDatabase();
      const [doc] = await db
        .insert(schema.document)
        .values({ tenantId: TENANT, name: 'Never downloadable.pdf', status: 'uploading' })
        .returning({ id: schema.document.id });
      const [version] = await db
        .insert(schema.documentVersion)
        .values({
          tenantId: TENANT,
          documentId: doc!.id,
          version: 1,
          storageKey: `${TENANT}/${doc!.id}/v1/x.pdf`,
          fileName: 'x.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1,
          checksum: 'x',
        })
        .returning({ id: schema.documentVersion.id });
      await db
        .update(schema.document)
        .set({ status: 'available', currentVersionId: version!.id })
        .where(eq(schema.document.id, doc!.id));

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/documents/${doc!.id}/download-url`,
        headers: auth(ALICE_TOKEN),
      });

      expect(response.statusCode).toBe(503);
    });
  });

  describe('locking', () => {
    let documentId: string;

    beforeAll(async () => {
      const [doc] = await getDatabase()
        .insert(schema.document)
        .values({ tenantId: TENANT, name: 'Controlled Drawing.dwg', status: 'available' })
        .returning({ id: schema.document.id });
      documentId = doc!.id;
    });

    it('checks a document out', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/documents/${documentId}/lock`,
        headers: auth(ALICE_TOKEN),
        payload: { note: 'Revising the elevation.' },
      });

      expect(response.statusCode).toBe(200);

      const [lock] = await getDatabase()
        .select()
        .from(schema.documentLock)
        .where(eq(schema.documentLock.documentId, documentId));
      expect(lock!.lockedBy).toBe(ALICE);
    });

    it('surfaces the lock holder on the register, so a second person sees it is taken before trying', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/documents',
        headers: auth(BOB_TOKEN),
      });

      expect(response.statusCode).toBe(200);
      const row = response.json().rows.find((r: { id: string }) => r.id === documentId);
      expect(row.lockedBy).toBe(ALICE);
      expect(row.lockedByName).toBe('Alice');
    });

    it('refuses to let a second person check the same document out', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/documents/${documentId}/lock`,
        headers: auth(BOB_TOKEN),
        payload: {},
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/already checked out/i);
    });

    it('refuses to let anyone but the lock holder check it back in', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/documents/${documentId}/unlock`,
        headers: auth(BOB_TOKEN),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/only the person who checked/i);

      // Still locked — the refusal did not silently release it.
      const [lock] = await getDatabase()
        .select()
        .from(schema.documentLock)
        .where(eq(schema.documentLock.documentId, documentId));
      expect(lock).toBeDefined();
    });

    it('lets the lock holder check it back in', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/documents/${documentId}/unlock`,
        headers: auth(ALICE_TOKEN),
      });

      expect(response.statusCode).toBe(200);

      const [lock] = await getDatabase()
        .select()
        .from(schema.documentLock)
        .where(eq(schema.documentLock.documentId, documentId));
      expect(lock).toBeUndefined();
    });

    it('lets someone else check it out once it is free', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/documents/${documentId}/lock`,
        headers: auth(BOB_TOKEN),
        payload: {},
      });

      expect(response.statusCode).toBe(200);

      const [lock] = await getDatabase()
        .select()
        .from(schema.documentLock)
        .where(
          and(eq(schema.documentLock.documentId, documentId), eq(schema.documentLock.lockedBy, BOB)),
        );
      expect(lock).toBeDefined();
    });
  });

  describe('version history', () => {
    let documentId: string;

    beforeAll(async () => {
      const db = getDatabase();
      const [doc] = await db
        .insert(schema.document)
        .values({ tenantId: TENANT, name: 'Revised Elevation.dwg', status: 'available', versionCount: 2 })
        .returning({ id: schema.document.id });
      documentId = doc!.id;
      await db.insert(schema.documentVersion).values([
        {
          tenantId: TENANT,
          documentId,
          version: 1,
          storageKey: `${TENANT}/${documentId}/v1/elevation.dwg`,
          fileName: 'elevation.dwg',
          mimeType: 'application/octet-stream',
          sizeBytes: 4096,
          checksum: 'a'.repeat(64),
          uploadedBy: ALICE,
        },
        {
          tenantId: TENANT,
          documentId,
          version: 2,
          storageKey: `${TENANT}/${documentId}/v2/elevation-r2.dwg`,
          fileName: 'elevation-r2.dwg',
          mimeType: 'application/octet-stream',
          sizeBytes: 4200,
          checksum: 'b'.repeat(64),
          uploadedBy: BOB,
          changeNote: 'Revised the door schedule.',
        },
      ]);
    });

    it('lists both versions, newest first, with the uploader resolved to a name', async () => {
      const listResponse = await app.inject({
        method: 'GET',
        url: `/api/v1/documents/${documentId}/versions`,
        headers: auth(ALICE_TOKEN),
      });

      expect(listResponse.statusCode).toBe(200);
      const { rows } = listResponse.json();
      expect(rows).toHaveLength(2);
      expect(rows[0].version).toBe(2);
      expect(rows[0].fileName).toBe('elevation-r2.dwg');
      expect(rows[0].uploadedByName).toBe('Bob');
      expect(rows[0].changeNote).toBe('Revised the door schedule.');
      expect(rows[1].version).toBe(1);
      expect(rows[1].uploadedByName).toBe('Alice');
    });
  });
});

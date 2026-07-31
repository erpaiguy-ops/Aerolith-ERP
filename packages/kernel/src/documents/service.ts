/**
 * Documents — kernel capability every module attaches files to.
 *
 * Bytes never pass through this file, or through the Fastify process at all:
 * `storage.ts` mints short-lived presigned R2 URLs and the browser talks to
 * R2 directly (see docs/04-infrastructure.md — "signed, expiring R2 URLs").
 * What lives here is metadata only — the folder tree, the document and its
 * versions, the polymorphic links to whatever entity a document belongs to,
 * and the check-in/check-out lock — following the same tenant-scoping,
 * `recordAudit()` and domain-error-class shape as `masterdata/service.ts`.
 *
 * Access control INHERITS from the parent entity rather than introducing a
 * second permission system (see the schema file's own comment): this module
 * only checks `kernel.document.read` / `kernel.document.manage`, which is
 * what gates the folder tree and the raw document register. A module that
 * shows a document attached to one of ITS records is expected to have
 * already checked that record's own permission before it ever calls
 * `listDocuments` with an entity filter.
 */
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';

import { type Transaction } from '../db';
import { appUser, document, documentLink, documentLock, documentVersion, folder } from '../db/schema';
import { recordAudit } from '../audit/service';
import { listResult, searchPattern, type ListParams, type ListResult } from '../db/list';
import { requireTenantContext } from '../tenancy/context';
import {
  StorageNotConfiguredError,
  deleteObject,
  presignDownloadUrl,
  presignUploadUrl,
} from './storage';

export { StorageNotConfiguredError };

const MODULE_KEY = 'kernel';
const DEFAULT_LOCK_MINUTES = 60;

export class DocumentError extends Error {
  override readonly name = 'DocumentError';
}

// --- Folders ---------------------------------------------------------------

export interface FolderRow {
  id: string;
  name: string;
  path: string;
  parentId: string | null;
  ownerEntityType: string | null;
  ownerEntityId: string | null;
  isSystem: boolean;
}

export const FOLDER_SORTS = ['name', 'path', 'createdAt'] as const;
export type FolderSort = (typeof FOLDER_SORTS)[number];

export interface CreateFolderInput {
  name: string;
  parentId?: string | null;
  ownerEntityType?: string | null;
  ownerEntityId?: string | null;
}

/**
 * Creates a folder, computing its materialised path from the parent's.
 *
 * A root folder (no parent) gets `/name`; a nested one gets its parent's
 * path plus `/name`. The unique `(tenantId, path)` constraint is the
 * authority on collisions, enforced the same way `createItem` enforces its
 * code uniqueness: `onConflictDoNothing` and a null row on the way back out.
 */
export async function createFolder(tx: Transaction, input: CreateFolderInput): Promise<{ id: string }> {
  const { tenantId } = requireTenantContext();

  let path = `/${input.name}`;
  if (input.parentId) {
    const [parent] = await tx
      .select({ path: folder.path })
      .from(folder)
      .where(and(eq(folder.tenantId, tenantId), eq(folder.id, input.parentId), isNull(folder.deletedAt)));
    if (!parent) throw new DocumentError('Parent folder not found.');
    path = `${parent.path}/${input.name}`;
  }

  const [row] = await tx
    .insert(folder)
    .values({
      tenantId,
      parentId: input.parentId ?? null,
      name: input.name,
      path,
      ownerEntityType: input.ownerEntityType ?? null,
      ownerEntityId: input.ownerEntityId ?? null,
    })
    .onConflictDoNothing({ target: [folder.tenantId, folder.path] })
    .returning({ id: folder.id });

  if (!row) throw new DocumentError(`A folder already exists at "${path}".`);

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'kernel.folder',
    entityId: row.id,
    entityLabel: path,
    action: 'create',
  });

  return { id: row.id };
}

export async function listFolders(
  tx: Transaction,
  params: ListParams<FolderSort>,
  filters: { parentId?: string | null } = {},
): Promise<ListResult<FolderRow>> {
  const { tenantId } = requireTenantContext();

  const conditions = [eq(folder.tenantId, tenantId), isNull(folder.deletedAt)];
  if (filters.parentId !== undefined) {
    conditions.push(filters.parentId === null ? isNull(folder.parentId) : eq(folder.parentId, filters.parentId));
  }
  if (params.search) {
    conditions.push(ilike(folder.name, searchPattern(params.search)));
  }

  const where = and(...conditions);

  const sortColumn = { name: folder.name, path: folder.path, createdAt: folder.createdAt }[
    params.sort
  ] ?? folder.path;

  const rows = await tx
    .select({
      id: folder.id,
      name: folder.name,
      path: folder.path,
      parentId: folder.parentId,
      ownerEntityType: folder.ownerEntityType,
      ownerEntityId: folder.ownerEntityId,
      isSystem: folder.isSystem,
    })
    .from(folder)
    .where(where)
    .orderBy(params.direction === 'asc' ? asc(sortColumn) : desc(sortColumn), asc(folder.id))
    .limit(params.pageSize)
    .offset(params.offset);

  const [counted] = await tx.select({ total: sql<number>`count(*)::int` }).from(folder).where(where);

  return listResult(rows, counted?.total ?? 0, params);
}

// --- Documents ---------------------------------------------------------------

export interface DocumentRow {
  id: string;
  name: string;
  description: string | null;
  documentType: string | null;
  status: string;
  folderId: string | null;
  currentVersionId: string | null;
  versionCount: number;
  referenceNumber: string | null;
  revision: string | null;
  lockedBy: string | null;
  lockedByName: string | null;
  lockedAt: string | null;
  lockExpiresAt: string | null;
}

export const DOCUMENT_SORTS = ['name', 'createdAt', 'referenceNumber'] as const;
export type DocumentSort = (typeof DOCUMENT_SORTS)[number];

export async function listDocuments(
  tx: Transaction,
  params: ListParams<DocumentSort>,
  filters: { folderId?: string; entityType?: string; entityId?: string } = {},
): Promise<ListResult<DocumentRow>> {
  const { tenantId } = requireTenantContext();

  const conditions = [eq(document.tenantId, tenantId), isNull(document.deletedAt)];
  if (filters.folderId) conditions.push(eq(document.folderId, filters.folderId));
  // "Every document linked to this entity" joins through document_link — a
  // document can be linked to several entities, so this is a genuine
  // many-to-many, not a column on `document` itself. A subquery (rather than
  // an inner join + `selectDistinct`) sidesteps Postgres's rule that
  // `SELECT DISTINCT`'s `ORDER BY` expressions must appear in the select
  // list — the default sort is `createdAt`, which isn't part of the
  // narrower `DocumentRow` projection, so the join+distinct form 500s on
  // every request that doesn't happen to sort by a projected column.
  if (filters.entityType && filters.entityId) {
    conditions.push(
      inArray(
        document.id,
        tx
          .select({ documentId: documentLink.documentId })
          .from(documentLink)
          .where(
            and(
              eq(documentLink.entityType, filters.entityType),
              eq(documentLink.entityId, filters.entityId),
            ),
          ),
      ),
    );
  }
  if (params.search) {
    conditions.push(
      or(
        ilike(document.name, searchPattern(params.search)),
        ilike(document.referenceNumber, searchPattern(params.search)),
      )!,
    );
  }

  const where = and(...conditions);

  const sortColumn = {
    name: document.name,
    createdAt: document.createdAt,
    referenceNumber: document.referenceNumber,
  }[params.sort] ?? document.createdAt;

  const selection = {
    id: document.id,
    name: document.name,
    description: document.description,
    documentType: document.documentType,
    status: document.status,
    folderId: document.folderId,
    currentVersionId: document.currentVersionId,
    versionCount: document.versionCount,
    referenceNumber: document.referenceNumber,
    revision: document.revision,
    lockedBy: documentLock.lockedBy,
    lockedByName: appUser.name,
    lockedAt: sql<string | null>`${documentLock.lockedAt}`,
    lockExpiresAt: sql<string | null>`${documentLock.expiresAt}`,
  };

  const rows = await tx
    .select(selection)
    .from(document)
    .leftJoin(documentLock, eq(documentLock.documentId, document.id))
    .leftJoin(appUser, eq(appUser.id, documentLock.lockedBy))
    .where(where)
    .orderBy(params.direction === 'asc' ? asc(sortColumn) : desc(sortColumn), asc(document.id))
    .limit(params.pageSize)
    .offset(params.offset);

  const [counted] = await tx.select({ total: sql<number>`count(*)::int` }).from(document).where(where);

  return listResult(rows, counted?.total ?? 0, params);
}

// --- Upload / versions -------------------------------------------------------

export interface InitiateDocumentUploadInput {
  name: string;
  folderId?: string | null;
  documentType?: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  referenceNumber?: string | null;
  revision?: string | null;
}

export interface InitiateDocumentUploadResult {
  documentId: string;
  versionId: string;
  uploadUrl: string;
}

/**
 * Creates the document and its first version row, then mints a presigned PUT
 * URL for the browser to push the bytes to directly.
 *
 * `StorageNotConfiguredError` is allowed to propagate uncaught: the route
 * layer needs to tell "storage was never configured" (503) apart from a
 * genuine 500, and re-wrapping it as `DocumentError` would collapse that
 * distinction into the same 409 every other domain error gets.
 */
export async function initiateDocumentUpload(
  tx: Transaction,
  input: InitiateDocumentUploadInput,
): Promise<InitiateDocumentUploadResult> {
  const { tenantId, userId } = requireTenantContext();

  const [documentRow] = await tx
    .insert(document)
    .values({
      tenantId,
      folderId: input.folderId ?? null,
      name: input.name,
      documentType: input.documentType ?? null,
      status: 'uploading',
      referenceNumber: input.referenceNumber ?? null,
      revision: input.revision ?? null,
    })
    .returning({ id: document.id });
  const documentId = documentRow!.id;

  const storageKey = `${tenantId}/${documentId}/v1/${input.fileName}`;

  const [versionRow] = await tx
    .insert(documentVersion)
    .values({
      tenantId,
      documentId,
      version: 1,
      storageKey,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      checksum: '',
      uploadedBy: userId,
    })
    .returning({ id: documentVersion.id });
  const versionId = versionRow!.id;

  // Deliberately after both inserts: a caller who never gets a URL because R2
  // is unconfigured still leaves a `document`/`documentVersion` pair behind in
  // `uploading` status, exactly as if the presign had succeeded and the
  // browser upload had simply never happened — the same state a genuinely
  // abandoned upload leaves, not a special case housekeeping has to know about.
  const uploadUrl = await presignUploadUrl(storageKey, input.mimeType);

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'kernel.document',
    entityId: documentId,
    entityLabel: input.name,
    action: 'create',
  });

  return { documentId, versionId, uploadUrl };
}

export interface ConfirmDocumentUploadInput {
  documentId: string;
  versionId: string;
  checksum: string;
}

/** Marks an uploaded version as the current one, once the browser's PUT has landed. */
export async function confirmDocumentUpload(
  tx: Transaction,
  input: ConfirmDocumentUploadInput,
): Promise<void> {
  const { tenantId } = requireTenantContext();

  const [existing] = await tx
    .select({ id: document.id, versionCount: document.versionCount })
    .from(document)
    .where(and(eq(document.tenantId, tenantId), eq(document.id, input.documentId)));
  if (!existing) throw new DocumentError('Document not found.');

  const [version] = await tx
    .select({ id: documentVersion.id })
    .from(documentVersion)
    .where(
      and(
        eq(documentVersion.tenantId, tenantId),
        eq(documentVersion.id, input.versionId),
        eq(documentVersion.documentId, input.documentId),
      ),
    );
  if (!version) throw new DocumentError('Document version not found.');

  await tx
    .update(documentVersion)
    .set({ checksum: input.checksum, updatedAt: new Date() })
    .where(eq(documentVersion.id, input.versionId));

  await tx
    .update(document)
    .set({
      status: 'available',
      currentVersionId: input.versionId,
      versionCount: existing.versionCount + 1,
      updatedAt: new Date(),
    })
    .where(eq(document.id, input.documentId));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'kernel.document',
    entityId: input.documentId,
    action: 'update',
    reason: 'Upload confirmed.',
  });
}

export interface AddDocumentVersionInput {
  documentId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  changeNote?: string | null;
  /** Who is adding the version — checked against any active lock. */
  callerId: string;
}

/**
 * Starts a new version of an existing document, the same presign flow as the
 * first — refused outright if someone else holds the check-out lock.
 */
export async function addDocumentVersion(
  tx: Transaction,
  input: AddDocumentVersionInput,
): Promise<InitiateDocumentUploadResult> {
  const { tenantId } = requireTenantContext();

  const [existing] = await tx
    .select({ id: document.id, versionCount: document.versionCount })
    .from(document)
    .where(and(eq(document.tenantId, tenantId), eq(document.id, input.documentId), isNull(document.deletedAt)));
  if (!existing) throw new DocumentError('Document not found.');

  const [lock] = await tx
    .select({ lockedBy: documentLock.lockedBy })
    .from(documentLock)
    .where(eq(documentLock.documentId, input.documentId));
  if (lock && lock.lockedBy !== input.callerId) {
    throw new DocumentError('This document is checked out by someone else.');
  }

  const nextVersion = existing.versionCount + 1;
  const storageKey = `${tenantId}/${input.documentId}/v${nextVersion}/${input.fileName}`;

  const [versionRow] = await tx
    .insert(documentVersion)
    .values({
      tenantId,
      documentId: input.documentId,
      version: nextVersion,
      storageKey,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      checksum: '',
      uploadedBy: input.callerId,
      changeNote: input.changeNote ?? null,
    })
    .returning({ id: documentVersion.id });
  const versionId = versionRow!.id;

  await tx.update(document).set({ status: 'uploading', updatedAt: new Date() }).where(eq(document.id, input.documentId));

  const uploadUrl = await presignUploadUrl(storageKey, input.mimeType);

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'kernel.document',
    entityId: input.documentId,
    action: 'update',
    reason: `Version ${nextVersion} started.`,
  });

  return { documentId: input.documentId, versionId, uploadUrl };
}

export interface DocumentVersionRow {
  id: string;
  version: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  uploadedBy: string | null;
  uploadedByName: string | null;
  changeNote: string | null;
  createdAt: string;
}

/** Every version ever uploaded for a document, newest first — nothing is ever overwritten in place. */
export async function listDocumentVersions(
  tx: Transaction,
  documentId: string,
): Promise<DocumentVersionRow[]> {
  const { tenantId } = requireTenantContext();

  return tx
    .select({
      id: documentVersion.id,
      version: documentVersion.version,
      fileName: documentVersion.fileName,
      mimeType: documentVersion.mimeType,
      sizeBytes: documentVersion.sizeBytes,
      checksum: documentVersion.checksum,
      uploadedBy: documentVersion.uploadedBy,
      uploadedByName: appUser.name,
      changeNote: documentVersion.changeNote,
      createdAt: sql<string>`${documentVersion.createdAt}`,
    })
    .from(documentVersion)
    .leftJoin(appUser, eq(appUser.id, documentVersion.uploadedBy))
    .where(and(eq(documentVersion.tenantId, tenantId), eq(documentVersion.documentId, documentId)))
    .orderBy(desc(documentVersion.version));
}

export interface GetDocumentDownloadUrlInput {
  documentId: string;
  versionId?: string;
}

export async function getDocumentDownloadUrl(
  tx: Transaction,
  input: GetDocumentDownloadUrlInput,
): Promise<{ url: string; fileName: string }> {
  const { tenantId } = requireTenantContext();

  const [existing] = await tx
    .select({ currentVersionId: document.currentVersionId })
    .from(document)
    .where(and(eq(document.tenantId, tenantId), eq(document.id, input.documentId), isNull(document.deletedAt)));
  if (!existing) throw new DocumentError('Document not found.');

  const versionId = input.versionId ?? existing.currentVersionId;
  if (!versionId) throw new DocumentError('This document has no available version yet.');

  const [version] = await tx
    .select({ storageKey: documentVersion.storageKey, fileName: documentVersion.fileName })
    .from(documentVersion)
    .where(
      and(
        eq(documentVersion.tenantId, tenantId),
        eq(documentVersion.id, versionId),
        eq(documentVersion.documentId, input.documentId),
      ),
    );
  if (!version) throw new DocumentError('Document version not found.');

  const url = await presignDownloadUrl(version.storageKey, version.fileName);
  return { url, fileName: version.fileName };
}

/** Removes a document's stored object outright — used when purging a version. */
export async function deleteDocumentObject(storageKey: string): Promise<void> {
  await deleteObject(storageKey);
}

// --- Links -------------------------------------------------------------------

export interface LinkDocumentInput {
  documentId: string;
  entityType: string;
  entityId: string;
  moduleKey: string;
  linkType?: 'attachment' | 'primary' | 'signed_copy' | 'supporting';
  linkedBy?: string | null;
}

export async function linkDocument(tx: Transaction, input: LinkDocumentInput): Promise<{ id: string }> {
  const { tenantId } = requireTenantContext();

  const [existing] = await tx
    .select({ id: document.id })
    .from(document)
    .where(and(eq(document.tenantId, tenantId), eq(document.id, input.documentId), isNull(document.deletedAt)));
  if (!existing) throw new DocumentError('Document not found.');

  const [row] = await tx
    .insert(documentLink)
    .values({
      tenantId,
      documentId: input.documentId,
      entityType: input.entityType,
      entityId: input.entityId,
      moduleKey: input.moduleKey,
      linkType: input.linkType ?? 'attachment',
      linkedBy: input.linkedBy ?? null,
    })
    .onConflictDoNothing({
      target: [documentLink.documentId, documentLink.entityType, documentLink.entityId, documentLink.linkType],
    })
    .returning({ id: documentLink.id });

  if (!row) throw new DocumentError('This document is already linked to that record with that link type.');

  await recordAudit(tx, {
    moduleKey: input.moduleKey,
    entityType: 'kernel.document_link',
    entityId: row.id,
    entityLabel: `${input.entityType}:${input.entityId}`,
    action: 'create',
  });

  return { id: row.id };
}

export async function unlinkDocument(tx: Transaction, input: { linkId: string }): Promise<void> {
  const { tenantId } = requireTenantContext();

  const [row] = await tx
    .delete(documentLink)
    .where(and(eq(documentLink.tenantId, tenantId), eq(documentLink.id, input.linkId)))
    .returning({ id: documentLink.id, moduleKey: documentLink.moduleKey });
  if (!row) throw new DocumentError('Link not found.');

  await recordAudit(tx, {
    moduleKey: row.moduleKey,
    entityType: 'kernel.document_link',
    entityId: input.linkId,
    action: 'delete',
  });
}

// --- Lock / unlock -------------------------------------------------------------

export interface LockDocumentInput {
  documentId: string;
  lockedBy: string;
  minutes?: number;
  note?: string | null;
}

/** Checks a document out, refusing if someone else already has. */
export async function lockDocument(tx: Transaction, input: LockDocumentInput): Promise<void> {
  const { tenantId } = requireTenantContext();

  const [existing] = await tx
    .select({ id: document.id })
    .from(document)
    .where(and(eq(document.tenantId, tenantId), eq(document.id, input.documentId), isNull(document.deletedAt)));
  if (!existing) throw new DocumentError('Document not found.');

  const [lock] = await tx
    .select({ lockedBy: documentLock.lockedBy })
    .from(documentLock)
    .where(eq(documentLock.documentId, input.documentId));
  if (lock && lock.lockedBy !== input.lockedBy) {
    throw new DocumentError('This document is already checked out by someone else.');
  }

  const expiresAt = new Date(Date.now() + (input.minutes ?? DEFAULT_LOCK_MINUTES) * 60_000);

  await tx
    .insert(documentLock)
    .values({
      documentId: input.documentId,
      tenantId,
      lockedBy: input.lockedBy,
      expiresAt,
      note: input.note ?? null,
    })
    .onConflictDoUpdate({
      target: documentLock.documentId,
      set: { lockedBy: input.lockedBy, lockedAt: new Date(), expiresAt, note: input.note ?? null },
    });

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'kernel.document',
    entityId: input.documentId,
    action: 'update',
    reason: 'Checked out.',
  });
}

/** Checks a document back in. Only the lock holder may do this. */
export async function unlockDocument(tx: Transaction, input: { documentId: string; callerId: string }): Promise<void> {
  const { tenantId } = requireTenantContext();

  const [lock] = await tx
    .select({ lockedBy: documentLock.lockedBy })
    .from(documentLock)
    .where(and(eq(documentLock.tenantId, tenantId), eq(documentLock.documentId, input.documentId)));
  if (!lock) throw new DocumentError('This document is not checked out.');
  if (lock.lockedBy !== input.callerId) {
    throw new DocumentError('Only the person who checked this document out can check it back in.');
  }

  await tx.delete(documentLock).where(eq(documentLock.documentId, input.documentId));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'kernel.document',
    entityId: input.documentId,
    action: 'update',
    reason: 'Checked in.',
  });
}

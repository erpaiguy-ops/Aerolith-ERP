/**
 * Document management — kernel capability (your item 12).
 *
 * Every module attaches files, so this is built once. Documents are attached
 * polymorphically to any entity in any module, and access control INHERITS from
 * the parent entity rather than introducing a second permission system.
 *
 * Bytes live in Cloudflare R2 (zero egress); only metadata lives here.
 */
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { kernel, softDelete, tenantColumn, timestamps } from '../columns';

export const documentStatus = kernel.enum('document_status', [
  'uploading',
  'processing',
  'available',
  'quarantined',
  'failed',
]);

export const folder = kernel.table(
  'folder',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    /** Materialised path for cheap subtree queries: /projects/P-001/drawings */
    path: text('path').notNull(),
    /** Folders auto-created for an entity, e.g. every project gets a tree. */
    ownerEntityType: varchar('owner_entity_type', { length: 96 }),
    ownerEntityId: uuid('owner_entity_id'),
    isSystem: boolean('is_system').notNull().default(false),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    unique('folder_path_uq').on(t.tenantId, t.path),
    index('folder_parent_idx').on(t.tenantId, t.parentId),
  ],
);

export const document = kernel.table(
  'document',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    folderId: uuid('folder_id'),
    name: text('name').notNull(),
    description: text('description'),
    /** Tenant document type, e.g. 'shop_drawing', 'invoice', 'passport_copy'. */
    documentType: varchar('document_type', { length: 64 }),
    status: documentStatus('status').notNull().default('uploading'),

    currentVersionId: uuid('current_version_id'),
    versionCount: integer('version_count').notNull().default(0),

    /** Drawing register fields — null for ordinary documents. */
    referenceNumber: varchar('reference_number', { length: 64 }),
    revision: varchar('revision', { length: 16 }),

    /** Expiry-tracked documents (trade licence, insurance) link to the requirement. */
    requirementId: uuid('requirement_id'),
    expiresOn: date('expires_on'),

    tags: text('tags').array(),
    /** Populated by a background job; drives full-text search. */
    extractedText: text('extracted_text'),
    ocrCompletedAt: timestamp('ocr_completed_at', { withTimezone: true }),

    isConfidential: boolean('is_confidential').notNull().default(false),
    retainUntil: date('retain_until'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    index('document_folder_idx').on(t.tenantId, t.folderId),
    index('document_type_idx').on(t.tenantId, t.documentType),
    index('document_expiry_idx').on(t.tenantId, t.expiresOn),
    index('document_reference_idx').on(t.tenantId, t.referenceNumber, t.revision),
  ],
);

export const documentVersion = kernel.table(
  'document_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => document.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    /** Object key in R2. */
    storageKey: text('storage_key').notNull(),
    fileName: text('file_name').notNull(),
    mimeType: varchar('mime_type', { length: 128 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    /** SHA-256, for integrity and de-duplication. */
    checksum: varchar('checksum', { length: 64 }).notNull(),
    uploadedBy: uuid('uploaded_by'),
    changeNote: text('change_note'),
    ...timestamps(),
  },
  (t) => [
    unique('document_version_uq').on(t.documentId, t.version),
    index('document_version_checksum_idx').on(t.tenantId, t.checksum),
  ],
);

/** Polymorphic attachment — how any module links a document to its records. */
export const documentLink = kernel.table(
  'document_link',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => document.id, { onDelete: 'cascade' }),
    entityType: varchar('entity_type', { length: 96 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    moduleKey: varchar('module_key', { length: 64 }).notNull(),
    /** 'attachment' | 'primary' | 'signed_copy' | 'supporting'. */
    linkType: varchar('link_type', { length: 32 }).notNull().default('attachment'),
    linkedBy: uuid('linked_by'),
    ...timestamps(),
  },
  (t) => [
    unique('document_link_uq').on(t.documentId, t.entityType, t.entityId, t.linkType),
    index('document_link_entity_idx').on(t.tenantId, t.entityType, t.entityId),
  ],
);

/** Check-in / check-out, so two people cannot revise a drawing at once. */
export const documentLock = kernel.table(
  'document_lock',
  {
    documentId: uuid('document_id')
      .primaryKey()
      .references(() => document.id, { onDelete: 'cascade' }),
    tenantId: tenantColumn(),
    lockedBy: uuid('locked_by').notNull(),
    lockedAt: timestamp('locked_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    note: text('note'),
  },
  (t) => [index('document_lock_tenant_idx').on(t.tenantId)],
);

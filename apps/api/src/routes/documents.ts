/**
 * Documents — the kernel capability every module attaches files to.
 *
 * Reads are gated on `kernel.document.read`, writes on `kernel.document.manage`
 * — the same shape as master data. Uploads and downloads never carry file
 * bytes through this API: every endpoint that touches R2 hands back a
 * short-lived presigned URL and the browser talks to R2 directly (see
 * `packages/kernel/src/documents/storage.ts`).
 */
import {
  DOCUMENT_SORTS,
  DocumentError,
  FOLDER_SORTS,
  StorageNotConfiguredError,
  addDocumentVersion,
  confirmDocumentUpload,
  createFolder,
  getDocumentDownloadUrl,
  initiateDocumentUpload,
  linkDocument,
  listDocuments,
  listFolders,
  lockDocument,
  parseListParams,
  unlinkDocument,
  unlockDocument,
  withTenant,
} from '@aerolith/kernel';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { authenticate, requirePermission, withPrincipal } from '../context';

const LINK_TYPES = ['attachment', 'primary', 'signed_copy', 'supporting'] as const;

const createFolderBody = z.object({
  name: z.string().min(1),
  parentId: z.string().uuid().nullish(),
  ownerEntityType: z.string().min(1).nullish(),
  ownerEntityId: z.string().uuid().nullish(),
});

const uploadBody = z.object({
  name: z.string().min(1),
  folderId: z.string().uuid().nullish(),
  documentType: z.string().nullish(),
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  referenceNumber: z.string().nullish(),
  revision: z.string().nullish(),
});

const confirmBody = z.object({
  versionId: z.string().uuid(),
  checksum: z.string().min(1),
});

const versionBody = z.object({
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  changeNote: z.string().nullish(),
});

const linkBody = z.object({
  entityType: z.string().min(1),
  entityId: z.string().uuid(),
  moduleKey: z.string().min(1),
  linkType: z.enum(LINK_TYPES).optional(),
});

const lockBody = z.object({
  minutes: z.number().int().positive().optional(),
  note: z.string().nullish(),
});

/**
 * Maps the two error kinds this module can throw to their status codes.
 *
 * `StorageNotConfiguredError` is deliberately NOT a 409: it is not a data
 * conflict, it is a deployment that has not set its R2 environment variables
 * yet. 503 says "come back once this is configured", which 409 does not.
 */
function handleError(error: unknown, reply: FastifyReply) {
  if (error instanceof StorageNotConfiguredError) {
    return reply.code(503).send({ error: `Document storage is not configured: ${error.message}` });
  }
  if (error instanceof DocumentError) {
    return reply.code(409).send({ error: error.message });
  }
  throw error;
}

export async function documentRoutes(app: FastifyInstance) {
  // --- Folders ---------------------------------------------------------------

  app.get<{
    Querystring: {
      page?: string;
      pageSize?: string;
      sort?: string;
      direction?: string;
      q?: string;
      parentId?: string;
    };
  }>('/documents/folders', async (request) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.document.read');

    const params = parseListParams(request.query, {
      sortable: FOLDER_SORTS,
      defaultSort: 'path',
      defaultDirection: 'asc',
    });

    return withPrincipal(principal, () =>
      withTenant((tx) =>
        listFolders(tx, params, {
          parentId: request.query.parentId === 'root' ? null : request.query.parentId,
        }),
      ),
    );
  });

  app.post('/documents/folders', async (request, reply) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.document.manage');

    const parsed = createFolderBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      return await withPrincipal(principal, () => withTenant((tx) => createFolder(tx, parsed.data)));
    } catch (error) {
      return handleError(error, reply);
    }
  });

  // --- Documents ---------------------------------------------------------------

  app.get<{
    Querystring: {
      page?: string;
      pageSize?: string;
      sort?: string;
      direction?: string;
      q?: string;
      folderId?: string;
      entityType?: string;
      entityId?: string;
    };
  }>('/documents', async (request) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.document.read');

    const params = parseListParams(request.query, {
      sortable: DOCUMENT_SORTS,
      defaultSort: 'createdAt',
      defaultDirection: 'desc',
    });

    return withPrincipal(principal, () =>
      withTenant((tx) =>
        listDocuments(tx, params, {
          folderId: request.query.folderId,
          entityType: request.query.entityType,
          entityId: request.query.entityId,
        }),
      ),
    );
  });

  app.post('/documents/upload', async (request, reply) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.document.manage');

    const parsed = uploadBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      return await withPrincipal(principal, () =>
        withTenant((tx) => initiateDocumentUpload(tx, parsed.data)),
      );
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post<{ Params: { id: string } }>('/documents/:id/confirm', async (request, reply) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.document.manage');

    const parsed = confirmBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      await withPrincipal(principal, () =>
        withTenant((tx) =>
          confirmDocumentUpload(tx, { documentId: request.params.id, ...parsed.data }),
        ),
      );
    } catch (error) {
      return handleError(error, reply);
    }

    return { confirmed: true };
  });

  app.post<{ Params: { id: string } }>('/documents/:id/versions', async (request, reply) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.document.manage');

    const parsed = versionBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      return await withPrincipal(principal, () =>
        withTenant((tx) =>
          addDocumentVersion(tx, {
            documentId: request.params.id,
            ...parsed.data,
            callerId: principal.userId,
          }),
        ),
      );
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { versionId?: string } }>(
    '/documents/:id/download-url',
    async (request, reply) => {
      const principal = await authenticate(request);
      requirePermission(principal, 'kernel.document.read');

      try {
        return await withPrincipal(principal, () =>
          withTenant((tx) =>
            getDocumentDownloadUrl(tx, {
              documentId: request.params.id,
              versionId: request.query.versionId,
            }),
          ),
        );
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  // --- Links -------------------------------------------------------------------

  app.post<{ Params: { id: string } }>('/documents/:id/link', async (request, reply) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.document.manage');

    const parsed = linkBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      return await withPrincipal(principal, () =>
        withTenant((tx) =>
          linkDocument(tx, {
            documentId: request.params.id,
            ...parsed.data,
            linkedBy: principal.userId,
          }),
        ),
      );
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post<{ Params: { id: string; linkId: string } }>(
    '/documents/:id/link/:linkId/remove',
    async (request, reply) => {
      const principal = await authenticate(request);
      requirePermission(principal, 'kernel.document.manage');

      try {
        await withPrincipal(principal, () =>
          withTenant((tx) => unlinkDocument(tx, { linkId: request.params.linkId })),
        );
      } catch (error) {
        return handleError(error, reply);
      }

      return { removed: true };
    },
  );

  // --- Lock / unlock -------------------------------------------------------------

  app.post<{ Params: { id: string } }>('/documents/:id/lock', async (request, reply) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.document.manage');

    const parsed = lockBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      await withPrincipal(principal, () =>
        withTenant((tx) =>
          lockDocument(tx, {
            documentId: request.params.id,
            lockedBy: principal.userId,
            ...parsed.data,
          }),
        ),
      );
    } catch (error) {
      return handleError(error, reply);
    }

    return { locked: true };
  });

  app.post<{ Params: { id: string } }>('/documents/:id/unlock', async (request, reply) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.document.manage');

    try {
      await withPrincipal(principal, () =>
        withTenant((tx) => unlockDocument(tx, { documentId: request.params.id, callerId: principal.userId })),
      );
    } catch (error) {
      return handleError(error, reply);
    }

    return { unlocked: true };
  });
}

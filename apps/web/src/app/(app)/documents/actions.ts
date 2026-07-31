'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { requiredText, runAction, type ActionState } from '@/lib/actions';
import { ApiError, apiFetch } from '@/lib/api';

const LINK_TYPES = new Set(['attachment', 'primary', 'signed_copy', 'supporting']);

export async function createFolderAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const name = requiredText(form, 'name');
  if (!name) {
    return { status: 'error', error: 'A folder needs a name.' };
  }

  return runAction(
    () =>
      apiFetch('/documents/folders', {
        method: 'POST',
        body: { name, parentId: requiredText(form, 'parentId') },
      }),
    { revalidate: ['/documents'], success: `"${name}" created.` },
  );
}

/**
 * Attaches a document to a record in another module — `documentId` and
 * `linkType` travel as hidden fields, `entityType`/`entityId`/`moduleKey`
 * name what it is being attached to. The generic register on this page is
 * one caller; the intended long-run caller is a detail screen in whichever
 * module owns the record, reusing this same action.
 */
export async function linkDocumentAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const documentId = requiredText(form, 'documentId');
  const entityType = requiredText(form, 'entityType');
  const entityId = requiredText(form, 'entityId');
  const moduleKey = requiredText(form, 'moduleKey');
  if (!documentId || !entityType || !entityId || !moduleKey) {
    return {
      status: 'error',
      error: 'Linking a document needs which record — its type, id and owning module.',
    };
  }

  const linkTypeRaw = form.get('linkType');
  const linkType = typeof linkTypeRaw === 'string' && LINK_TYPES.has(linkTypeRaw) ? linkTypeRaw : undefined;

  return runAction(
    () =>
      apiFetch(`/documents/${documentId}/link`, {
        method: 'POST',
        body: { entityType, entityId, moduleKey, linkType },
      }),
    { revalidate: ['/documents'], success: 'Document linked.' },
  );
}

export async function unlinkDocumentAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const documentId = form.get('documentId');
  const linkId = form.get('linkId');
  if (typeof documentId !== 'string' || typeof linkId !== 'string') {
    return { status: 'error', error: 'That link could not be read. Reload and try again.' };
  }

  return runAction(
    () => apiFetch(`/documents/${documentId}/link/${linkId}/remove`, { method: 'POST' }),
    { revalidate: ['/documents'], success: 'Document unlinked.' },
  );
}

export interface UploadIntent {
  documentId: string;
  versionId: string;
  uploadUrl: string;
}

export interface UploadInput {
  name: string;
  folderId?: string | null;
  documentType?: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Called directly from `UploadButton` (a client component), not bound to a
 * `<form>` — this is the "get me a presigned URL" half of the flow. Returns a
 * plain error shape rather than throwing: `UploadButton` is not wrapped in
 * `useActionState`, so there is no `runAction` catching this for it.
 */
export async function initiateUploadAction(
  input: UploadInput,
): Promise<UploadIntent | { error: string }> {
  try {
    return await apiFetch<UploadIntent>('/documents/upload', { method: 'POST', body: input });
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    console.error('upload initiation failed', error);
    return { error: 'Something went wrong starting the upload. The failure has been logged.' };
  }
}

/**
 * The second half: called once the browser's raw `fetch(uploadUrl, { method:
 * 'PUT' })` against R2 has actually landed.
 */
export async function confirmUploadAction(input: {
  documentId: string;
  versionId: string;
  checksum: string;
}): Promise<{ ok: true } | { error: string }> {
  try {
    await apiFetch(`/documents/${input.documentId}/confirm`, {
      method: 'POST',
      body: { versionId: input.versionId, checksum: input.checksum },
    });
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    console.error('upload confirmation failed', error);
    return { error: 'Something went wrong confirming the upload. The failure has been logged.' };
  }

  revalidatePath('/documents');
  return { ok: true };
}

/**
 * Bound directly to a plain `<form action={downloadDocumentAction}>` — no
 * `useActionState`, because a download is a redirect, not a message. It
 * degrades the same way every form here does: without client JS the form
 * still posts and the redirect still happens, just as a full navigation
 * instead of one intercepted by the router.
 */
export async function downloadDocumentAction(form: FormData): Promise<void> {
  const documentId = form.get('documentId');
  if (typeof documentId !== 'string') return;

  const versionId = form.get('versionId');
  const query = typeof versionId === 'string' && versionId ? `?versionId=${versionId}` : '';

  const { url } = await apiFetch<{ url: string; fileName: string }>(
    `/documents/${documentId}/download-url${query}`,
  );
  redirect(url);
}

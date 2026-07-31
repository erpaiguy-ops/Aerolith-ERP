'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { confirmUploadAction, initiateUploadAction } from './actions';

/**
 * The one client component this slice needs.
 *
 * Everything else on the page is a server component; this exists because
 * uploading needs a real browser `fetch` — a raw `PUT` of the file straight
 * to the presigned R2 URL, never through the Fastify API. The three-step
 * dance:
 *
 *  1. Ask the server for `{ documentId, versionId, uploadUrl }`
 *     (`initiateUploadAction`, which calls `POST /documents/upload`).
 *  2. `fetch(uploadUrl, { method: 'PUT', body: file })` — straight to R2,
 *     never touching this app's own server.
 *  3. Confirm with the server (`confirmUploadAction`, `POST
 *     /documents/:id/confirm`), which is what flips the document to
 *     `available` and makes it show up in the list.
 *
 * The checksum is computed client-side with the Web Crypto API rather than
 * re-reading the file on the server, which would mean routing the bytes
 * through this app after all — exactly what the presigned-URL design exists
 * to avoid.
 */
export function UploadButton({ folderId }: { folderId?: string }) {
  const [status, setStatus] = useState<'idle' | 'uploading' | 'error' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function handleFile(file: File) {
    setStatus('uploading');
    setError(null);

    const intent = await initiateUploadAction({
      name: file.name,
      folderId: folderId ?? null,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
    });

    if ('error' in intent) {
      setStatus('error');
      setError(intent.error);
      return;
    }

    const put = await fetch(intent.uploadUrl, {
      method: 'PUT',
      body: file,
      headers: { 'content-type': file.type || 'application/octet-stream' },
    });

    if (!put.ok) {
      setStatus('error');
      setError('The upload to storage failed. Try again.');
      return;
    }

    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    const checksum = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');

    const confirmed = await confirmUploadAction({
      documentId: intent.documentId,
      versionId: intent.versionId,
      checksum,
    });

    if ('error' in confirmed) {
      setStatus('error');
      setError(confirmed.error);
      return;
    }

    setStatus('done');
    if (inputRef.current) inputRef.current.value = '';
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <input
        ref={inputRef}
        type="file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleFile(file);
        }}
        disabled={status === 'uploading'}
        className="text-sm"
      />
      {status === 'uploading' ? (
        <span className="text-sm text-(--color-muted)">Uploading…</span>
      ) : null}
      {status === 'error' ? <span className="text-sm text-(--color-bad)">{error}</span> : null}
      {status === 'done' ? <span className="text-sm text-(--color-good)">Uploaded.</span> : null}
    </div>
  );
}

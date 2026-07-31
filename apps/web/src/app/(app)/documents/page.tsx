import Link from 'next/link';

import { ActionForm, SubmitButton } from '@/components/Action';
import { EmptyList, Pager, fetchList, listQuery } from '@/components/List';
import { Badge, Card, Empty, PageHeader, Table, Td, Th } from '@/components/ui';
import { can } from '@/lib/actions';
import { pageFetch } from '@/lib/api';
import { getMe } from '@/lib/session';

import { createFolderAction, downloadDocumentAction, linkDocumentAction } from './actions';
import { UploadButton } from './UploadButton';

interface FolderRow {
  id: string;
  name: string;
  path: string;
  parentId: string | null;
  ownerEntityType: string | null;
  ownerEntityId: string | null;
  isSystem: boolean;
}

interface DocumentRow {
  id: string;
  name: string;
  description: string | null;
  documentType: string | null;
  status: 'uploading' | 'processing' | 'available' | 'quarantined' | 'failed';
  folderId: string | null;
  currentVersionId: string | null;
  versionCount: number;
  referenceNumber: string | null;
  revision: string | null;
}

const BASE = '/documents';

const STATUS_TONE = {
  available: 'good',
  uploading: 'neutral',
  processing: 'neutral',
  quarantined: 'bad',
  failed: 'bad',
} as const;

const field =
  'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1 text-sm outline-none focus:border-(--color-accent)';

/**
 * A folder browser and document register — the kernel capability every
 * module attaches files to, given its first screen. Folders and documents
 * share the `folderId` query parameter: it is both "list the subfolders of
 * this folder" and "list the documents in this folder", so navigating into a
 * folder and the document list scoping to it are the same click.
 *
 * Uploading is the one place this page needs real client JavaScript — see
 * `UploadButton`. Everything else here is a server component: search,
 * sorting and pagination are plain links, the same as every other register.
 */
export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const currentFolderId = query.folderId;

  const me = await getMe();
  const mayManage = can(me.permissions, 'kernel.document.manage') || me.user.isOwner;

  const [folders, documents] = await Promise.all([
    pageFetch<{ rows: FolderRow[] }>(
      `/documents/folders?parentId=${currentFolderId ?? 'root'}&pageSize=200&sort=name&direction=asc`,
    ),
    fetchList<DocumentRow>('/documents', query),
  ]);

  return (
    <>
      <PageHeader
        title="Documents"
        subtitle="The folder tree and register every module attaches files to — drawings, invoices, certificates, photos."
      />

      {currentFolderId ? (
        <p className="mb-4 text-sm">
          <Link href={BASE} className="text-(--color-accent) hover:underline">
            ← All folders
          </Link>
        </p>
      ) : null}

      <Card title="Folders" className="mb-6">
        {folders.rows.length === 0 ? (
          <Empty
            title="No subfolders here"
            detail={mayManage ? 'Add one below.' : undefined}
          />
        ) : (
          <Table
            head={
              <tr>
                <Th>Name</Th>
                <Th>Path</Th>
              </tr>
            }
          >
            {folders.rows.map((row) => (
              <tr key={row.id}>
                <Td>
                  <Link
                    href={`${BASE}?folderId=${row.id}`}
                    className="text-(--color-accent) hover:underline"
                  >
                    {row.name}
                  </Link>
                  {row.isSystem ? (
                    <Badge tone="neutral">
                      <span className="ms-1">system</span>
                    </Badge>
                  ) : null}
                </Td>
                <Td>
                  <span className="numeric text-xs text-(--color-muted)">{row.path}</span>
                </Td>
              </tr>
            ))}
          </Table>
        )}

        {mayManage ? (
          <ActionForm
            action={createFolderAction}
            className="mt-4 flex flex-wrap items-end gap-3 border-t border-(--color-line) pt-4"
          >
            <input type="hidden" name="parentId" value={currentFolderId ?? ''} />
            <label className="block">
              <span className="mb-1 block text-xs text-(--color-muted)">Folder name</span>
              <input name="name" dir="auto" placeholder="Drawings" className={field} />
            </label>
            <SubmitButton pendingLabel="Adding…">Add folder</SubmitButton>
          </ActionForm>
        ) : null}
      </Card>

      {mayManage ? (
        <Card title="Upload a document" className="mb-6">
          <UploadButton folderId={currentFolderId} />
        </Card>
      ) : null}

      <Card title="Documents">
        {documents.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['document', 'documents']}
            hint="Upload one above, or open a subfolder."
          />
        ) : (
          <Table
            head={
              <tr>
                <Th>Name</Th>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th>Reference</Th>
                <Th>Versions</Th>
                <Th />
              </tr>
            }
          >
            {documents.rows.map((row) => (
              <tr key={row.id}>
                <Td>
                  <span className="block">{row.name}</span>
                  {row.description ? (
                    <span className="text-xs text-(--color-muted)">{row.description}</span>
                  ) : null}
                </Td>
                <Td>{row.documentType ?? '—'}</Td>
                <Td>
                  <Badge tone={STATUS_TONE[row.status]}>{row.status.replace(/_/g, ' ')}</Badge>
                </Td>
                <Td>
                  <span className="numeric">
                    {row.referenceNumber ? `${row.referenceNumber}${row.revision ? ` rev ${row.revision}` : ''}` : '—'}
                  </span>
                </Td>
                <Td numeric>{row.versionCount}</Td>
                <Td>
                  <div className="flex flex-wrap items-center gap-2">
                    {row.status === 'available' ? (
                      <form action={downloadDocumentAction}>
                        <input type="hidden" name="documentId" value={row.id} />
                        <button
                          type="submit"
                          className="rounded-md border border-(--color-line) px-2.5 py-1 text-xs hover:bg-(--color-canvas)"
                        >
                          Download
                        </button>
                      </form>
                    ) : null}
                    {mayManage ? <LinkToRecordForm documentId={row.id} /> : null}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}

        <Pager base={BASE} query={query} result={documents} noun={['document', 'documents']} />
      </Card>
    </>
  );
}

/**
 * A compact, collapsed-by-default form for attaching a document to a record
 * elsewhere in the system — `kernel.document_link` is polymorphic, so this
 * register cannot know in advance which entity types exist to offer as a
 * dropdown, and asks for them as plain text instead. The primary way a
 * document gets linked is expected to be the OTHER module's own detail
 * screen, pre-filling all three fields; this is the fallback for doing it
 * from here.
 */
function LinkToRecordForm({ documentId }: { documentId: string }) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-(--color-muted) hover:text-(--color-fg)">Link…</summary>
      <ActionForm action={linkDocumentAction} className="mt-2 flex flex-col gap-1.5 sm:w-56">
        <input type="hidden" name="documentId" value={documentId} />
        <input name="entityType" placeholder="Entity type, e.g. project" className={field} />
        <input name="entityId" placeholder="Entity id" className={field} />
        <input name="moduleKey" placeholder="Module, e.g. projects" className={field} />
        <select name="linkType" defaultValue="attachment" className={field}>
          <option value="attachment">Attachment</option>
          <option value="primary">Primary</option>
          <option value="signed_copy">Signed copy</option>
          <option value="supporting">Supporting</option>
        </select>
        <SubmitButton pendingLabel="Linking…">Link</SubmitButton>
      </ActionForm>
    </details>
  );
}

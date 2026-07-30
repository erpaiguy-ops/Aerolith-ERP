import { EmptyList, FilterChips, Pager, SearchBox, fetchList, listQuery } from '@/components/List';
import { Badge, Bidi, Card, PageHeader, Stat, Table, Td, Th } from '@/components/ui';
import { datetime, integer } from '@/lib/format';

interface FieldChange {
  from: unknown;
  to: unknown;
}

interface AuditRow {
  id: string;
  occurredAt: string;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  actorType: string;
  moduleKey: string | null;
  entityType: string;
  entityId: string | null;
  entityLabel: string | null;
  action: string;
  changes: Record<string, FieldChange> | null;
  redactedFields: string[] | null;
  reason: string | null;
}

interface AuditExtra {
  entityTypes: string[];
  actions: string[];
}

const BASE = '/settings/audit';

const ACTION_TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  create: 'good',
  approve: 'good',
  post: 'good',
  submit: 'neutral',
  read: 'neutral',
  login: 'neutral',
  logout: 'neutral',
  export: 'neutral',
  update: 'neutral',
  reject: 'bad',
  delete: 'bad',
  cancel: 'bad',
  reverse: 'bad',
  permission_change: 'bad',
};

function actionLabel(action: string): string {
  return action.replace(/_/g, ' ');
}

/** One value from a change, as short prose rather than raw JSON. */
function shown(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * The audit trail, browsable.
 *
 * `recordAudit` has been called from every mutation across five modules since
 * they were built — the table has been filling up the whole time. Nothing
 * before this screen could read it back except a raw SQL client, which made
 * "who changed this" a question only whoever holds the database password
 * could answer.
 *
 * Redaction already happened when the row was written (see
 * `packages/kernel/src/audit/service.ts`), so a redacted field shows
 * `[redacted]` here because that is genuinely what was stored — this screen
 * has nothing further to hide.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = listQuery(await searchParams);
  const result = await fetchList<AuditRow, AuditExtra>('/admin/audit', query);

  return (
    <>
      <PageHeader
        title="Audit trail"
        subtitle="Every recorded change in this workspace, newest first."
      />

      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Stat label="Events" value={integer(result.total)} />
          <Stat label="Entity types touched" value={integer(result.entityTypes.length)} />
          <Stat label="Kinds of action recorded" value={integer(result.actions.length)} />
        </div>
      </Card>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <FilterChips
          base={BASE}
          query={query}
          param="entityType"
          options={[
            { label: 'All entities', value: null },
            ...result.entityTypes.map((type) => ({ label: type, value: type })),
          ]}
        />
        <SearchBox base={BASE} query={query} placeholder="Person, record or reason…" />
      </div>

      <div className="mb-4">
        <FilterChips
          base={BASE}
          query={query}
          param="action"
          options={[
            { label: 'All actions', value: null },
            ...result.actions.map((action) => ({ label: actionLabel(action), value: action })),
          ]}
        />
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyList
            query={query}
            noun={['event', 'events']}
            hint="Nothing has been recorded yet — this fills in as the modules you use are worked."
          />
        ) : (
          <Table
            head={
              <tr>
                <Th>When</Th>
                <Th>Who</Th>
                <Th>Action</Th>
                <Th>Record</Th>
                <Th>What changed</Th>
              </tr>
            }
          >
            {result.rows.map((row) => (
              <tr key={row.id} className="align-top">
                <Td>
                  <span className="numeric block">{datetime(row.occurredAt)}</span>
                </Td>
                <Td>
                  {row.actorName ? (
                    <>
                      <span className="block">{row.actorName}</span>
                      <span className="block text-xs text-(--color-muted)">{row.actorEmail}</span>
                    </>
                  ) : (
                    <Badge tone="neutral">{row.actorType}</Badge>
                  )}
                </Td>
                <Td>
                  <Badge tone={ACTION_TONE[row.action] ?? 'neutral'}>
                    <Bidi>{actionLabel(row.action)}</Bidi>
                  </Badge>
                </Td>
                <Td>
                  <span className="block">{row.entityType}</span>
                  {row.entityLabel ? (
                    <span className="block text-xs text-(--color-muted)">
                      <Bidi>{row.entityLabel}</Bidi>
                    </span>
                  ) : null}
                </Td>
                <Td>
                  {row.changes && Object.keys(row.changes).length > 0 ? (
                    <ul className="space-y-0.5 text-xs">
                      {Object.entries(row.changes).map(([field, change]) => (
                        <li key={field}>
                          <span className="text-(--color-muted)">{field}: </span>
                          <span className="numeric">{shown(change.from)}</span>
                          {' → '}
                          <span className="numeric">{shown(change.to)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-(--color-muted)">—</span>
                  )}
                  {row.reason ? (
                    <span className="mt-1 block text-xs text-(--color-muted)">
                      <Bidi>{row.reason}</Bidi>
                    </span>
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        )}

        <Pager base={BASE} query={query} result={result} noun={['event', 'events']} />
      </Card>
    </>
  );
}

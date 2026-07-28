import { notFound } from 'next/navigation';

import { Badge, Card, Empty, PageHeader, Table, Td, Th } from '@/components/ui';
import { ApiError, apiFetch } from '@/lib/api';
import { integer, percent } from '@/lib/format';

/**
 * The shop-floor board.
 *
 * Deliberately NOT a paged register. Every other screen in this app is a list
 * with a pager, because a list answers "find me the one I am looking for". This
 * answers "what is queued where", which is a shape — a foreman reads the whole
 * board at once and a page 2 would hide the station that is idle. The endpoint
 * already returns it grouped by work centre for the same reason.
 */
interface BoardOperation {
  operationId: string;
  workOrderNumber: string | null;
  description: string;
  sequence: number;
  name: string;
  status: string;
  priority: number;
  plannedMinutes: string | null;
  actualMinutes: string | null;
  completedQuantity: number;
}

interface BoardCentre {
  id: string;
  code: string;
  name: string;
  queue: BoardOperation[];
}

const STATUS_TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  in_progress: 'good',
  paused: 'bad',
};

export default async function BoardPage() {
  let board: { workCentres: BoardCentre[] };
  try {
    board = await apiFetch<{ workCentres: BoardCentre[] }>('/production/board');
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) notFound();
    throw error;
  }

  const queued = board.workCentres.reduce((total, centre) => total + centre.queue.length, 0);

  return (
    <>
      <PageHeader
        title="Shop floor"
        subtitle={
          queued === 0
            ? 'Nothing is queued at any station.'
            : `${queued} operation${queued === 1 ? '' : 's'} queued across ${board.workCentres.length} station${board.workCentres.length === 1 ? '' : 's'}.`
        }
      />

      {board.workCentres.length === 0 ? (
        <Empty
          title="No work at any station"
          detail="Operations appear here once a work order is released and its first operation is ready."
        />
      ) : (
        <div className="space-y-4">
          {board.workCentres.map((centre) => (
            <Card key={centre.id} title={`${centre.code} — ${centre.name}`}>
              <Table
                head={
                  <tr>
                    <Th>Order</Th>
                    <Th>Operation</Th>
                    <Th>Status</Th>
                    <Th numeric>Priority</Th>
                    <Th numeric>Time</Th>
                  </tr>
                }
              >
                {centre.queue.map((op) => {
                  const planned = Number(op.plannedMinutes ?? 0);
                  const actual = Number(op.actualMinutes ?? 0);
                  // Only meaningful once work has started. An operation showing
                  // "0 of 90 min" before anyone scans on looks like it is
                  // running late when it has not begun.
                  const over = actual > 0 && planned > 0 && actual > planned;

                  return (
                    <tr key={op.operationId} className="hover:bg-(--color-canvas)">
                      <Td>
                        <span className="numeric block">{op.workOrderNumber ?? '—'}</span>
                        <span className="text-xs text-(--color-muted)">{op.description}</span>
                      </Td>
                      <Td>
                        <span className="block">{op.name}</span>
                        <span className="numeric text-xs text-(--color-muted)">
                          {`step ${op.sequence}`}
                        </span>
                      </Td>
                      <Td>
                        <Badge tone={STATUS_TONE[op.status] ?? 'neutral'}>
                          {op.status.replace(/_/g, ' ')}
                        </Badge>
                        {op.completedQuantity > 0 ? (
                          <span className="block text-xs text-(--color-muted)">
                            {`${integer(op.completedQuantity)} done`}
                          </span>
                        ) : null}
                      </Td>
                      <Td numeric>
                        <span className="numeric">{integer(op.priority)}</span>
                      </Td>
                      <Td numeric>
                        {planned === 0 ? (
                          <span className="text-(--color-muted)">—</span>
                        ) : (
                          <>
                            <span className={over ? 'text-(--color-bad)' : ''}>
                              {`${integer(actual)} / ${integer(planned)} min`}
                            </span>
                            {actual > 0 ? (
                              <span className="block text-xs text-(--color-muted)">
                                {/* Derived from barcode scans, never a timesheet
                                    — which is what makes it worth showing. */}
                                {percent((actual / planned) * 100, 0)} of plan
                              </span>
                            ) : null}
                          </>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </Table>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

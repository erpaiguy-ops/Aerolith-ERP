import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, PageHeader, ProgressBar, Stat, Table, Td, Th } from '@/components/ui';
import { can } from '@/lib/actions';
import { ApiError, pageFetch } from '@/lib/api';
import { date, dimensions, integer, quantity } from '@/lib/format';
import { getMe } from '@/lib/session';

import { releaseWorkOrderAction } from './actions';

interface OperationProgress {
  state: string;
  completedQuantity: number;
  rejectedQuantity: number;
  reworkQuantity: number;
  activeMinutes: number;
  pausedMinutes: number;
  operators: string[];
}

interface Operation {
  id: string;
  sequence: number;
  name: string;
  workCentreCode: string;
  workCentreName: string;
  isQualityGate: boolean;
  progress: OperationProgress;
}

interface Part {
  id: string;
  partNumber: number;
  label: string;
  lengthMm: string;
  widthMm: string;
  thicknessMm: string | null;
  quantity: number;
  barcode: string | null;
  completedQuantity: number;
  rejectedQuantity: number;
}

interface WorkOrderDetail {
  order: {
    id: string;
    number: string | null;
    description: string;
    quantity: string;
    status: string;
    priority: number;
    plannedStartDate: string | null;
    plannedEndDate: string | null;
    actualStartAt: string | null;
    actualEndAt: string | null;
    holdReason: string | null;
    notes: string | null;
  };
  projectCode: string | null;
  projectName: string | null;
  itemCode: string | null;
  itemName: string | null;
  routingCode: string | null;
  routingName: string | null;
  operations: Operation[];
  progress: {
    percentComplete: number;
    currentOperationName: string | null;
    completedOperations: number;
    totalOperations: number;
    totalActiveMinutes: number;
    totalRejected: number;
    isBlocked: boolean;
    blockedReason: string | null;
  };
  scanCount: number;
  parts: Part[];
}

const STATUS_TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  completed: 'good',
  cancelled: 'bad',
  on_hold: 'bad',
};

const OP_STATUS_TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  completed: 'good',
  in_progress: 'good',
  paused: 'bad',
  skipped: 'bad',
};

/**
 * A work order, followed from routing to the floor.
 *
 * The list screen answers "which orders exist and roughly where they are" — this
 * answers "what is actually happening on this one": which operation it is
 * sitting at, who has scanned against it, and whether a failed quality gate is
 * quietly blocking every station behind it. All of it is derived from scans
 * (see `packages/modules/production/src/domain/progress.ts`), never from a
 * status somebody remembered to update.
 *
 * Releasing is the only write this screen offers. Scanning happens at the
 * machine, against a barcode — a web form re-typing "start operation 3" is not
 * how a saw operator works, and building one here would be a screen for a user
 * who does not exist.
 */
export default async function WorkOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getMe();
  const mayRelease = can(me.permissions, 'production.work_order.release') || me.user.isOwner;

  let detail: WorkOrderDetail;
  try {
    detail = await pageFetch<WorkOrderDetail>(`/production/work-orders/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) notFound();
    throw error;
  }

  const { order } = detail;
  const canRelease = order.status === 'draft' || order.status === 'planned';
  const targetQuantity = integer(Number(order.quantity));

  const plans = await pageFetch<{ rows: { id: string; version: number }[] }>(
    `/production/cutting-plans?workOrderId=${order.id}&pageSize=1&sort=createdAt&direction=desc`,
  );
  const latestPlan = plans.rows[0] ?? null;

  return (
    <>
      <PageHeader
        title={order.number ?? 'Unnumbered work order'}
        subtitle={[
          order.description,
          detail.projectCode ? `${detail.projectCode} · ${detail.projectName}` : null,
          detail.routingCode ? `routing ${detail.routingCode}` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          mayRelease && canRelease ? (
            <ActionForm action={releaseWorkOrderAction}>
              <input type="hidden" name="workOrderId" value={order.id} />
              <SubmitButton pendingLabel="Releasing…">Release to the floor</SubmitButton>
            </ActionForm>
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Link href="/production/orders" className="text-(--color-accent) hover:underline">
          ← All work orders
        </Link>
        <Badge tone={STATUS_TONE[order.status] ?? 'neutral'}>{order.status.replace(/_/g, ' ')}</Badge>
        {order.holdReason ? <span className="text-(--color-bad)">{order.holdReason}</span> : null}
        {detail.progress.isBlocked ? (
          // A failed quality gate blocks everything behind it — surfaced here
          // rather than discovered at packing.
          <Badge tone="bad">{detail.progress.blockedReason ?? 'blocked by a failed gate'}</Badge>
        ) : null}
        {latestPlan ? (
          <Link
            href={`/production/cutlist/${latestPlan.id}`}
            className="text-(--color-accent) hover:underline"
          >
            {`Cutting plan v${latestPlan.version} →`}
          </Link>
        ) : (
          <span className="text-(--color-muted)">not planned yet</span>
        )}
      </div>

      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat
            label="Operations"
            value={`${integer(detail.progress.completedOperations)} of ${integer(detail.progress.totalOperations)}`}
            hint={detail.progress.currentOperationName ? `at ${detail.progress.currentOperationName}` : 'not started'}
          />
          <Stat label="Quantity" value={quantity(order.quantity)} />
          <Stat
            label="Active time"
            value={`${integer(detail.progress.totalActiveMinutes)} min`}
            hint={`${integer(detail.scanCount)} scans recorded`}
          />
          <Stat
            label="Rejected"
            value={integer(detail.progress.totalRejected)}
            tone={detail.progress.totalRejected > 0 ? 'bad' : 'neutral'}
          />
        </div>
        <div className="mt-3">
          <ProgressBar value={detail.progress.percentComplete} />
        </div>
      </Card>

      <Card title="Details" className="mb-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-(--color-muted)">Item</dt>
            <dd>{detail.itemCode ? `${detail.itemCode} — ${detail.itemName}` : '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-(--color-muted)">Priority</dt>
            {/* Lower runs first — the field that decides the queue when two
                orders want the same saw. */}
            <dd className="numeric">{integer(order.priority)}</dd>
          </div>
          <div>
            <dt className="text-xs text-(--color-muted)">Planned</dt>
            <dd>{`${date(order.plannedStartDate)} → ${date(order.plannedEndDate)}`}</dd>
          </div>
          <div>
            <dt className="text-xs text-(--color-muted)">Actual</dt>
            <dd>
              {order.actualStartAt
                ? `${date(order.actualStartAt)} → ${order.actualEndAt ? date(order.actualEndAt) : 'in progress'}`
                : 'not started'}
            </dd>
          </div>
          {order.notes ? (
            <div className="col-span-2 sm:col-span-3">
              <dt className="text-xs text-(--color-muted)">Notes</dt>
              <dd className="whitespace-pre-wrap">{order.notes}</dd>
            </div>
          ) : null}
        </dl>
      </Card>

      <Card title="Operations" className="mb-4">
        <Table
          head={
            <tr>
              <Th>Step</Th>
              <Th>Work centre</Th>
              <Th>Status</Th>
              <Th numeric>Done / target</Th>
              <Th numeric>Time</Th>
              <Th>Who</Th>
            </tr>
          }
        >
          {detail.operations.map((op) => (
            <tr key={op.id}>
              <Td>
                <span className="block">{`${op.sequence}. ${op.name}`}</span>
                {op.isQualityGate ? (
                  <span className="mt-0.5 block">
                    <Badge tone="neutral">quality gate</Badge>
                  </span>
                ) : null}
              </Td>
              <Td>{`${op.workCentreCode} — ${op.workCentreName}`}</Td>
              <Td>
                <Badge tone={OP_STATUS_TONE[op.progress.state] ?? 'neutral'}>
                  {op.progress.state.replace(/_/g, ' ')}
                </Badge>
              </Td>
              <Td numeric>
                <span className="numeric">{`${integer(op.progress.completedQuantity)} / ${targetQuantity}`}</span>
                {op.progress.rejectedQuantity > 0 ? (
                  <span className="block text-xs text-(--color-bad)">
                    {`${integer(op.progress.rejectedQuantity)} rejected`}
                  </span>
                ) : null}
                {op.progress.reworkQuantity > 0 ? (
                  <span className="block text-xs text-(--color-muted)">
                    {`${integer(op.progress.reworkQuantity)} reworked`}
                  </span>
                ) : null}
              </Td>
              <Td numeric>
                <span className="numeric">{`${integer(op.progress.activeMinutes)} min`}</span>
                {op.progress.pausedMinutes > 0 ? (
                  <span className="numeric block text-xs text-(--color-muted)">
                    {`${integer(op.progress.pausedMinutes)} paused`}
                  </span>
                ) : null}
              </Td>
              <Td>
                {op.progress.operators.length > 0 ? (
                  op.progress.operators.join(', ')
                ) : (
                  <span className="text-(--color-muted)">—</span>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      {detail.parts.length > 0 ? (
        <Card title="Parts">
          <Table
            head={
              <tr>
                <Th>Part</Th>
                <Th numeric>Size (mm)</Th>
                <Th numeric>Qty</Th>
                <Th>Barcode</Th>
                <Th numeric>Done / rejected</Th>
              </tr>
            }
          >
            {detail.parts.map((part) => (
              <tr key={part.id}>
                <Td>
                  <span className="numeric block">{`#${part.partNumber}`}</span>
                  <span className="text-xs text-(--color-muted)">{part.label}</span>
                </Td>
                <Td numeric>{dimensions(part.lengthMm, part.widthMm, part.thicknessMm)}</Td>
                <Td numeric>{integer(part.quantity)}</Td>
                <Td>
                  <span className="numeric">{part.barcode ?? '—'}</span>
                </Td>
                <Td numeric>
                  <span className="numeric">{integer(part.completedQuantity)}</span>
                  {part.rejectedQuantity > 0 ? (
                    <span className="numeric block text-xs text-(--color-bad)">
                      {`${integer(part.rejectedQuantity)} rejected`}
                    </span>
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      ) : null}
    </>
  );
}

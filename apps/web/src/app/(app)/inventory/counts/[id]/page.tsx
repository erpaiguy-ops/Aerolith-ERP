import { notFound } from 'next/navigation';

import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, PageHeader, Stat, Table, Td, Th } from '@/components/ui';
import { can } from '@/lib/actions';
import { ApiError, pageFetch } from '@/lib/api';
import { date, quantity } from '@/lib/format';
import { getMe } from '@/lib/session';

import {
  generateCountSheetAction,
  reconcileStockCountAction,
  recordCountLineAction,
} from '../actions';

interface CountLine {
  id: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  binCode: string | null;
  batchCode: string | null;
  systemQuantity: string;
  countedQuantity: string | null;
  variance: string | null;
  varianceReason: string | null;
  countedAt: string | null;
}

interface CountDetail {
  id: string;
  number: string | null;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  status: string;
  countDate: string;
  adjustmentMovementId: string | null;
  postedAt: string | null;
  notes: string | null;
  lines: CountLine[];
}

const STATUS_TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  posted: 'good',
  cancelled: 'bad',
};

export default async function StockCountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getMe();
  const mayReconcile = can(me.permissions, 'inventory.stock_count.reconcile') || me.user.isOwner;

  let count: CountDetail;
  try {
    count = await pageFetch<CountDetail>(`/inventory/counts/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) notFound();
    throw error;
  }

  const countedLines = count.lines.filter((l) => l.countedQuantity != null).length;
  const varianceLines = count.lines.filter(
    (l) => l.countedQuantity != null && Number(l.variance) !== 0,
  ).length;

  return (
    <>
      <PageHeader
        title={count.number ?? 'Stock count'}
        subtitle={`${count.warehouseCode} — ${count.warehouseName} · ${date(count.countDate)}`}
      />

      <Card className="mb-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat
            label="Status"
            value={<Badge tone={STATUS_TONE[count.status] ?? 'neutral'}>{count.status.replace(/_/g, ' ')}</Badge>}
          />
          <Stat label="Lines" value={String(count.lines.length)} />
          <Stat label="Counted" value={`${countedLines} of ${count.lines.length}`} />
          <Stat
            label="Lines that varied"
            value={String(varianceLines)}
            tone={varianceLines > 0 ? 'bad' : 'neutral'}
          />
        </div>
      </Card>

      {count.status === 'draft' && mayReconcile ? (
        <Card
          className="mb-6"
          title="Generate the count sheet"
          footnote="Freezes the book quantity per line at this instant — the moment a counted figure starts meaning something."
        >
          <ActionForm action={generateCountSheetAction.bind(null, id)}>
            <SubmitButton pendingLabel="Generating…">Generate count sheet</SubmitButton>
          </ActionForm>
        </Card>
      ) : null}

      {count.status === 'draft' ? null : (
        <Card
          title="Count sheet"
          className="mb-6"
          footnote={
            count.status === 'pending_approval'
              ? 'Every line is counted. Reconcile below to post the variance to the stock ledger.'
              : count.status === 'counting'
                ? 'Enter what was actually found. Zero is a valid count — it means the shelf is empty, not that it was skipped.'
                : undefined
          }
        >
          <Table
            head={
              <tr>
                <Th>Item</Th>
                <Th>Bin / batch</Th>
                <Th numeric>Book</Th>
                <Th numeric>Counted</Th>
                <Th numeric>Variance</Th>
                {mayReconcile && count.status !== 'posted' ? <Th /> : null}
              </tr>
            }
          >
            {count.lines.map((line) => {
              const variance = line.variance == null ? null : Number(line.variance);
              const editable = mayReconcile && (count.status === 'counting' || count.status === 'pending_approval');

              return (
                <tr key={line.id}>
                  <Td>
                    <span className="numeric block">{line.itemCode}</span>
                    <span className="block text-xs text-(--color-muted)">{line.itemName}</span>
                  </Td>
                  <Td>
                    <span className="text-xs text-(--color-muted)">
                      {[line.binCode, line.batchCode].filter(Boolean).join(' · ') || '—'}
                    </span>
                  </Td>
                  <Td numeric>{quantity(line.systemQuantity)}</Td>
                  <Td numeric>
                    {line.countedQuantity == null ? (
                      <span className="text-(--color-muted)">not yet counted</span>
                    ) : (
                      quantity(line.countedQuantity)
                    )}
                  </Td>
                  <Td numeric>
                    {variance == null ? (
                      <span className="text-(--color-muted)">—</span>
                    ) : (
                      <span
                        className={variance === 0 ? 'text-(--color-muted)' : variance > 0 ? '' : 'text-(--color-bad)'}
                      >
                        {variance > 0 ? `+${quantity(variance)}` : quantity(variance)}
                      </span>
                    )}
                    {line.varianceReason ? (
                      <span className="block text-xs text-(--color-muted)">{line.varianceReason}</span>
                    ) : null}
                  </Td>
                  {mayReconcile && count.status !== 'posted' ? (
                    <Td>
                      {editable ? (
                        <ActionForm
                          action={recordCountLineAction.bind(null, id)}
                          className="flex items-center gap-1.5"
                        >
                          <input type="hidden" name="countLineId" value={line.id} />
                          <input
                            type="number"
                            name="countedQuantity"
                            step="0.0001"
                            min={0}
                            defaultValue={line.countedQuantity ?? undefined}
                            className="w-24 rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1 text-xs outline-none focus:border-(--color-accent)"
                          />
                          <input
                            type="text"
                            name="varianceReason"
                            dir="auto"
                            placeholder="Reason (optional)"
                            defaultValue={line.varianceReason ?? ''}
                            className="w-36 rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1 text-xs outline-none focus:border-(--color-accent)"
                          />
                          <SubmitButton pendingLabel="…">Save</SubmitButton>
                        </ActionForm>
                      ) : null}
                    </Td>
                  ) : null}
                </tr>
              );
            })}
          </Table>
        </Card>
      )}

      {count.status === 'pending_approval' && mayReconcile ? (
        <Card
          title="Reconcile"
          footnote="Posts one adjustment movement for every line that varied — a line that matched the book exactly is left alone. This is the only way the ledger changes to match what was actually found."
        >
          <ActionForm action={reconcileStockCountAction.bind(null, id)} className="flex items-end gap-3">
            <div className="flex-1">
              <label htmlFor="notes" className="mb-1 block text-xs text-(--color-muted)">
                Notes (optional)
              </label>
              <input
                id="notes"
                name="notes"
                dir="auto"
                className="w-full rounded-md border border-(--color-line) bg-(--color-surface) px-3 py-1.5 text-sm outline-none focus:border-(--color-accent)"
              />
            </div>
            <SubmitButton pendingLabel="Reconciling…">Reconcile</SubmitButton>
          </ActionForm>
        </Card>
      ) : null}

      {count.status === 'posted' ? (
        <Card>
          <p className="text-sm text-(--color-muted)">
            Posted {count.postedAt ? date(count.postedAt) : ''}.{' '}
            {count.adjustmentMovementId
              ? 'An adjustment movement carried the variance to the ledger.'
              : 'Every counted line matched the book exactly — nothing was posted.'}
          </p>
        </Card>
      ) : null}
    </>
  );
}

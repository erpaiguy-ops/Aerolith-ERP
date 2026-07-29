import { notFound } from 'next/navigation';

import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, Money, PageHeader, Stat, Table, Td, Th } from '@/components/ui';
import { can, requiredText, runAction, type ActionState } from '@/lib/actions';
import { ApiError, apiFetch, apiFetchOptional, pageFetch } from '@/lib/api';
import { date } from '@/lib/format';
import { getMe } from '@/lib/session';

interface OrderPosition {
  purchaseOrderId: string;
  number: string;
  status: string;
  supplierId: string;
  grossValue: number;
  baseValue: number;
  outstandingValue: number;
  lines: {
    id: string;
    lineNumber: number;
    description: string;
    quantityOrdered: number;
    quantityReceived: number;
    quantityInvoiced: number;
    availableToBill: number;
    outstanding: number;
    unitPrice: number;
    lineValue: number;
  }[];
}

/**
 * Issues the order to the supplier.
 *
 * The side effect is the point and it is stated on the button: issuing
 * registers the order as a commitment against the project budget. Ordered money
 * is spent money as far as a forecast is concerned, and a user who does not know
 * that is about to happen will not understand why the job's numbers moved.
 */
async function issue(id: string, _state: ActionState, _form: FormData): Promise<ActionState> {
  'use server';

  return runAction(
    () => apiFetch(`/procurement/orders/${id}/issue`, { method: 'POST' }),
    {
      revalidate: [`/procurement/orders/${id}`, '/procurement/orders', '/projects'],
      success: 'Issued. The commitment is registered against the budget.',
    },
  );
}

/**
 * Records a delivery against the order.
 *
 * The over-delivery check runs BEFORE anything is written, so an excess is a
 * decision taken at the gate while the lorry is still there rather than a report
 * read the next morning. It is accepted and flagged, not refused: the goods are
 * physically on site either way, and a system that refuses to record what is
 * standing in the yard just gets worked around.
 *
 * A blank quantity is not a zero. Lines are only sent when a figure was typed,
 * because posting zero for every untouched line would write a receipt claiming
 * nothing arrived — and, worse, one that looks deliberate.
 */
async function receive(
  id: string,
  countryCode: string,
  lines: { id: string; outstanding: number }[],
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  'use server';

  const received: Record<string, unknown>[] = [];

  for (const line of lines) {
    const raw = form.get(`${line.id}.qty`);
    if (typeof raw !== 'string' || raw.trim() === '') continue;

    const quantityReceived = Number(raw);
    if (!Number.isFinite(quantityReceived) || quantityReceived === 0) continue;

    const rejectedRaw = form.get(`${line.id}.rejected`);
    const quantityRejected =
      typeof rejectedRaw === 'string' && rejectedRaw.trim() !== '' ? Number(rejectedRaw) : 0;

    received.push({
      purchaseOrderLineId: line.id,
      quantityReceived,
      quantityRejected: Number.isFinite(quantityRejected) ? quantityRejected : 0,
      rejectionReason: requiredText(form, `${line.id}.reason`) ?? undefined,
    });
  }

  if (received.length === 0) {
    return {
      status: 'error',
      error: 'Nothing was entered. Put a quantity against at least one line.',
    };
  }

  let flagged = false;
  let accrued = 0;

  const state = await runAction(
    async () => {
      const result = await pageFetch<{
        number: string;
        overDelivered: boolean;
        accrualValue: number;
        stockPosted: boolean;
        costAccrued: boolean;
        exceptions: { message: string }[];
      }>(`/procurement/orders/${id}/receipts`, {
        method: 'POST',
        body: {
          countryCode,
          receivedOn: String(form.get('receivedOn') ?? '') || undefined,
          warehouseId: (form.get('warehouseId') as string) || undefined,
          deliveryNoteReference: requiredText(form, 'deliveryNoteReference') ?? undefined,
          inspectionNotes: requiredText(form, 'inspectionNotes') ?? undefined,
          lines: received,
        },
      });
      flagged = result.overDelivered;
      accrued = result.accrualValue;
      return result;
    },
    {
      revalidate: [
        `/procurement/orders/${id}`,
        '/procurement/orders',
        '/procurement/receipts',
        // The job was charged the moment this landed.
        '/projects',
      ],
      success: 'Received.',
    },
  );

  // No over-delivery warning composed here, deliberately. Receiving the last of
  // an order makes it no longer receivable, so this whole card — form and status
  // element together — is removed before anything could read the message. The
  // flag lives on the delivery itself and is rendered by the Deliveries card
  // below, which survives.
  void flagged;
  void accrued;
  return state;
}

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getMe();

  let position: OrderPosition;
  try {
    position = await pageFetch<OrderPosition>(`/procurement/orders/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) notFound();
    throw error;
  }

  const currency = me.tenant.currencyCode;
  const isDraft = position.status === 'draft';
  const mayIssue = can(me.permissions, 'procurement.order.issue');
  const mayReceive = can(me.permissions, 'procurement.receipt.write');

  // Open for delivery: issued or part-received, with something still outstanding.
  const outstanding = position.lines.filter((line) => line.outstanding > 0);
  const receivable =
    outstanding.length > 0 &&
    (position.status === 'issued' || position.status === 'partially_received');

  // Only when Inventory is entitled. Without it the receipt still records and
  // still accrues the cost — there is simply nowhere to put the stock, which is
  // exactly what a procurement-only tenant expects.
  const warehouses = receivable
    ? await apiFetchOptional<{ warehouses: { id: string; code: string; name: string }[] }>(
        '/inventory/warehouses',
      )
    : null;

  // This order's delivery history. The durable home for the over-delivery flag:
  // it is a fact about a delivery, and the receive form that reported it
  // disappears the moment the order is fully received.
  const deliveries = await apiFetchOptional<{
    rows: {
      id: string;
      number: string | null;
      receivedOn: string;
      deliveryNoteReference: string | null;
      overDelivered: boolean;
      lineCount: number;
      accrualValue: number;
    }[];
  }>(`/procurement/receipts?purchaseOrderId=${id}&pageSize=25`);

  const today = new Date().toISOString().slice(0, 10);
  const field =
    'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-3 py-1.5 text-sm outline-none focus:border-(--color-accent)';

  return (
    <>
      <PageHeader
        title={position.number || 'Purchase order'}
        subtitle={`${position.status.replace(/_/g, ' ')} · ${position.lines.length} line${
          position.lines.length === 1 ? '' : 's'
        }`}
      />

      {isDraft ? (
        <Card className="mb-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Not yet issued</p>
              <p className="mt-1 text-sm text-(--color-muted)">
                Issuing commits the company to{' '}
                <Money amount={position.grossValue} currency={currency} /> and registers it
                against the project budget.
              </p>
            </div>
            {mayIssue ? (
              <ActionForm action={issue.bind(null, id)}>
                <SubmitButton pendingLabel="Issuing…">Issue to supplier</SubmitButton>
              </ActionForm>
            ) : (
              <p className="text-sm text-(--color-muted)">
                You do not have permission to issue a purchase order.
              </p>
            )}
          </div>
        </Card>
      ) : null}

      {receivable && mayReceive ? (
        <Card
          title="Receive a delivery"
          className="mb-6"
          footnote="Leave a line blank if none of it arrived. A blank is not a zero — sending zero would record a delivery claiming nothing came, which reads as deliberate."
        >
          <ActionForm
            action={receive.bind(
              null,
              id,
              me.tenant.countryCode ?? 'AE',
              outstanding.map((line) => ({ id: line.id, outstanding: line.outstanding })),
            )}
          >
            <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <label htmlFor="receivedOn" className="mb-1 block text-xs text-(--color-muted)">
                  Received on
                </label>
                <input
                  id="receivedOn"
                  name="receivedOn"
                  type="date"
                  defaultValue={today}
                  className={field}
                />
              </div>
              <div>
                <label
                  htmlFor="deliveryNoteReference"
                  className="mb-1 block text-xs text-(--color-muted)"
                >
                  Delivery note
                </label>
                <input id="deliveryNoteReference" name="deliveryNoteReference" className={field} />
              </div>
              {warehouses && warehouses.warehouses.length > 0 ? (
                <div>
                  <label htmlFor="warehouseId" className="mb-1 block text-xs text-(--color-muted)">
                    Into
                  </label>
                  <select id="warehouseId" name="warehouseId" className={field}>
                    {warehouses.warehouses.map((warehouse) => (
                      <option key={warehouse.id} value={warehouse.id}>
                        {warehouse.code} — {warehouse.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <div>
                <label
                  htmlFor="inspectionNotes"
                  className="mb-1 block text-xs text-(--color-muted)"
                >
                  Inspection notes
                </label>
                <input id="inspectionNotes" name="inspectionNotes" className={field} />
              </div>
            </div>

            <div className="space-y-3">
              {outstanding.map((line) => (
                <div
                  key={line.id}
                  className="grid gap-3 border-t border-(--color-line) pt-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)]"
                >
                  <div>
                    <span className="block text-sm">{line.description}</span>
                    <span className="text-xs text-(--color-muted)">
                      <span className="numeric">{line.outstanding}</span> still to come of{' '}
                      <span className="numeric">{line.quantityOrdered}</span>
                    </span>
                  </div>
                  <label className="block">
                    <span className="mb-1 block text-xs text-(--color-muted)">Received</span>
                    <input
                      name={`${line.id}.qty`}
                      type="number"
                      step="any"
                      min={0}
                      // Deliberately NOT capped at the outstanding quantity. Over-
                      // delivery happens, the goods are in the yard either way,
                      // and a form that refuses to record what physically arrived
                      // just gets worked around. It is accepted and flagged.
                      placeholder={String(line.outstanding)}
                      className={field}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-(--color-muted)">Rejected</span>
                    <input
                      name={`${line.id}.rejected`}
                      type="number"
                      step="any"
                      min={0}
                      className={field}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-(--color-muted)">
                      Reason, if rejected
                    </span>
                    <input name={`${line.id}.reason`} className={field} />
                  </label>
                </div>
              ))}
            </div>

            <div className="mt-4">
              <SubmitButton pendingLabel="Receiving…">Record delivery</SubmitButton>
              <p className="mt-2 text-xs text-(--color-muted)">
                Takes the accepted quantity into stock and charges the job on the delivery date —
                not whenever the supplier gets round to invoicing.
              </p>
            </div>
          </ActionForm>
        </Card>
      ) : null}

      <Card title="Position" className="mb-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Order value" value={<Money amount={position.grossValue} currency={currency} />} />
          <Stat
            label="Outstanding"
            value={<Money amount={position.outstandingValue} currency={currency} />}
            hint="ordered, not yet delivered"
          />
          <Stat
            label="Status"
            value={
              <Badge tone={position.status === 'received' ? 'good' : 'neutral'}>
                {position.status.replace(/_/g, ' ')}
              </Badge>
            }
          />
          <Stat
            label="Billable now"
            value={String(position.lines.reduce((total, l) => total + l.availableToBill, 0))}
            hint="received, not yet invoiced"
          />
        </div>
      </Card>

      {deliveries && deliveries.rows.length > 0 ? (
        <Card
          title="Deliveries"
          className="mb-6"
          footnote="Charged to the job on the delivery date, not when the supplier invoices. An over-delivery is flagged here permanently — it is a fact about the delivery, and it outlives the form that reported it."
        >
          <Table
            head={
              <tr>
                <Th>GRN</Th>
                <Th>Received</Th>
                <Th numeric>Lines</Th>
                <Th numeric>Charged to job</Th>
              </tr>
            }
          >
            {deliveries.rows.map((delivery) => (
              <tr key={delivery.id}>
                <Td>
                  <span className="numeric block">{delivery.number ?? '—'}</span>
                  {delivery.deliveryNoteReference ? (
                    <span className="numeric text-xs text-(--color-muted)">
                      DN {delivery.deliveryNoteReference}
                    </span>
                  ) : null}
                </Td>
                <Td>
                  <span className="block">{date(delivery.receivedOn)}</span>
                  {delivery.overDelivered ? (
                    <Badge tone="bad">more arrived than ordered</Badge>
                  ) : null}
                </Td>
                <Td numeric>{delivery.lineCount}</Td>
                <Td numeric>
                  <Money amount={delivery.accrualValue} currency={currency} />
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      ) : null}

      <Card
        title="Lines"
        footnote="Billable is received minus already invoiced — the figure an invoice is matched against. It is what stops one delivery being billed twice."
      >
        <Table
          head={
            <tr>
              <Th>Description</Th>
              <Th numeric>Ordered</Th>
              <Th numeric>Received</Th>
              <Th numeric>Invoiced</Th>
              <Th numeric>Billable</Th>
              <Th numeric>Value</Th>
            </tr>
          }
        >
          {position.lines.map((line) => (
            <tr key={line.id}>
              <Td>{line.description}</Td>
              <Td numeric>{line.quantityOrdered}</Td>
              <Td numeric>{line.quantityReceived}</Td>
              <Td numeric>{line.quantityInvoiced}</Td>
              <Td numeric>
                <span className={line.availableToBill < 0 ? 'text-(--color-bad)' : ''}>
                  {line.availableToBill}
                </span>
              </Td>
              <Td numeric>
                <Money amount={line.lineValue} currency={currency} />
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}

import { notFound } from 'next/navigation';

import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, Money, PageHeader, Stat, Table, Td, Th } from '@/components/ui';
import { can, runAction, type ActionState } from '@/lib/actions';
import { ApiError, apiFetch } from '@/lib/api';
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

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getMe();

  let position: OrderPosition;
  try {
    position = await apiFetch<OrderPosition>(`/procurement/orders/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) notFound();
    throw error;
  }

  const currency = me.tenant.currencyCode;
  const isDraft = position.status === 'draft';
  const mayIssue = can(me.permissions, 'procurement.order.issue');

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

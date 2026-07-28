import { notFound } from 'next/navigation';

import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, Empty, Money, PageHeader, Stat, Table, Td, Th } from '@/components/ui';
import { ApiError, apiFetch } from '@/lib/api';
import { can, requiredText, runAction, type ActionState } from '@/lib/actions';
import { date } from '@/lib/format';
import { getMe } from '@/lib/session';

interface InvoiceDetail {
  invoice: {
    id: string;
    number: string | null;
    supplierReference: string;
    status: string;
    invoiceDate: string;
    receivedOn: string;
    dueOn: string | null;
    currencyCode: string | null;
    netValue: string;
    taxAmount: string;
    grossValue: string;
    matchVariance: string | null;
    holdReason: string | null;
    releasedOn: string | null;
    notes: string | null;
  };
  lines: {
    id: string;
    lineNumber: number;
    description: string;
    quantity: string;
    unitPrice: string;
    lineValue: string;
    expectedValue: string | null;
  }[];
  exceptions: {
    id: string;
    code: string;
    message: string;
    amount: string;
    isFavourable: boolean;
    resolution: string;
    resolutionNote: string | null;
  }[];
}

/**
 * Releases a held invoice over its matching exceptions.
 *
 * The reason is mandatory here as well as in the API. Not duplication for its
 * own sake: a round trip to be told "this is required" is a slow way to learn
 * something the form already knew, and the API's check is what actually stops a
 * caller that is not this form.
 */
async function releaseInvoice(
  id: string,
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  'use server';

  const reason = requiredText(form, 'reason');
  if (!reason) {
    return {
      status: 'error',
      error: 'Give a reason. It is recorded against your name and it is the only explanation anyone will have later.',
    };
  }

  return runAction(
    () =>
      apiFetch(`/procurement/invoices/${id}/release`, {
        method: 'POST',
        body: { reason },
      }),
    {
      revalidate: [
        `/procurement/invoices/${id}`,
        '/procurement/invoices',
        // The exception queue shrinks by however many this invoice held.
        '/procurement/exceptions',
      ],
      success: 'Released.',
    },
  );
}

const num = (value: string | null | undefined): number => (value == null ? 0 : Number(value));

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getMe();

  let detail: InvoiceDetail;
  try {
    detail = await apiFetch<InvoiceDetail>(`/procurement/invoices/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) notFound();
    throw error;
  }

  const { invoice, lines, exceptions } = detail;
  const currency = invoice.currencyCode ?? me.tenant.currencyCode;
  const open = exceptions.filter((e) => e.resolution === 'open');
  const held = invoice.status === 'on_hold';
  const mayRelease = can(me.permissions, 'procurement.invoice.release');

  const release = releaseInvoice.bind(null, id);

  return (
    <>
      <PageHeader
        title={invoice.supplierReference}
        subtitle={`${invoice.number ?? ''} · ${date(invoice.invoiceDate)}`}
      />

      {/*
        Success is reported by the durable state below, not by the action's own
        message. It has to be: releasing revalidates this page, the invoice is no
        longer held, and this whole card — message element included — is removed
        from the DOM before anything could read it. A transient confirmation that
        deletes itself on success is worse than none, because it looks like it
        worked and says nothing.

        The action message still earns its place on FAILURE, where the invoice is
        still held and the form is still on screen to show it.
      */}
      {!held && invoice.releasedOn ? (
        <Card>
          <p className="text-sm font-medium">Released over its exceptions</p>
          <p className="mt-1 text-sm text-(--color-muted)">
            {date(invoice.releasedOn)} · the match was overridden and this invoice can be paid.
          </p>
          {invoice.notes ? (
            <p className="mt-2 border-s-2 border-(--color-line) ps-3 text-sm">{invoice.notes}</p>
          ) : null}
        </Card>
      ) : null}

      {held ? (
        <Card>
          <div className="mb-3">
            <p className="text-sm font-medium text-(--color-bad)">
              Held on {open.length} exception{open.length === 1 ? '' : 's'} —{' '}
              <Money
                amount={open.reduce((total, e) => total + num(e.amount), 0)}
                currency={currency}
              />{' '}
              at stake
            </p>
            <p className="mt-1 text-sm text-(--color-muted)">
              Releasing overrides the match and lets this invoice be paid. It is recorded
              against your name and emitted as its own event.
            </p>
          </div>

          {mayRelease ? (
            <ActionForm action={release} className="max-w-xl">
              <label htmlFor="reason" className="mb-1 block text-sm">
                Reason
              </label>
              <div className="flex gap-2">
                <input
                  id="reason"
                  name="reason"
                  type="text"
                  required
                  placeholder="e.g. price rise agreed verbally with the supplier on 12 Aug"
                  className="w-full rounded-md border border-(--color-line) bg-(--color-surface) px-3 py-1.5 text-sm outline-none focus:border-(--color-accent)"
                />
                <SubmitButton tone="danger" pendingLabel="Releasing…">
                  Release
                </SubmitButton>
              </div>
            </ActionForm>
          ) : (
            /* Hidden rather than disabled, and the API refuses it regardless.
               A disabled button invites a user to go and ask for the permission;
               naming who can act is more useful than a greyed-out control. */
            <p className="text-sm text-(--color-muted)">
              You do not have permission to release a held invoice. Accounts payable does.
            </p>
          )}
        </Card>
      ) : null}

      <div className="my-6 grid gap-4 md:grid-cols-2">
        <Card title="Invoice">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat label="Net" value={<Money amount={num(invoice.netValue)} currency={currency} />} />
            <Stat label="Tax" value={<Money amount={num(invoice.taxAmount)} currency={currency} />} />
            <Stat
              label="Gross"
              value={<Money amount={num(invoice.grossValue)} currency={currency} />}
            />
            <Stat label="Received" value={date(invoice.receivedOn)} />
            <Stat label="Due" value={date(invoice.dueOn)} />
            <Stat
              label="Status"
              value={<Badge tone={held ? 'bad' : 'good'}>{invoice.status.replace(/_/g, ' ')}</Badge>}
            />
          </div>
        </Card>

        <Card
          title="Match"
          footnote="Variance is the invoice against what the same quantities would have cost at the ordered price."
        >
          <div className="grid grid-cols-2 gap-4">
            <Stat
              label="Variance"
              value={<Money amount={num(invoice.matchVariance)} currency={currency} />}
              tone={num(invoice.matchVariance) > 0 ? 'bad' : 'neutral'}
            />
            <Stat label="Open exceptions" value={String(open.length)} />
          </div>
        </Card>
      </div>

      <Card title="Exceptions" className="mb-6">
        {exceptions.length === 0 ? (
          <Empty
            title="Matched cleanly"
            detail="This invoice agreed with the order and with what was received."
          />
        ) : (
          <Table
            head={
              <tr>
                <Th>Problem</Th>
                <Th>Detail</Th>
                <Th>Resolution</Th>
                <Th numeric>Amount</Th>
              </tr>
            }
          >
            {exceptions.map((exception) => (
              <tr key={exception.id}>
                <Td>
                  <Badge tone={exception.isFavourable ? 'neutral' : 'bad'}>
                    {exception.code.replace(/_/g, ' ')}
                  </Badge>
                </Td>
                <Td>{exception.message}</Td>
                <Td>
                  <span className="block">{exception.resolution}</span>
                  {exception.resolutionNote ? (
                    <span className="text-xs text-(--color-muted)">{exception.resolutionNote}</span>
                  ) : null}
                </Td>
                <Td numeric>
                  <Money amount={num(exception.amount)} currency={currency} />
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Lines">
        <Table
          head={
            <tr>
              <Th>Description</Th>
              <Th numeric>Quantity</Th>
              <Th numeric>Unit price</Th>
              <Th numeric>Billed</Th>
              <Th numeric>Expected</Th>
            </tr>
          }
        >
          {lines.map((line) => {
            const billed = num(line.lineValue);
            const expected = line.expectedValue == null ? null : num(line.expectedValue);
            return (
              <tr key={line.id}>
                <Td>{line.description}</Td>
                <Td numeric>{Number(line.quantity)}</Td>
                <Td numeric>{Number(line.unitPrice)}</Td>
                <Td numeric>
                  <Money amount={billed} currency={currency} />
                </Td>
                <Td numeric>
                  {/* What the same quantity would have cost at the ordered
                      price. Side by side, because the gap is the whole
                      question and making a reader subtract two columns in
                      their head is how a variance goes unnoticed. */}
                  {expected == null ? (
                    <span className="text-(--color-muted)">not on order</span>
                  ) : (
                    <Money
                      amount={expected}
                      currency={currency}
                      tone={billed > expected ? 'bad' : 'neutral'}
                    />
                  )}
                </Td>
              </tr>
            );
          })}
        </Table>
      </Card>
    </>
  );
}

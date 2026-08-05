import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, Money, PageHeader, Table, Td, Th } from '@/components/ui';
import { can } from '@/lib/actions';
import { ApiError, pageFetch } from '@/lib/api';
import { date, integer, quantity } from '@/lib/format';
import { getMe } from '@/lib/session';

import { awardRfqAction } from './actions';

interface RfqLine {
  id: string;
  lineNumber: number;
  description: string;
  specification: string | null;
  quantity: string;
  uomCode: string | null;
}

interface RfqQuote {
  id: string;
  supplierId: string;
  supplierName: string | null;
  status: string;
  reference: string | null;
  receivedOn: string | null;
  leadTimeDays: number | null;
  landedCost: string | null;
  effectiveUnitCost: string | null;
  premiumOverBest: string | null;
  comparedAt: string | null;
}

interface RfqDetail {
  rfq: {
    id: string;
    number: string | null;
    title: string;
    status: string;
    currencyCode: string | null;
    issuedOn: string | null;
    responseDueOn: string | null;
    surplusIsStock: boolean;
    awardedOn: string | null;
    awardRationale: string | null;
  };
  projectCode: string | null;
  projectName: string | null;
  lines: RfqLine[];
  quotes: RfqQuote[];
}

const STATUS_TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  awarded: 'good',
  cancelled: 'bad',
};

const QUOTE_STATUS_TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  awarded: 'good',
  shortlisted: 'good',
  declined: 'bad',
  lost: 'bad',
  expired: 'bad',
};

const field =
  'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1 text-sm outline-none focus:border-(--color-accent)';

/**
 * An enquiry, with every quote received against it.
 *
 * Comparison is on landed cost, not unit price — freight, duty and a
 * supplier's payment terms routinely reverse which quote is actually
 * cheapest, which is the whole reason `compareRfqLine` exists. This screen
 * shows the comparison exactly as it was last stored, not recomputed: a past
 * figure that silently restated itself as exchange rates moved is the one
 * thing an awarded RFQ must not do.
 */
export default async function RfqPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getMe();
  const mayAward = can(me.permissions, 'procurement.rfq.award') || me.user.isOwner;

  let detail: RfqDetail;
  try {
    detail = await pageFetch<RfqDetail>(`/procurement/rfqs/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) notFound();
    throw error;
  }

  const { rfq } = detail;
  const currency = rfq.currencyCode ?? me.tenant.currencyCode;
  const awardable = detail.quotes.filter((q) => q.status === 'received' || q.status === 'shortlisted');
  const canAward = mayAward && rfq.status !== 'awarded' && rfq.status !== 'cancelled' && awardable.length > 0;

  return (
    <>
      <PageHeader
        title={rfq.number ?? 'Unnumbered enquiry'}
        subtitle={[rfq.title, detail.projectCode ? `${detail.projectCode} · ${detail.projectName}` : null]
          .filter(Boolean)
          .join(' · ')}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Link href="/procurement/rfqs" className="text-(--color-accent) hover:underline">
          ← All enquiries
        </Link>
        <Badge tone={STATUS_TONE[rfq.status] ?? 'neutral'}>{rfq.status}</Badge>
        <span className="text-(--color-muted)">
          {`closes ${date(rfq.responseDueOn)}`}
        </span>
        {rfq.awardedOn ? (
          <span className="text-(--color-muted)">{`awarded ${date(rfq.awardedOn)}`}</span>
        ) : null}
      </div>

      {rfq.awardRationale ? (
        <Card className="mb-4">
          <p className="text-sm">
            <span className="text-(--color-muted)">Why this award: </span>
            {rfq.awardRationale}
          </p>
        </Card>
      ) : null}

      <Card title="Lines" className="mb-4">
        <Table
          head={
            <tr>
              <Th>#</Th>
              <Th>Description</Th>
              <Th numeric>Qty</Th>
            </tr>
          }
        >
          {detail.lines.map((line) => (
            <tr key={line.id}>
              <Td>
                <span className="numeric">{line.lineNumber}</span>
              </Td>
              <Td>
                <span className="block">{line.description}</span>
                {line.specification ? (
                  <span className="block text-xs text-(--color-muted)">{line.specification}</span>
                ) : null}
              </Td>
              <Td numeric>{quantity(line.quantity, line.uomCode)}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card title="Quotes" className="mb-4">
        {detail.quotes.length === 0 ? (
          <p className="text-sm text-(--color-muted)">No supplier has quoted yet.</p>
        ) : (
          <Table
            head={
              <tr>
                <Th>Supplier</Th>
                <Th>Status</Th>
                <Th numeric>Lead time</Th>
                <Th numeric>Landed cost</Th>
                <Th numeric>Premium over best</Th>
              </tr>
            }
          >
            {detail.quotes.map((quote) => (
              <tr key={quote.id}>
                <Td>
                  <span className="block">{quote.supplierName ?? '—'}</span>
                  {quote.reference ? (
                    <span className="numeric block text-xs text-(--color-muted)">
                      {quote.reference}
                    </span>
                  ) : null}
                </Td>
                <Td>
                  <Badge tone={QUOTE_STATUS_TONE[quote.status] ?? 'neutral'}>{quote.status}</Badge>
                </Td>
                <Td numeric>
                  {quote.leadTimeDays != null ? `${integer(quote.leadTimeDays)} days` : '—'}
                </Td>
                <Td numeric>
                  {quote.comparedAt ? (
                    <Money amount={quote.landedCost} currency={currency} />
                  ) : (
                    <span className="text-(--color-muted)">not compared yet</span>
                  )}
                </Td>
                <Td numeric>
                  {quote.comparedAt ? (
                    <Money amount={quote.premiumOverBest} currency={currency} />
                  ) : (
                    <span className="text-(--color-muted)">—</span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {canAward ? (
        <Card title="Award">
          <ActionForm action={awardRfqAction} className="space-y-2">
            <input type="hidden" name="rfqId" value={rfq.id} />
            <select name="quoteId" className={field} defaultValue="">
              <option value="" disabled>
                Choose the winning quote…
              </option>
              {awardable.map((q) => (
                <option key={q.id} value={q.id}>
                  {`${q.supplierName ?? q.supplierId}${q.comparedAt ? ` — ${integer(Number(q.landedCost))} ${currency}` : ''}`}
                </option>
              ))}
            </select>
            <input
              name="rationale"
              dir="auto"
              className={field}
              placeholder="Why, if not the cheapest (required in that case)"
            />
            <SubmitButton pendingLabel="Awarding…">Award</SubmitButton>
          </ActionForm>
        </Card>
      ) : null}
    </>
  );
}

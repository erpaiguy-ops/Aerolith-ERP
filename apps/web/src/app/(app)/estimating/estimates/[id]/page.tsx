import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, Money, PageHeader, Stat, Table, Td, Th } from '@/components/ui';
import { can } from '@/lib/actions';
import { ApiError, pageFetch } from '@/lib/api';
import { percent, quantity } from '@/lib/format';
import { getMe } from '@/lib/session';

import { convertToWorkOrderAction, submitEstimateAction } from './actions';

interface EstimateLine {
  id: string;
  lineNumber: number;
  reference: string | null;
  description: string;
  quantity: string;
  uomCode: string | null;
  kind: string;
  unitRate: string;
  lineValue: string;
  /** Absent, not null, without `estimation.margin.view`. */
  unitCost?: string;
  lineCost?: string;
}

interface EstimateDetail {
  estimate: {
    id: string;
    tenderId: string;
    version: number;
    label: string;
    status: string;
    overheadPercent: string | null;
    marginPercent?: string | null;
    totalCost?: string;
    totalValue: string;
    provisionalTotal: string;
    optionalTotal: string;
    isSubmitted: boolean;
    notes: string | null;
  };
  tenderNumber: string | null;
  tenderName: string;
  tenderStatus: string;
  clientName: string | null;
  currencyCode: string | null;
  lines: EstimateLine[];
  marginVisible: boolean;
}

const KIND_LABEL: Record<string, string> = {
  measured: 'measured',
  provisional_sum: 'PC/provisional',
  prime_cost: 'PC/provisional',
  dayworks: 'dayworks',
  preliminaries: 'prelims',
  optional: 'optional',
};

const STATUS_TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  approved: 'good',
  superseded: 'neutral',
};

/**
 * One priced version of a tender — the build-up, not just the number.
 *
 * Cost and margin follow the same redaction the API already applies:
 * `estimation.margin.view` is a separate permission from reading an estimate,
 * because a site manager pulling quantities from a won bid should not learn
 * what the company makes on the job. The screen says so rather than rendering
 * an empty column, which reads as "there is no margin" instead of "you cannot
 * see it".
 */
export default async function EstimatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getMe();
  const maySubmit = can(me.permissions, 'estimation.estimate.submit') || me.user.isOwner;
  const mayConvert = can(me.permissions, 'estimation.estimate.write') || me.user.isOwner;
  const hasProduction = me.modules.some((m) => m.key === 'production');

  let detail: EstimateDetail;
  try {
    detail = await pageFetch<EstimateDetail>(`/estimating/estimates/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) notFound();
    throw error;
  }

  const { estimate } = detail;
  const currency = detail.currencyCode ?? me.tenant.currencyCode;
  const canSubmit = maySubmit && estimate.status === 'draft';
  const canConvert = mayConvert && hasProduction && detail.tenderStatus === 'won';

  return (
    <>
      <PageHeader
        title={`${detail.tenderNumber ?? 'Unnumbered tender'} · v${estimate.version}`}
        subtitle={[detail.tenderName, detail.clientName, estimate.label].filter(Boolean).join(' · ')}
        actions={
          <div className="flex gap-2">
            {canConvert ? (
              <ActionForm action={convertToWorkOrderAction}>
                <input type="hidden" name="estimateId" value={estimate.id} />
                <SubmitButton pendingLabel="Raising…">Raise work order</SubmitButton>
              </ActionForm>
            ) : null}
            {canSubmit ? (
              <ActionForm action={submitEstimateAction}>
                <input type="hidden" name="estimateId" value={estimate.id} />
                <SubmitButton pendingLabel="Submitting…">Submit as bid</SubmitButton>
              </ActionForm>
            ) : null}
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Link href="/estimating/estimates" className="text-(--color-accent) hover:underline">
          ← All estimates
        </Link>
        <Badge tone={STATUS_TONE[estimate.status] ?? 'neutral'}>
          {estimate.status.replace(/_/g, ' ')}
        </Badge>
        {estimate.isSubmitted ? <Badge tone="good">submitted</Badge> : null}
        <Link
          href={`/estimating/tenders/${estimate.tenderId}`}
          className="text-(--color-accent) hover:underline"
        >
          {`tender ${detail.tenderStatus.replace(/_/g, ' ')} →`}
        </Link>
      </div>

      {!detail.marginVisible ? (
        <p className="mb-4 rounded-md border border-(--color-line) bg-(--color-canvas) px-3 py-2 text-xs text-(--color-muted)">
          Cost and margin are hidden. Viewing them is a separate permission from viewing an
          estimate.
        </p>
      ) : null}

      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Value" value={<Money amount={estimate.totalValue} currency={currency} />} />
          {detail.marginVisible ? (
            <Stat label="Cost" value={<Money amount={estimate.totalCost} currency={currency} />} />
          ) : null}
          {detail.marginVisible ? (
            <Stat
              label="Margin achieved"
              value={
                <Money
                  amount={Number(estimate.totalValue) - Number(estimate.totalCost ?? 0)}
                  currency={currency}
                />
              }
              hint={
                estimate.marginPercent
                  ? `${percent(estimate.marginPercent)} requested`
                  : undefined
              }
            />
          ) : null}
          <Stat
            label="Provisional"
            value={<Money amount={estimate.provisionalTotal} currency={currency} />}
            hint="not yet a commitment either way"
          />
        </div>
      </Card>

      <Card title="Lines">
        <Table
          head={
            <tr>
              <Th>Ref</Th>
              <Th>Description</Th>
              <Th numeric>Qty</Th>
              <Th numeric>Rate</Th>
              {detail.marginVisible ? <Th numeric>Cost</Th> : null}
              <Th numeric>Value</Th>
              <Th>Kind</Th>
            </tr>
          }
        >
          {detail.lines.map((line) => (
            <tr key={line.id}>
              <Td>
                <span className="numeric">{line.reference ?? line.lineNumber}</span>
              </Td>
              <Td>{line.description}</Td>
              <Td numeric>{quantity(line.quantity, line.uomCode)}</Td>
              <Td numeric>
                <Money amount={line.unitRate} currency={currency} />
              </Td>
              {detail.marginVisible ? (
                <Td numeric>
                  <Money amount={line.unitCost} currency={currency} />
                </Td>
              ) : null}
              <Td numeric>
                <Money amount={line.lineValue} currency={currency} />
              </Td>
              <Td>
                {line.kind === 'measured' ? (
                  <span className="text-(--color-muted)">—</span>
                ) : (
                  <Badge tone="neutral">{KIND_LABEL[line.kind] ?? line.kind}</Badge>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}

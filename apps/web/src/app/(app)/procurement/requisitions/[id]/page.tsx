import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, Money, PageHeader, Table, Td, Th } from '@/components/ui';
import { can } from '@/lib/actions';
import { ApiError, pageFetch } from '@/lib/api';
import { date, integer, quantity } from '@/lib/format';
import { getMe } from '@/lib/session';

import { approveRequisitionAction } from './actions';

interface RequisitionLine {
  id: string;
  lineNumber: number;
  description: string;
  specification: string | null;
  quantity: string;
  uomCode: string | null;
  estimatedUnitPrice: string | null;
  quantityOrdered: string;
}

interface RequisitionDetail {
  requisition: {
    id: string;
    number: string | null;
    title: string;
    status: string;
    requiredBy: string | null;
    priority: string;
    justification: string | null;
    estimatedValue: string;
    approvedOn: string | null;
    rejectedReason: string | null;
  };
  projectCode: string | null;
  projectName: string | null;
  costCentreCode: string | null;
  costCentreName: string | null;
  requestedByName: string | null;
  approvedByName: string | null;
  lines: RequisitionLine[];
}

const STATUS_TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  ordered: 'good',
  approved: 'good',
  rejected: 'bad',
  cancelled: 'bad',
};

/**
 * What the site needs, and whether anybody has started buying it.
 *
 * `quantityOrdered` stays per line rather than being rolled up: a requisition
 * is actioned line by line, and a reader needs to see which lines have gone
 * to a supplier and which have not, not a single blended fraction.
 */
export default async function RequisitionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getMe();
  const mayApprove = can(me.permissions, 'procurement.requisition.approve') || me.user.isOwner;

  let detail: RequisitionDetail;
  try {
    detail = await pageFetch<RequisitionDetail>(`/procurement/requisitions/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) notFound();
    throw error;
  }

  const { requisition } = detail;
  const canApprove = mayApprove && requisition.status === 'draft';
  const spendAgainst = [
    detail.projectCode ? `${detail.projectCode} · ${detail.projectName}` : null,
    detail.costCentreCode ? `cost centre ${detail.costCentreCode} · ${detail.costCentreName}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <PageHeader
        title={requisition.number ?? 'Unnumbered requisition'}
        subtitle={[requisition.title, spendAgainst || null].filter(Boolean).join(' · ')}
        actions={
          canApprove ? (
            <ActionForm action={approveRequisitionAction}>
              <input type="hidden" name="requisitionId" value={requisition.id} />
              <SubmitButton pendingLabel="Approving…">Approve</SubmitButton>
            </ActionForm>
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Link href="/procurement/requisitions" className="text-(--color-accent) hover:underline">
          ← All requisitions
        </Link>
        <Badge tone={STATUS_TONE[requisition.status] ?? 'neutral'}>{requisition.status}</Badge>
        {requisition.priority !== 'routine' ? (
          <Badge tone={requisition.priority === 'emergency' ? 'bad' : 'neutral'}>
            {requisition.priority}
          </Badge>
        ) : null}
      </div>

      <Card title="Details" className="mb-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-(--color-muted)">Estimated</dt>
            <dd>
              <Money amount={requisition.estimatedValue} currency={me.tenant.currencyCode} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-(--color-muted)">Needed by</dt>
            <dd>{date(requisition.requiredBy)}</dd>
          </div>
          <div>
            <dt className="text-xs text-(--color-muted)">Requested by</dt>
            <dd>{detail.requestedByName ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-(--color-muted)">
              {requisition.status === 'rejected' ? 'Rejected' : 'Approved'}
            </dt>
            <dd>
              {requisition.status === 'rejected' ? (
                <span className="text-(--color-bad)">{requisition.rejectedReason ?? '—'}</span>
              ) : requisition.approvedOn ? (
                `${detail.approvedByName ?? 'someone'} · ${date(requisition.approvedOn)}`
              ) : (
                '—'
              )}
            </dd>
          </div>
          {requisition.justification ? (
            <div className="col-span-2 sm:col-span-4">
              <dt className="text-xs text-(--color-muted)">Justification</dt>
              <dd className="whitespace-pre-wrap">{requisition.justification}</dd>
            </div>
          ) : null}
        </dl>
      </Card>

      <Card title="Lines">
        <Table
          head={
            <tr>
              <Th>#</Th>
              <Th>Description</Th>
              <Th numeric>Qty</Th>
              <Th numeric>Est. unit price</Th>
              <Th numeric>Est. total</Th>
              <Th numeric>Ordered</Th>
            </tr>
          }
        >
          {detail.lines.map((line) => {
            const lineQty = Number(line.quantity);
            const ordered = Number(line.quantityOrdered);
            return (
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
                <Td numeric>
                  <Money amount={line.estimatedUnitPrice} currency={me.tenant.currencyCode} />
                </Td>
                <Td numeric>
                  <Money
                    amount={
                      line.estimatedUnitPrice ? Number(line.estimatedUnitPrice) * lineQty : null
                    }
                    currency={me.tenant.currencyCode}
                  />
                </Td>
                <Td numeric>
                  {ordered === 0 ? (
                    <span className="text-(--color-muted)">not yet</span>
                  ) : (
                    <span className="numeric">
                      {`${integer(ordered)} of ${integer(lineQty)}`}
                    </span>
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

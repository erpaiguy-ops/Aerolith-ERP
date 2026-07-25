import { notFound } from 'next/navigation';

import { Badge, Card, Empty, Money, PageHeader, Stat, Table, Td, Th } from '@/components/ui';
import { ApiError, apiFetch, apiFetchOptional } from '@/lib/api';
import { date, money, percent, toneForVariance } from '@/lib/format';
import { getMe } from '@/lib/session';

interface Position {
  number: string | null;
  originalSum: number;
  currentSum: number;
  grossValuedToDate: number;
  certifiedToDate: number;
  uncertified: number;
  retentionHeld: number;
  retentionReleased: number;
  advanceOutstanding: number;
  backChargesOutstanding: number;
  overdueAmount: number;
  anticipatedFinalValue: number;
  variations: {
    approvedValue: number;
    exposureValue: number;
    exposureCost: number;
    pendingValue: number;
    rejectedValue: number;
    oldestUnapprovedDays: number | null;
    counts: Record<string, number>;
  };
}

interface VariationRow {
  id: string;
  number: string | null;
  title: string;
  status: string;
  basis: string;
  instructedOn: string | null;
  approvedOn: string | null;
  quotedValue: string | null;
  approvedValue: string | null;
  percentExecuted: string;
}

interface NoticeExposure {
  atRisk: {
    variationId: string;
    number: string | null;
    title: string;
    value: number;
    status: { deadlineOn: string; daysRemaining: number; isTimeBarred: boolean; isGiven: boolean };
  }[];
  timeBarredCount: number;
  timeBarredValue: number;
}

export default async function ContractPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getMe();
  const currency = me.tenant.currencyCode;

  let position: Position;
  try {
    position = await apiFetch<Position>(`/contracts/${id}/position`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) notFound();
    throw error;
  }

  const [variations, notices] = await Promise.all([
    apiFetchOptional<{ variations: VariationRow[] }>(`/contracts/${id}/variations`),
    apiFetchOptional<NoticeExposure>(`/contracts/${id}/notice-exposure`),
  ]);

  return (
    <>
      <PageHeader
        title={position.number ?? 'Contract'}
        subtitle={`${money(position.originalSum, currency)} original · ${money(
          position.currentSum,
          currency,
        )} current`}
      />

      {/* The time-bar warning goes ABOVE everything else, because it is the one
          fact on this page with a deadline attached. Entitlement lost to a
          missed notice is lost permanently. */}
      {notices && notices.timeBarredCount > 0 ? (
        <div className="mb-6 rounded-lg border border-(--color-bad)/30 bg-(--color-bad)/5 p-4">
          <p className="text-sm font-medium text-(--color-bad)">
            {notices.timeBarredCount} variation{notices.timeBarredCount === 1 ? '' : 's'} past the
            notice deadline — {money(notices.timeBarredValue, currency)} at risk
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {notices.atRisk
              .filter((r) => r.status.isTimeBarred)
              .map((r) => (
                <li key={r.variationId} className="text-(--color-muted)">
                  <span className="numeric">{r.number}</span> · {r.title} · deadline{' '}
                  {date(r.status.deadlineOn)}
                </li>
              ))}
          </ul>
        </div>
      ) : null}

      <div className="mb-6 grid gap-4 md:grid-cols-2">
        <Card title="Commercial position">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat label="Current sum" value={money(position.currentSum, currency)} />
            <Stat
              label="Valued to date"
              value={money(position.grossValuedToDate, currency)}
              hint={percent(
                position.currentSum > 0
                  ? (position.grossValuedToDate / position.currentSum) * 100
                  : 0,
              )}
            />
            <Stat label="Certified to date" value={money(position.certifiedToDate, currency)} />
            <Stat
              label="Applied, not certified"
              value={money(position.uncertified, currency)}
              tone={position.uncertified > 0 ? 'neutral' : 'neutral'}
            />
            <Stat label="Retention held" value={money(position.retentionHeld, currency)} />
            <Stat
              label="Overdue"
              value={money(position.overdueAmount, currency)}
              tone={position.overdueAmount > 0 ? 'bad' : 'neutral'}
            />
          </div>
        </Card>

        <Card
          title="Variations"
          footnote="Exposure is instructed work already built and not yet approved. Pending is claimed but never instructed — a much weaker position, so it is counted separately."
        >
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat
              label="Approved"
              value={money(position.variations.approvedValue, currency)}
              hint="the only thing that moves the sum"
            />
            <Stat
              label="Exposure"
              value={money(position.variations.exposureValue, currency)}
              tone={position.variations.exposureValue > 0 ? 'bad' : 'neutral'}
              hint={`${money(position.variations.exposureCost, currency)} already spent`}
            />
            <Stat label="Pending" value={money(position.variations.pendingValue, currency)} />
            <Stat
              label="Anticipated final"
              value={money(position.anticipatedFinalValue, currency)}
              hint="approved + executed exposure"
            />
            {position.variations.oldestUnapprovedDays != null ? (
              <Stat
                label="Oldest unapproved"
                value={`${position.variations.oldestUnapprovedDays} days`}
                tone={position.variations.oldestUnapprovedDays > 60 ? 'bad' : 'neutral'}
              />
            ) : null}
          </div>
        </Card>
      </div>

      <Card title="Variation register">
        {!variations || variations.variations.length === 0 ? (
          <Empty title="No variations" detail="Nothing has changed on this contract yet." />
        ) : (
          <Table
            head={
              <tr>
                <Th>Number</Th>
                <Th>Title</Th>
                <Th>Status</Th>
                <Th>Instructed</Th>
                <Th numeric>Quoted</Th>
                <Th numeric>Approved</Th>
                <Th numeric>Variance</Th>
              </tr>
            }
          >
            {variations.variations.map((v) => {
              const quoted = v.quotedValue == null ? null : Number(v.quotedValue);
              const approved = v.approvedValue == null ? null : Number(v.approvedValue);
              const variance = quoted != null && approved != null ? approved - quoted : null;

              return (
                <tr key={v.id}>
                  <Td>
                    <span className="numeric">{v.number}</span>
                  </Td>
                  <Td>{v.title}</Td>
                  <Td>
                    <Badge
                      tone={
                        v.status === 'approved'
                          ? 'good'
                          : v.status === 'rejected'
                            ? 'bad'
                            : 'neutral'
                      }
                    >
                      {v.status.replace(/_/g, ' ')}
                    </Badge>
                  </Td>
                  <Td>{date(v.instructedOn)}</Td>
                  <Td numeric>
                    <Money amount={quoted} currency={currency} />
                  </Td>
                  <Td numeric>
                    <Money amount={approved} currency={currency} />
                  </Td>
                  <Td numeric>
                    {/* The gap between what was claimed and what was agreed. A
                        client who settles everything at 90% is a pattern you can
                        price against — but only if the quote survives approval. */}
                    <Money amount={variance} currency={currency} tone={toneForVariance(variance)} />
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </>
  );
}

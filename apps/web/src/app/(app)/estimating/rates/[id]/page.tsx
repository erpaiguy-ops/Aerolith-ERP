import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Badge, Card, Money, PageHeader, Stat, Table, Td, Th } from '@/components/ui';
import { ApiError, pageFetch } from '@/lib/api';
import { money, percent, quantity } from '@/lib/format';
import { getMe } from '@/lib/session';

interface RateComponent {
  id: string;
  sequence: number;
  type: string;
  description: string | null;
  itemId: string | null;
  itemCode: string | null;
  itemName: string | null;
  quantityPerUnit: string;
  unitRate: string;
  wastagePercent: string | null;
  netCost: number;
  grossCost: number;
  wastageCost: number;
}

interface RateDetail {
  rateItem: {
    id: string;
    code: string;
    description: string;
    uomCode: string | null;
    category: string | null;
    unitRate: string;
    overheadPercent: string | null;
    marginPercent: string | null;
    isActive: boolean;
    lastActualCost: string | null;
    actualSampleSize: number;
  };
  libraryCode: string;
  libraryName: string;
  libraryVersion: number;
  currencyCode: string | null;
  components: RateComponent[];
  directCost: number;
  overheadCost: number;
  totalCost: number;
  computedUnitRate: number;
  effectiveMarginPercent: number;
  effectiveMarkupPercent: number;
  byType: Record<string, number>;
  actualVariancePercent: number | null;
}

const TYPE_LABEL: Record<string, string> = {
  material: 'material',
  labour: 'labour',
  machine: 'machine',
  finishing: 'finishing',
  hardware: 'hardware',
  subcontract: 'subcontract',
  transport: 'transport',
  other: 'other',
};

/**
 * A rate, exploded into what actually prices it.
 *
 * Every cost figure here is RECOMPUTED from the components with the same
 * `calculateBuildUp` the rate list uses for its "assumed cost" column —
 * never read from `rate_item.direct_cost`, which nothing in the system keeps
 * in sync. `computedUnitRate` is shown next to the stored, committed
 * `unitRate` deliberately: the two are expected to agree, and a gap between
 * them means the build-up changed after the rate was priced.
 */
export default async function RatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getMe();

  let detail: RateDetail;
  try {
    detail = await pageFetch<RateDetail>(`/estimating/rates/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) notFound();
    throw error;
  }

  const { rateItem } = detail;
  const currency = detail.currencyCode ?? me.tenant.currencyCode;
  const variance = detail.actualVariancePercent;
  const varianceTone = variance == null ? '' : variance < 0 ? 'text-(--color-bad)' : 'text-(--color-good)';
  const drift = Math.abs(detail.computedUnitRate - Number(rateItem.unitRate));

  return (
    <>
      <PageHeader
        title={rateItem.code}
        subtitle={[
          rateItem.description,
          `${detail.libraryName} v${detail.libraryVersion}`,
          rateItem.category,
        ]
          .filter(Boolean)
          .join(' · ')}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Link href="/estimating/rates" className="text-(--color-accent) hover:underline">
          ← Rate library
        </Link>
        {!rateItem.isActive ? <Badge tone="bad">retired</Badge> : null}
        {rateItem.uomCode ? (
          <span className="text-(--color-muted)">{`per ${rateItem.uomCode}`}</span>
        ) : null}
      </div>

      {drift > 0.01 ? (
        <p className="mb-4 rounded-md border border-(--color-line) bg-(--color-canvas) px-3 py-2 text-xs text-(--color-muted)">
          The stored rate (<Money amount={rateItem.unitRate} currency={currency} />) and what the
          build-up prices out to today (
          <Money amount={detail.computedUnitRate} currency={currency} />) have drifted apart — a
          component changed since this rate was last committed.
        </p>
      ) : null}

      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Rate" value={<Money amount={rateItem.unitRate} currency={currency} />} />
          <Stat
            label="Direct cost"
            value={<Money amount={detail.directCost} currency={currency} />}
          />
          {detail.overheadCost > 0 ? (
            <Stat
              label="Overhead"
              value={<Money amount={detail.overheadCost} currency={currency} />}
              hint={rateItem.overheadPercent ? `${percent(rateItem.overheadPercent)}` : undefined}
            />
          ) : null}
          <Stat
            label="Margin"
            value={percent(detail.effectiveMarginPercent)}
            hint={`${percent(detail.effectiveMarkupPercent)} markup`}
          />
          <Stat
            label="Against actuals"
            value={
              variance == null ? (
                <span className="text-(--color-muted)">no actuals yet</span>
              ) : (
                <span className={varianceTone}>
                  {variance > 0 ? `+${percent(variance)}` : percent(variance)}
                </span>
              )
            }
            hint={
              variance == null
                ? undefined
                : `${rateItem.actualSampleSize} job${rateItem.actualSampleSize === 1 ? '' : 's'}` +
                  (rateItem.lastActualCost
                    ? ` · actual ${money(rateItem.lastActualCost, currency)}`
                    : '')
            }
          />
        </div>
      </Card>

      <Card title="Build-up">
        <Table
          head={
            <tr>
              <Th>#</Th>
              <Th>Type</Th>
              <Th>Component</Th>
              <Th numeric>Qty / unit</Th>
              <Th numeric>Rate</Th>
              <Th numeric>Wastage</Th>
              <Th numeric>Cost</Th>
            </tr>
          }
        >
          {detail.components.map((c) => (
            <tr key={c.id}>
              <Td>
                <span className="numeric">{c.sequence}</span>
              </Td>
              <Td>
                <Badge tone="neutral">{TYPE_LABEL[c.type] ?? c.type}</Badge>
              </Td>
              <Td>
                <span className="block">{c.description ?? '—'}</span>
                {c.itemCode ? (
                  <span className="numeric block text-xs text-(--color-muted)">
                    {`${c.itemCode} · ${c.itemName}`}
                  </span>
                ) : null}
              </Td>
              <Td numeric>{quantity(c.quantityPerUnit)}</Td>
              <Td numeric>
                <Money amount={c.unitRate} currency={currency} />
              </Td>
              <Td numeric>
                {c.wastagePercent ? (
                  percent(c.wastagePercent)
                ) : (
                  <span className="text-(--color-muted)">—</span>
                )}
              </Td>
              <Td numeric>
                <Money amount={c.grossCost} currency={currency} />
                {c.wastageCost > 0 ? (
                  <span className="block text-xs text-(--color-muted)">
                    {`net `}
                    <Money amount={c.netCost} currency={currency} />
                  </span>
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}

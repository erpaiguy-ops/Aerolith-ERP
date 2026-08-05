import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Badge, Card, Money, PageHeader, Stat } from '@/components/ui';
import { can } from '@/lib/actions';
import { ApiError, pageFetch } from '@/lib/api';
import { money, percent } from '@/lib/format';
import { getMe } from '@/lib/session';

import { BuildUpGrid } from './BuildUpGrid';

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
    updatedAt: string;
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

/**
 * A rate, exploded into what actually prices it.
 *
 * The build-up itself lives in `BuildUpGrid` — the app's one deliberately
 * client-heavy surface, edited spreadsheet-style. Everything on this server
 * page is initial data and context that does not change while editing: who
 * this rate is, and how the currently-saved build-up has performed against
 * real jobs. `computedUnitRate` is shown next to the stored, committed
 * `unitRate` for exactly that reason — the two are expected to agree, and a
 * gap between them means the build-up changed after the rate was last saved.
 * Saving the grid closes that gap, since both are recomputed together.
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
  const canManage = can(me.permissions, 'estimation.rate_library.manage') || me.user.isOwner;
  const variance = detail.actualVariancePercent;
  const varianceTone =
    variance == null ? '' : variance < 0 ? 'text-(--color-bad)' : 'text-(--color-good)';
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
          The stored rate (
          <Money amount={rateItem.unitRate} currency={currency} />) and what the build-up prices out
          to today (
          <Money amount={detail.computedUnitRate} currency={currency} />) have drifted apart — a
          component changed since this rate was last committed.
        </p>
      ) : null}

      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat
            label="Stored rate"
            value={<Money amount={rateItem.unitRate} currency={currency} />}
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

      <BuildUpGrid
        key={rateItem.updatedAt}
        rateItemId={rateItem.id}
        currency={currency}
        canManage={canManage}
        initialComponents={detail.components}
        initialOverheadPercent={rateItem.overheadPercent}
        initialMarginPercent={rateItem.marginPercent}
      />
    </>
  );
}

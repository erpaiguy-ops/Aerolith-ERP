'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { saveRateBuildUp, type RateComponentInput } from './actions';

/**
 * `@/components/ui` and `@/lib/format` reach `lib/locale`, which is marked
 * `server-only` — the same reason `Action.tsx` rolls its own `<bdi>` instead
 * of importing `Bidi`. This client component cannot import either module, so
 * formatting here is a plain, browser-locale `Intl.NumberFormat` rather than
 * the tenant-locale-aware one the rest of the app uses. That is an accepted
 * gap: this grid is a live preview while editing, and the authoritative
 * figures — formatted the normal way — are what the page shows after Save.
 */
function formatMoney(amount: number, currency: string | null | undefined): string {
  if (!Number.isFinite(amount)) return '—';
  try {
    return new Intl.NumberFormat(undefined, {
      style: currency ? 'currency' : 'decimal',
      currency: currency ?? undefined,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency ?? ''} ${amount.toFixed(2)}`.trim();
  }
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(1)}%`;
}

type ComponentType =
  | 'material'
  | 'labour'
  | 'machine'
  | 'finishing'
  | 'hardware'
  | 'subcontract'
  | 'transport'
  | 'other';

const TYPES: ComponentType[] = [
  'material',
  'labour',
  'machine',
  'finishing',
  'hardware',
  'subcontract',
  'transport',
  'other',
];

export interface InitialComponent {
  id: string;
  type: string;
  description: string | null;
  itemId: string | null;
  itemCode: string | null;
  itemName: string | null;
  quantityPerUnit: string;
  unitRate: string;
  wastagePercent: string | null;
}

interface DraftRow {
  key: string;
  type: ComponentType;
  description: string;
  quantityPerUnit: string;
  unitRate: string;
  wastagePercent: string;
  itemId: string | null;
  itemCode: string | null;
  itemName: string | null;
}

let nextKey = 0;
const newRowKey = () => `new-${Date.now()}-${nextKey++}`;

/**
 * The API's numeric columns arrive as strings at full precision — "5.500000",
 * "20.000" — which is correct on the wire and unreadable in a cell someone is
 * about to edit. Trimmed here, on the way into the grid, not on the way out:
 * what gets saved is whatever the user actually typed.
 */
function trimTrailingZeros(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/0+$/, '').replace(/\.$/, '');
}

function toDraft(c: InitialComponent): DraftRow {
  return {
    key: c.id,
    type: (c.type as ComponentType) ?? 'other',
    description: c.description ?? '',
    quantityPerUnit: trimTrailingZeros(c.quantityPerUnit),
    unitRate: trimTrailingZeros(c.unitRate),
    wastagePercent: c.wastagePercent ? trimTrailingZeros(c.wastagePercent) : '',
    itemId: c.itemId,
    itemCode: c.itemCode,
    itemName: c.itemName,
  };
}

function blankRow(): DraftRow {
  return {
    key: newRowKey(),
    type: 'material',
    description: '',
    quantityPerUnit: '',
    unitRate: '',
    wastagePercent: '',
    itemId: null,
    itemCode: null,
    itemName: null,
  };
}

/** Cost for one row, wastage applied — the same order of operations as `calculateBuildUp`. */
function rowCost(row: DraftRow): { netCost: number; grossCost: number } {
  const netCost = (parseFloat(row.quantityPerUnit) || 0) * (parseFloat(row.unitRate) || 0);
  const wastage = (parseFloat(row.wastagePercent) || 0) / 100;
  return { netCost, grossCost: netCost * (1 + wastage) };
}

/**
 * Mirrors `calculateBuildUp` (the estimation domain package) for LIVE preview
 * as the grid is edited. The server is the one that recomputes for real on
 * save — this only has to be close enough to type against, which is why it is
 * a few lines here rather than a dependency on the backend package.
 */
function computeTotals(rows: DraftRow[], overheadPercent: number, marginPercent: number) {
  const directCost = rows.reduce((sum, r) => sum + rowCost(r).grossCost, 0);
  const overheadCost = directCost * (overheadPercent / 100);
  const totalCost = directCost + overheadCost;
  const unitRate = marginPercent >= 100 ? NaN : totalCost / (1 - marginPercent / 100);
  const profit = unitRate - totalCost;
  return {
    directCost,
    overheadCost,
    totalCost,
    unitRate,
    effectiveMarginPercent: unitRate > 0 ? (profit / unitRate) * 100 : 0,
    effectiveMarkupPercent: totalCost > 0 ? (profit / totalCost) * 100 : 0,
  };
}

const cellClass =
  'w-full min-w-0 rounded border border-transparent bg-transparent px-1.5 py-1 text-sm ' +
  'focus:border-(--color-accent) focus:bg-(--color-surface) disabled:border-transparent';

/**
 * The rate build-up as a spreadsheet: click a cell, type, Tab or Enter to the
 * next one, add or remove rows, Save when the sheet is right.
 *
 * Nothing here persists until Save — this is the app's one deliberately
 * client-heavy surface, because a build-up filled in one API call per
 * keystroke is not what "spreadsheet-like" means. `router.refresh()` after a
 * successful save re-fetches the page; the parent keys this component on the
 * rate's `updatedAt`, so a save remounts it with the server's own numbers
 * rather than trusting the client's running total to match exactly.
 */
export function BuildUpGrid({
  rateItemId,
  currency,
  canManage,
  initialComponents,
  initialOverheadPercent,
  initialMarginPercent,
}: {
  rateItemId: string;
  currency: string | null | undefined;
  canManage: boolean;
  initialComponents: InitialComponent[];
  initialOverheadPercent: string | null;
  initialMarginPercent: string | null;
}) {
  const router = useRouter();
  const gridRef = useRef<HTMLDivElement>(null);

  const [rows, setRows] = useState<DraftRow[]>(() => initialComponents.map(toDraft));
  const [overheadPercent, setOverheadPercent] = useState(
    initialOverheadPercent ? trimTrailingZeros(initialOverheadPercent) : '',
  );
  const [marginPercent, setMarginPercent] = useState(
    initialMarginPercent ? trimTrailingZeros(initialMarginPercent) : '',
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totals = computeTotals(
    rows,
    parseFloat(overheadPercent) || 0,
    parseFloat(marginPercent) || 0,
  );

  function updateRow(key: string, patch: Partial<DraftRow>) {
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function removeRow(key: string) {
    setRows((current) => current.filter((r) => r.key !== key));
  }

  function addRow() {
    setRows((current) => [...current, blankRow()]);
  }

  /** Enter moves to the same column, next row — Tab already works natively. */
  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Enter') return;
    const target = event.target as HTMLElement;
    const col = target.dataset.col;
    const row = target.dataset.row;
    if (!col || row == null) return;
    event.preventDefault();

    const nextRow = Number(row) + 1;
    const next = gridRef.current?.querySelector<HTMLElement>(
      `[data-col="${col}"][data-row="${nextRow}"]`,
    );
    if (next) {
      next.focus();
    } else {
      addRow();
    }
  }

  async function handleSave() {
    if (rows.length === 0) {
      setError('A rate needs at least one component — an empty build-up prices nothing.');
      return;
    }

    setSaving(true);
    setError(null);

    const components: RateComponentInput[] = rows.map((r) => ({
      type: r.type,
      description: r.description.trim() === '' ? null : r.description.trim(),
      itemId: r.itemId,
      quantityPerUnit: parseFloat(r.quantityPerUnit) || 0,
      unitRate: parseFloat(r.unitRate) || 0,
      wastagePercent: r.wastagePercent === '' ? null : parseFloat(r.wastagePercent) || 0,
    }));

    const result = await saveRateBuildUp({
      rateItemId,
      overheadPercent: overheadPercent === '' ? null : parseFloat(overheadPercent) || 0,
      marginPercent: marginPercent === '' ? null : parseFloat(marginPercent) || 0,
      components,
    });

    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  const stats: { label: string; value: string; hint?: string }[] = [
    { label: 'Direct cost', value: formatMoney(totals.directCost, currency) },
    {
      label: 'Overhead',
      value: formatMoney(totals.overheadCost, currency),
      hint: overheadPercent ? `${overheadPercent}%` : undefined,
    },
    {
      label: 'Rate',
      value: formatMoney(totals.unitRate, currency),
      hint: marginPercent ? `${marginPercent}% margin` : undefined,
    },
    { label: 'Markup', value: formatPercent(totals.effectiveMarkupPercent) },
  ];

  return (
    <section className="rounded-lg border border-(--color-line) bg-(--color-surface)">
      <h2 className="border-b border-(--color-line) px-4 py-2.5 text-sm font-medium">Build-up</h2>
      <div className="p-4">
        <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label}>
              <div className="text-xs text-(--color-muted)">{s.label}</div>
              <div className="numeric mt-0.5 text-lg font-medium">{s.value}</div>
              {s.hint ? <div className="mt-0.5 text-xs text-(--color-muted)">{s.hint}</div> : null}
            </div>
          ))}
        </div>

        {canManage ? (
          <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-1.5">
              <span className="text-(--color-muted)">Overhead %</span>
              <input
                className={`${cellClass} w-20 border-(--color-line)`}
                inputMode="decimal"
                value={overheadPercent}
                onChange={(e) => setOverheadPercent(e.target.value)}
              />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-(--color-muted)">Margin %</span>
              <input
                className={`${cellClass} w-20 border-(--color-line)`}
                inputMode="decimal"
                value={marginPercent}
                onChange={(e) => setMarginPercent(e.target.value)}
              />
            </label>
          </div>
        ) : null}

        <div ref={gridRef} onKeyDown={handleKeyDown} className="-mx-4 overflow-x-auto px-4">
          <table className="w-full min-w-[48rem] text-sm">
            <thead className="text-start text-xs text-(--color-muted)">
              <tr>
                <th className="border-b border-(--color-line) pb-2 pe-2 text-start font-medium">
                  #
                </th>
                <th className="border-b border-(--color-line) pb-2 pe-2 text-start font-medium">
                  Type
                </th>
                <th className="border-b border-(--color-line) pb-2 pe-2 text-start font-medium">
                  Component
                </th>
                <th className="border-b border-(--color-line) pb-2 pe-2 text-end font-medium">
                  Qty / unit
                </th>
                <th className="border-b border-(--color-line) pb-2 pe-2 text-end font-medium">
                  Rate
                </th>
                <th className="border-b border-(--color-line) pb-2 pe-2 text-end font-medium">
                  Wastage %
                </th>
                <th className="border-b border-(--color-line) pb-2 pe-2 text-end font-medium">
                  Cost
                </th>
                {canManage ? <th className="border-b border-(--color-line) pb-2" /> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const cost = rowCost(row);
                return (
                  <tr key={row.key}>
                    <td className="border-b border-(--color-line) py-1 pe-2 text-(--color-muted)">
                      <span className="numeric">{index + 1}</span>
                    </td>
                    <td className="border-b border-(--color-line) py-1 pe-2">
                      <select
                        className={cellClass}
                        value={row.type}
                        disabled={!canManage}
                        data-col="type"
                        data-row={index}
                        onChange={(e) =>
                          updateRow(row.key, {
                            type: e.target.value as ComponentType,
                          })
                        }
                      >
                        {TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="border-b border-(--color-line) py-1 pe-2">
                      <input
                        className={cellClass}
                        dir="auto"
                        value={row.description}
                        disabled={!canManage}
                        placeholder="What this is"
                        data-col="description"
                        data-row={index}
                        onChange={(e) => updateRow(row.key, { description: e.target.value })}
                      />
                      {row.itemCode ? (
                        <span className="numeric block px-1.5 text-xs text-(--color-muted)">
                          {`${row.itemCode} · ${row.itemName}`}
                        </span>
                      ) : null}
                    </td>
                    <td className="border-b border-(--color-line) py-1 pe-2">
                      <input
                        className={`${cellClass} numeric text-end`}
                        inputMode="decimal"
                        value={row.quantityPerUnit}
                        disabled={!canManage}
                        data-col="quantityPerUnit"
                        data-row={index}
                        onChange={(e) =>
                          updateRow(row.key, {
                            quantityPerUnit: e.target.value,
                          })
                        }
                      />
                    </td>
                    <td className="border-b border-(--color-line) py-1 pe-2">
                      <input
                        className={`${cellClass} numeric text-end`}
                        inputMode="decimal"
                        value={row.unitRate}
                        disabled={!canManage}
                        data-col="unitRate"
                        data-row={index}
                        onChange={(e) => updateRow(row.key, { unitRate: e.target.value })}
                      />
                    </td>
                    <td className="border-b border-(--color-line) py-1 pe-2">
                      <input
                        className={`${cellClass} numeric text-end`}
                        inputMode="decimal"
                        placeholder="—"
                        value={row.wastagePercent}
                        disabled={!canManage}
                        data-col="wastagePercent"
                        data-row={index}
                        onChange={(e) => updateRow(row.key, { wastagePercent: e.target.value })}
                      />
                    </td>
                    <td className="numeric border-b border-(--color-line) py-1 pe-2 text-end">
                      {formatMoney(cost.grossCost, currency)}
                    </td>
                    {canManage ? (
                      <td className="border-b border-(--color-line) py-1 text-end">
                        <button
                          type="button"
                          onClick={() => removeRow(row.key)}
                          className="px-1.5 text-(--color-muted) hover:text-(--color-bad)"
                          aria-label="Remove row"
                        >
                          ×
                        </button>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {canManage ? (
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={addRow}
              className="rounded-md border border-(--color-line) px-3 py-1.5 text-sm hover:bg-(--color-canvas)"
            >
              + Add row
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="rounded-md border border-(--color-line) px-3 py-1.5 text-sm hover:bg-(--color-canvas) disabled:opacity-50"
            >
              <bdi>{saving ? 'Saving…' : 'Save'}</bdi>
            </button>
            {error ? (
              <p role="status" className="text-sm text-(--color-bad)">
                <bdi>{error}</bdi>
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

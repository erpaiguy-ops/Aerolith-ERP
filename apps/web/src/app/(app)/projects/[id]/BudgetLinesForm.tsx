'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { createBudgetAction, type BudgetLineDraft } from './actions';

const CATEGORIES = [
  'material',
  'labour',
  'machine',
  'finishing',
  'hardware',
  'subcontract',
  'transport',
  'preliminaries',
  'contingency',
  'other',
] as const;

interface DraftRow {
  key: string;
  wbsCode: string;
  category: (typeof CATEGORIES)[number];
  description: string;
  lineCost: string;
  lineValue: string;
}

let nextKey = 0;
function emptyRow(): DraftRow {
  nextKey += 1;
  return { key: `row-${nextKey}`, wbsCode: '', category: 'material', description: '', lineCost: '', lineValue: '' };
}

const field =
  'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-2 py-1 text-sm outline-none focus:border-(--color-accent)';

/**
 * A new budget version, one line at a time, in a real grid rather than a
 * repeated form submission — the same reasoning the rate build-up grid
 * already established: a costed line list needs to be built up and reviewed
 * before it is submitted, and `createBudgetVersion` takes every line in one
 * call with no way to add to a version afterward.
 */
export function BudgetLinesForm({
  projectId,
  wbsCodes,
}: {
  projectId: string;
  wbsCodes: string[];
}) {
  const router = useRouter();
  const [rows, setRows] = useState<DraftRow[]>(() => [emptyRow()]);
  const [contingencyAmount, setContingencyAmount] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateRow(key: string, patch: Partial<DraftRow>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function removeRow(key: string) {
    setRows((prev) => (prev.length === 1 ? prev : prev.filter((r) => r.key !== key)));
  }

  async function handleCreate() {
    const cleaned = rows.filter((r) => r.description.trim() !== '');
    if (cleaned.length === 0) {
      setError('A budget needs at least one line — an empty version prices nothing.');
      return;
    }

    setSaving(true);
    setError(null);

    const lines: BudgetLineDraft[] = cleaned.map((r) => ({
      wbsCode: r.wbsCode.trim() === '' ? null : r.wbsCode.trim(),
      category: r.category,
      description: r.description.trim(),
      quantity: 0,
      uomCode: null,
      unitCost: 0,
      lineCost: parseFloat(r.lineCost) || 0,
      lineValue: parseFloat(r.lineValue) || 0,
    }));

    const result = await createBudgetAction({
      projectId,
      contingencyAmount: contingencyAmount === '' ? null : parseFloat(contingencyAmount) || 0,
      note: note.trim() === '' ? null : note.trim(),
      lines,
    });

    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setRows([emptyRow()]);
    setContingencyAmount('');
    setNote('');
    router.refresh();
  }

  return (
    <div>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-(--color-line) text-left text-xs text-(--color-muted)">
            <th className="py-1 pr-2 font-normal">WBS code</th>
            <th className="py-1 pr-2 font-normal">Category</th>
            <th className="py-1 pr-2 font-normal">Description</th>
            <th className="py-1 pr-2 text-right font-normal">Cost</th>
            <th className="py-1 pr-2 text-right font-normal">Value</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-(--color-line)/50">
              <td className="py-1 pr-2">
                <input
                  list={`wbs-codes-${projectId}`}
                  value={row.wbsCode}
                  onChange={(e) => updateRow(row.key, { wbsCode: e.target.value })}
                  placeholder="optional"
                  className={`${field} w-28`}
                />
              </td>
              <td className="py-1 pr-2">
                <select
                  value={row.category}
                  onChange={(e) => updateRow(row.key, { category: e.target.value as DraftRow['category'] })}
                  className={field}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </td>
              <td className="py-1 pr-2">
                <input
                  dir="auto"
                  value={row.description}
                  onChange={(e) => updateRow(row.key, { description: e.target.value })}
                  className={field}
                />
              </td>
              <td className="py-1 pr-2">
                <input
                  type="number"
                  step="0.01"
                  value={row.lineCost}
                  onChange={(e) => updateRow(row.key, { lineCost: e.target.value })}
                  className={`${field} w-28 text-right`}
                />
              </td>
              <td className="py-1 pr-2">
                <input
                  type="number"
                  step="0.01"
                  value={row.lineValue}
                  onChange={(e) => updateRow(row.key, { lineValue: e.target.value })}
                  className={`${field} w-28 text-right`}
                />
              </td>
              <td className="py-1">
                <button
                  type="button"
                  onClick={() => removeRow(row.key)}
                  className="text-xs text-(--color-muted) hover:text-(--color-bad)"
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <datalist id={`wbs-codes-${projectId}`}>
        {wbsCodes.map((code) => (
          <option key={code} value={code} />
        ))}
      </datalist>

      <button
        type="button"
        onClick={() => setRows((prev) => [...prev, emptyRow()])}
        className="mt-2 rounded-md border border-(--color-line) px-3 py-1 text-xs hover:bg-(--color-canvas)"
      >
        Add line
      </button>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs text-(--color-muted)">Contingency (optional)</label>
          <input
            type="number"
            step="0.01"
            value={contingencyAmount}
            onChange={(e) => setContingencyAmount(e.target.value)}
            className={`${field} w-32`}
          />
        </div>
        <div className="flex-1">
          <label className="mb-1 block text-xs text-(--color-muted)">Note (optional)</label>
          <input dir="auto" value={note} onChange={(e) => setNote(e.target.value)} className={field} />
        </div>
        <button
          type="button"
          disabled={saving}
          onClick={handleCreate}
          className="rounded-md border border-(--color-line) px-3 py-1.5 text-sm hover:bg-(--color-canvas) disabled:opacity-50"
        >
          {saving ? 'Creating…' : 'Create budget version'}
        </button>
      </div>

      {error ? <p className="mt-2 text-sm text-(--color-bad)">{error}</p> : null}
    </div>
  );
}

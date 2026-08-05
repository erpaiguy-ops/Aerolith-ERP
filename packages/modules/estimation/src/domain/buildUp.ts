/**
 * Rate build-up — how a BOQ line gets a price.
 *
 * Pure functions over plain numbers. This is the arithmetic a tender is won or
 * lost on, so it is separately testable without a database anywhere near it.
 *
 * Two things here are where estimators actually lose money, and both are handled
 * explicitly rather than left to whoever writes the spreadsheet:
 *
 *  1. MARGIN IS NOT MARKUP. Adding 20% to cost gives a 16.7% margin, not 20%.
 *     An estimator who means margin and computes markup under-prices every line,
 *     and the error compounds across a whole tender.
 *  2. WASTAGE APPLIES TO MATERIAL, NOT TO LABOUR. Cutting 10% extra board does
 *     not mean paying the joiner 10% more. Applying wastage to the whole rate
 *     silently inflates every labour-heavy item.
 */

export type ComponentType =
  | 'material'
  | 'labour'
  | 'machine'
  | 'finishing'
  | 'hardware'
  | 'subcontract'
  | 'transport'
  | 'other';

export interface BuildUpComponent {
  type: ComponentType;
  description?: string;
  /** Quantity of this component per ONE unit of the BOQ item. */
  quantityPerUnit: number;
  unitRate: number;
  /**
   * Wastage as a percentage, applied to this component only. Meaningful on
   * material and finishing; meaningless on labour.
   */
  wastagePercent?: number;
}

export interface BuildUpOptions {
  /**
   * Overhead as a percentage of direct cost — site establishment, supervision,
   * the things not attributable to one line.
   */
  overheadPercent?: number;
  /** Profit expressed as MARGIN (share of selling price). */
  marginPercent?: number;
  /**
   * Profit expressed as MARKUP (share of cost) instead. Mutually exclusive with
   * marginPercent; supplying both is a configuration error, not a merge.
   */
  markupPercent?: number;
  /** Rounds the final rate. Tenders are rarely priced to four decimals. */
  roundTo?: number;
}

export interface ComponentBreakdown {
  type: ComponentType;
  description?: string;
  /** Cost before wastage. */
  netCost: number;
  /** Cost after wastage. */
  grossCost: number;
  wastageCost: number;
}

export interface BuildUpResult {
  components: ComponentBreakdown[];
  /** Sum of component gross costs. */
  directCost: number;
  overheadCost: number;
  /** Direct + overhead. What the item costs to deliver. */
  totalCost: number;
  profit: number;
  /** The number that goes on the tender. */
  unitRate: number;
  /** Profit as a share of the selling price. Always reported, however set. */
  effectiveMarginPercent: number;
  /** Profit as a share of cost. Always reported, however set. */
  effectiveMarkupPercent: number;
  byType: Record<string, number>;
}

export class BuildUpError extends Error {
  override readonly name = 'BuildUpError';
}

/**
 * Prices one unit of a BOQ item from its components.
 *
 * Order of operations matters and is fixed: wastage on each component, then
 * overhead on the direct cost, then profit on the total. Applying overhead after
 * profit, or profit before overhead, produces a different — and wrong — number.
 */
export function calculateBuildUp(
  components: readonly BuildUpComponent[],
  options: BuildUpOptions = {},
): BuildUpResult {
  if (options.marginPercent !== undefined && options.markupPercent !== undefined) {
    throw new BuildUpError(
      'Supply either marginPercent or markupPercent, not both — they are different ' +
        'things and silently combining them is how tenders get under-priced.',
    );
  }
  if (options.marginPercent !== undefined && options.marginPercent >= 100) {
    throw new BuildUpError('A margin of 100% or more is impossible: price would be infinite.');
  }

  const breakdown: ComponentBreakdown[] = components.map((component) => {
    if (component.quantityPerUnit < 0 || component.unitRate < 0) {
      throw new BuildUpError(
        `Component "${component.description ?? component.type}" has a negative quantity or rate.`,
      );
    }

    const netCost = component.quantityPerUnit * component.unitRate;
    // Wastage on labour is almost always a mistake, but it is the estimator's
    // call — the engine applies what it is given and the UI warns.
    const wastage = (component.wastagePercent ?? 0) / 100;
    const grossCost = netCost * (1 + wastage);

    return {
      type: component.type,
      description: component.description,
      netCost: round(netCost, 6),
      grossCost: round(grossCost, 6),
      wastageCost: round(grossCost - netCost, 6),
    };
  });

  const directCost = round(
    breakdown.reduce((sum, c) => sum + c.grossCost, 0),
    6,
  );

  const overheadCost = round(directCost * ((options.overheadPercent ?? 0) / 100), 6);
  const totalCost = round(directCost + overheadCost, 6);

  // MARGIN divides; MARKUP multiplies. This is the distinction that costs money.
  let unitRate: number;
  if (options.marginPercent !== undefined) {
    unitRate = totalCost / (1 - options.marginPercent / 100);
  } else if (options.markupPercent !== undefined) {
    unitRate = totalCost * (1 + options.markupPercent / 100);
  } else {
    unitRate = totalCost;
  }

  unitRate = options.roundTo ? roundTo(unitRate, options.roundTo) : round(unitRate, 4);
  const profit = round(unitRate - totalCost, 4);

  const byType: Record<string, number> = {};
  for (const component of breakdown) {
    byType[component.type] = round((byType[component.type] ?? 0) + component.grossCost, 4);
  }

  return {
    components: breakdown,
    directCost: round(directCost, 4),
    overheadCost: round(overheadCost, 4),
    totalCost: round(totalCost, 4),
    profit,
    unitRate,
    effectiveMarginPercent: unitRate === 0 ? 0 : round((profit / unitRate) * 100, 4),
    effectiveMarkupPercent: totalCost === 0 ? 0 : round((profit / totalCost) * 100, 4),
    byType,
  };
}

/** Converts a margin to the equivalent markup. */
export function marginToMarkup(marginPercent: number): number {
  if (marginPercent >= 100) {
    throw new BuildUpError('A margin of 100% or more has no finite markup equivalent.');
  }
  return round((marginPercent / (100 - marginPercent)) * 100, 6);
}

/** Converts a markup to the equivalent margin. */
export function markupToMargin(markupPercent: number): number {
  return round((markupPercent / (100 + markupPercent)) * 100, 6);
}

// ---------------------------------------------------------------------------

export interface EstimateLine {
  id: string;
  /** Section or element this line rolls up into. */
  sectionId?: string | null;
  quantity: number;
  unitRate: number;
  totalCost?: number;
  /** Provisional sums and prime cost items are excluded from margin analysis. */
  isProvisional?: boolean;
  /** An alternate the client may or may not take — never in the base total. */
  isOptional?: boolean;
}

export interface RollUp {
  /** Base total: everything except optional items. */
  total: number;
  /** Provisional sums and PC items within the base total. */
  provisionalTotal: number;
  /** Optional and alternate items, quoted separately. */
  optionalTotal: number;
  /** Total excluding provisional sums — the part actually being competed on. */
  competitiveTotal: number;
  cost: number;
  profit: number;
  marginPercent: number;
  lineCount: number;
}

/**
 * Rolls priced lines up to a tender total.
 *
 * Optional items are excluded from the base total on purpose. Including an
 * alternate the client did not ask for makes a bid look expensive and loses
 * tenders; quoting it separately is the convention and this enforces it.
 */
export function rollUp(lines: readonly EstimateLine[]): RollUp {
  let total = 0;
  let provisionalTotal = 0;
  let optionalTotal = 0;
  let cost = 0;

  for (const line of lines) {
    const value = line.quantity * line.unitRate;
    const lineCost = (line.totalCost ?? 0) * line.quantity;

    if (line.isOptional) {
      optionalTotal += value;
      continue;
    }

    total += value;
    cost += lineCost;
    if (line.isProvisional) provisionalTotal += value;
  }

  const profit = total - cost;

  return {
    total: round(total, 2),
    provisionalTotal: round(provisionalTotal, 2),
    optionalTotal: round(optionalTotal, 2),
    competitiveTotal: round(total - provisionalTotal, 2),
    cost: round(cost, 2),
    profit: round(profit, 2),
    marginPercent: total === 0 ? 0 : round((profit / total) * 100, 2),
    lineCount: lines.filter((l) => !l.isOptional).length,
  };
}

/** Rolls up per section, for the tender summary page. */
export function rollUpBySection(lines: readonly EstimateLine[]): Map<string, RollUp> {
  const grouped = new Map<string, EstimateLine[]>();

  for (const line of lines) {
    const key = line.sectionId ?? '';
    const existing = grouped.get(key);
    if (existing) existing.push(line);
    else grouped.set(key, [line]);
  }

  return new Map([...grouped.entries()].map(([sectionId, group]) => [sectionId, rollUp(group)]));
}

// ---------------------------------------------------------------------------

export interface MarginScenario {
  label: string;
  marginPercent: number;
  total: number;
  profit: number;
  /** Change against the base scenario. */
  deltaTotal: number;
}

/**
 * What-if analysis: the same cost base at several margins.
 *
 * The conversation an estimator has with a director before submission — "what
 * do we bid if we want the job?" — and it needs to be one call, not a
 * spreadsheet rebuild.
 */
export function marginScenarios(
  lines: readonly EstimateLine[],
  margins: readonly { label: string; marginPercent: number }[],
): MarginScenario[] {
  const base = rollUp(lines);

  return margins.map((scenario) => {
    if (scenario.marginPercent >= 100) {
      throw new BuildUpError(`Scenario "${scenario.label}": margin must be below 100%.`);
    }

    const total = round(base.cost / (1 - scenario.marginPercent / 100), 2);
    return {
      label: scenario.label,
      marginPercent: scenario.marginPercent,
      total,
      profit: round(total - base.cost, 2),
      deltaTotal: round(total - base.total, 2),
    };
  });
}

// ---------------------------------------------------------------------------

export interface HistoricalActual {
  /** Rate library item this actual relates to. */
  rateItemCode: string;
  /** Cost actually incurred per unit on a completed job. */
  actualUnitCost: number;
  quantity: number;
  completedOn: Date;
}

export interface RateSuggestion {
  rateItemCode: string;
  /** Rate currently in the library. */
  currentRate: number;
  /** Weighted average of what it actually cost. */
  actualAverage: number;
  variancePercent: number;
  /** Suggested new rate, weighted toward recent jobs. */
  suggestedRate: number;
  sampleSize: number;
  confidence: 'low' | 'medium' | 'high';
}

/**
 * Feeds job actuals back into the rate library.
 *
 * This is the compounding asset: every job finished makes the next estimate more
 * accurate, and nobody else in this market does it. Recent jobs are weighted
 * more heavily than old ones, because material prices and labour rates move.
 *
 * It SUGGESTS rather than applies. An estimator overriding a suggestion is
 * exercising judgement; the system silently changing rates under them is how
 * they stop trusting it.
 */
export function suggestRateFromActuals(
  rateItemCode: string,
  currentRate: number,
  actuals: readonly HistoricalActual[],
  options: { halfLifeDays?: number; asAt?: Date } = {},
): RateSuggestion | null {
  const relevant = actuals.filter((a) => a.rateItemCode === rateItemCode && a.quantity > 0);
  if (relevant.length === 0) return null;

  const asAt = options.asAt ?? new Date();
  const halfLifeDays = options.halfLifeDays ?? 365;

  // Exponential decay: a job a year old counts half as much as one today.
  let weightedSum = 0;
  let weightTotal = 0;
  let plainSum = 0;
  let plainQuantity = 0;

  for (const actual of relevant) {
    const ageDays = Math.max(0, (asAt.getTime() - actual.completedOn.getTime()) / 86_400_000);
    const recency = Math.pow(0.5, ageDays / halfLifeDays);
    const weight = actual.quantity * recency;

    weightedSum += actual.actualUnitCost * weight;
    weightTotal += weight;
    plainSum += actual.actualUnitCost * actual.quantity;
    plainQuantity += actual.quantity;
  }

  const suggestedRate = weightTotal === 0 ? currentRate : round(weightedSum / weightTotal, 4);
  const actualAverage = plainQuantity === 0 ? 0 : round(plainSum / plainQuantity, 4);

  return {
    rateItemCode,
    currentRate,
    actualAverage,
    variancePercent:
      currentRate === 0 ? 0 : round(((actualAverage - currentRate) / currentRate) * 100, 2),
    suggestedRate,
    sampleSize: relevant.length,
    // Three jobs is an anecdote; ten is a trend. Say which one this is rather
    // than presenting both with equal authority.
    confidence: relevant.length >= 10 ? 'high' : relevant.length >= 4 ? 'medium' : 'low',
  };
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function roundTo(value: number, nearest: number): number {
  if (nearest <= 0) return round(value, 4);
  return round(Math.round(value / nearest) * nearest, 4);
}

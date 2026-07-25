/**
 * Earned value and cost forecasting.
 *
 * The question this answers is the only one that matters on a live job: *we have
 * spent 60% of the budget — have we done 60% of the work?* Standard EVM answers
 * it, and it is standard precisely so that a QS, a PM and a financier all read
 * the number the same way. So the textbook formulae are used verbatim, with one
 * construction-specific addition described at `forecast()`.
 *
 * A caution the acronyms hide: EV is only as good as the progress measurement
 * behind it. If percentage complete came from someone's opinion, CPI is that
 * opinion divided by the general ledger. `containsManualClaims` on the progress
 * roll-up is there so this can be shown, not buried.
 */

export interface EarnedValueInput {
  /** BAC — the approved cost budget at completion, including approved variations. */
  budgetAtCompletion: number;
  /** PV — what the plan said should be earned by now. Optional: no baseline
   *  programme means no schedule variance, which is honest rather than zero. */
  plannedValue?: number;
  /** EV — budget value of work actually done. From the progress roll-up. */
  earnedValue: number;
  /** AC — cost actually incurred to date, from the job cost ledger. */
  actualCost: number;
  /** Purchase orders and subcontracts raised but not yet invoiced. */
  openCommitments?: number;
}

export interface EarnedValueMetrics {
  budgetAtCompletion: number;
  plannedValue: number | null;
  earnedValue: number;
  actualCost: number;
  openCommitments: number;

  /** EV − AC. Negative means the work done cost more than it was budgeted at. */
  costVariance: number;
  /** EV − PV. Negative means behind programme, measured in money. */
  scheduleVariance: number | null;

  /** EV / AC. Below 1.0 is losing money. Null when nothing has been spent. */
  costPerformanceIndex: number | null;
  /** EV / PV. Below 1.0 is late. Null with no baseline. */
  schedulePerformanceIndex: number | null;

  percentComplete: number;
  percentSpent: number;
}

export function earnedValueMetrics(input: EarnedValueInput): EarnedValueMetrics {
  const { budgetAtCompletion: bac, earnedValue: ev, actualCost: ac } = input;
  const pv = input.plannedValue ?? null;
  const commitments = input.openCommitments ?? 0;

  return {
    budgetAtCompletion: bac,
    plannedValue: pv,
    earnedValue: ev,
    actualCost: ac,
    openCommitments: commitments,

    costVariance: ev - ac,
    scheduleVariance: pv === null ? null : ev - pv,

    // Guarded rather than defaulted to 1.0: a CPI of 1.0 on day one reads as
    // "exactly on budget", which is a claim. Null reads as "not yet knowable".
    costPerformanceIndex: ac > 0 ? ev / ac : null,
    schedulePerformanceIndex: pv !== null && pv > 0 ? ev / pv : null,

    percentComplete: bac > 0 ? (ev / bac) * 100 : 0,
    percentSpent: bac > 0 ? (ac / bac) * 100 : 0,
  };
}

// ---------------------------------------------------------------------------
// Forecasting
// ---------------------------------------------------------------------------

export type ForecastMethod =
  /** Remaining work will cost what it was budgeted. The variance was one-off. */
  | 'budget_rate'
  /** Remaining work will cost at today's performance. EAC = BAC / CPI. */
  | 'performance_rate'
  /** Cost and schedule pressure both persist. The pessimistic standard method. */
  | 'cost_and_schedule';

export interface Forecast {
  method: ForecastMethod;
  /** EAC — forecast total cost at completion. */
  estimateAtCompletion: number;
  /** ETC — forecast remaining cost. */
  estimateToComplete: number;
  /** VAC — BAC − EAC. Negative is an overrun. */
  varianceAtCompletion: number;
  /**
   * TCPI — the cost performance required from here on to still land on budget.
   * Above ~1.1 in practice means the budget is gone; saying so early is the
   * entire point of the number.
   */
  toCompletePerformanceIndex: number | null;
  /** True when open commitments, not performance, set the remaining cost. */
  commitmentBound: boolean;
}

/**
 * Forecasts the final cost.
 *
 * The construction-specific part is `commitmentBound`. Textbook EVM forecasts
 * remaining cost purely from performance, which quietly assumes remaining money
 * is still discretionary. On a joinery job it is not: once the veneer is ordered
 * and the sub is appointed, that money is spent whether or not the CPI says so.
 * So the estimate to complete is floored at the open commitment balance, and the
 * flag says when the floor is what is driving the number — because that is a
 * different management problem from poor productivity, and the two need
 * different responses.
 */
export function forecast(
  input: EarnedValueInput,
  method: ForecastMethod = 'performance_rate',
): Forecast {
  const metrics = earnedValueMetrics(input);
  const { budgetAtCompletion: bac, earnedValue: ev, actualCost: ac } = input;
  const cpi = metrics.costPerformanceIndex;
  const spi = metrics.schedulePerformanceIndex;
  const commitments = input.openCommitments ?? 0;

  let etc: number;
  switch (method) {
    case 'budget_rate':
      etc = bac - ev;
      break;

    case 'performance_rate':
      // With no spend yet there is no performance to extrapolate, so this
      // degrades to the budget rate rather than dividing by zero.
      etc = cpi && cpi > 0 ? (bac - ev) / cpi : bac - ev;
      break;

    case 'cost_and_schedule': {
      const factor = (cpi ?? 1) * (spi ?? 1);
      etc = factor > 0 ? (bac - ev) / factor : bac - ev;
      break;
    }
  }

  // Remaining work never costs less than nothing, whatever the arithmetic says
  // once earned value exceeds the budget.
  etc = Math.max(0, etc);

  const commitmentBound = commitments > etc;
  if (commitmentBound) etc = commitments;

  const eac = ac + etc;

  return {
    method,
    estimateAtCompletion: eac,
    estimateToComplete: etc,
    varianceAtCompletion: bac - eac,
    // Once spend passes the budget, no future performance recovers it: the
    // index is undefined rather than negative, and a negative TCPI printed on a
    // report is read as "good" by someone in a hurry.
    toCompletePerformanceIndex: bac - ac > 0 ? (bac - ev) / (bac - ac) : null,
    commitmentBound,
  };
}

// ---------------------------------------------------------------------------
// Commercial position
// ---------------------------------------------------------------------------

export interface MarginPositionInput extends EarnedValueInput {
  /** Contract sum including approved variations — the revenue side. */
  contractValue: number;
  /** Original margin at tender, for the comparison that gets asked for. */
  tenderMarginPercent?: number;
}

export interface MarginPosition {
  contractValue: number;
  budgetAtCompletion: number;
  forecastCost: number;
  /** Contract value minus forecast cost. The number the director asks for. */
  forecastMargin: number;
  forecastMarginPercent: number;
  /** Margin implied by the budget, before any performance is known. */
  budgetMargin: number;
  budgetMarginPercent: number;
  /** Forecast margin minus budget margin, in currency. Negative is erosion. */
  marginErosion: number;
  tenderMarginPercent: number | null;
}

/**
 * Where the job's margin has actually got to.
 *
 * Margin is expressed against REVENUE throughout, matching the estimating
 * module: margin divides, markup multiplies, and mixing them here after getting
 * it right in the build-up would be the worst possible place to slip.
 */
export function marginPosition(
  input: MarginPositionInput,
  method: ForecastMethod = 'performance_rate',
): MarginPosition {
  const { contractValue, budgetAtCompletion: bac } = input;
  const forecastCost = forecast(input, method).estimateAtCompletion;

  const forecastMargin = contractValue - forecastCost;
  const budgetMargin = contractValue - bac;

  return {
    contractValue,
    budgetAtCompletion: bac,
    forecastCost,
    forecastMargin,
    forecastMarginPercent: contractValue > 0 ? (forecastMargin / contractValue) * 100 : 0,
    budgetMargin,
    budgetMarginPercent: contractValue > 0 ? (budgetMargin / contractValue) * 100 : 0,
    marginErosion: forecastMargin - budgetMargin,
    tenderMarginPercent: input.tenderMarginPercent ?? null,
  };
}

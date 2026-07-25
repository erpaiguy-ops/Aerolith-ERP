/**
 * Stock valuation.
 *
 * Money is handled as strings at the database boundary (Postgres `numeric`) and
 * converted here deliberately. Never let a numeric column become a float
 * implicitly — accumulated over a year of movements it produces a stock value
 * that does not reconcile to the ledger, and finding out why is expensive.
 */

export type CostingMethod = 'moving_average' | 'fifo' | 'standard';

export interface StockPosition {
  quantity: number;
  averageCost: number;
}

export interface ReceiptInput {
  quantity: number;
  unitCost: number;
}

export class NegativeStockError extends Error {
  override readonly name = 'NegativeStockError';
  constructor(available: number, requested: number) {
    super(
      `Cannot issue ${requested}: only ${available} on hand. Post a receipt or an ` +
        'adjustment first.',
    );
  }
}

/**
 * Applies a receipt using moving average.
 *
 *   newAverage = (oldQty × oldAvg + inQty × inCost) / (oldQty + inQty)
 *
 * Two cases the naive formula gets wrong, both handled:
 *
 *  - Receiving into ZERO stock. The old average is meaningless (often 0) and
 *    must not be averaged in; the new cost simply becomes the average.
 *  - Receiving into NEGATIVE stock, which happens where issues are allowed to
 *    run ahead of paperwork. Averaging against a negative quantity produces a
 *    nonsensical — sometimes negative — unit cost, so the incoming cost is
 *    taken as-is instead.
 */
export function applyReceipt(position: StockPosition, receipt: ReceiptInput): StockPosition {
  if (receipt.quantity <= 0) {
    throw new Error('A receipt quantity must be positive.');
  }

  const newQuantity = round(position.quantity + receipt.quantity, 4);

  if (position.quantity <= 0) {
    return { quantity: newQuantity, averageCost: round(receipt.unitCost, 6) };
  }

  const totalValue = position.quantity * position.averageCost + receipt.quantity * receipt.unitCost;
  return {
    quantity: newQuantity,
    averageCost: newQuantity === 0 ? 0 : round(totalValue / newQuantity, 6),
  };
}

/**
 * Applies an issue.
 *
 * The average cost does NOT change on an issue — that is the defining property
 * of moving average, and the reason the cost of goods issued is knowable at the
 * moment of issue rather than at period end.
 */
export function applyIssue(
  position: StockPosition,
  quantity: number,
  options: { allowNegative?: boolean } = {},
): { position: StockPosition; issuedValue: number } {
  if (quantity <= 0) {
    throw new Error('An issue quantity must be positive.');
  }

  if (!options.allowNegative && quantity > position.quantity) {
    throw new NegativeStockError(position.quantity, quantity);
  }

  return {
    position: {
      quantity: round(position.quantity - quantity, 4),
      averageCost: position.averageCost,
    },
    issuedValue: round(quantity * position.averageCost, 4),
  };
}

/**
 * Applies a stock-count adjustment.
 *
 * A positive variance is valued at the CURRENT average rather than a new cost:
 * finding stock you already owned is not a purchase, and valuing it at today's
 * price would quietly revalue the whole holding.
 */
export function applyAdjustment(
  position: StockPosition,
  countedQuantity: number,
): { position: StockPosition; varianceQuantity: number; varianceValue: number } {
  const varianceQuantity = round(countedQuantity - position.quantity, 4);

  return {
    position: { quantity: round(countedQuantity, 4), averageCost: position.averageCost },
    varianceQuantity,
    varianceValue: round(varianceQuantity * position.averageCost, 4),
  };
}

/** Total value of a position. */
export function positionValue(position: StockPosition): number {
  return round(position.quantity * position.averageCost, 4);
}

/**
 * Apportions a landed cost (freight, duty, clearing) across receipt lines by
 * value.
 *
 * Rounding remainder goes to the largest line, so the apportioned total always
 * equals the cost being apportioned. Dropping a fraction here is how a stock
 * ledger stops reconciling to the purchase ledger.
 */
export function apportionLandedCost(
  lines: { id: string; value: number }[],
  landedCost: number,
): Map<string, number> {
  const result = new Map<string, number>();
  if (lines.length === 0 || landedCost === 0) {
    for (const line of lines) result.set(line.id, 0);
    return result;
  }

  const totalValue = lines.reduce((sum, line) => sum + line.value, 0);

  if (totalValue === 0) {
    // No value to apportion by — split evenly rather than silently dropping it.
    const share = round(landedCost / lines.length, 4);
    let remaining = landedCost;
    lines.forEach((line, index) => {
      const amount = index === lines.length - 1 ? round(remaining, 4) : share;
      result.set(line.id, amount);
      remaining = round(remaining - amount, 4);
    });
    return result;
  }

  let allocated = 0;
  for (const line of lines) {
    const amount = round((line.value / totalValue) * landedCost, 4);
    result.set(line.id, amount);
    allocated = round(allocated + amount, 4);
  }

  const remainder = round(landedCost - allocated, 4);
  if (remainder !== 0) {
    const largest = lines.reduce((a, b) => (b.value > a.value ? b : a));
    result.set(largest.id, round((result.get(largest.id) ?? 0) + remainder, 4));
  }

  return result;
}

/** Parses a Postgres `numeric` string. Rejects rather than silently yielding NaN. */
export function toNumber(value: string | number | null | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Expected a numeric value, received ${JSON.stringify(value)}.`);
  }
  return parsed;
}

/** Formats for a Postgres `numeric` column. */
export function toNumeric(value: number, scale = 4): string {
  return value.toFixed(scale);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  // +Number.EPSILON corrects the classic 1.005 → 1.00 float artefact.
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

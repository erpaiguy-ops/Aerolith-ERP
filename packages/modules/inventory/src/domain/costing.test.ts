import { describe, expect, it } from 'vitest';

import {
  NegativeStockError,
  apportionLandedCost,
  applyAdjustment,
  applyIssue,
  applyReceipt,
  positionValue,
  toNumber,
} from './costing';

describe('applyReceipt', () => {
  it('averages a receipt into existing stock', () => {
    // 10 @ 100 + 10 @ 200 → 20 @ 150
    const result = applyReceipt({ quantity: 10, averageCost: 100 }, { quantity: 10, unitCost: 200 });
    expect(result.quantity).toBe(20);
    expect(result.averageCost).toBe(150);
  });

  it('takes the receipt cost outright when stock is zero', () => {
    // The old average is meaningless at zero quantity and must not dilute the
    // new cost.
    const result = applyReceipt({ quantity: 0, averageCost: 999 }, { quantity: 5, unitCost: 42 });
    expect(result.averageCost).toBe(42);
  });

  it('takes the receipt cost outright when stock is negative', () => {
    // Averaging against a negative quantity yields a nonsensical unit cost.
    const result = applyReceipt({ quantity: -5, averageCost: 100 }, { quantity: 10, unitCost: 80 });
    expect(result.quantity).toBe(5);
    expect(result.averageCost).toBe(80);
  });

  it('weights by quantity, not by line count', () => {
    // 100 @ 10 + 1 @ 1000 must not average to 505.
    const result = applyReceipt({ quantity: 100, averageCost: 10 }, { quantity: 1, unitCost: 1000 });
    expect(result.averageCost).toBeCloseTo(19.802, 3);
  });

  it('rejects a non-positive receipt', () => {
    expect(() => applyReceipt({ quantity: 1, averageCost: 1 }, { quantity: 0, unitCost: 1 })).toThrow();
    expect(() => applyReceipt({ quantity: 1, averageCost: 1 }, { quantity: -5, unitCost: 1 })).toThrow();
  });

  it('does not accumulate float error over many receipts', () => {
    let position = { quantity: 0, averageCost: 0 };
    for (let i = 0; i < 100; i += 1) {
      position = applyReceipt(position, { quantity: 0.1, unitCost: 10.05 });
    }
    expect(position.quantity).toBe(10);
    expect(position.averageCost).toBeCloseTo(10.05, 4);
  });
});

describe('applyIssue', () => {
  it('leaves the average cost unchanged — the defining property of moving average', () => {
    const { position, issuedValue } = applyIssue({ quantity: 20, averageCost: 150 }, 5);
    expect(position.quantity).toBe(15);
    expect(position.averageCost).toBe(150);
    expect(issuedValue).toBe(750);
  });

  it('refuses to issue more than is on hand', () => {
    expect(() => applyIssue({ quantity: 3, averageCost: 10 }, 5)).toThrow(NegativeStockError);
  });

  it('allows negative stock when explicitly permitted', () => {
    const { position } = applyIssue({ quantity: 3, averageCost: 10 }, 5, { allowNegative: true });
    expect(position.quantity).toBe(-2);
  });

  it('names the numbers in the error so a storekeeper can act on it', () => {
    try {
      applyIssue({ quantity: 3, averageCost: 10 }, 5);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('5');
      expect((error as Error).message).toContain('3');
    }
  });
});

describe('applyAdjustment', () => {
  it('values a positive variance at the existing average, not a new cost', () => {
    // Finding stock you already owned is not a purchase.
    const result = applyAdjustment({ quantity: 10, averageCost: 50 }, 12);
    expect(result.varianceQuantity).toBe(2);
    expect(result.varianceValue).toBe(100);
    expect(result.position.averageCost).toBe(50);
  });

  it('values a shortfall as a negative variance', () => {
    const result = applyAdjustment({ quantity: 10, averageCost: 50 }, 7);
    expect(result.varianceQuantity).toBe(-3);
    expect(result.varianceValue).toBe(-150);
  });

  it('reports zero variance when the count agrees', () => {
    const result = applyAdjustment({ quantity: 10, averageCost: 50 }, 10);
    expect(result.varianceQuantity).toBe(0);
    expect(result.varianceValue).toBe(0);
  });
});

describe('apportionLandedCost', () => {
  it('splits by value', () => {
    const result = apportionLandedCost(
      [
        { id: 'a', value: 750 },
        { id: 'b', value: 250 },
      ],
      100,
    );

    expect(result.get('a')).toBe(75);
    expect(result.get('b')).toBe(25);
  });

  it('always apportions the full amount despite rounding', () => {
    // Three equal lines and 100 of freight cannot divide evenly; the remainder
    // must not be dropped, or stock stops reconciling to the purchase ledger.
    const result = apportionLandedCost(
      [
        { id: 'a', value: 100 },
        { id: 'b', value: 100 },
        { id: 'c', value: 100 },
      ],
      100,
    );

    const total = [...result.values()].reduce((sum, v) => sum + v, 0);
    expect(Math.round(total * 10000) / 10000).toBe(100);
  });

  it('splits evenly when the lines carry no value', () => {
    const result = apportionLandedCost(
      [
        { id: 'a', value: 0 },
        { id: 'b', value: 0 },
      ],
      50,
    );

    expect([...result.values()].reduce((s, v) => s + v, 0)).toBe(50);
  });

  it('handles no landed cost and no lines', () => {
    expect(apportionLandedCost([{ id: 'a', value: 10 }], 0).get('a')).toBe(0);
    expect(apportionLandedCost([], 100).size).toBe(0);
  });
});

describe('positionValue', () => {
  it('multiplies quantity by average cost', () => {
    expect(positionValue({ quantity: 12.5, averageCost: 8 })).toBe(100);
  });
});

describe('toNumber', () => {
  it('parses the strings Postgres numeric returns', () => {
    expect(toNumber('123.4500')).toBe(123.45);
  });

  it('falls back for null and undefined', () => {
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined, 7)).toBe(7);
  });

  it('throws rather than yielding NaN', () => {
    // A silent NaN propagates into stock value and is found weeks later.
    expect(() => toNumber('not a number')).toThrow();
  });
});

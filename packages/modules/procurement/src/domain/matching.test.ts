import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TOLERANCE,
  checkReceipt,
  matchInvoice,
  withinTolerance,
  type PurchaseOrderLine,
} from './matching';

const orderLine = (overrides: Partial<PurchaseOrderLine> = {}): PurchaseOrderLine => ({
  reference: 'L1',
  description: '18mm MDF',
  quantityOrdered: 100,
  unitPrice: 92,
  quantityReceived: 0,
  quantityInvoiced: 0,
  ...overrides,
});

describe('tolerance', () => {
  it('accepts a trivial absolute difference whatever the percentage', () => {
    // 2 AED item billed at 5: 150% over, but 3 AED. Generating an exception a
    // human must read costs more than the difference.
    const result = withinTolerance(2, 5, DEFAULT_TOLERANCE);
    expect(result.pass).toBe(true);
    expect(result.percent).toBe(150);
  });

  it('accepts a small proportional difference', () => {
    expect(withinTolerance(1_000, 1_015, DEFAULT_TOLERANCE).pass).toBe(true);
  });

  it('rejects a proportional difference beyond the percentage', () => {
    expect(withinTolerance(1_000, 1_060, DEFAULT_TOLERANCE).pass).toBe(false);
  });

  it('rejects a large absolute difference even at a small percentage', () => {
    // 1% of 200,000 is 2,000 — inside the percentage, far outside what anyone
    // would want to pay without looking.
    const result = withinTolerance(200_000, 202_000, DEFAULT_TOLERANCE);
    expect(Math.abs(result.percent)).toBeLessThan(DEFAULT_TOLERANCE.pricePercent);
    expect(result.pass).toBe(false);
  });

  it('always passes a favourable variance, however large', () => {
    // Charged less than agreed. Blocking payment generates a phone call and no
    // benefit whatsoever.
    const result = withinTolerance(1_000, 400, DEFAULT_TOLERANCE);
    expect(result.pass).toBe(true);
    expect(result.difference).toBe(-600);
  });

  it('treats a charge against a zero expected price as a full variance', () => {
    expect(withinTolerance(0, 100, DEFAULT_TOLERANCE).percent).toBe(100);
    expect(withinTolerance(0, 0, DEFAULT_TOLERANCE).pass).toBe(true);
  });
});

describe('invoice matching', () => {
  it('matches an invoice for exactly what was received', () => {
    const result = matchInvoice({
      orderLines: [orderLine({ quantityReceived: 40 })],
      invoiceLines: [{ purchaseOrderLineReference: 'L1', description: '18mm MDF', quantity: 40, unitPrice: 92 }],
    });

    expect(result.status).toBe('matched');
    expect(result.invoiceTotal).toBe(3_680);
    expect(result.variance).toBe(0);
  });

  it('holds an invoice for more than has been received', () => {
    // The one that costs real money: 100 billed, 40 delivered.
    const result = matchInvoice({
      orderLines: [orderLine({ quantityReceived: 40 })],
      invoiceLines: [{ purchaseOrderLineReference: 'L1', description: '18mm MDF', quantity: 100, unitPrice: 92 }],
    });

    expect(result.status).toBe('exception');
    const exception = result.exceptions.find((e) => e.code === 'over_invoiced_quantity')!;
    expect(exception).toBeDefined();
    expect(exception.amount).toBe(60 * 92);
  });

  it('matches against received-and-unbilled, not against the order', () => {
    // A supplier who has delivered 40 and billed 40 can bill nothing more,
    // however much the purchase order says. Comparing each invoice to the ORDER
    // quantity would let them bill the full 100 three times over without any
    // single invoice looking wrong.
    const result = matchInvoice({
      orderLines: [orderLine({ quantityReceived: 40, quantityInvoiced: 40 })],
      invoiceLines: [{ purchaseOrderLineReference: 'L1', description: '18mm MDF', quantity: 40, unitPrice: 92 }],
    });

    expect(result.status).toBe('exception');
    expect(result.exceptions[0]!.code).toBe('over_invoiced_quantity');
    expect(result.lines[0]!.quantityAvailableToBill).toBe(0);
  });

  it('accepts the second invoice of a partial delivery', () => {
    // 40 delivered and billed, another 35 arrives: 35 is now billable.
    const result = matchInvoice({
      orderLines: [orderLine({ quantityReceived: 75, quantityInvoiced: 40 })],
      invoiceLines: [{ purchaseOrderLineReference: 'L1', description: '18mm MDF', quantity: 35, unitPrice: 92 }],
    });

    expect(result.status).toBe('matched');
    expect(result.lines[0]!.quantityAvailableToBill).toBe(35);
  });

  it('holds an invoice with no goods receipt at all', () => {
    const result = matchInvoice({
      orderLines: [orderLine()],
      invoiceLines: [{ purchaseOrderLineReference: 'L1', description: '18mm MDF', quantity: 10, unitPrice: 92 }],
    });

    expect(result.exceptions.map((e) => e.code)).toContain('no_receipt');
  });

  it('holds a price above the ordered price', () => {
    const result = matchInvoice({
      orderLines: [orderLine({ quantityReceived: 100 })],
      invoiceLines: [{ purchaseOrderLineReference: 'L1', description: '18mm MDF', quantity: 100, unitPrice: 110 }],
    });

    expect(result.status).toBe('exception');
    const exception = result.exceptions.find((e) => e.code === 'price_variance')!;
    expect(exception.amount).toBe(18 * 100);
    expect(result.variance).toBe(1_800);
  });

  it('reports an undercharge without blocking the invoice', () => {
    const result = matchInvoice({
      orderLines: [orderLine({ quantityReceived: 100 })],
      invoiceLines: [{ purchaseOrderLineReference: 'L1', description: '18mm MDF', quantity: 100, unitPrice: 85 }],
    });

    expect(result.status).toBe('matched');
    expect(result.favourable).toHaveLength(1);
    expect(result.variance).toBe(-700);
  });

  it('holds a line that is not on the purchase order', () => {
    const result = matchInvoice({
      orderLines: [orderLine({ quantityReceived: 100 })],
      invoiceLines: [
        { purchaseOrderLineReference: 'L1', description: '18mm MDF', quantity: 100, unitPrice: 92 },
        { purchaseOrderLineReference: null, description: 'Pallet charge', quantity: 1, unitPrice: 150 },
      ],
    });

    expect(result.status).toBe('exception');
    expect(result.exceptions.map((e) => e.code)).toContain('unmatched_line');
    // The unordered line still counts towards what the supplier is claiming, or
    // the totals would not reconcile with the paper invoice.
    expect(result.invoiceTotal).toBe(9_350);
    expect(result.expectedTotal).toBe(9_200);
  });

  it('raises every failing line, not just the first', () => {
    // A buyer triaging exceptions needs all of them, sized, in one pass.
    const result = matchInvoice({
      orderLines: [
        orderLine({ reference: 'L1', quantityReceived: 10 }),
        orderLine({ reference: 'L2', description: 'Edge tape', quantityOrdered: 500, unitPrice: 3, quantityReceived: 500 }),
      ],
      invoiceLines: [
        { purchaseOrderLineReference: 'L1', description: '18mm MDF', quantity: 40, unitPrice: 92 },
        { purchaseOrderLineReference: 'L2', description: 'Edge tape', quantity: 500, unitPrice: 4.2 },
      ],
    });

    expect(result.exceptions).toHaveLength(2);
    expect(result.exceptions.map((e) => e.code).sort()).toEqual([
      'over_invoiced_quantity',
      'price_variance',
    ]);
  });
});

describe('receipt checking', () => {
  it('accepts a delivery inside the over-delivery tolerance', () => {
    // 103 against an order of 100 is a full pallet, not a dispute.
    const result = checkReceipt({
      orderLines: [orderLine()],
      receiptLines: [{ purchaseOrderLineReference: 'L1', quantity: 103 }],
    });

    expect(result.overDelivered).toBe(false);
  });

  it('flags a material over-delivery, priced', () => {
    const result = checkReceipt({
      orderLines: [orderLine()],
      receiptLines: [{ purchaseOrderLineReference: 'L1', quantity: 140 }],
    });

    expect(result.overDelivered).toBe(true);
    expect(result.exceptions[0]!.amount).toBe(40 * 92);
  });

  it('counts deliveries cumulatively', () => {
    // 90 already in, another 30 arriving. Each looks fine alone; together they
    // are 20% over.
    const result = checkReceipt({
      orderLines: [orderLine({ quantityReceived: 90 })],
      receiptLines: [{ purchaseOrderLineReference: 'L1', quantity: 30 }],
    });

    expect(result.overDelivered).toBe(true);
  });

  it('flags goods that are not on the order', () => {
    const result = checkReceipt({
      orderLines: [orderLine()],
      receiptLines: [{ purchaseOrderLineReference: 'NOPE', quantity: 5 }],
    });

    expect(result.exceptions[0]!.code).toBe('unmatched_line');
  });
});

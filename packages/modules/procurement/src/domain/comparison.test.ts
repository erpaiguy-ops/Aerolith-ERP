import { describe, expect, it } from 'vitest';

import {
  ComparisonError,
  compareQuotes,
  orderQuantityFor,
  paymentTermsValue,
  type QuoteInput,
} from './comparison';

const quote = (overrides: Partial<QuoteInput> = {}): QuoteInput => ({
  supplierId: 'S1',
  supplierName: 'Gulf Panels',
  currencyCode: 'AED',
  exchangeRate: 1,
  unitPrice: 96,
  ...overrides,
});

describe('order quantity', () => {
  it('buys what is needed when there is no minimum', () => {
    expect(orderQuantityFor(140, {})).toBe(140);
  });

  it('lifts to the supplier minimum', () => {
    expect(orderQuantityFor(140, { minimumOrderQuantity: 200 })).toBe(200);
  });

  it('rounds up to the next increment', () => {
    // Sold by the pallet of 25.
    expect(orderQuantityFor(140, { orderIncrement: 25 })).toBe(150);
  });

  it('applies the minimum before the increment', () => {
    // 140 needed, minimum 200, pallets of 60. Rounding first gives 180 — below
    // the minimum, so the supplier refuses the order. Minimum first gives 240.
    expect(orderQuantityFor(140, { minimumOrderQuantity: 200, orderIncrement: 60 })).toBe(240);
  });

  it('leaves an exact multiple alone', () => {
    expect(orderQuantityFor(150, { orderIncrement: 25 })).toBe(150);
  });
});

describe('payment terms', () => {
  it('prices credit as a benefit', () => {
    // 100,000 held for 60 days at 8% is worth 1,315.07.
    const value = paymentTermsValue(100_000, { paymentTermDays: 60 }, 0.08);
    expect(value).toBeCloseTo(-1_315.07, 2);
  });

  it('is worth nothing when payment is due on delivery', () => {
    expect(paymentTermsValue(100_000, {}, 0.08)).toBe(0);
  });

  it('takes a discount that beats the cost of capital', () => {
    // "2/10 net 60" — 2% for giving up 50 days is an implied ~14.7% a year,
    // comfortably above an 8% cost of capital, so it should be taken.
    //   pay late : -100,000 x 8% x 60/365 = -1,315.07
    //   pay early: -2,000 - 100,000 x 8% x 10/365 = -2,219.18
    const value = paymentTermsValue(
      100_000,
      { paymentTermDays: 60, earlyPaymentDiscountPercent: 2, earlyPaymentDays: 10 },
      0.08,
    );
    expect(value).toBeCloseTo(-2_219.18, 2);
  });

  it('refuses a discount that does not', () => {
    // "0.25/10 net 60" is about 1.8% a year. Taking it destroys value, and a
    // buyer chasing "free money" would take it every time.
    const value = paymentTermsValue(
      100_000,
      { paymentTermDays: 60, earlyPaymentDiscountPercent: 0.25, earlyPaymentDays: 10 },
      0.08,
    );
    expect(value).toBeCloseTo(-1_315.07, 2);
  });

  it('takes any discount when capital is free', () => {
    // Cost of capital zero: credit is worth nothing, so 0.25% is pure gain.
    const value = paymentTermsValue(
      100_000,
      { paymentTermDays: 60, earlyPaymentDiscountPercent: 0.25, earlyPaymentDays: 10 },
      0,
    );
    expect(value).toBe(-250);
  });
});

describe('quote comparison', () => {
  it('ranks on landed cost, not unit price', () => {
    // The whole reason this file exists. Ex-works Italy at 20 EUR is a 80 AED
    // sheet against a 96 AED sheet delivered in Dubai — and loses once freight
    // and duty are counted.
    const result = compareQuotes(
      [
        quote({ supplierId: 'IT', supplierName: 'Lombardia Legno', currencyCode: 'EUR', exchangeRate: 4, unitPrice: 20, freight: 900, dutyPercent: 5 }),
        quote({ supplierId: 'AE', supplierName: 'Gulf Panels', unitPrice: 96, paymentTermDays: 30 }),
      ],
      { quantityRequired: 140, surplusIsStock: true },
    );

    expect(result.map((r) => r.supplierId)).toEqual(['AE', 'IT']);

    // Italy: (2,800 goods + 140 duty + 900 freight) x 4 = 15,360.
    expect(result[1]!.landedCost).toBe(15_360);
    // Dubai: 13,440 less 30 days of credit at 8%.
    expect(result[0]!.landedCost).toBeCloseTo(13_351.63, 2);
    expect(result[0]!.premiumOverBest).toBe(0);
    expect(result[1]!.premiumOverBest).toBeCloseTo(2_008.37, 2);
  });

  it('components add up to the landed cost', () => {
    // A buyer checks the column against the footer before they check anything
    // else. If it does not tie out they stop trusting the whole comparison.
    const [only] = compareQuotes(
      [quote({ currencyCode: 'EUR', exchangeRate: 3.9713, unitPrice: 20.35, freight: 917.5, dutyPercent: 5, otherCharges: 63.25, paymentTermDays: 45, minimumOrderQuantity: 175 })],
      { quantityRequired: 140, surplusIsStock: true },
    );

    const sum =
      only!.goodsValue +
      only!.freight +
      only!.duty +
      only!.otherCharges +
      only!.paymentTermsBenefit +
      only!.surplusCredit;

    expect(only!.landedCost).toBe(Math.round(sum * 100) / 100);
  });

  it('charges surplus bought only to clear a minimum when it will never be used', () => {
    // 140 needed, 200 minimum, at 90. The 60 spare are a one-off colour nobody
    // will order again, so the full 18,000 is the cost of getting 140 sheets.
    const [result] = compareQuotes(
      [quote({ unitPrice: 90, minimumOrderQuantity: 200 })],
      { quantityRequired: 140, surplusIsStock: false },
    );

    expect(result!.quantityToOrder).toBe(200);
    expect(result!.surplusQuantity).toBe(60);
    expect(result!.surplusValue).toBe(5_400);
    expect(result!.surplusCredit).toBe(0);
    expect(result!.landedCost).toBe(18_000);
    // 90 a sheet on the label, 128.57 in reality.
    expect(result!.effectiveUnitCost).toBe(128.57);
  });

  it('credits surplus that is genuine stock, so an MOQ costs nothing but capital', () => {
    // Same order, but 18mm MDF goes on the next job. The 60 spare are an asset,
    // and the effective unit cost falls back to exactly the quoted price.
    const [result] = compareQuotes(
      [quote({ unitPrice: 90, minimumOrderQuantity: 200 })],
      { quantityRequired: 140, surplusIsStock: true },
    );

    expect(result!.surplusCredit).toBe(-5_400);
    expect(result!.landedCost).toBe(12_600);
    expect(result!.effectiveUnitCost).toBe(90);
  });

  it('does not bill the surplus twice', () => {
    // The surplus is already inside the goods value — it is bought and paid for.
    // Charging it again as a write-off on top made every minimum order look
    // roughly twice as punitive as it is, and would push a buyer towards a
    // supplier with no MOQ and a worse price.
    const [result] = compareQuotes(
      [quote({ unitPrice: 90, minimumOrderQuantity: 200 })],
      { quantityRequired: 140, surplusIsStock: false },
    );

    expect(result!.goodsValue).toBe(18_000);
    expect(result!.landedCost).toBe(result!.goodsValue);
  });

  it('credits stock surplus at the landed rate, duty included', () => {
    // Duty scales with quantity, so the surplus carries its share of it.
    // Freight does not: it would have been paid on the smaller order too.
    const [result] = compareQuotes(
      [quote({ unitPrice: 100, dutyPercent: 5, freight: 500, minimumOrderQuantity: 120 })],
      { quantityRequired: 100, surplusIsStock: true },
    );

    // 20 spare at 100 plus 5% duty.
    expect(result!.surplusCredit).toBe(-2_100);
    // 12,000 goods + 600 duty + 500 freight − 2,100 credited.
    expect(result!.landedCost).toBe(11_000);
  });

  it('reports lead time without pricing it', () => {
    // Two weeks longer is free when the job is not waiting and ruinous when it
    // is. This module cannot know which, so it shows the number and ranks on
    // money — a buyer overrides with a reason rather than being told an answer.
    const result = compareQuotes(
      [
        quote({ supplierId: 'SLOW', unitPrice: 88, leadTimeDays: 45 }),
        quote({ supplierId: 'FAST', unitPrice: 96, leadTimeDays: 3 }),
      ],
      { quantityRequired: 100, surplusIsStock: true },
    );

    expect(result[0]!.supplierId).toBe('SLOW');
    expect(result[0]!.leadTimeDays).toBe(45);
    expect(result[1]!.leadTimeDays).toBe(3);
  });

  it('leaves lead time null when the supplier did not say', () => {
    const [result] = compareQuotes([quote()], { quantityRequired: 10, surplusIsStock: true });
    expect(result!.leadTimeDays).toBeNull();
  });

  it('carries the buyer’s notes through to the comparison', () => {
    const [result] = compareQuotes(
      [quote({ notes: 'FSC certified, 10-year warranty' })],
      { quantityRequired: 10, surplusIsStock: true },
    );
    expect(result!.notes).toBe('FSC certified, 10-year warranty');
  });

  it('keeps input order on an exact tie', () => {
    // A deliberate preference — listing the incumbent first — survives a tie
    // rather than being reordered by whatever the sort happens to do.
    const result = compareQuotes(
      [quote({ supplierId: 'INCUMBENT' }), quote({ supplierId: 'CHALLENGER' })],
      { quantityRequired: 100, surplusIsStock: true },
    );

    expect(result.map((r) => r.supplierId)).toEqual(['INCUMBENT', 'CHALLENGER']);
    expect(result[1]!.premiumOverBest).toBe(0);
  });

  it('uses the cost of capital it is given', () => {
    // A business on an overdraft values 90 days far more than one sitting on
    // cash. Encoding one assumption for everybody would be wrong for most.
    const cheap = compareQuotes([quote({ paymentTermDays: 90 })], {
      quantityRequired: 100,
      surplusIsStock: true,
      costOfCapitalPercent: 2,
    });
    const dear = compareQuotes([quote({ paymentTermDays: 90 })], {
      quantityRequired: 100,
      surplusIsStock: true,
      costOfCapitalPercent: 24,
    });

    expect(dear[0]!.landedCost).toBeLessThan(cheap[0]!.landedCost);
  });

  it('returns nothing for no quotes', () => {
    expect(compareQuotes([], { quantityRequired: 100, surplusIsStock: true })).toEqual([]);
  });

  it('refuses a comparison with nothing to buy', () => {
    expect(() => compareQuotes([quote()], { quantityRequired: 0, surplusIsStock: true })).toThrow(
      ComparisonError,
    );
  });

  it('refuses a quote with no usable exchange rate', () => {
    // Silently treating a missing rate as 1 would make a EUR quote look four
    // times cheaper than it is, and the award would be made on it.
    expect(() =>
      compareQuotes([quote({ currencyCode: 'EUR', exchangeRate: 0 })], {
        quantityRequired: 100,
        surplusIsStock: true,
      }),
    ).toThrow(ComparisonError);
  });
});

import { describe, expect, it } from 'vitest';

import {
  BuildUpError,
  calculateBuildUp,
  marginScenarios,
  marginToMarkup,
  markupToMargin,
  rollUp,
  rollUpBySection,
  suggestRateFromActuals,
  type BuildUpComponent,
  type EstimateLine,
} from './buildUp';

/** A wardrobe door: board, edging, labour, spray. */
const doorComponents: BuildUpComponent[] = [
  { type: 'material', description: '18mm MDF', quantityPerUnit: 0.98, unitRate: 92, wastagePercent: 10 },
  { type: 'material', description: 'Edge tape', quantityPerUnit: 4.9, unitRate: 3.2, wastagePercent: 5 },
  { type: 'labour', description: 'Machining', quantityPerUnit: 0.75, unitRate: 45 },
  { type: 'finishing', description: '2-pack spray', quantityPerUnit: 0.98, unitRate: 55, wastagePercent: 15 },
  { type: 'hardware', description: 'Soft-close hinges', quantityPerUnit: 2, unitRate: 18 },
];

describe('calculateBuildUp — components and wastage', () => {
  it('sums components into a direct cost', () => {
    const result = calculateBuildUp([
      { type: 'material', quantityPerUnit: 2, unitRate: 50 },
      { type: 'labour', quantityPerUnit: 1, unitRate: 30 },
    ]);

    expect(result.directCost).toBe(130);
    expect(result.unitRate).toBe(130);
  });

  it('applies wastage per component, not to the whole rate', () => {
    // Cutting 10% extra board does not mean paying the joiner 10% more.
    const result = calculateBuildUp([
      { type: 'material', quantityPerUnit: 1, unitRate: 100, wastagePercent: 10 },
      { type: 'labour', quantityPerUnit: 1, unitRate: 100 },
    ]);

    expect(result.directCost).toBe(210);
    expect(result.components[0]!.wastageCost).toBe(10);
    expect(result.components[1]!.wastageCost).toBe(0);
  });

  it('reports cost grouped by component type', () => {
    const result = calculateBuildUp(doorComponents);

    expect(result.byType.material).toBeGreaterThan(0);
    expect(result.byType.labour).toBe(33.75);
    expect(result.byType.hardware).toBe(36);
  });

  it('rejects a negative quantity or rate', () => {
    expect(() =>
      calculateBuildUp([{ type: 'material', quantityPerUnit: -1, unitRate: 50 }]),
    ).toThrow(BuildUpError);
  });

  it('handles an empty build-up', () => {
    const result = calculateBuildUp([]);
    expect(result.directCost).toBe(0);
    expect(result.unitRate).toBe(0);
    expect(result.effectiveMarginPercent).toBe(0);
  });
});

describe('calculateBuildUp — margin versus markup', () => {
  // This is the distinction that costs real money on a tender.

  it('treats margin as a share of the SELLING price', () => {
    // 100 cost at 20% margin sells at 125, not 120.
    const result = calculateBuildUp([{ type: 'material', quantityPerUnit: 1, unitRate: 100 }], {
      marginPercent: 20,
    });

    expect(result.unitRate).toBe(125);
    expect(result.profit).toBe(25);
    expect(result.effectiveMarginPercent).toBe(20);
  });

  it('treats markup as a share of COST', () => {
    // 100 cost at 20% markup sells at 120 — and that is only a 16.7% margin.
    const result = calculateBuildUp([{ type: 'material', quantityPerUnit: 1, unitRate: 100 }], {
      markupPercent: 20,
    });

    expect(result.unitRate).toBe(120);
    expect(result.effectiveMarginPercent).toBeCloseTo(16.667, 2);
  });

  it('always reports both, so the difference is impossible to miss', () => {
    const result = calculateBuildUp([{ type: 'material', quantityPerUnit: 1, unitRate: 100 }], {
      marginPercent: 25,
    });

    expect(result.effectiveMarginPercent).toBe(25);
    expect(result.effectiveMarkupPercent).toBeCloseTo(33.333, 2);
  });

  it('refuses to accept both at once rather than silently picking one', () => {
    expect(() =>
      calculateBuildUp([{ type: 'material', quantityPerUnit: 1, unitRate: 100 }], {
        marginPercent: 20,
        markupPercent: 20,
      }),
    ).toThrow(/not both/i);
  });

  it('refuses a margin of 100% or more, which has no finite price', () => {
    expect(() =>
      calculateBuildUp([{ type: 'material', quantityPerUnit: 1, unitRate: 100 }], {
        marginPercent: 100,
      }),
    ).toThrow(/impossible/i);
  });
});

describe('calculateBuildUp — overhead ordering', () => {
  it('applies overhead to direct cost, then profit to the total', () => {
    // 100 direct + 10% overhead = 110 cost; 20% margin on 110 = 137.50.
    // Applying profit first would give a different, wrong answer.
    const result = calculateBuildUp([{ type: 'material', quantityPerUnit: 1, unitRate: 100 }], {
      overheadPercent: 10,
      marginPercent: 20,
    });

    expect(result.overheadCost).toBe(10);
    expect(result.totalCost).toBe(110);
    expect(result.unitRate).toBe(137.5);
  });

  it('rounds the final rate to a sensible increment when asked', () => {
    const result = calculateBuildUp([{ type: 'material', quantityPerUnit: 1, unitRate: 97.37 }], {
      marginPercent: 18,
      roundTo: 0.5,
    });

    expect(result.unitRate % 0.5).toBe(0);
  });

  it('prices a realistic door build-up', () => {
    const result = calculateBuildUp(doorComponents, { overheadPercent: 8, marginPercent: 18 });

    expect(result.directCost).toBeGreaterThan(0);
    expect(result.unitRate).toBeGreaterThan(result.totalCost);
    expect(result.effectiveMarginPercent).toBeCloseTo(18, 1);
  });
});

describe('marginToMarkup / markupToMargin', () => {
  it('round-trips', () => {
    expect(markupToMargin(marginToMarkup(20))).toBeCloseTo(20, 6);
    expect(marginToMarkup(markupToMargin(33.3333))).toBeCloseTo(33.3333, 3);
  });

  it('converts the classic pairs', () => {
    expect(marginToMarkup(20)).toBeCloseTo(25, 4);
    expect(markupToMargin(25)).toBeCloseTo(20, 4);
    expect(marginToMarkup(50)).toBeCloseTo(100, 4);
  });

  it('refuses an impossible margin', () => {
    expect(() => marginToMarkup(100)).toThrow(BuildUpError);
  });
});

describe('rollUp', () => {
  const lines: EstimateLine[] = [
    { id: 'a', sectionId: 's1', quantity: 10, unitRate: 100, totalCost: 80 },
    { id: 'b', sectionId: 's1', quantity: 5, unitRate: 200, totalCost: 150 },
    { id: 'c', sectionId: 's2', quantity: 1, unitRate: 5000, totalCost: 5000, isProvisional: true },
    { id: 'd', sectionId: 's2', quantity: 2, unitRate: 900, totalCost: 700, isOptional: true },
  ];

  it('excludes optional items from the base total', () => {
    // Including an alternate the client did not ask for makes a bid look
    // expensive and loses tenders.
    const result = rollUp(lines);

    expect(result.total).toBe(10 * 100 + 5 * 200 + 5000);
    expect(result.optionalTotal).toBe(1800);
  });

  it('reports the competitive total separately from provisional sums', () => {
    // Provisional sums are fixed by the client; the bid competes on the rest.
    const result = rollUp(lines);

    expect(result.provisionalTotal).toBe(5000);
    expect(result.competitiveTotal).toBe(2000);
  });

  it('computes margin against the base total', () => {
    const simple: EstimateLine[] = [{ id: 'a', quantity: 10, unitRate: 100, totalCost: 75 }];
    const result = rollUp(simple);

    expect(result.cost).toBe(750);
    expect(result.profit).toBe(250);
    expect(result.marginPercent).toBe(25);
  });

  it('counts only non-optional lines', () => {
    expect(rollUp(lines).lineCount).toBe(3);
  });

  it('handles an empty estimate without dividing by zero', () => {
    const result = rollUp([]);
    expect(result.total).toBe(0);
    expect(result.marginPercent).toBe(0);
  });
});

describe('rollUpBySection', () => {
  it('groups totals per section for the summary page', () => {
    const lines: EstimateLine[] = [
      { id: 'a', sectionId: 'joinery', quantity: 10, unitRate: 100, totalCost: 80 },
      { id: 'b', sectionId: 'joinery', quantity: 5, unitRate: 200, totalCost: 150 },
      { id: 'c', sectionId: 'ironmongery', quantity: 20, unitRate: 30, totalCost: 22 },
    ];

    const sections = rollUpBySection(lines);
    expect(sections.get('joinery')!.total).toBe(2000);
    expect(sections.get('ironmongery')!.total).toBe(600);
  });

  it('puts lines with no section under an empty key rather than dropping them', () => {
    const sections = rollUpBySection([{ id: 'a', quantity: 1, unitRate: 100 }]);
    expect(sections.get('')!.total).toBe(100);
  });
});

describe('marginScenarios', () => {
  const lines: EstimateLine[] = [{ id: 'a', quantity: 100, unitRate: 125, totalCost: 100 }];

  it('reprices the same cost base at several margins', () => {
    // The conversation before submission: "what do we bid if we want the job?"
    const scenarios = marginScenarios(lines, [
      { label: 'Aggressive', marginPercent: 10 },
      { label: 'Target', marginPercent: 20 },
      { label: 'Comfortable', marginPercent: 30 },
    ]);

    expect(scenarios[0]!.total).toBeCloseTo(11111.11, 1);
    expect(scenarios[1]!.total).toBeCloseTo(12500, 1);
    expect(scenarios[2]!.total).toBeCloseTo(14285.71, 1);
  });

  it('reports the change against the current price', () => {
    const scenarios = marginScenarios(lines, [{ label: 'Aggressive', marginPercent: 10 }]);
    // Base total is 12,500 at the current rate.
    expect(scenarios[0]!.deltaTotal).toBeCloseTo(-1388.89, 1);
  });

  it('rejects an impossible margin rather than returning Infinity', () => {
    expect(() => marginScenarios(lines, [{ label: 'Silly', marginPercent: 100 }])).toThrow(
      /below 100/i,
    );
  });
});

describe('suggestRateFromActuals', () => {
  const day = 86_400_000;
  const asAt = new Date('2026-07-01T00:00:00Z');

  it('returns nothing when there is no history', () => {
    expect(suggestRateFromActuals('DOOR-STD', 100, [], { asAt })).toBeNull();
  });

  it('weights recent jobs more heavily than old ones', () => {
    // Material prices move; a job from two years ago is weak evidence.
    const suggestion = suggestRateFromActuals(
      'DOOR-STD',
      100,
      [
        { rateItemCode: 'DOOR-STD', actualUnitCost: 90, quantity: 100, completedOn: new Date(asAt.getTime() - 730 * day) },
        { rateItemCode: 'DOOR-STD', actualUnitCost: 130, quantity: 100, completedOn: new Date(asAt.getTime() - 10 * day) },
      ],
      { asAt, halfLifeDays: 365 },
    );

    // The plain average is 110; the weighted figure must lean toward the recent 130.
    expect(suggestion!.actualAverage).toBe(110);
    expect(suggestion!.suggestedRate).toBeGreaterThan(120);
  });

  it('weights by quantity as well as recency', () => {
    const suggestion = suggestRateFromActuals(
      'DOOR-STD',
      100,
      [
        { rateItemCode: 'DOOR-STD', actualUnitCost: 200, quantity: 1, completedOn: asAt },
        { rateItemCode: 'DOOR-STD', actualUnitCost: 100, quantity: 500, completedOn: asAt },
      ],
      { asAt },
    );

    // One odd job of quantity 1 must not drag the rate.
    expect(suggestion!.suggestedRate).toBeLessThan(105);
  });

  it('reports variance against the rate currently in the library', () => {
    const suggestion = suggestRateFromActuals(
      'DOOR-STD',
      100,
      [{ rateItemCode: 'DOOR-STD', actualUnitCost: 120, quantity: 10, completedOn: asAt }],
      { asAt },
    );

    expect(suggestion!.variancePercent).toBe(20);
  });

  it('is honest about how much evidence it has', () => {
    // Three jobs is an anecdote; ten is a trend.
    const one = suggestRateFromActuals(
      'X',
      100,
      [{ rateItemCode: 'X', actualUnitCost: 110, quantity: 1, completedOn: asAt }],
      { asAt },
    );
    expect(one!.confidence).toBe('low');

    const many = suggestRateFromActuals(
      'X',
      100,
      Array.from({ length: 12 }, (_, i) => ({
        rateItemCode: 'X',
        actualUnitCost: 110,
        quantity: 5,
        completedOn: new Date(asAt.getTime() - i * day),
      })),
      { asAt },
    );
    expect(many!.confidence).toBe('high');
  });

  it('ignores actuals for other rate items', () => {
    const suggestion = suggestRateFromActuals(
      'DOOR-STD',
      100,
      [
        { rateItemCode: 'OTHER', actualUnitCost: 999, quantity: 100, completedOn: asAt },
        { rateItemCode: 'DOOR-STD', actualUnitCost: 105, quantity: 10, completedOn: asAt },
      ],
      { asAt },
    );

    expect(suggestion!.sampleSize).toBe(1);
    expect(suggestion!.suggestedRate).toBe(105);
  });
});

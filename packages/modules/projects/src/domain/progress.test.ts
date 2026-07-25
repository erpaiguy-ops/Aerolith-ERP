import { describe, expect, it } from 'vitest';

import {
  MANUAL_PROGRESS_CEILING,
  ProgressError,
  nodeProgressPercent,
  projectProgress,
  rollUpProgress,
  type WbsNode,
} from './progress';

describe('rules of credit', () => {
  it('gives nothing for binary credit until the work is finished', () => {
    expect(nodeProgressPercent({ ruleOfCredit: 'binary', started: true })).toBe(0);
    expect(nodeProgressPercent({ ruleOfCredit: 'binary', finished: true })).toBe(100);
  });

  it('gives 20% for starting under started/finished credit', () => {
    expect(nodeProgressPercent({ ruleOfCredit: 'started_finished' })).toBe(0);
    expect(nodeProgressPercent({ ruleOfCredit: 'started_finished', started: true })).toBe(20);
    expect(
      nodeProgressPercent({ ruleOfCredit: 'started_finished', started: true, finished: true }),
    ).toBe(100);
  });

  it('measures units as a proportion of the plan', () => {
    expect(
      nodeProgressPercent({ ruleOfCredit: 'units', unitsPlanned: 40, unitsComplete: 10 }),
    ).toBe(25);
  });

  it('caps over-delivery at 100% rather than reporting more than complete', () => {
    // 110 doors against a 100-door node is a quantity variation, not 110% progress.
    expect(
      nodeProgressPercent({ ruleOfCredit: 'units', unitsPlanned: 100, unitsComplete: 110 }),
    ).toBe(100);
  });

  it('falls back to the finished flag when there is no unit denominator', () => {
    expect(nodeProgressPercent({ ruleOfCredit: 'units', unitsComplete: 5 })).toBe(0);
    expect(
      nodeProgressPercent({ ruleOfCredit: 'units', unitsComplete: 5, finished: true }),
    ).toBe(100);
  });

  it('sums the weights of achieved milestones', () => {
    const percent = nodeProgressPercent({
      ruleOfCredit: 'milestone',
      milestones: [
        { key: 'design', weightPercent: 20, achieved: true },
        { key: 'procure', weightPercent: 30, achieved: true },
        { key: 'manufacture', weightPercent: 40, achieved: false },
        { key: 'install', weightPercent: 10, achieved: false },
      ],
    });
    expect(percent).toBe(50);
  });

  it('rejects milestone weights that do not total 100', () => {
    expect(() =>
      nodeProgressPercent({
        ruleOfCredit: 'milestone',
        milestones: [
          { key: 'a', weightPercent: 30, achieved: true },
          { key: 'b', weightPercent: 30, achieved: false },
        ],
      }),
    ).toThrow(ProgressError);
  });

  it('caps a self-assessed claim short of complete', () => {
    // The whole point: "100% done" must require marking it finished, not typing 100.
    expect(nodeProgressPercent({ ruleOfCredit: 'manual', manualPercent: 100 })).toBe(
      MANUAL_PROGRESS_CEILING,
    );
    expect(
      nodeProgressPercent({ ruleOfCredit: 'manual', manualPercent: 100, finished: true }),
    ).toBe(100);
  });
});

describe('value-weighted roll-up', () => {
  /**
   * The scenario the weighting exists for: many small complete nodes and one
   * large untouched one. An unweighted average says 80%; the truth is 20%.
   */
  const lopsided: WbsNode[] = [
    { id: 'root', budgetValue: 0 },
    { id: 'a', parentId: 'root', budgetValue: 5_000, progress: { ruleOfCredit: 'binary', finished: true } },
    { id: 'b', parentId: 'root', budgetValue: 5_000, progress: { ruleOfCredit: 'binary', finished: true } },
    { id: 'c', parentId: 'root', budgetValue: 5_000, progress: { ruleOfCredit: 'binary', finished: true } },
    { id: 'd', parentId: 'root', budgetValue: 5_000, progress: { ruleOfCredit: 'binary', finished: true } },
    { id: 'e', parentId: 'root', budgetValue: 80_000, progress: { ruleOfCredit: 'binary', finished: false } },
  ];

  it('weights by budget rather than averaging percentages', () => {
    const summary = projectProgress(lopsided);
    expect(summary.budgetValue).toBe(100_000);
    expect(summary.earnedValue).toBe(20_000);
    expect(summary.percentComplete).toBe(20);

    // The number an average of the five leaves would have produced.
    const naiveAverage = (100 + 100 + 100 + 100 + 0) / 5;
    expect(naiveAverage).toBe(80);
  });

  it('rolls a multi-level tree up through its parents', () => {
    const nodes: WbsNode[] = [
      { id: 'job', budgetValue: 0 },
      { id: 'joinery', parentId: 'job', budgetValue: 0 },
      {
        id: 'doors',
        parentId: 'joinery',
        budgetValue: 60_000,
        progress: { ruleOfCredit: 'units', unitsPlanned: 120, unitsComplete: 90 },
      },
      {
        id: 'wardrobes',
        parentId: 'joinery',
        budgetValue: 40_000,
        progress: { ruleOfCredit: 'started_finished', started: true },
      },
      {
        id: 'sitework',
        parentId: 'job',
        budgetValue: 20_000,
        progress: { ruleOfCredit: 'binary', finished: false },
      },
    ];

    const rolled = rollUpProgress(nodes);

    // Doors: 75% of 60k = 45k. Wardrobes: 20% of 40k = 8k. Joinery = 53k of 100k.
    expect(rolled.get('joinery')!.earnedValue).toBeCloseTo(53_000, 6);
    expect(rolled.get('joinery')!.percentComplete).toBeCloseTo(53, 6);

    // Job total: 53k earned against 120k budget.
    expect(rolled.get('job')!.totalBudgetValue).toBe(120_000);
    expect(rolled.get('job')!.percentComplete).toBeCloseTo(44.1667, 3);
  });

  it('counts a node that carries both its own budget and children', () => {
    const nodes: WbsNode[] = [
      {
        id: 'supply_and_install',
        budgetValue: 10_000,
        progress: { ruleOfCredit: 'binary', finished: true },
      },
      {
        id: 'sub_task',
        parentId: 'supply_and_install',
        budgetValue: 10_000,
        progress: { ruleOfCredit: 'binary', finished: false },
      },
    ];

    const rolled = rollUpProgress(nodes);
    expect(rolled.get('supply_and_install')!.totalBudgetValue).toBe(20_000);
    expect(rolled.get('supply_and_install')!.percentComplete).toBe(50);
  });

  it('rolls cost and revenue up separately, because CPI needs cost', () => {
    // A job priced at a 20% margin: 800k of cost sold for 1m. At 40% complete,
    // 400k of revenue is earned and 320k of cost. Dividing the REVENUE figure by
    // actual cost overstates CPI by exactly the margin, so a job losing money
    // reports comfortably above 1.0 until the final account.
    const nodes: WbsNode[] = [
      { id: 'root', budgetValue: 0, budgetCost: 0 },
      {
        id: 'doors',
        parentId: 'root',
        budgetValue: 600_000,
        budgetCost: 480_000,
        progress: { ruleOfCredit: 'units', unitsPlanned: 100, unitsComplete: 50 },
      },
      {
        id: 'wardrobes',
        parentId: 'root',
        budgetValue: 400_000,
        budgetCost: 320_000,
        progress: { ruleOfCredit: 'units', unitsPlanned: 40, unitsComplete: 10 },
      },
    ];

    const summary = projectProgress(nodes);
    expect(summary.earnedValue).toBe(400_000);
    expect(summary.earnedCost).toBe(320_000);
    expect(summary.budgetCost).toBe(800_000);

    // Both express the same 40% of work — in different units, which is the point.
    expect(summary.earnedCost / summary.budgetCost).toBeCloseTo(0.4, 6);
    expect(summary.earnedValue / summary.budgetValue).toBeCloseTo(0.4, 6);

    const actualCost = 300_000;
    expect(summary.earnedCost / actualCost).toBeCloseTo(1.0667, 4);
    // What the wrong units would have claimed. A third better than the truth.
    expect(summary.earnedValue / actualCost).toBeCloseTo(1.3333, 4);
  });

  it('treats a node with no cost budget as zero cost, not as missing', () => {
    const rolled = rollUpProgress([
      { id: 'a', budgetValue: 100, progress: { ruleOfCredit: 'binary', finished: true } },
    ]);
    expect(rolled.get('a')!.earnedCost).toBe(0);
    expect(rolled.get('a')!.earnedValue).toBe(100);
  });

  it('reports zero percent for a tree with no budget without claiming nothing is done', () => {
    const rolled = rollUpProgress([
      { id: 'a', budgetValue: 0, progress: { ruleOfCredit: 'binary', finished: true } },
    ]);
    expect(rolled.get('a')!.percentComplete).toBe(0);
    expect(rolled.get('a')!.earnedValue).toBe(0);
  });

  it('flags a tree containing any self-assessed claim', () => {
    const rolled = rollUpProgress([
      { id: 'root', budgetValue: 0 },
      { id: 'measured', parentId: 'root', budgetValue: 100, progress: { ruleOfCredit: 'binary', finished: true } },
      { id: 'claimed', parentId: 'root', budgetValue: 100, progress: { ruleOfCredit: 'manual', manualPercent: 60 } },
    ]);

    expect(rolled.get('root')!.containsManualClaims).toBe(true);
    expect(rolled.get('measured')!.containsManualClaims).toBe(false);
  });

  it('refuses a WBS that does not form a tree', () => {
    expect(() =>
      rollUpProgress([{ id: 'orphan', parentId: 'missing', budgetValue: 100 }]),
    ).toThrow(/parent that does not exist/);

    expect(() =>
      rollUpProgress([
        { id: 'a', parentId: 'b', budgetValue: 1 },
        { id: 'b', parentId: 'a', budgetValue: 1 },
      ]),
    ).toThrow(/cycle/);
  });
});

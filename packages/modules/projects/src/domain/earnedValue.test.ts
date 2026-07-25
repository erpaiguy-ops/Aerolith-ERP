import { describe, expect, it } from 'vitest';

import { earnedValueMetrics, forecast, marginPosition } from './earnedValue';

describe('earned value metrics', () => {
  /**
   * The scenario the whole module exists to expose: 60% of the budget spent,
   * 45% of the work done. It looks fine on a spend report and is a 33% overrun.
   */
  const overrunning = {
    budgetAtCompletion: 1_000_000,
    plannedValue: 500_000,
    earnedValue: 450_000,
    actualCost: 600_000,
  };

  it('reports the cost variance the spend report hides', () => {
    const m = earnedValueMetrics(overrunning);
    expect(m.costVariance).toBe(-150_000);
    expect(m.costPerformanceIndex).toBe(0.75);
    expect(m.percentComplete).toBe(45);
    expect(m.percentSpent).toBe(60);
  });

  it('reports schedule variance in money', () => {
    const m = earnedValueMetrics(overrunning);
    expect(m.scheduleVariance).toBe(-50_000);
    expect(m.schedulePerformanceIndex).toBe(0.9);
  });

  it('returns null rather than 1.0 when there is nothing to measure yet', () => {
    // A CPI of 1.0 on day one reads as "exactly on budget", which is a claim
    // nobody has earned. Null reads as "not yet knowable", which is the truth.
    const m = earnedValueMetrics({
      budgetAtCompletion: 100_000,
      earnedValue: 0,
      actualCost: 0,
    });
    expect(m.costPerformanceIndex).toBeNull();
    expect(m.schedulePerformanceIndex).toBeNull();
    expect(m.scheduleVariance).toBeNull();
  });
});

describe('forecasting', () => {
  const job = {
    budgetAtCompletion: 1_000_000,
    plannedValue: 500_000,
    earnedValue: 450_000,
    actualCost: 600_000,
  };

  it('assumes the variance was one-off under budget_rate', () => {
    const f = forecast(job, 'budget_rate');
    expect(f.estimateToComplete).toBe(550_000);
    expect(f.estimateAtCompletion).toBe(1_150_000);
    expect(f.varianceAtCompletion).toBe(-150_000);
  });

  it('extrapolates today’s productivity under performance_rate', () => {
    // Remaining 550k of budget work at CPI 0.75 costs 733,333.
    const f = forecast(job, 'performance_rate');
    expect(f.estimateToComplete).toBeCloseTo(733_333.33, 2);
    expect(f.estimateAtCompletion).toBeCloseTo(1_333_333.33, 2);
    expect(f.varianceAtCompletion).toBeCloseTo(-333_333.33, 2);
  });

  it('is more pessimistic when schedule pressure is included', () => {
    const performance = forecast(job, 'performance_rate');
    const both = forecast(job, 'cost_and_schedule');
    expect(both.estimateAtCompletion).toBeGreaterThan(performance.estimateAtCompletion);
    // (1,000,000 - 450,000) / (0.75 * 0.9) = 814,814.81
    expect(both.estimateToComplete).toBeCloseTo(814_814.81, 2);
  });

  it('degrades to the budget rate when nothing has been spent', () => {
    const f = forecast(
      { budgetAtCompletion: 100_000, earnedValue: 0, actualCost: 0 },
      'performance_rate',
    );
    expect(f.estimateToComplete).toBe(100_000);
    expect(f.estimateAtCompletion).toBe(100_000);
  });

  it('reports the performance needed to still land on budget', () => {
    // (1,000,000 - 450,000) / (1,000,000 - 600,000) = 1.375. Not happening.
    const f = forecast(job);
    expect(f.toCompletePerformanceIndex).toBeCloseTo(1.375, 4);
  });

  it('gives no TCPI once spend has passed the budget', () => {
    // A negative index printed on a report is read as "good" by someone in a hurry.
    const f = forecast({
      budgetAtCompletion: 1_000_000,
      earnedValue: 800_000,
      actualCost: 1_100_000,
    });
    expect(f.toCompletePerformanceIndex).toBeNull();
  });

  it('floors remaining cost at the open commitment balance', () => {
    // Performing well — CPI 1.25 — so EVM alone forecasts 160k to complete. But
    // 300k of veneer and subcontract is already ordered. That money is spent.
    const f = forecast(
      {
        budgetAtCompletion: 1_000_000,
        earnedValue: 800_000,
        actualCost: 640_000,
        openCommitments: 300_000,
      },
      'performance_rate',
    );

    expect(f.commitmentBound).toBe(true);
    expect(f.estimateToComplete).toBe(300_000);
    expect(f.estimateAtCompletion).toBe(940_000);
  });

  it('does not flag commitment-bound when performance is the binding constraint', () => {
    const f = forecast(
      {
        budgetAtCompletion: 1_000_000,
        earnedValue: 450_000,
        actualCost: 600_000,
        openCommitments: 100_000,
      },
      'performance_rate',
    );
    expect(f.commitmentBound).toBe(false);
    expect(f.estimateToComplete).toBeCloseTo(733_333.33, 2);
  });

  it('never forecasts a negative cost to complete', () => {
    const f = forecast({
      budgetAtCompletion: 100_000,
      earnedValue: 120_000,
      actualCost: 90_000,
    });
    expect(f.estimateToComplete).toBe(0);
    expect(f.estimateAtCompletion).toBe(90_000);
  });
});

describe('margin position', () => {
  it('shows margin eroding as cost performance slips', () => {
    const position = marginPosition(
      {
        contractValue: 1_200_000,
        budgetAtCompletion: 1_000_000,
        earnedValue: 450_000,
        actualCost: 600_000,
        tenderMarginPercent: 16.67,
      },
      'performance_rate',
    );

    // Budgeted margin 200k on 1.2m = 16.67%.
    expect(position.budgetMargin).toBe(200_000);
    expect(position.budgetMarginPercent).toBeCloseTo(16.667, 3);

    // Forecast cost 1,333,333 turns it into a 133k loss.
    expect(position.forecastMargin).toBeCloseTo(-133_333.33, 2);
    expect(position.forecastMarginPercent).toBeCloseTo(-11.11, 2);
    expect(position.marginErosion).toBeCloseTo(-333_333.33, 2);
  });

  it('expresses margin against revenue, matching the estimating build-up', () => {
    // Margin divides, markup multiplies. 200k on 1m of cost is a 20% markup and
    // a 16.67% margin; getting this backwards here after getting it right in the
    // estimate would be the worst possible place to slip.
    const position = marginPosition({
      contractValue: 1_200_000,
      budgetAtCompletion: 1_000_000,
      earnedValue: 500_000,
      actualCost: 500_000,
    });
    expect(position.forecastMarginPercent).toBeCloseTo(16.667, 3);
  });
});

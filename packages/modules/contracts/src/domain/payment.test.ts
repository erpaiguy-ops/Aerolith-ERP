import { describe, expect, it } from 'vitest';

import {
  PaymentError,
  advanceRecoveredToDate,
  compareCertification,
  paymentDue,
  retentionHeld,
  retentionReleasable,
  valuePayment,
} from './payment';

describe('retention', () => {
  it('withholds the contract percentage of the gross valuation', () => {
    expect(retentionHeld(500_000, 2_000_000, { percent: 10 })).toBe(50_000);
  });

  it('stops withholding once the cap on the contract sum is reached', () => {
    // 10% retention capped at 5% of a 2m contract stops at 100k, which happens
    // at 1m of valuation. This cap is routinely missed in spreadsheets, always
    // in the client's favour.
    const terms = { percent: 10, capPercentOfContractSum: 5 };
    expect(retentionHeld(1_000_000, 2_000_000, terms)).toBe(100_000);
    expect(retentionHeld(1_800_000, 2_000_000, terms)).toBe(100_000);
  });

  it('applies an absolute cap where the contract states an amount', () => {
    expect(retentionHeld(1_000_000, 2_000_000, { percent: 10, capAmount: 75_000 })).toBe(75_000);
  });

  it('takes the lower of two caps when both are stated', () => {
    expect(
      retentionHeld(1_000_000, 2_000_000, {
        percent: 10,
        capPercentOfContractSum: 5,
        capAmount: 75_000,
      }),
    ).toBe(75_000);
  });

  it('rejects a nonsensical retention percentage', () => {
    expect(() => retentionHeld(100, 1000, { percent: 150 })).toThrow(PaymentError);
  });
});

describe('retention release', () => {
  const terms = { practicalCompletionPercent: 50, endOfDlpPercent: 50 };

  it('releases nothing before practical completion', () => {
    expect(
      retentionReleasable(100_000, terms, {
        practicalCompletionAchieved: false,
        defectsLiabilityExpired: false,
        previouslyReleased: 0,
      }),
    ).toBe(0);
  });

  it('releases the first half at practical completion', () => {
    expect(
      retentionReleasable(100_000, terms, {
        practicalCompletionAchieved: true,
        defectsLiabilityExpired: false,
        previouslyReleased: 0,
      }),
    ).toBe(50_000);
  });

  it('releases only the balance once the first half has been paid', () => {
    expect(
      retentionReleasable(100_000, terms, {
        practicalCompletionAchieved: true,
        defectsLiabilityExpired: true,
        previouslyReleased: 50_000,
      }),
    ).toBe(50_000);
  });

  it('releases nothing more once everything has been released', () => {
    expect(
      retentionReleasable(100_000, terms, {
        practicalCompletionAchieved: true,
        defectsLiabilityExpired: true,
        previouslyReleased: 100_000,
      }),
    ).toBe(0);
  });

  it('rejects a schedule that does not release the whole retention', () => {
    expect(() =>
      retentionReleasable(100_000, { practicalCompletionPercent: 50, endOfDlpPercent: 30 }, {
        practicalCompletionAchieved: true,
        defectsLiabilityExpired: true,
        previouslyReleased: 0,
      }),
    ).toThrow(/must total 100/);
  });
});

describe('advance payment recovery', () => {
  const advance = {
    amount: 200_000,
    recoveryStartsAtProgressPercent: 10,
    recoveryCompleteAtProgressPercent: 90,
  };

  it('recovers nothing before the threshold', () => {
    expect(advanceRecoveredToDate(150_000, 2_000_000, advance)).toBe(0);
  });

  it('recovers pro-rata between the thresholds', () => {
    // 50% progress is halfway through the 10%-90% window, so half the advance.
    expect(advanceRecoveredToDate(1_000_000, 2_000_000, advance)).toBe(100_000);
  });

  it('is fully recovered by the completion threshold', () => {
    expect(advanceRecoveredToDate(1_800_000, 2_000_000, advance)).toBe(200_000);
    expect(advanceRecoveredToDate(2_000_000, 2_000_000, advance)).toBe(200_000);
  });

  it('rejects a recovery window that finishes before it starts', () => {
    expect(() =>
      advanceRecoveredToDate(100, 1000, {
        amount: 100,
        recoveryStartsAtProgressPercent: 90,
        recoveryCompleteAtProgressPercent: 10,
      }),
    ).toThrow(PaymentError);
  });
});

describe('interim payment valuation', () => {
  const contractSum = 2_000_000;
  const retention = { percent: 10, capPercentOfContractSum: 5 };

  it('values the first application from zero', () => {
    const v = valuePayment({
      contractSum,
      workDoneToDate: 400_000,
      retention,
      previouslyCertifiedNet: 0,
      taxPercent: 5,
    });

    expect(v.grossValuationToDate).toBe(400_000);
    expect(v.retentionHeldToDate).toBe(40_000);
    expect(v.netValuationToDate).toBe(360_000);
    expect(v.netThisCertificate).toBe(360_000);
    expect(v.taxAmount).toBe(18_000);
    expect(v.totalPayable).toBe(378_000);
    expect(v.progressPercent).toBe(20);
  });

  it('is the cumulative position less what was previously certified', () => {
    const v = valuePayment({
      contractSum,
      workDoneToDate: 700_000,
      retention,
      previouslyCertifiedNet: 360_000,
    });

    expect(v.grossValuationToDate).toBe(700_000);
    expect(v.retentionHeldToDate).toBe(70_000);
    expect(v.netValuationToDate).toBe(630_000);
    // 630k cumulative less 360k already certified.
    expect(v.netThisCertificate).toBe(270_000);
  });

  it('handles a downward re-measurement as a reduced certificate, not a lost figure', () => {
    // The client's QS disallows work claimed last month. Cumulative valuation
    // FALLS. A monthly-increment model has nowhere to put this and silently
    // keeps the overpayment; the cumulative model produces a smaller certificate.
    const v = valuePayment({
      contractSum,
      workDoneToDate: 650_000,
      retention,
      previouslyCertifiedNet: 630_000,
    });

    expect(v.netValuationToDate).toBe(585_000);
    expect(v.netThisCertificate).toBe(-45_000);
    expect(v.isNegativeCertificate).toBe(true);
  });

  it('values materials on site at the agreed percentage', () => {
    const v = valuePayment({
      contractSum,
      workDoneToDate: 400_000,
      materialsOnSite: 100_000,
      materialsOnSitePercent: 80,
      retention,
      previouslyCertifiedNet: 0,
    });

    expect(v.materialsOnSiteValued).toBe(80_000);
    expect(v.grossValuationToDate).toBe(480_000);
    // Retention is charged on materials on site too — 10% of 480k.
    expect(v.retentionHeldToDate).toBe(48_000);
  });

  it('keeps approved variations separate from measured work', () => {
    const v = valuePayment({
      contractSum: 2_150_000,
      workDoneToDate: 700_000,
      variationsToDate: 120_000,
      retention,
      previouslyCertifiedNet: 0,
    });

    expect(v.workDoneToDate).toBe(700_000);
    expect(v.variationsToDate).toBe(120_000);
    expect(v.grossValuationToDate).toBe(820_000);
  });

  it('nets this period’s advance recovery against what was already recovered', () => {
    const advance = {
      amount: 200_000,
      recoveryStartsAtProgressPercent: 10,
      recoveryCompleteAtProgressPercent: 90,
    };

    const v = valuePayment({
      contractSum,
      workDoneToDate: 1_200_000,
      retention,
      advance,
      previouslyCertifiedNet: 810_000,
      previouslyRecoveredAdvance: 100_000,
    });

    // 60% progress is 5/8 through the recovery window: 125k recovered to date.
    expect(v.advanceRecoveredToDate).toBe(125_000);
    expect(v.advanceRecoveredThisCertificate).toBe(25_000);
  });

  it('never hands back advance the contractor has already repaid', () => {
    // A downward re-measurement reduces progress. Recovery must not reverse.
    const v = valuePayment({
      contractSum,
      workDoneToDate: 600_000,
      advance: {
        amount: 200_000,
        recoveryStartsAtProgressPercent: 10,
        recoveryCompleteAtProgressPercent: 90,
      },
      previouslyCertifiedNet: 0,
      previouslyRecoveredAdvance: 125_000,
    });

    expect(v.advanceRecoveredThisCertificate).toBe(0);
  });

  it('applies the cap so retention stops growing mid-contract', () => {
    const v = valuePayment({
      contractSum,
      workDoneToDate: 1_600_000,
      retention,
      previouslyCertifiedNet: 0,
    });

    // 10% of 1.6m would be 160k, but 5% of the 2m contract sum caps it at 100k.
    expect(v.retentionHeldToDate).toBe(100_000);
    expect(v.netValuationToDate).toBe(1_500_000);
  });

  it('deducts back charges and liquidated damages cumulatively', () => {
    const v = valuePayment({
      contractSum,
      workDoneToDate: 1_000_000,
      retention,
      backChargesToDate: 25_000,
      liquidatedDamagesToDate: 40_000,
      previouslyCertifiedNet: 0,
    });

    // 1m gross, 100k retention (capped), 25k contra, 40k LDs.
    expect(v.netValuationToDate).toBe(835_000);
  });

  it('adds released retention back into the certificate', () => {
    const v = valuePayment({
      contractSum,
      workDoneToDate: 2_000_000,
      retention,
      retentionReleased: 50_000,
      previouslyCertifiedNet: 1_900_000,
    });

    // 2m gross, 100k held, 50k of it released back.
    expect(v.netValuationToDate).toBe(1_950_000);
    expect(v.netThisCertificate).toBe(50_000);
  });

  it('taxes the net amount payable by default and the gross when required', () => {
    const base = {
      contractSum,
      workDoneToDate: 700_000,
      retention,
      previouslyCertifiedNet: 360_000,
      taxPercent: 5,
    };

    // GCC VAT: tax follows the net payable.
    expect(valuePayment(base).taxAmount).toBe(13_500);

    // Withholding regimes that require the gross basis get a different number,
    // which is exactly why the flag exists rather than a single formula.
    expect(valuePayment({ ...base, taxOnGrossValuation: true }).taxAmount).toBe(17_000);
  });

  it('reconciles a three-application sequence to the cumulative total', () => {
    const one = valuePayment({
      contractSum,
      workDoneToDate: 400_000,
      retention,
      previouslyCertifiedNet: 0,
    });
    const two = valuePayment({
      contractSum,
      workDoneToDate: 900_000,
      retention,
      previouslyCertifiedNet: one.netValuationToDate,
    });
    const three = valuePayment({
      contractSum,
      workDoneToDate: 1_400_000,
      retention,
      previouslyCertifiedNet: two.netValuationToDate,
    });

    const sumOfCertificates =
      one.netThisCertificate + two.netThisCertificate + three.netThisCertificate;

    // The invariant the whole design rests on: the certificates must add up to
    // the cumulative net position, whatever happened in between.
    expect(sumOfCertificates).toBeCloseTo(three.netValuationToDate, 6);
  });
});

describe('application versus certificate', () => {
  it('measures what the client disallowed', () => {
    const c = compareCertification(270_000, 221_400);
    expect(c.difference).toBe(-48_600);
    expect(c.differencePercent).toBeCloseTo(-18, 6);
    expect(c.wasReduced).toBe(true);
  });

  it('does not treat a certificate paid in full as a reduction', () => {
    expect(compareCertification(270_000, 270_000).wasReduced).toBe(false);
  });
});

describe('payment ageing', () => {
  it('computes the due date from the certification date and the terms', () => {
    const due = paymentDue({
      certifiedOn: new Date('2026-01-15T00:00:00Z'),
      paymentTermDays: 60,
      asAt: new Date('2026-02-01T00:00:00Z'),
    });
    expect(due.dueOn.toISOString().slice(0, 10)).toBe('2026-03-16');
    expect(due.isOverdue).toBe(false);
    expect(due.daysOverdue).toBe(0);
  });

  it('counts days overdue on an unpaid certificate', () => {
    const due = paymentDue({
      certifiedOn: new Date('2026-01-15T00:00:00Z'),
      paymentTermDays: 60,
      asAt: new Date('2026-04-15T00:00:00Z'),
    });
    expect(due.isOverdue).toBe(true);
    expect(due.daysOverdue).toBe(30);
  });

  it('freezes the lateness of a paid certificate at its payment date', () => {
    // Otherwise an invoice paid three days late keeps accruing overdue days
    // forever and the ageing report becomes fiction.
    const due = paymentDue({
      certifiedOn: new Date('2026-01-15T00:00:00Z'),
      paymentTermDays: 60,
      paidOn: new Date('2026-03-19T00:00:00Z'),
      asAt: new Date('2026-07-01T00:00:00Z'),
    });
    expect(due.isPaid).toBe(true);
    expect(due.isOverdue).toBe(false);
    expect(due.daysOverdue).toBe(3);
  });
});

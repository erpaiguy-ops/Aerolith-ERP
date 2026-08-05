import { describe, expect, it } from 'vitest';

import {
  VariationError,
  noticeStatus,
  valueDayworks,
  valueVariation,
  variationPosition,
  type VariationRecord,
} from './variation';

describe('dayworks', () => {
  const sheet = {
    labour: [
      { hours: 40, rate: 45 },
      { hours: 16, rate: 60 },
    ],
    materials: [{ quantity: 12, rate: 180 }],
    plant: [{ hours: 8, rate: 90 }],
    labourUpliftPercent: 20,
    materialUpliftPercent: 10,
    plantUpliftPercent: 5,
  };

  it('applies each uplift to its own category', () => {
    const v = valueDayworks(sheet);
    expect(v.labourCost).toBe(2_760);
    expect(v.materialCost).toBe(2_160);
    expect(v.plantCost).toBe(720);

    expect(v.labourUplift).toBe(552);
    expect(v.materialUplift).toBe(216);
    expect(v.plantUplift).toBe(36);
    expect(v.total).toBe(6_444);
  });

  it('differs from a single blended uplift, which is why they are separate', () => {
    const separate = valueDayworks(sheet).total;
    const blended = (2_760 + 2_160 + 720) * 1.15;
    expect(separate).not.toBeCloseTo(blended, 2);
  });
});

describe('variation valuation', () => {
  it('values measured work at contract rates and reports the margin on it', () => {
    const v = valueVariation({
      basis: 'contract_rates',
      lines: [
        { description: 'Extra veneered doors', quantity: 12, unitRate: 1_850, unitCost: 1_400 },
        { description: 'Ironmongery', quantity: 12, unitRate: 240, unitCost: 190 },
      ],
    });

    expect(v.value).toBe(25_080);
    expect(v.cost).toBe(19_080);
    expect(v.marginPercent).toBeCloseTo(23.923, 3);
    expect(v.isOmission).toBe(false);
  });

  it('reports no margin when only some lines carry a cost', () => {
    // A partial roll-up understates cost and flatters the margin on the change.
    const v = valueVariation({
      basis: 'contract_rates',
      lines: [
        { description: 'a', quantity: 1, unitRate: 1_000, unitCost: 700 },
        { description: 'b', quantity: 1, unitRate: 500 },
      ],
    });
    expect(v.cost).toBeNull();
    expect(v.marginPercent).toBeNull();
  });

  it('treats an omission as a negative variation', () => {
    const v = valueVariation({
      basis: 'contract_rates',
      lines: [{ description: 'Omit reception desk', quantity: -1, unitRate: 42_000 }],
    });
    expect(v.value).toBe(-42_000);
    expect(v.isOmission).toBe(true);
  });

  it('takes the recorded resource as the cost of a dayworks claim', () => {
    // The uplifts are recovery, not expense.
    const v = valueVariation({
      basis: 'dayworks',
      dayworks: {
        labour: [{ hours: 40, rate: 45 }],
        materials: [],
        plant: [],
        labourUpliftPercent: 20,
      },
    });
    expect(v.value).toBe(2_160);
    expect(v.cost).toBe(1_800);
  });

  it('adds overhead and profit to the cost where the contract allows it', () => {
    const v = valueVariation({
      basis: 'lump_sum',
      lumpSumValue: 30_000,
      lumpSumCost: 24_000,
      ohpPercent: 12.5,
    });
    expect(v.ohpAmount).toBe(3_000);
    expect(v.value).toBe(33_000);
  });

  it('refuses a measured basis with no lines and a lump sum with no value', () => {
    expect(() => valueVariation({ basis: 'star_rate' })).toThrow(VariationError);
    expect(() => valueVariation({ basis: 'lump_sum' })).toThrow(VariationError);
    expect(() => valueVariation({ basis: 'dayworks' })).toThrow(VariationError);
  });
});

describe('variation position', () => {
  const asAt = new Date('2026-06-30T00:00:00Z');

  const register: VariationRecord[] = [
    // Agreed and priced: moves the contract sum.
    {
      id: '1',
      reference: 'VO-001',
      status: 'approved',
      value: 42_000,
      approvedOn: new Date('2026-03-01T00:00:00Z'),
    },
    // Instructed in February, fully built, still unpriced by the client.
    {
      id: '2',
      reference: 'VO-002',
      status: 'instructed',
      value: 68_000,
      cost: 51_000,
      percentExecuted: 100,
      instructedOn: new Date('2026-02-10T00:00:00Z'),
    },
    // Instructed and half built.
    {
      id: '3',
      reference: 'VO-003',
      status: 'submitted',
      value: 30_000,
      cost: 22_000,
      percentExecuted: 50,
      instructedOn: new Date('2026-05-20T00:00:00Z'),
    },
    // Claimed but never instructed. Much weaker.
    { id: '4', reference: 'VO-004', status: 'identified', value: 15_000 },
    { id: '5', reference: 'VO-005', status: 'rejected', value: 9_000 },
    { id: '6', reference: 'VO-006', status: 'withdrawn', value: 4_000 },
  ];

  const position = variationPosition(2_000_000, register, asAt);

  it('moves the contract sum only for approved variations', () => {
    expect(position.approvedValue).toBe(42_000);
    expect(position.currentContractSum).toBe(2_042_000);
  });

  it('weights exposure by how much of the instructed work is actually built', () => {
    // 68k fully built + half of 30k = 83k of money genuinely at risk.
    expect(position.exposureValue).toBe(83_000);
    expect(position.exposureCost).toBe(62_000);
  });

  it('keeps uninstructed claims out of exposure', () => {
    // No instruction, no obligation — a much weaker position, so a separate figure.
    expect(position.pendingValue).toBe(15_000);
    expect(position.rejectedValue).toBe(9_000);
  });

  it('reports the anticipated final value rather than the safe one', () => {
    expect(position.anticipatedFinalValue).toBe(2_125_000);
  });

  it('ages the oldest unapproved instruction', () => {
    // VO-002 was instructed on 10 February; 140 days to 30 June.
    expect(position.oldestUnapprovedDays).toBe(140);
  });

  it('excludes withdrawn variations from every total', () => {
    expect(position.counts.withdrawn).toBe(1);
    // 42k approved + 83k exposure + 15k pending + 9k rejected. The withdrawn
    // 4k appears in none of them.
    const totalled =
      position.approvedValue + position.exposureValue + position.pendingValue + position.rejectedValue;
    expect(totalled).toBe(149_000);

    const withWithdrawnCounted = variationPosition(
      2_000_000,
      register.map((v) => (v.status === 'withdrawn' ? { ...v, status: 'identified' as const } : v)),
      asAt,
    );
    expect(withWithdrawnCounted.pendingValue).toBe(19_000);
  });
});

describe('notice periods', () => {
  const eventOn = new Date('2026-05-01T00:00:00Z');

  it('counts down the days remaining to the deadline', () => {
    const s = noticeStatus({
      noticePeriodDays: 28,
      eventOn,
      asAt: new Date('2026-05-20T00:00:00Z'),
    });
    expect(s.deadlineOn.toISOString().slice(0, 10)).toBe('2026-05-29');
    expect(s.daysRemaining).toBe(9);
    expect(s.isTimeBarred).toBe(false);
  });

  it('reports a time bar once the deadline passes with no notice given', () => {
    // Entitlement extinguished. The system already knew the instruction date,
    // which is why this is worth more than most of the module.
    const s = noticeStatus({
      noticePeriodDays: 28,
      eventOn,
      asAt: new Date('2026-06-15T00:00:00Z'),
    });
    expect(s.isTimeBarred).toBe(true);
    expect(s.daysRemaining).toBeLessThan(0);
  });

  it('is not time barred once notice has been given', () => {
    const s = noticeStatus({
      noticePeriodDays: 28,
      eventOn,
      noticeGivenOn: new Date('2026-05-10T00:00:00Z'),
      asAt: new Date('2026-06-15T00:00:00Z'),
    });
    expect(s.isTimeBarred).toBe(false);
    expect(s.wasLate).toBe(false);
  });

  it('flags a notice given after the deadline as late but not barred', () => {
    const s = noticeStatus({
      noticePeriodDays: 28,
      eventOn,
      noticeGivenOn: new Date('2026-06-05T00:00:00Z'),
      asAt: new Date('2026-06-15T00:00:00Z'),
    });
    expect(s.isGiven).toBe(true);
    expect(s.wasLate).toBe(true);
    expect(s.isTimeBarred).toBe(false);
  });
});

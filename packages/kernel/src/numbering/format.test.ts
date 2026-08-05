import { describe, expect, it } from 'vitest';

import {
  fiscalYear,
  formatNumber,
  periodKey,
  validatePattern,
  validateResetConsistency,
} from './format';

const date = new Date(Date.UTC(2026, 6, 25)); // 25 July 2026

describe('formatNumber', () => {
  it('formats the common invoice pattern', () => {
    expect(
      formatNumber('INV-{YYYY}-{SEQ}', { sequence: 123, date, padding: 5 }),
    ).toBe('INV-2026-00123');
  });

  it('supports two-digit years and months', () => {
    expect(formatNumber('{YY}{MM}-{SEQ}', { sequence: 7, date, padding: 4 })).toBe('2607-0007');
  });

  it('substitutes entity and project codes', () => {
    expect(
      formatNumber('{ENTITY}-{PROJECT}-{SEQ}', {
        sequence: 42,
        date,
        padding: 3,
        entityCode: 'DXB',
        projectCode: 'P001',
      }),
    ).toBe('DXB-P001-042');
  });

  it('does not leave a dangling separator when a token is unused', () => {
    // A GRN raised against no project must not come out as "GRN--00001".
    expect(
      formatNumber('GRN-{PROJECT}-{SEQ}', { sequence: 1, date, padding: 5 }),
    ).toBe('GRN-00001');
  });

  it('numbers a backdated document by its own date, not today', () => {
    const backdated = new Date(Date.UTC(2025, 11, 31));
    expect(
      formatNumber('INV-{YYYY}-{SEQ}', { sequence: 900, date: backdated, padding: 4 }),
    ).toBe('INV-2025-0900');
  });

  it('does not truncate a sequence that outgrows its padding', () => {
    expect(formatNumber('{SEQ}', { sequence: 123456, date, padding: 4 })).toBe('123456');
  });
});

describe('fiscalYear', () => {
  it('labels a fiscal year by its starting calendar year', () => {
    // April-start FY: January 2027 still belongs to FY2026.
    expect(fiscalYear(new Date(Date.UTC(2027, 0, 15)), 4)).toBe(2026);
    expect(fiscalYear(new Date(Date.UTC(2026, 4, 15)), 4)).toBe(2026);
  });

  it('matches the calendar year when the fiscal year starts in January', () => {
    expect(fiscalYear(date, 1)).toBe(2026);
  });
});

describe('periodKey', () => {
  it('is stable within a period and changes across periods', () => {
    expect(periodKey('yearly', date)).toBe('2026');
    expect(periodKey('yearly', new Date(Date.UTC(2026, 11, 31)))).toBe('2026');
    expect(periodKey('yearly', new Date(Date.UTC(2027, 0, 1)))).toBe('2027');
  });

  it('never changes when the series does not reset', () => {
    expect(periodKey('never', date)).toBe('ALL');
    expect(periodKey('never', new Date(Date.UTC(2099, 0, 1)))).toBe('ALL');
  });

  it('tracks the fiscal year, not the calendar year', () => {
    expect(periodKey('fiscal_year', new Date(Date.UTC(2027, 0, 15)), 4)).toBe('FY2026');
  });

  it('changes monthly for a monthly series', () => {
    expect(periodKey('monthly', date)).toBe('2026-07');
    expect(periodKey('monthly', new Date(Date.UTC(2026, 7, 1)))).toBe('2026-08');
  });
});

describe('validatePattern', () => {
  it('rejects a pattern with no sequence, which would collide', () => {
    expect(validatePattern('INV-{YYYY}')).toMatchObject({ ok: false });
  });

  it('rejects an unknown token rather than silently emitting nothing', () => {
    const result = validatePattern('INV-{QUARTER}-{SEQ}');
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain('{QUARTER}');
  });

  it('accepts a valid pattern', () => {
    expect(validatePattern('INV-{YYYY}-{SEQ}')).toEqual({ ok: true });
  });
});

describe('validateResetConsistency', () => {
  it('rejects a yearly reset with no year in the pattern', () => {
    // This is the classic bug: the sequence resets and last year's numbers
    // are issued a second time.
    expect(validateResetConsistency('INV-{SEQ}', 'yearly')).toMatchObject({ ok: false });
  });

  it('rejects a monthly reset without a month token', () => {
    expect(validateResetConsistency('INV-{YYYY}-{SEQ}', 'monthly')).toMatchObject({ ok: false });
  });

  it('accepts a never-resetting series with no date tokens', () => {
    expect(validateResetConsistency('INV-{SEQ}', 'never')).toEqual({ ok: true });
  });

  it('accepts consistent combinations', () => {
    expect(validateResetConsistency('INV-{YYYY}-{SEQ}', 'yearly')).toEqual({ ok: true });
    expect(validateResetConsistency('INV-{YYYY}{MM}-{SEQ}', 'monthly')).toEqual({ ok: true });
    expect(validateResetConsistency('INV-{FY}-{SEQ}', 'fiscal_year')).toEqual({ ok: true });
  });
});

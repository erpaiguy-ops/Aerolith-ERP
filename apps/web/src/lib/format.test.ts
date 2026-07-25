import { describe, expect, it } from 'vitest';

import { date, directionFor, money, percent, signed, toneForIndex, toneForVariance } from './format';

describe('money', () => {
  it('formats in the tenant currency, not a hardcoded one', () => {
    // A currency symbol fixed to one country is a bug the moment the second
    // tenant signs up, which is the entire premise of the localisation design.
    expect(money(1234.5, 'AED')).toContain('1,234.50');
    expect(money(1234.5, 'QAR')).toContain('1,234.50');
    expect(money(1234.5, 'AED')).not.toBe(money(1234.5, 'QAR'));
  });

  it('accepts the strings the API actually returns', () => {
    // numeric(18,2) does not fit in a double, so the API sends strings. The
    // conversion happens once, here, rather than scattered through components.
    expect(money('1234.50', 'AED')).toBe(money(1234.5, 'AED'));
  });

  it('renders an em dash for absent values rather than 0.00', () => {
    // "0.00" is a claim that something was measured and came to nothing.
    expect(money(null, 'AED')).toBe('—');
    expect(money(undefined, 'AED')).toBe('—');
    expect(money('', 'AED')).toBe('—');
  });

  it('renders an unknown but well-formed currency code as-is', () => {
    // Intl accepts any three-letter code and prints it verbatim, so a currency
    // this runtime has never heard of still renders correctly.
    expect(money(1234.5, 'XYZ')).toContain('1,234.50');
    expect(money(1234.5, 'XYZ')).toContain('XYZ');
  });

  it('falls back rather than throwing on a malformed currency code', () => {
    // Intl DOES throw on a code that is not three letters. Bad reference data
    // must not take a page down.
    expect(money(1234.5, '123')).toBe('123 1234.50');
    expect(money(1234.5, 'X')).toBe('X 1234.50');
  });

  it('rejects a non-numeric string instead of printing NaN', () => {
    expect(money('not a number', 'AED')).toBe('—');
  });
});

describe('percent', () => {
  it('takes a percentage, not a fraction', () => {
    // Matching every API in this system, so nobody has to remember which
    // convention a given field uses.
    expect(percent(68.4)).toBe('68.4%');
    expect(percent(0.684)).toBe('0.7%');
  });

  it('handles absent and non-finite values', () => {
    expect(percent(null)).toBe('—');
    expect(percent(Number.NaN)).toBe('—');
  });
});

describe('signed', () => {
  it('marks a variance as a variance rather than a total', () => {
    expect(signed(175_000, 'AED')).toMatch(/^\+/);
    expect(signed(-175_000, 'AED')).toMatch(/^−/);
  });
});

describe('direction', () => {
  it('flips for Arabic, which is why the shell handles direction at all', () => {
    expect(directionFor('ar')).toBe('rtl');
    expect(directionFor('ar-AE')).toBe('rtl');
    expect(directionFor('en')).toBe('ltr');
    expect(directionFor('en-AE')).toBe('ltr');
  });
});

describe('tone', () => {
  it('reads a positive variance as under budget', () => {
    // The sign convention is not obvious and gets inverted constantly: a
    // positive variance-at-completion is good, a positive days-overdue is not.
    expect(toneForVariance(175_000)).toBe('good');
    expect(toneForVariance(-175_000)).toBe('bad');
    expect(toneForVariance(0)).toBe('neutral');
  });

  it('treats an unknowable index as neutral, not as good', () => {
    // Null CPI means nothing has been spent yet. Rendering that green claims a
    // performance nobody has earned.
    expect(toneForIndex(null)).toBe('neutral');
    expect(toneForIndex(1.28)).toBe('good');
    expect(toneForIndex(0.97)).toBe('neutral');
    expect(toneForIndex(0.75)).toBe('bad');
  });
});

describe('date', () => {
  it('formats in UTC so a certificate date does not shift by timezone', () => {
    expect(date('2026-03-20')).toContain('2026');
    expect(date('2026-03-20')).toContain('20');
  });

  it('handles absent and invalid values', () => {
    expect(date(null)).toBe('—');
    expect(date('not a date')).toBe('—');
  });
});

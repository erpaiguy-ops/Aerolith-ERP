import { describe, expect, it } from 'vitest';

import {
  date,
  directionFor,
  dimensions,
  fileSize,
  integer,
  money,
  percent,
  quantity,
  signed,
  toneForIndex,
  toneForVariance,
} from './format';

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

describe('fileSize', () => {
  it('stays in bytes below a KB', () => {
    expect(fileSize(512)).toBe('512 B');
  });

  it('picks the largest unit that keeps the number readable', () => {
    expect(fileSize(2048)).toBe('2.0 KB');
    expect(fileSize(4_500_000)).toBe('4.3 MB');
  });

  it('handles absent values', () => {
    expect(fileSize(null)).toBe('—');
    expect(fileSize(undefined)).toBe('—');
  });
});

describe('integer', () => {
  it('formats in the given locale rather than the server one', () => {
    // `Number.prototype.toLocaleString()` with no argument formats in the
    // SERVER's locale — a machine setting with no relationship to the user,
    // which silently disagrees with every other figure on the page.
    expect(integer(1234567, 'en-AE')).toBe('1,234,567');
    expect(integer(1234567, 'de-DE')).toBe('1.234.567');
  });

  it('keeps Latin digits for Arabic in the Gulf', () => {
    // The distinction the locale plumbing exists to preserve: Arabic-Indic
    // digits are right in Cairo and wrong in Dubai.
    expect(integer(1234, 'ar-AE')).toMatch(/[0-9]/);
    expect(integer(1234, 'ar-EG')).not.toMatch(/[0-9]/);
  });

  it('rounds rather than showing a fractional count', () => {
    expect(integer(3.6)).toBe('4');
  });

  it('handles values that are not finite', () => {
    expect(integer(Number.NaN)).toBe('—');
    expect(integer(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('dimensions', () => {
  it('reads as a board size, not three measurements', () => {
    expect(dimensions('2440.00', '1220.00', '18.00')).toBe('2440 × 1220 × 18');
  });

  it('drops the trailing zeros the database carries', () => {
    // numeric(12,2) stores 2440.00 and 0.80. Nobody says either of those.
    expect(dimensions('3050.00', '1300.00', '0.80')).toBe('3050 × 1300 × 0.8');
  });

  it('omits a thickness that was never recorded', () => {
    expect(dimensions('2440', '1220')).toBe('2440 × 1220');
    expect(dimensions('2440', '1220', null)).toBe('2440 × 1220');
  });

  it('refuses to render a single number as a size', () => {
    // A lone length rendered as "2440" reads as a quantity, which is the one
    // thing it must not be mistaken for on a stock screen.
    expect(dimensions('2440', null)).toBe('—');
    expect(dimensions(null, null)).toBe('—');
    expect(dimensions('0', '0')).toBe('—');
  });
});

describe('quantity', () => {
  it('drops trailing zeros but keeps a real fraction', () => {
    // numeric(18,4) gives "900.0000" for something a storekeeper calls 900.
    expect(quantity('900.0000')).toBe('900');
    expect(quantity('3.5000')).toBe('3.5');
  });

  it('appends the unit only when there is one', () => {
    expect(quantity('12', 'NR')).toBe('12 NR');
    expect(quantity('12', null)).toBe('12');
    expect(quantity('12')).toBe('12');
  });

  it('formats in the given locale rather than the server one', () => {
    expect(quantity(1234.5, null, 'en-AE')).toBe('1,234.5');
    expect(quantity(1234.5, null, 'de-DE')).toBe('1.234,5');
  });

  it('renders an em dash for absent values rather than 0', () => {
    // "0" claims the shelf was checked and is empty. Null means nobody looked.
    expect(quantity(null)).toBe('—');
    expect(quantity(undefined)).toBe('—');
    expect(quantity('')).toBe('—');
    expect(quantity('not a number')).toBe('—');
  });
});

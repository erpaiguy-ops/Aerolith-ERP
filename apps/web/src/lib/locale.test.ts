import { describe, expect, it } from 'vitest';

import { formattingLocale } from './locale';

describe('formattingLocale', () => {
  it('combines the user language with the tenant country', () => {
    // Both facts matter and neither is sufficient. The language decides the
    // month names; the country decides the digits and the currency placement.
    expect(formattingLocale('ar', 'AE')).toBe('ar-AE');
    expect(formattingLocale('en', 'QA')).toBe('en-QA');
  });

  it('separates the two facts that a single locale string conflates', () => {
    // The case the whole function exists for: an Arabic speaker in Dubai wants
    // Arabic month names with LATIN digits. `ar` alone or `ar-EG` gives
    // Arabic-Indic digits, which is correct in Cairo and wrong in the Gulf.
    const gulf = new Intl.NumberFormat(formattingLocale('ar', 'AE')).format(1234);
    expect(gulf).toMatch(/[0-9]/);
    expect(new Intl.NumberFormat('ar-EG').format(1234)).not.toMatch(/[0-9]/);
  });

  it('takes the base language, so a full tag does not produce ar-SA-AE', () => {
    expect(formattingLocale('ar-SA', 'AE')).toBe('ar-AE');
    expect(formattingLocale('en-GB', 'ae')).toBe('en-AE');
  });

  it('falls back to the bare language when the tenant has no country', () => {
    // A tenant without a country is a real state — the country is chosen during
    // onboarding — and it must not produce the invalid tag `ar-null`.
    expect(formattingLocale('ar', null)).toBe('ar');
    expect(() => new Intl.NumberFormat(formattingLocale('ar', null))).not.toThrow();
  });

  it('always produces a tag Intl accepts', () => {
    for (const [language, country] of [
      ['ar', 'AE'],
      ['en', 'QA'],
      ['ar-SA', 'OM'],
      ['en', null],
    ] as const) {
      expect(() => new Intl.NumberFormat(formattingLocale(language, country))).not.toThrow();
    }
  });
});

/**
 * Document number formatting.
 *
 * Pure and separately testable, because getting this wrong is quietly
 * expensive: a tax invoice number that changes shape mid-year, or a sequence
 * that resets when it should not, is an audit finding.
 */

export interface NumberTokens {
  sequence: number;
  /** Date the document is dated, not "now" — a backdated invoice numbers by its own date. */
  date: Date;
  padding: number;
  prefix?: string | null;
  suffix?: string | null;
  entityCode?: string | null;
  projectCode?: string | null;
  fiscalYearStartMonth?: number;
}

const TOKEN = /\{(PREFIX|SUFFIX|YYYY|YY|MM|DD|FY|ENTITY|PROJECT|SEQ)\}/g;

export function formatNumber(pattern: string, tokens: NumberTokens): string {
  const { date } = tokens;
  const year = date.getUTCFullYear();

  const replacements: Record<string, string> = {
    PREFIX: tokens.prefix ?? '',
    SUFFIX: tokens.suffix ?? '',
    YYYY: String(year),
    YY: String(year % 100).padStart(2, '0'),
    MM: String(date.getUTCMonth() + 1).padStart(2, '0'),
    DD: String(date.getUTCDate()).padStart(2, '0'),
    FY: String(fiscalYear(date, tokens.fiscalYearStartMonth ?? 1)),
    ENTITY: tokens.entityCode ?? '',
    PROJECT: tokens.projectCode ?? '',
    SEQ: String(tokens.sequence).padStart(tokens.padding, '0'),
  };

  const formatted = pattern.replace(TOKEN, (_match, token: string) => replacements[token] ?? '');

  // A pattern with an unused {PROJECT} leaves a double separator behind.
  return formatted.replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
}

/**
 * The fiscal year a date falls in, labelled by its STARTING calendar year.
 * A fiscal year beginning in April 2026 is "2026", including January 2027.
 */
export function fiscalYear(date: Date, startMonth: number): number {
  const year = date.getUTCFullYear();
  return date.getUTCMonth() + 1 >= startMonth ? year : year - 1;
}

/**
 * The period key a series is currently in. When this changes, the sequence
 * resets — so the key must be stable for every date within one period.
 */
export function periodKey(
  frequency: 'never' | 'yearly' | 'monthly' | 'fiscal_year',
  date: Date,
  fiscalYearStartMonth = 1,
): string {
  switch (frequency) {
    case 'never':
      return 'ALL';
    case 'yearly':
      return String(date.getUTCFullYear());
    case 'monthly':
      return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    case 'fiscal_year':
      return `FY${fiscalYear(date, fiscalYearStartMonth)}`;
  }
}

/**
 * Rejects a pattern that cannot produce unique numbers.
 *
 * Validated when a series is saved rather than when a document is issued —
 * discovering the problem at issue time means discovering it on a duplicate
 * invoice number.
 */
export function validatePattern(pattern: string): { ok: true } | { ok: false; error: string } {
  if (!pattern.includes('{SEQ}')) {
    return { ok: false, error: 'Pattern must contain {SEQ}, or numbers will collide.' };
  }

  const unknown = [...pattern.matchAll(/\{([A-Z_]+)\}/g)]
    .map((m) => m[1]!)
    .filter((token) => !/^(PREFIX|SUFFIX|YYYY|YY|MM|DD|FY|ENTITY|PROJECT|SEQ)$/.test(token));

  if (unknown.length > 0) {
    return { ok: false, error: `Unknown token(s): ${unknown.map((t) => `{${t}}`).join(', ')}.` };
  }

  return { ok: true };
}

/**
 * Checks the reset frequency against the pattern.
 *
 * A yearly reset with no year in the pattern produces last year's numbers
 * again — the single most common way document numbering goes wrong.
 */
export function validateResetConsistency(
  pattern: string,
  frequency: 'never' | 'yearly' | 'monthly' | 'fiscal_year',
): { ok: true } | { ok: false; error: string } {
  const hasYear = /\{(YYYY|YY|FY)\}/.test(pattern);
  const hasMonth = pattern.includes('{MM}');

  if (frequency === 'yearly' && !hasYear) {
    return {
      ok: false,
      error: 'A yearly reset needs {YYYY}, {YY} or {FY} in the pattern, or numbers repeat.',
    };
  }
  if (frequency === 'fiscal_year' && !hasYear) {
    return { ok: false, error: 'A fiscal-year reset needs {FY} in the pattern.' };
  }
  if (frequency === 'monthly' && !(hasYear && hasMonth)) {
    return { ok: false, error: 'A monthly reset needs both a year token and {MM}.' };
  }

  return { ok: true };
}

/**
 * Locale-aware formatting.
 *
 * Money is the thing this file exists to get right. An ERP that renders
 * `1234.5` where a contract says `AED 1,234.50` looks broken to the only people
 * whose opinion matters, and a currency symbol hardcoded to one country is a
 * bug the moment the second tenant signs up — which is the whole premise of the
 * localisation design.
 */

/** Arabic is the reason the shell has to handle direction at all. */
export const RTL_LOCALES = new Set(['ar', 'he', 'fa', 'ur']);

export function directionFor(locale: string): 'rtl' | 'ltr' {
  return RTL_LOCALES.has(locale.split('-')[0]!) ? 'rtl' : 'ltr';
}

/**
 * Formats an amount in a currency.
 *
 * The API returns numerics as strings, because a `numeric(18,2)` does not fit in
 * a double and JSON has no decimal type. So this accepts a string and converts
 * once, at the edge, rather than letting `Number` conversions scatter through
 * components where a rounding error is invisible.
 */
export function money(
  amount: number | string | null | undefined,
  currency: string | null | undefined,
  locale = 'en-AE',
): string {
  if (amount == null || amount === '') return '—';
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(value)) return '—';

  try {
    return new Intl.NumberFormat(locale, {
      style: currency ? 'currency' : 'decimal',
      currency: currency ?? undefined,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    // An unknown ISO code must not blank the screen; show the number and the
    // code rather than nothing.
    return `${currency ?? ''} ${value.toFixed(2)}`.trim();
  }
}

/**
 * A percentage, with a fixed number of decimals.
 *
 * Takes a number already expressed as a percentage (68.4), not a fraction
 * (0.684) — matching what every API in this system returns, so nobody has to
 * remember which convention a given field uses.
 */
export function percent(value: number | string | null | undefined, decimals = 1): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(decimals)}%`;
}

/** A signed figure, so a variance reads as a variance and not as a total. */
export function signed(
  amount: number | string | null | undefined,
  currency: string | null | undefined,
  locale = 'en-AE',
): string {
  if (amount == null || amount === '') return '—';
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(value)) return '—';
  const formatted = money(Math.abs(value), currency, locale);
  return value < 0 ? `−${formatted}` : `+${formatted}`;
}

export function date(value: string | Date | null | undefined, locale = 'en-AE'): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    timeZone: 'UTC',
  }).format(d);
}

/**
 * Whether a figure should read as good, bad or neutral.
 *
 * Centralised because the sign convention is not obvious and gets inverted
 * constantly: a positive variance-at-completion is UNDER budget and good, while
 * a positive days-overdue is bad. Components pass the meaning, not the colour.
 */
export type Tone = 'good' | 'bad' | 'neutral';

export function toneForVariance(value: number | null | undefined): Tone {
  if (value == null || !Number.isFinite(value) || value === 0) return 'neutral';
  return value > 0 ? 'good' : 'bad';
}

export function toneForIndex(value: number | null | undefined): Tone {
  // CPI and SPI: 1.0 is on plan. Null means not yet knowable, which is neutral
  // rather than good — the distinction the API is careful to preserve.
  if (value == null || !Number.isFinite(value)) return 'neutral';
  if (value >= 1) return 'good';
  return value >= 0.95 ? 'neutral' : 'bad';
}

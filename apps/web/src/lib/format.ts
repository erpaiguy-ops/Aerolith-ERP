/**
 * Locale-aware formatting.
 *
 * Money is the thing this file exists to get right. An ERP that renders
 * `1234.5` where a contract says `AED 1,234.50` looks broken to the only people
 * whose opinion matters, and a currency symbol hardcoded to one country is a
 * bug the moment the second tenant signs up — which is the whole premise of the
 * localisation design.
 */

import { currentLocale } from './locale';

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
  locale = currentLocale(),
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
 * A stock quantity, with its unit.
 *
 * Separate from `money` because a quantity has no currency and separate from
 * `integer` because 3.5 sheets is a real figure. Trailing zeros are dropped —
 * the database holds `900.0000` and the storekeeper says 900 — but a genuine
 * fraction is kept.
 */
export function quantity(
  value: number | string | null | undefined,
  uom?: string | null,
  locale = currentLocale(),
): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';

  const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(n);
  return uom ? `${formatted} ${uom}` : formatted;
}

/**
 * Panel dimensions, as a joiner writes them.
 *
 * `2440 × 1220 × 18` rather than three columns, because the three numbers are
 * one fact — a board size is recognised as a shape, not read as measurements.
 * Trailing zeros are dropped: the database holds `2440.00` and nobody says that.
 */
export function dimensions(
  length: string | number | null | undefined,
  width: string | number | null | undefined,
  thickness?: string | number | null,
): string {
  const parts = [length, width, thickness]
    .filter((value) => value != null && value !== '')
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    // `parseFloat` of the fixed form, so 18.00 → 18 and 0.80 → 0.8.
    .map((value) => String(Number.parseFloat(value.toFixed(2))));

  // Fewer than two numbers is not a size. A lone length rendered as "2440"
  // reads as a quantity.
  return parts.length >= 2 ? parts.join(' × ') : '—';
}

/**
 * A whole number — a count, a page number.
 *
 * Exists so that no caller reaches for `Number.prototype.toLocaleString()` with
 * no argument, which formats in the SERVER's locale. That is a machine setting
 * with no relationship to the user, and it silently disagrees with every other
 * figure on the page.
 */
export function integer(value: number, locale = currentLocale()): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
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
  locale = currentLocale(),
): string {
  if (amount == null || amount === '') return '—';
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(value)) return '—';
  const formatted = money(Math.abs(value), currency, locale);
  return value < 0 ? `−${formatted}` : `+${formatted}`;
}

/**
 * A byte count as a human size — `sizeBytes` from the documents register is
 * the only caller, so this stays binary (KiB/MiB) rather than chasing SI vs.
 * binary convention for a general-purpose figure nobody else needs yet.
 */
export function fileSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

export function date(value: string | Date | null | undefined, locale = currentLocale()): string {
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
 * A date with the time of day, for records where several can land on the same
 * day and the order between them is the point — an audit trail entry, most of
 * all.
 */
export function datetime(value: string | Date | null | undefined, locale = currentLocale()): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
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

/**
 * The request's formatting locale.
 *
 * Every formatting helper defaulted to `en-AE`, and every caller took the
 * default — so an Arabic-speaking user in Dubai saw `AED 1,234.50` and
 * `28 Jul 2026` rather than `‏1,234.50 د.إ.‏` and `28 يوليو 2026`. The locale
 * was plumbed as a parameter and then never passed, which is the quietest kind
 * of broken: it typechecks, it renders, and it is wrong for exactly the users
 * the product is aimed at.
 *
 * It has to be ambient rather than a prop, because the components that format
 * money — `Money`, the table cells — are shared and never see the session, and
 * React context does not exist for server components.
 *
 * **Why `cache()` and not `AsyncLocalStorage`.** The obvious implementation is
 * `storage.run(locale, () => <Shell>{children}</Shell>)`, and it silently does
 * nothing: `run` holds the store for the synchronous execution of its callback,
 * and that callback only *creates* the element. React renders the children
 * afterwards, on its own, by which time `run` has long returned and the store is
 * gone. It renders, it typechecks, and every figure comes out in the fallback
 * locale — the same failure mode this file was written to fix, one level up.
 *
 * `cache()` gives a memo slot scoped to the React request, so writing into the
 * object it returns is a request-scoped write that survives until the render
 * finishes. It relies on the layout body running before its children render,
 * which is exactly how React renders a parent and the `children` it returned.
 *
 * **The fallback matters.** Rendering outside a request scope — a server action,
 * a unit test — must still produce something correct-looking rather than
 * throwing, so an absent locale reads as `en-AE`. That is a degradation, not a
 * default: it means the user sees English formatting, which is what they saw
 * before this existed.
 */
import 'server-only';

import { cache } from 'react';

export const DEFAULT_LOCALE = 'en-AE';

/**
 * One mutable holder per request.
 *
 * `cache()` memoises on arguments; called with none, it yields a single object
 * for the life of the request and a fresh one for the next, which is what makes
 * writing to it safe under concurrency.
 */
const holder = cache((): { locale: string } => ({ locale: DEFAULT_LOCALE }));

/**
 * The locale a user should see figures in.
 *
 * The UI language and the country conventions are different facts and both
 * matter: an Arabic speaker in the UAE wants Arabic month names and the dirham
 * mark, but LATIN digits — `ar-AE` gives exactly that, while `ar-EG` would give
 * Arabic-Indic digits, which is correct in Cairo and wrong in Dubai. Combining
 * the user's language with the tenant's country is what gets that right without
 * anyone maintaining a table of exceptions.
 */
export function formattingLocale(language: string, countryCode: string | null): string {
  const base = language.split('-')[0]!;
  if (!countryCode) return base;
  return `${base}-${countryCode.toUpperCase()}`;
}

/**
 * Establishes the locale for the rest of the request.
 *
 * Called once, by the authenticated layout, before it returns the shell.
 */
export function setLocale(locale: string): void {
  holder().locale = locale;
}

export function currentLocale(): string {
  try {
    return holder().locale;
  } catch {
    // `cache()` throws outside a React request scope. Formatting is not
    // important enough to take a page down over.
    return DEFAULT_LOCALE;
  }
}

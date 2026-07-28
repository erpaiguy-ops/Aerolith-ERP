import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ApiError, apiFetch } from '@/lib/api';
import { integer } from '@/lib/format';
import { href, queryString, type ListEnvelope, type Query } from '@/lib/list';
import { Bidi, Empty } from './ui';

// Re-exported so an index screen imports everything it needs from one place.
export { href, listQuery, queryString, type ListEnvelope, type Query } from '@/lib/list';

/**
 * Fetches a page for an index screen, turning "not entitled" into a 404 page.
 *
 * The API answers 404 rather than 403 for a module the tenant has not bought, so
 * that an unentitled module does not confirm it exists. This mirrors that: a
 * user who types the URL of a module they do not have gets the not-found page,
 * the same as any other unknown address — not a stack trace, and not an upgrade
 * pitch that leaks the catalogue.
 *
 * The detail screens already did this. The list screens did not, which meant a
 * typed URL crashed the render instead of answering it.
 */
export async function fetchList<TRow>(path: string, query: Query): Promise<ListEnvelope<TRow>> {
  try {
    return await apiFetch<ListEnvelope<TRow>>(`${path}${queryString(query)}`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) notFound();
    throw error;
  }
}

/**
 * The furniture every index screen needs: search, filter chips, sortable column
 * headers and a pager.
 *
 * All of it is plain links, no client JavaScript. Each control is a URL, which
 * means a filtered, sorted page is bookmarkable and sendable — "here is the list
 * of held invoices over 10k, sorted by value" is a message somebody can paste
 * into a chat. A client-side filter would have made that impossible and bought
 * nothing: the server has to run the query either way.
 */

export function SearchBox({
  base,
  query,
  placeholder,
}: {
  base: string;
  query: Query;
  placeholder: string;
}) {
  return (
    <form action={base} className="flex w-full max-w-sm gap-2">
      {/* Every other active filter rides along as a hidden field. Without this,
          searching silently clears the status filter the user just set, which
          reads as the search being broken. */}
      {Object.entries(query)
        .filter(([key, value]) => key !== 'q' && key !== 'page' && value)
        .map(([key, value]) => (
          <input key={key} type="hidden" name={key} value={value} />
        ))}
      <input
        type="search"
        name="q"
        defaultValue={query.q ?? ''}
        placeholder={placeholder}
        // A placeholder cannot contain an element, so the isolation has to be an
        // attribute. `auto` orders the placeholder by its own first strong
        // character — without it "Number, name or client ref…" renders with the
        // ellipsis leading on an Arabic page — and does the same for whatever
        // the user types, so an Arabic search term reads correctly as it is
        // entered.
        dir="auto"
        // A search box whose placeholder is cut off mid-word ("Order number or
        // suppl") reads as a rendering fault. Wide enough for the longest
        // placeholder these screens use.
        className="w-full min-w-56 rounded-md border border-(--color-line) bg-(--color-surface) px-3 py-1.5 text-sm outline-none focus:border-(--color-accent)"
      />
      <button
        type="submit"
        className="rounded-md border border-(--color-line) px-3 py-1.5 text-sm hover:bg-(--color-canvas)"
      >
        <Bidi>Search</Bidi>
      </button>
    </form>
  );
}

export function FilterChips({
  base,
  query,
  param,
  options,
}: {
  base: string;
  query: Query;
  param: string;
  /** `value: null` is the "all" chip. */
  options: { label: string; value: string | null }[];
}) {
  const active = query[param] ?? null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const selected = active === option.value;
        return (
          <Link
            key={option.label}
            // Changing a filter returns to page 1. Staying on page 4 of a
            // narrower result set shows an empty screen and looks like a bug.
            href={href(base, query, { [param]: option.value ?? undefined, page: undefined })}
            className={`rounded-full border px-2.5 py-1 text-xs ${
              selected
                ? 'border-(--color-accent) bg-(--color-accent)/10 text-(--color-accent)'
                : 'border-(--color-line) text-(--color-muted) hover:bg-(--color-canvas)'
            }`}
          >
            <Bidi>{option.label}</Bidi>
          </Link>
        );
      })}
    </div>
  );
}

/** A column header that toggles the sort. */
export function SortTh({
  base,
  query,
  column,
  current,
  direction,
  children,
  numeric,
}: {
  base: string;
  query: Query;
  column: string;
  current: string;
  direction: 'asc' | 'desc';
  children: React.ReactNode;
  numeric?: boolean;
}) {
  const active = current === column;
  // Clicking the active column flips it; clicking a new one starts ascending,
  // which is what a user expects from a name or a date.
  const next = active && direction === 'asc' ? 'desc' : 'asc';

  return (
    <th
      // Same inline-end padding as `Th`, which this deliberately does not reuse
      // because the header has to wrap its label in a link.
      className={`border-b border-(--color-line) pb-2 pe-4 font-medium last:pe-0 ${
        numeric ? 'text-end' : 'text-start'
      }`}
    >
      <Link
        href={href(base, query, { sort: column, direction: next, page: undefined })}
        className={`inline-flex items-center gap-1 hover:text-(--color-fg) ${
          active ? 'text-(--color-fg)' : ''
        }`}
      >
        <Bidi>{children}</Bidi>
        <span aria-hidden className={active ? '' : 'opacity-0'}>
          {direction === 'asc' ? '↑' : '↓'}
        </span>
      </Link>
    </th>
  );
}

export function Pager({
  base,
  query,
  result,
  noun,
}: {
  base: string;
  query: Query;
  result: Pick<ListEnvelope<unknown>, 'page' | 'totalPages' | 'total' | 'pageSize'>;
  /**
   * Singular and plural. Both spelled out rather than derived: English
   * pluralisation has too many exceptions to guess at, and "1 open exceptions"
   * on an otherwise careful screen makes a reader wonder what else was not
   * checked.
   */
  noun: [singular: string, plural: string];
}) {
  const { page, totalPages, total } = result;
  const word = total === 1 ? noun[0] : noun[1];

  return (
    <div className="mt-4 flex items-center justify-between text-sm text-(--color-muted)">
      <p>
        {/* The total is the point of this line. It is very often the only thing
            the user came to find out.

            Isolated as one run: "1 contract" is a number followed by a word, and
            in an RTL paragraph the number is weak while the word is strongly
            LTR, so the line renders "contract 1" — the count reading as an index.
            Ordering the whole phrase by its own first strong character fixes it,
            and keeps working once the noun is translated. */}
        <Bidi>
          <span className="numeric">{integer(total)}</span> {word}
          {totalPages > 1 ? (
            <>
              {' '}
              · page <span className="numeric">{integer(page)}</span> of{' '}
              <span className="numeric">{integer(totalPages)}</span>
            </>
          ) : null}
        </Bidi>
      </p>

      {totalPages > 1 ? (
        <div className="flex gap-2">
          <PagerLink
            base={base}
            query={query}
            to={page - 1}
            disabled={page <= 1}
            label="Previous"
          />
          <PagerLink
            base={base}
            query={query}
            to={page + 1}
            disabled={page >= totalPages}
            label="Next"
          />
        </div>
      ) : null}
    </div>
  );
}

function PagerLink({
  base,
  query,
  to,
  disabled,
  label,
}: {
  base: string;
  query: Query;
  to: number;
  disabled: boolean;
  label: string;
}) {
  if (disabled) {
    return (
      <span className="rounded-md border border-(--color-line) px-2.5 py-1 opacity-40">
        <Bidi>{label}</Bidi>
      </span>
    );
  }

  return (
    <Link
      href={href(base, query, { page: String(to) })}
      className="rounded-md border border-(--color-line) px-2.5 py-1 hover:bg-(--color-canvas)"
    >
      <Bidi>{label}</Bidi>
    </Link>
  );
}

/**
 * The empty state, which says something different depending on WHY it is empty.
 *
 * "No results for 'marnia'" tells a user they have made a typo. "Nothing here
 * yet" tells them the feature works and they have not used it. One generic
 * message for both wastes the only moment the screen has their attention.
 */
export function EmptyList({
  query,
  noun,
  hint,
}: {
  query: Query;
  /** Same singular/plural pair as `Pager`, so a screen states it once. */
  noun: [singular: string, plural: string];
  hint?: string;
}) {
  const filtered = Boolean(query.q || query.status || query.side || query.held || query.overdue);

  if (filtered) {
    return (
      <Empty
        title={query.q ? `Nothing matches “${query.q}”` : `No ${noun[1]} match these filters`}
        detail="Clear the filters to see everything."
      />
    );
  }

  return <Empty title={`No ${noun[1]} yet`} detail={hint} />;
}

/**
 * List parameters and the response envelope, shared by every list endpoint.
 *
 * What this deliberately is NOT: a generic query builder. Every module writes
 * its own `select`, because Drizzle's types only work when the query is written
 * against a concrete table, and a layer that erases them would trade compile-time
 * safety for the illusion of reuse. What IS shared is the boring part that is
 * dangerous to get wrong twice — parsing untrusted query strings, whitelisting
 * sort columns, capping page size, and shaping the response the same way
 * everywhere so the web client has one thing to read.
 *
 * **Sort columns are whitelisted, not validated.** Drizzle parameterises values,
 * never identifiers. `order by ${request.query.sort}` is a SQL injection whatever
 * you do to the string afterwards, so the caller passes the set of sortable keys
 * and anything else falls back to the default. There is no clever escaping here
 * and there should not be.
 *
 * **Offset pagination, with a total.** Keyset would page more efficiently, but it
 * cannot produce a total, and "47 open orders" is a fact an ERP list genuinely
 * needs — it is often the only thing the user came to find out. ERP users filter
 * and sort; they do not page to row 40,000. The cost is that a deep page scans
 * what it skips: fine at this scale, and the note in `LIST_MAX_PAGE_SIZE` says
 * what to do when it stops being fine.
 */

/** Hard ceiling on rows per request, whatever the caller asks for. */
export const LIST_MAX_PAGE_SIZE = 200;
export const LIST_DEFAULT_PAGE_SIZE = 50;

export type SortDirection = 'asc' | 'desc';

export interface ListParams<TSort extends string = string> {
  page: number;
  pageSize: number;
  /** Always one of the caller's declared sortable keys. Safe to map to a column. */
  sort: TSort;
  direction: SortDirection;
  /** Free-text search, trimmed and lowercased. Empty string becomes undefined. */
  search?: string;
  /** Rows to skip. Derived, so no caller recomputes it slightly differently. */
  offset: number;
}

export interface ParseListOptions<TSort extends string> {
  /** The only columns this list may be sorted by. */
  sortable: readonly TSort[];
  defaultSort: TSort;
  defaultDirection?: SortDirection;
  defaultPageSize?: number;
  maxPageSize?: number;
}

/** Raw query-string values, all possibly absent and all possibly rubbish. */
export interface RawListQuery {
  page?: string | number;
  pageSize?: string | number;
  sort?: string;
  direction?: string;
  q?: string;
}

/**
 * Turns an untrusted query string into parameters that are safe to use.
 *
 * Never throws. A list endpoint that 400s because somebody typed `?page=abc`
 * into the address bar is worse than one that shows page 1: the request has an
 * obvious sane reading, and refusing it teaches users the software is brittle.
 * Anything unparseable falls back to the default.
 */
export function parseListParams<TSort extends string>(
  raw: RawListQuery | undefined,
  options: ParseListOptions<TSort>,
): ListParams<TSort> {
  const query = raw ?? {};
  const maxPageSize = options.maxPageSize ?? LIST_MAX_PAGE_SIZE;

  const page = positiveInt(query.page, 1);
  const pageSize = clamp(
    positiveInt(query.pageSize, options.defaultPageSize ?? LIST_DEFAULT_PAGE_SIZE),
    1,
    maxPageSize,
  );

  const requested = typeof query.sort === 'string' ? query.sort : undefined;
  const sort =
    requested && (options.sortable as readonly string[]).includes(requested)
      ? (requested as TSort)
      : options.defaultSort;

  const direction: SortDirection =
    query.direction === 'asc' || query.direction === 'desc'
      ? query.direction
      : (options.defaultDirection ?? 'desc');

  const search = typeof query.q === 'string' ? query.q.trim().toLowerCase() : '';

  return {
    page,
    pageSize,
    sort,
    direction,
    search: search === '' ? undefined : search,
    offset: (page - 1) * pageSize,
  };
}

export interface ListResult<TRow> {
  rows: TRow[];
  page: number;
  pageSize: number;
  /** Total matching the filter, not the page. */
  total: number;
  totalPages: number;
  hasMore: boolean;
  sort: string;
  direction: SortDirection;
}

/** Wraps a page of rows with everything a client needs to render a pager. */
export function listResult<TRow>(
  rows: TRow[],
  total: number,
  params: ListParams,
): ListResult<TRow> {
  return {
    rows,
    page: params.page,
    pageSize: params.pageSize,
    total,
    // A list with no rows has one (empty) page, not zero. Reporting zero makes
    // "page 1 of 0" appear in the UI, which every reviewer stops to ask about.
    totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
    hasMore: params.offset + rows.length < total,
    sort: params.sort,
    direction: params.direction,
  };
}

/**
 * A `%term%` pattern with the LIKE wildcards in the term itself escaped.
 *
 * Without this, a user searching for a literal `100%` matches everything, and
 * `_` silently matches any character — both of which read as "search is broken"
 * rather than as an escaping bug. The backslash is escaped first, or it would
 * double-escape the wildcards added after it.
 */
export function searchPattern(term: string): string {
  const escaped = term.replace(/\\/g, '\\\\').replace(/[%_]/g, (char) => `\\${char}`);
  return `%${escaped}%`;
}

function positiveInt(value: string | number | undefined, fallback: number): number {
  if (value == null) return fallback;
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The pure half of the index screens: the response envelope, the query shape and
 * the URL arithmetic behind every control on a list.
 *
 * Separate from `components/List.tsx` because that file imports the server-only
 * API client, and none of this needs it. Keeping the logic here means it is unit
 * tested directly rather than only through a rendered page — the URL building is
 * where the real behaviour is, and it is the part that silently drops a filter
 * when it goes wrong.
 */

export interface ListEnvelope<TRow> {
  rows: TRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
  sort: string;
  direction: 'asc' | 'desc';
}

export type Query = Record<string, string | undefined>;

/**
 * Next hands `searchParams` as `string | string[] | undefined` because a URL may
 * repeat a key. None of these lists means anything by a repeated key, so the
 * first wins — which is also what the API's parser does with a repeated value,
 * so the screen and the query agree.
 */
export function listQuery(raw: Record<string, string | string[] | undefined>): Query {
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]),
  );
}

/** The query re-serialised for the API call, with empty values dropped. */
export function queryString(query: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value) params.set(key, value);
  }
  const string = params.toString();
  return string ? `?${string}` : '';
}

/** Rebuilds the current URL with some parameters changed. */
export function href(base: string, query: Query, changes: Query): string {
  const next = new URLSearchParams();

  for (const [key, value] of Object.entries({ ...query, ...changes })) {
    // A blank filter must drop out of the URL rather than appear as `?status=`,
    // or every link accumulates empty parameters until the address bar is noise.
    if (value == null || value === '') continue;
    next.set(key, value);
  }

  const string = next.toString();
  return string ? `${base}?${string}` : base;
}

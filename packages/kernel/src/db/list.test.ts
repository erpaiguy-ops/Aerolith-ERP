import { describe, expect, it } from 'vitest';

import {
  LIST_MAX_PAGE_SIZE,
  listResult,
  parseListParams,
  searchPattern,
} from './list';

const options = {
  sortable: ['createdAt', 'name', 'value'] as const,
  defaultSort: 'createdAt' as const,
};

describe('list parameters', () => {
  it('defaults everything when nothing is given', () => {
    const params = parseListParams(undefined, options);

    expect(params.page).toBe(1);
    expect(params.pageSize).toBe(50);
    expect(params.sort).toBe('createdAt');
    expect(params.direction).toBe('desc');
    expect(params.search).toBeUndefined();
    expect(params.offset).toBe(0);
  });

  it('derives the offset rather than making each caller do it', () => {
    expect(parseListParams({ page: '3', pageSize: '20' }, options).offset).toBe(40);
  });

  it('refuses a sort column it was not told about', () => {
    // Drizzle parameterises values, never identifiers. An unrecognised sort key
    // cannot be escaped into safety — it can only be rejected.
    const params = parseListParams({ sort: 'password_hash' }, options);
    expect(params.sort).toBe('createdAt');
  });

  it('refuses a sort column that is an injection attempt', () => {
    const params = parseListParams(
      { sort: 'name; drop table kernel.tenant --' },
      options,
    );
    expect(params.sort).toBe('createdAt');
  });

  it('accepts a sort column it was told about', () => {
    expect(parseListParams({ sort: 'name', direction: 'asc' }, options).sort).toBe('name');
  });

  it('caps the page size however large the request', () => {
    // Otherwise `?pageSize=1000000` is a denial of service anybody can type.
    const params = parseListParams({ pageSize: '99999' }, options);
    expect(params.pageSize).toBe(LIST_MAX_PAGE_SIZE);
  });

  it('respects a stricter cap for an expensive list', () => {
    const params = parseListParams({ pageSize: '500' }, { ...options, maxPageSize: 25 });
    expect(params.pageSize).toBe(25);
  });

  it('falls back rather than failing on rubbish input', () => {
    // Somebody edited the address bar. Page 1 is the obvious reading; a 400
    // teaches users the software is brittle for no benefit.
    const params = parseListParams(
      { page: 'abc', pageSize: '-4', direction: 'sideways' },
      options,
    );

    expect(params.page).toBe(1);
    expect(params.pageSize).toBe(50);
    expect(params.direction).toBe('desc');
  });

  it('takes numbers as well as strings', () => {
    // Fastify gives strings; a service calling this directly gives numbers.
    expect(parseListParams({ page: 2, pageSize: 10 }, options).offset).toBe(10);
  });

  it('normalises the search term and drops an empty one', () => {
    expect(parseListParams({ q: '  Marina TOWER ' }, options).search).toBe('marina tower');
    expect(parseListParams({ q: '   ' }, options).search).toBeUndefined();
  });

  it('honours a per-list default sort and direction', () => {
    const params = parseListParams(undefined, {
      sortable: ['dueOn'] as const,
      defaultSort: 'dueOn',
      defaultDirection: 'asc',
      defaultPageSize: 25,
    });

    expect(params.sort).toBe('dueOn');
    expect(params.direction).toBe('asc');
    expect(params.pageSize).toBe(25);
  });
});

describe('list result', () => {
  const params = parseListParams({ page: '2', pageSize: '10' }, options);

  it('reports the total matching the filter, not the page', () => {
    const result = listResult([{ id: 'a' }], 47, params);
    expect(result.total).toBe(47);
    expect(result.totalPages).toBe(5);
  });

  it('knows when there is more', () => {
    // Offset 10, ten rows returned, 47 total.
    expect(listResult(new Array(10).fill({}), 47, params).hasMore).toBe(true);
    expect(listResult(new Array(10).fill({}), 20, params).hasMore).toBe(false);
  });

  it('gives an empty list one page, not zero', () => {
    // "Page 1 of 0" is the kind of detail that makes a user distrust every other
    // number on the screen.
    expect(listResult([], 0, params).totalPages).toBe(1);
  });

  it('echoes the sort back so the client can render the header state', () => {
    const result = listResult([], 0, params);
    expect(result.sort).toBe('createdAt');
    expect(result.direction).toBe('desc');
  });
});

describe('search pattern', () => {
  it('wraps the term in wildcards', () => {
    expect(searchPattern('marina')).toBe('%marina%');
  });

  it('escapes a percent, which would otherwise match everything', () => {
    // Searching for "100%" is an ordinary thing to do on a progress column.
    expect(searchPattern('100%')).toBe('%100\\%%');
  });

  it('escapes an underscore, which would otherwise match any character', () => {
    expect(searchPattern('PO_2026')).toBe('%PO\\_2026%');
  });

  it('escapes the backslash first, so the escapes are not double-escaped', () => {
    expect(searchPattern('a\\b')).toBe('%a\\\\b%');
    expect(searchPattern('50\\%')).toBe('%50\\\\\\%%');
  });
});

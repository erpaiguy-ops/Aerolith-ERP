import { describe, expect, it } from 'vitest';

import { href, listQuery, queryString } from './list';

describe('href', () => {
  it('keeps the parameters already in the URL', () => {
    // Sorting must not silently discard the filter the user just set.
    expect(href('/projects', { status: 'awarded', q: 'marina' }, { sort: 'code' })).toBe(
      '/projects?status=awarded&q=marina&sort=code',
    );
  });

  it('drops a parameter set to undefined', () => {
    // The "All" filter chip clears the filter by passing undefined.
    expect(href('/projects', { status: 'awarded' }, { status: undefined })).toBe('/projects');
  });

  it('drops an empty string rather than emitting a bare key', () => {
    // Otherwise every link accumulates `?q=&status=` until the address bar is
    // unreadable noise.
    expect(href('/projects', { q: '' }, {})).toBe('/projects');
  });

  it('returns the bare path when nothing is left', () => {
    expect(href('/contracts', {}, {})).toBe('/contracts');
  });

  it('resets the page when a filter changes', () => {
    // Staying on page 4 of a narrower result set shows an empty screen, which
    // reads as the filter being broken.
    expect(href('/projects', { page: '4' }, { status: 'closed', page: undefined })).toBe(
      '/projects?status=closed',
    );
  });

  it('overrides an existing value rather than repeating the key', () => {
    expect(href('/projects', { sort: 'code' }, { sort: 'name' })).toBe('/projects?sort=name');
  });

  it('encodes a value that would otherwise break the URL', () => {
    expect(href('/projects', {}, { q: 'marina & tower' })).toBe(
      '/projects?q=marina+%26+tower',
    );
  });
});

describe('listQuery', () => {
  it('takes the first value when a key repeats', () => {
    // A URL may legally repeat a key. None of these lists means anything by it,
    // and the API's parser takes the first too — so the screen and the query
    // agree rather than disagreeing invisibly.
    expect(listQuery({ status: ['a', 'b'] })).toEqual({ status: 'a' });
  });

  it('passes single values through', () => {
    expect(listQuery({ q: 'marina', page: '2' })).toEqual({ q: 'marina', page: '2' });
  });

  it('keeps an absent key absent', () => {
    expect(listQuery({ q: undefined })).toEqual({ q: undefined });
  });
});

describe('queryString', () => {
  it('serialises what is set and drops what is not', () => {
    expect(queryString({ q: 'marina', status: undefined, page: '' })).toBe('?q=marina');
  });

  it('returns an empty string when nothing is set, not a bare question mark', () => {
    // `fetch('/projects?')` works, but it appears in logs and in the address bar
    // and invites the question of what was meant to be there.
    expect(queryString({})).toBe('');
    expect(queryString({ q: undefined })).toBe('');
  });
});

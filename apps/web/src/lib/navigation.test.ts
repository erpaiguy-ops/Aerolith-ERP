import { describe, expect, it } from 'vitest';

import {
  accessState,
  flattenNav,
  isActiveGroup,
  isActivePath,
  landingPath,
  type Me,
  type NavItem,
} from './navigation';

const nav: NavItem[] = [
  {
    key: 'projects',
    label: 'Projects',
    order: 25,
    children: [
      { key: 'projects.list', label: 'Projects', path: '/projects', order: 10 },
      { key: 'projects.costs', label: 'Job Costing', path: '/projects/costs', order: 30 },
    ],
  },
  {
    key: 'contracts',
    label: 'Contracts',
    order: 30,
    children: [{ key: 'contracts.list', label: 'Contracts', path: '/contracts', order: 10 }],
  },
];

const me = (overrides: Partial<Me> = {}): Me => ({
  user: { id: 'u', locale: 'en', timezone: null, isOwner: false },
  tenant: { id: 't', countryCode: 'AE', currencyCode: 'AED' },
  modules: [{ key: 'projects', name: 'Aerolith Projects', version: '0.1.0' }],
  unavailableModules: [],
  navigation: nav,
  permissions: [],
  ...overrides,
});

describe('active path matching', () => {
  it('matches exactly', () => {
    expect(isActivePath('/projects', '/projects')).toBe(true);
  });

  it('matches a child route, so a detail page keeps its section lit', () => {
    expect(isActivePath('/projects', '/projects/abc-123')).toBe(true);
  });

  it('only matches on a segment boundary', () => {
    // A plain startsWith lights `/contracts` up for `/contracts-archive`, which
    // nobody notices until a customer has two similarly named screens.
    expect(isActivePath('/contracts', '/contracts-archive')).toBe(false);
    expect(isActivePath('/projects', '/projects-old/1')).toBe(false);
  });

  it('does not let the root match everything', () => {
    expect(isActivePath('/', '/projects')).toBe(false);
    expect(isActivePath('/', '/')).toBe(true);
  });

  it('treats a missing path as never active', () => {
    expect(isActivePath(undefined, '/projects')).toBe(false);
  });

  it('keeps a group open when any descendant is active', () => {
    expect(isActiveGroup(nav[0]!, '/projects/costs')).toBe(true);
    expect(isActiveGroup(nav[1]!, '/projects/costs')).toBe(false);
  });
});

describe('flattening', () => {
  it('returns only leaves that can actually be opened', () => {
    // Group headers have no path; linking to them 404s.
    expect(flattenNav(nav).map((i) => i.path)).toEqual([
      '/projects',
      '/projects/costs',
      '/contracts',
    ]);
  });
});

describe('landing page', () => {
  it('sends the user to the first thing they can actually open', () => {
    // Not a hardcoded dashboard: a tenant entitled only to Estimating has no
    // dashboard worth the name, and an empty page is a poor first impression
    // of a product they are evaluating.
    expect(landingPath(nav)).toBe('/projects');
  });

  it('falls back to an explanation rather than a blank screen', () => {
    expect(landingPath([])).toBe('/no-access');
  });
});

describe('access state', () => {
  it('is ready when there is anything to open', () => {
    expect(accessState(me())).toEqual({ kind: 'ready' });
  });

  it('distinguishes "no modules bought" from "no permissions granted"', () => {
    // Identical to the user, completely different fixes: buy the module versus
    // grant the role. Conflating them wastes an administrator's afternoon.
    expect(accessState(me({ navigation: [], modules: [] })).kind).toBe('no_modules');
    expect(accessState(me({ navigation: [] })).kind).toBe('no_permissions');
  });

  it('reports an entitlement this deployment cannot serve', () => {
    const state = accessState(
      me({
        navigation: [],
        modules: [],
        unavailableModules: [{ key: 'accounts', reason: 'Module is not present in this deployment.' }],
      }),
    );

    expect(state).toEqual({ kind: 'unavailable', keys: ['accounts'] });
  });

  it('stays ready when a module is unavailable but others still render', () => {
    // Graceful degradation: one missing module must not blank the whole app.
    const state = accessState(
      me({ unavailableModules: [{ key: 'accounts', reason: 'Not present.' }] }),
    );
    expect(state.kind).toBe('ready');
  });
});

/**
 * Navigation shaping.
 *
 * The API has already done the hard part: `/me` returns only the modules this
 * tenant is entitled to, with every item the user lacks permission for removed.
 * That is requirement 19 made visible — the same deployment renders a focused
 * single-module product for one tenant and the full ERP for another, and the web
 * app contains no `if (tenant === ...)` anywhere.
 *
 * What is left here is presentation: which item is active, and what to show when
 * the answer is nothing. Both are pure functions, which is why they are here
 * rather than inline in a component.
 */

export interface NavItem {
  key: string;
  label: string;
  icon?: string;
  path?: string;
  permission?: string;
  order: number;
  children?: NavItem[];
}

export interface Me {
  user: { id: string; locale: string; timezone: string | null; isOwner: boolean };
  tenant: { id: string; countryCode: string | null; currencyCode: string | null };
  modules: { key: string; name: string; version: string }[];
  unavailableModules: { key: string; reason: string }[];
  navigation: NavItem[];
  permissions: string[];
}

/**
 * Whether a nav item should render as the current page.
 *
 * Prefix matching, so `/projects/abc123` still lights up `/projects` — but only
 * on a SEGMENT boundary. A plain `startsWith` would light `/contracts` up for
 * `/contracts-archive`, which is the kind of thing nobody notices until a
 * customer has two similarly named modules.
 */
export function isActivePath(itemPath: string | undefined, currentPath: string): boolean {
  if (!itemPath) return false;
  if (itemPath === currentPath) return true;

  // The root is only ever active on an exact match, or it is active everywhere.
  if (itemPath === '/') return false;

  return currentPath.startsWith(`${itemPath}/`);
}

/** A parent is active when any descendant is, so the group stays open. */
export function isActiveGroup(item: NavItem, currentPath: string): boolean {
  if (isActivePath(item.path, currentPath)) return true;
  return (item.children ?? []).some((child) => isActiveGroup(child, currentPath));
}

/** Every leaf with a path, flattened — for the command palette and breadcrumbs. */
/**
 * The single nav item that should render as current.
 *
 * `isActivePath` prefix-matches, which is right on its own — `/projects/abc123`
 * belongs to `/projects`. But when two items both match, deciding per item
 * highlights BOTH: standing on `/contracts/applications` lit up "Contracts" as
 * well, so the sidebar disagreed with itself about where the user was.
 *
 * The longest match wins, because the most specific item is the one the user
 * actually navigated to. Returns undefined when nothing matches, which is a real
 * state — a detail screen under a path no nav item covers.
 */
export function activeNavPath(items: NavItem[], currentPath: string): string | undefined {
  return flattenNav(items)
    .map((item) => item.path)
    .filter((path): path is string => Boolean(path) && isActivePath(path, currentPath))
    .sort((a, b) => b.length - a.length)[0];
}

export function flattenNav(items: NavItem[]): NavItem[] {
  return items.flatMap((item) => [
    ...(item.path ? [item] : []),
    ...flattenNav(item.children ?? []),
  ]);
}

/**
 * The page a user should land on after signing in.
 *
 * Not hardcoded to a dashboard: a tenant entitled only to Estimating has no
 * dashboard worth the name, and dropping them on an empty page is a bad first
 * impression of a product they are evaluating. The first thing they can actually
 * open is a better answer.
 */
export function landingPath(nav: NavItem[]): string {
  return flattenNav(nav)[0]?.path ?? '/no-access';
}

export type AccessState =
  | { kind: 'ready' }
  /** Entitled to modules, but every screen in them is permission-gated away. */
  | { kind: 'no_permissions' }
  /** No modules at all — a workspace nobody has finished setting up. */
  | { kind: 'no_modules' }
  /** Entitled to something this deployment cannot serve. */
  | { kind: 'unavailable'; keys: string[] };

/**
 * Distinguishes the three ways a user can arrive at an empty screen.
 *
 * They look identical to the user and have completely different fixes — buy the
 * module, grant the role, upgrade the deployment — so telling them apart is the
 * difference between a support ticket and a self-service fix. An empty sidebar
 * with no explanation is the single most common way a permissioned ERP wastes
 * an administrator's afternoon.
 */
export function accessState(me: Me): AccessState {
  if (flattenNav(me.navigation).length > 0) return { kind: 'ready' };

  if (me.modules.length === 0) {
    return me.unavailableModules.length > 0
      ? { kind: 'unavailable', keys: me.unavailableModules.map((m) => m.key) }
      : { kind: 'no_modules' };
  }

  return { kind: 'no_permissions' };
}

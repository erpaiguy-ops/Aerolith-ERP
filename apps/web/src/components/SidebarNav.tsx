'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

import { activeNavPath, isActiveGroup, type NavItem } from '@/lib/navigation';

// `<bdi>` directly rather than the `Bidi` wrapper from `./ui`. The wrapper is
// nothing but this element, but its module reaches `lib/locale` through
// `lib/format`, which is `server-only` — importing it into a client component
// fails the production build, and `next build` is the only step that catches
// it (typecheck and lint both pass).

/**
 * The sidebar navigation.
 *
 * A client component, and it has to be, for a reason that is not about
 * interactivity for its own sake:
 *
 * **The highlight used to go stale.** `currentPath` reached the shell as an
 * `x-pathname` header set by the middleware and read in `(app)/layout.tsx`.
 * That is a SERVER value resolved when the layout renders — and Next preserves
 * a layout across client-side navigations rather than re-rendering it, so
 * clicking through the sidebar moved the page while the sidebar kept pointing
 * at wherever the last full render had left it. It only caught up when
 * something forced the layout to re-render, which in practice meant performing
 * an action. `usePathname()` is a subscription rather than a snapshot, so the
 * highlight now follows the router instead of lagging behind it.
 *
 * **Groups collapse.** Every module rendered every one of its children at all
 * times, which on a tenant entitled to the full ERP is a sidebar longer than
 * the viewport with no way to shorten it. Now a group opens on click and starts
 * open only when it contains the current page, so the way in is one click and
 * nothing else is in the way.
 *
 * Still no module names in this file: it renders whatever `/me` returned. The
 * data is the tenant's entitlements filtered by the user's permissions, and it
 * arrives as props exactly as it did before.
 */
export function SidebarNav({ navigation }: { navigation: NavItem[] }) {
  const pathname = usePathname() ?? '';
  const activePath = activeNavPath(navigation, pathname);

  return (
    <nav className="p-2">
      {navigation.map((group) => (
        <NavGroup key={group.key} item={group} currentPath={pathname} activePath={activePath} />
      ))}
    </nav>
  );
}

function NavGroup({
  item,
  currentPath,
  activePath,
}: {
  item: NavItem;
  currentPath: string;
  activePath: string | undefined;
}) {
  const children = item.children ?? [];
  const containsCurrent = isActiveGroup(item, currentPath);

  // Seeded from the route, then owned by the user. Deriving `open` from the
  // route on every render instead would mean a group the user deliberately
  // opened to look around in snaps shut the moment they navigate elsewhere,
  // and a group they collapsed springs back open — the state has to survive
  // navigation to be worth having.
  const [open, setOpen] = useState(containsCurrent);

  if (children.length === 0 && item.path) {
    return <NavLink item={item} activePath={activePath} />;
  }

  const panelId = `nav-group-${item.key}`;

  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center justify-between rounded px-3 py-1.5 text-start text-xs font-medium tracking-wide text-(--color-muted) uppercase hover:bg-(--color-canvas) hover:text-(--color-ink)"
      >
        <bdi>{item.label}</bdi>
        {/* Rotates rather than swapping glyph, so the control reads as one
            thing in two states instead of two different controls. `rtl:-scale-x-100`
            keeps it pointing into the panel in a right-to-left layout. */}
        <svg
          viewBox="0 0 12 12"
          aria-hidden="true"
          className={`size-3 shrink-0 transition-transform duration-150 rtl:-scale-x-100 ${
            open ? 'rotate-90' : ''
          }`}
        >
          <path
            d="M4 2.5 L8 6 L4 9.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open ? (
        <div id={panelId} className="mt-0.5 mb-2">
          {children.map((child) => (
            <NavLink key={child.key} item={child} activePath={activePath} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function NavLink({
  item,
  /** The one item that should look current, resolved once for the whole nav. */
  activePath,
}: {
  item: NavItem;
  activePath: string | undefined;
}) {
  if (!item.path) return null;
  const active = item.path === activePath;

  return (
    <Link
      href={item.path}
      aria-current={active ? 'page' : undefined}
      className={[
        'block rounded px-3 py-1.5 text-sm',
        active
          ? 'bg-(--color-accent-soft) font-medium text-(--color-accent)'
          : 'text-(--color-ink) hover:bg-(--color-canvas)',
      ].join(' ')}
    >
      <bdi>{item.label}</bdi>
    </Link>
  );
}

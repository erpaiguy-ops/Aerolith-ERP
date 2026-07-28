import Link from 'next/link';

import { directionFor } from '@/lib/format';
import { activeNavPath, isActiveGroup, type Me, type NavItem } from '@/lib/navigation';
import { Bidi } from './ui';

/**
 * The application shell.
 *
 * Worth stating plainly, because it is the visible half of requirement 19:
 * **this file contains no module names.** The sidebar is whatever `/me` returned,
 * which is the tenant's entitled modules filtered by the user's permissions. A
 * tenant who bought only Estimating sees a focused estimating product; a tenant
 * who bought everything sees an ERP. Same binary, same deployment, same code
 * path — the difference is rows in `kernel.tenant_module`.
 */
export function Shell({
  me,
  currentPath,
  children,
}: {
  me: Me;
  currentPath: string;
  children: React.ReactNode;
}) {
  const dir = directionFor(me.user.locale);
  // Resolved once for the whole sidebar: deciding per item highlights every
  // ancestor that prefix-matches, and the nav then disagrees with itself about
  // where the user is.
  const activePath = activeNavPath(me.navigation, currentPath);

  return (
    // `lang` as well as `dir`. Direction alone gets the layout right and leaves
    // assistive technology reading Arabic with an English voice, and leaves the
    // browser hyphenating by English rules.
    <div lang={me.user.locale} dir={dir} className="flex min-h-screen">
      <aside className="w-60 shrink-0 border-e border-(--color-line) bg-(--color-surface)">
        <div className="flex h-14 items-center border-b border-(--color-line) px-4">
          <span className="text-sm font-semibold tracking-tight">
            <Bidi>Aerolith</Bidi>
          </span>
        </div>

        <nav className="p-2">
          {me.navigation.map((group) => (
            <NavGroup
              key={group.key}
              item={group}
              currentPath={currentPath}
              activePath={activePath}
            />
          ))}
        </nav>

        {me.unavailableModules.length > 0 ? (
          <div className="mx-2 mt-2 rounded border border-(--color-warn)/30 bg-(--color-warn)/5 p-3">
            <p className="text-xs font-medium text-(--color-warn)">
              <Bidi>Not available here</Bidi>
            </p>
            {/* Surfaced rather than swallowed: a tenant entitled to something
                this deployment cannot serve should be told, not left wondering
                why they are paying for an invisible module. */}
            <ul className="mt-1 space-y-0.5 text-xs text-(--color-muted)">
              {me.unavailableModules.map((m) => (
                <li key={m.key}>
                  <Bidi>{m.key}</Bidi>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-(--color-line) bg-(--color-surface) px-6">
          <div className="text-sm text-(--color-muted)">
            {me.tenant.countryCode ? (
              <Bidi>
                {me.tenant.countryCode} · {me.tenant.currencyCode}
              </Bidi>
            ) : null}
          </div>
          <form action="/api/logout" method="post">
            <button type="submit" className="text-sm text-(--color-muted) hover:text-(--color-ink)">
              <Bidi>Sign out</Bidi>
            </button>
          </form>
        </header>

        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>
    </div>
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
  const open = isActiveGroup(item, currentPath);

  if (children.length === 0 && item.path) {
    return <NavLink item={item} activePath={activePath} />;
  }

  return (
    <div className="mb-3">
      <div className="px-3 py-1.5 text-xs font-medium tracking-wide text-(--color-muted) uppercase">
        <Bidi>{item.label}</Bidi>
      </div>
      <div className={open ? '' : ''}>
        {children.map((child) => (
          <NavLink key={child.key} item={child} activePath={activePath} />
        ))}
      </div>
    </div>
  );
}

function NavLink({
  item,
  activePath,
}: {
  item: NavItem;
  /** The one item that should look current, resolved once for the whole nav. */
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
      <Bidi>{item.label}</Bidi>
    </Link>
  );
}

import { directionFor } from '@/lib/format';
import { type Me } from '@/lib/navigation';
import { SidebarNav } from './SidebarNav';
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
  children,
}: {
  me: Me;
  children: React.ReactNode;
}) {
  const dir = directionFor(me.user.locale);

  return (
    // `lang` as well as `dir`. Direction alone gets the layout right and leaves
    // assistive technology reading Arabic with an English voice, and leaves the
    // browser hyphenating by English rules.
    <div lang={me.user.locale} dir={dir} className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col overflow-y-auto border-e border-(--color-line) bg-(--color-surface)">
        <div className="flex h-14 items-center border-b border-(--color-line) px-4">
          <span className="text-sm font-semibold tracking-tight">
            <Bidi>Aerolith</Bidi>
          </span>
        </div>

        {/* A client component: the highlight has to follow the router rather
            than a value captured when this layout last rendered, and groups
            have to collapse. See SidebarNav for why both need the browser. */}
        <SidebarNav navigation={me.navigation} />

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

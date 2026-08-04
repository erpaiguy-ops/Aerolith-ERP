import Link from 'next/link';
import { listEstate, summariseEstate } from '@aerolith/kernel';

import { Card, Stat, StatusPill, day } from '@/lib/ui';
import { audit, database, requireOperator } from '@/lib/session';

// Nothing here may be cached or prerendered: it is a live view of customer
// state, and a cached estate list would also mean an audit entry that did not
// correspond to somebody actually looking.
export const dynamic = 'force-dynamic';

export default async function EstatePage() {
  const operator = await requireOperator();
  const db = await database();

  const [tenants, summary] = await db.transaction(async (tx) => [
    await listEstate(tx),
    await summariseEstate(tx),
  ]);

  // Recorded as one entry describing the screen, with the number of tenants it
  // exposed. "Opened the estate list, 14 customers" is the fact a customer
  // would want answered; three rows saying "ran a select" is not.
  await audit(operator, 'estate.read', { tenantCount: tenants.length });

  const lapsed = summary.trialsExpiring.filter(
    (trial) => String(trial.trialEndsAt).slice(0, 10) < new Date().toISOString().slice(0, 10),
  );

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">The estate</h1>
          <p className="mt-0.5 text-sm text-(--color-muted)">
            Every customer, what they are entitled to, and who is still in a trial.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm text-(--color-muted)">
          <span>{operator.email}</span>
          <form action="/api/logout" method="post">
            <button type="submit" className="hover:text-(--color-ink)">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Customers" value={summary.tenants} />
        <Stat label="Active" value={summary.byStatus.active ?? 0} />
        <Stat label="In trial" value={summary.byStatus.trial ?? 0} />
        {/* Lapsed trials are the number somebody has to act on, so it is a
            headline rather than a row buried in the table. */}
        <Stat label="Trials lapsed" value={lapsed.length} />
      </div>

      <div className="mb-6">
        <Card>
          {tenants.length === 0 ? (
            <p className="py-6 text-center text-sm text-(--color-muted)">
              No customers yet. Create one with <code>pnpm provision create</code>.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-start text-xs text-(--color-muted)">
                    <th className="pb-2 text-start font-medium">Customer</th>
                    <th className="pb-2 text-start font-medium">Status</th>
                    <th className="pb-2 text-end font-medium">Users</th>
                    <th className="pb-2 text-start font-medium">Modules</th>
                    <th className="pb-2 text-start font-medium">Trial ends</th>
                  </tr>
                </thead>
                <tbody>
                  {tenants.map((tenant) => (
                    <tr key={tenant.tenantId} className="border-t border-(--color-line)">
                      <td className="py-2">
                        <Link
                          href={`/tenants/${tenant.tenantId}`}
                          className="font-medium hover:text-(--color-accent)"
                        >
                          {tenant.name}
                        </Link>
                        <span className="numeric block text-xs text-(--color-muted)">
                          {tenant.slug}
                          {tenant.countryCode ? ` · ${tenant.countryCode}` : ''}
                          {tenant.currencyCode ? ` · ${tenant.currencyCode}` : ''}
                        </span>
                      </td>
                      <td className="py-2">
                        <StatusPill status={tenant.status} />
                      </td>
                      <td className="numeric py-2 text-end">{tenant.activeUsers}</td>
                      <td className="py-2 text-xs text-(--color-muted)">
                        {tenant.modules.length === 0
                          ? '—'
                          : tenant.modules.map((m) => m.moduleKey).join(', ')}
                      </td>
                      <td className="numeric py-2 text-xs">{day(tenant.trialEndsAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="Module take-up">
          {summary.moduleTakeUp.length === 0 ? (
            <p className="text-sm text-(--color-muted)">Nothing entitled yet.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {summary.moduleTakeUp.map((module) => (
                <li key={module.moduleKey} className="flex items-baseline justify-between gap-4">
                  <span>{module.moduleKey}</span>
                  <span className="numeric text-xs text-(--color-muted)">
                    {module.enabled} enabled
                    {module.trialling > 0 ? ` · ${module.trialling} trialling` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Trials ending or ended">
          {summary.trialsExpiring.length === 0 ? (
            <p className="text-sm text-(--color-muted)">None in the next fortnight.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {summary.trialsExpiring.map((trial) => {
                const ends = String(trial.trialEndsAt).slice(0, 10);
                const isLapsed = ends < new Date().toISOString().slice(0, 10);
                return (
                  <li key={trial.tenantId} className="flex items-baseline justify-between gap-4">
                    <Link
                      href={`/tenants/${trial.tenantId}`}
                      className="hover:text-(--color-accent)"
                    >
                      {trial.name}
                    </Link>
                    <span
                      className={`numeric text-xs ${isLapsed ? 'text-(--color-bad)' : 'text-(--color-muted)'}`}
                    >
                      {ends}
                      {isLapsed ? ' · lapsed' : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </main>
  );
}

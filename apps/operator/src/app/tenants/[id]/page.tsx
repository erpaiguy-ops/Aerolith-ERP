import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getEstateTenant } from '@aerolith/kernel';

import { Card, Stat, StatusPill, day } from '@/lib/ui';
import { audit, database, requireOperator } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * One customer.
 *
 * Entitlements and lifecycle only — deliberately not their contracts, their
 * projects or their money. The platform role can read all of it, which is
 * precisely why this page does not: "the vendor can technically see everything"
 * and "the vendor's support tool shows everything" are different promises, and
 * only the second one is ours to make. Opening a customer's actual data should
 * be a separate, explicitly-justified screen if it is ever built at all.
 */
export default async function TenantPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const operator = await requireOperator();
  const db = await database();

  const tenant = await db.transaction((tx) => getEstateTenant(tx, id));
  if (!tenant) notFound();

  // Audited with the tenant named. This is the entry that answers "has anyone
  // at the vendor looked at us", so it has to identify who was looked at, not
  // just that a page was opened.
  await audit(operator, 'tenant.read', { tenantId: tenant.tenantId, tenantSlug: tenant.slug });

  const enabled = tenant.modules.filter((m) => m.status === 'enabled');
  const trialling = tenant.modules.filter((m) => m.status === 'trial');
  const other = tenant.modules.filter((m) => !['enabled', 'trial'].includes(m.status));

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <Link href="/" className="text-sm text-(--color-muted) hover:text-(--color-ink)">
        ← The estate
      </Link>

      <header className="mt-4 mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{tenant.name}</h1>
          <p className="numeric mt-0.5 text-sm text-(--color-muted)">
            {tenant.slug}
            {tenant.countryCode ? ` · ${tenant.countryCode}` : ''}
            {tenant.currencyCode ? ` · ${tenant.currencyCode}` : ''}
          </p>
        </div>
        <StatusPill status={tenant.status} />
      </header>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Active users" value={tenant.activeUsers} />
        <Stat label="Modules enabled" value={enabled.length} />
        <Stat label="In trial" value={trialling.length} />
        <Stat label="Customer since" value={day(tenant.createdAt)} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="Entitlements">
          {tenant.modules.length === 0 ? (
            <p className="text-sm text-(--color-muted)">
              Nothing entitled. This customer can sign in and see nothing.
            </p>
          ) : (
            <ul className="space-y-2 text-sm">
              {[...enabled, ...trialling, ...other].map((module) => (
                <li key={module.moduleKey} className="flex items-baseline justify-between gap-4">
                  <span>{module.moduleKey}</span>
                  <span className="text-xs text-(--color-muted)">
                    {module.status}
                    {module.expiresOn ? ` · expires ${day(module.expiresOn)}` : ''}
                    {/* `limits` is the closest thing to a plan the schema holds
                        today. Shown when set rather than hidden behind Stage 3,
                        because a seat cap somebody agreed to is worth seeing. */}
                    {module.limits?.seats ? ` · ${module.limits.seats} seats` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Lifecycle">
          <dl className="space-y-2 text-sm">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-(--color-muted)">Status</dt>
              <dd>{tenant.status}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-(--color-muted)">Trial ends</dt>
              <dd className="numeric">{day(tenant.trialEndsAt)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-(--color-muted)">Tenant id</dt>
              <dd className="numeric text-xs">{tenant.tenantId}</dd>
            </div>
          </dl>

          {/* No buttons. This surface reads; it connects as a role that holds
              SELECT and cannot write a tenant row even if a button existed. The
              commands are given rather than hidden, so the path forward is
              obvious instead of absent. */}
          <div className="mt-4 border-t border-(--color-line) pt-3 text-xs text-(--color-muted)">
            <p className="mb-1">Changing any of this is a command, not a button:</p>
            <code className="numeric block break-all">
              pnpm provision suspend --tenant {tenant.tenantId}
            </code>
          </div>
        </Card>
      </div>
    </main>
  );
}

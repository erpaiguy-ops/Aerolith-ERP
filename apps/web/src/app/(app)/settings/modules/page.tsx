import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, PageHeader } from '@/components/ui';
import { can } from '@/lib/actions';
import { pageFetch } from '@/lib/api';
import { date } from '@/lib/format';
import { getMe } from '@/lib/session';

import { disableModuleAction, enableModuleAction } from './actions';

interface ModuleRow {
  key: string;
  name: string;
  description: string | null;
  category: string;
  version: string;
  sellable: boolean;
  standalone: boolean;
  dependsOn: string[];
  status: string | null;
  enabledAt: string | null;
  expiresOn: string | null;
  requiredBy: string[];
}

/** Statuses that actually grant access — the API's own list, mirrored. */
const ACTIVE = new Set(['enabled', 'trial']);

/**
 * Modules — what this workspace has bought.
 *
 * `kernel.module.manage` was declared from the start and gated nothing:
 * `/modules/catalogue` could list what the deployment ships, `/me` could list
 * what the tenant has, and nothing could move a module between the two. A
 * workspace had exactly the entitlements a SQL script had inserted.
 *
 * One list rather than owned-and-available, because the question being answered
 * is "what could we turn on", and splitting it makes an admin hold both halves
 * in their head to answer it.
 */
export default async function ModulesPage() {
  const me = await getMe();
  const mayManage = can(me.permissions, 'kernel.module.manage') || me.user.isOwner;

  const { modules } = await pageFetch<{ modules: ModuleRow[] }>('/admin/modules');

  const byCategory = new Map<string, ModuleRow[]>();
  for (const module of modules) {
    const list = byCategory.get(module.category) ?? [];
    list.push(module);
    byCategory.set(module.category, list);
  }

  return (
    <>
      <PageHeader
        title="Modules"
        subtitle="What this workspace has access to. Enabling a module creates the document number series it declares."
      />

      <div className="grid gap-4">
        {[...byCategory.entries()].map(([category, rows]) => (
          <Card key={category} title={category.replace(/_/g, ' ')}>
            <div className="grid gap-3">
              {rows.map((module) => {
                const active = module.status !== null && ACTIVE.has(module.status);
                const blockers = module.requiredBy;

                return (
                  <div
                    key={module.key}
                    className="flex flex-wrap items-start justify-between gap-3 border-b border-(--color-line) pb-3 last:border-0 last:pb-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{module.name}</span>
                        <Badge tone={active ? 'good' : 'neutral'}>
                          {module.status ?? 'not enabled'}
                        </Badge>
                        {module.standalone ? <Badge tone="neutral">standalone</Badge> : null}
                        <span className="numeric text-xs text-(--color-muted)">
                          v{module.version}
                        </span>
                      </div>
                      {module.description ? (
                        <p className="mt-1 text-sm text-(--color-muted)">{module.description}</p>
                      ) : null}
                      <p className="mt-1 text-xs text-(--color-muted)">
                        {module.dependsOn.length > 0
                          ? `Needs ${module.dependsOn.join(', ')}. `
                          : ''}
                        {active && module.enabledAt ? `Enabled ${date(module.enabledAt)}.` : ''}
                        {module.expiresOn ? ` Expires ${date(module.expiresOn)}.` : ''}
                      </p>
                      {blockers.length > 0 ? (
                        // Named, not counted. Turning this off would silently
                        // take these with it.
                        <p className="mt-1 text-xs text-(--color-warn)">
                          {`Required by ${blockers.join(', ')} — disable ${blockers.length === 1 ? 'it' : 'those'} first.`}
                        </p>
                      ) : null}
                    </div>

                    {mayManage ? (
                      <div className="shrink-0">
                        {active ? (
                          <ActionForm action={disableModuleAction.bind(null, module.key)}>
                            <SubmitButton pendingLabel="Disabling…">Disable</SubmitButton>
                          </ActionForm>
                        ) : (
                          <ActionForm action={enableModuleAction.bind(null, module.key)}>
                            <SubmitButton pendingLabel="Enabling…">Enable</SubmitButton>
                          </ActionForm>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </Card>
        ))}
      </div>

      <p className="mt-4 text-xs text-(--color-muted)">
        Disabling a module hides it and stops its screens resolving. Nothing is deleted — its records
        stay, and enabling it again brings them back.
      </p>
    </>
  );
}

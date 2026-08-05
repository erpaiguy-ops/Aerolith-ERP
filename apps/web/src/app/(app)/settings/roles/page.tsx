import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, Empty, PageHeader, Stat } from '@/components/ui';
import { can } from '@/lib/actions';
import { pageFetch } from '@/lib/api';
import { integer } from '@/lib/format';
import { getMe } from '@/lib/session';

import { createRoleAction, setRolePermissionsAction } from '../members/actions';

interface Role {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  isApprovalTarget: boolean;
  permissionKeys: string[];
  memberCount: number;
}

interface Permission {
  key: string;
  moduleKey: string;
  label: string;
  description: string | null;
  category: string | null;
  isDangerous: boolean;
}

/**
 * Roles, and the permission matrix behind each one.
 *
 * Permissions are declared by modules and synced into a global catalogue at
 * boot; roles are tenant data. That split is the point: a customer can invent
 * "Assistant Storekeeper" without a deployment, and cannot invent a permission,
 * because a permission key that nothing enforces grants nothing while looking
 * like it grants something.
 *
 * **Only allows are shown.** The schema also supports `deny` rows, conditions
 * and field-level restrictions, and none of them are surfaced here. A tick box
 * cannot express "a deny anywhere beats a grant anywhere", and a screen that
 * silently dropped them would misreport what a role can actually do — which on a
 * permissions screen is the worst possible failure.
 *
 * Grouped by category, not by module: "Administration" and "Settings" are how a
 * person thinks about authority, while `kernel` versus `procurement` is how the
 * code is organised.
 */
export default async function RolesPage() {
  const me = await getMe();
  const mayGrant = can(me.permissions, 'kernel.role.manage') || me.user.isOwner;

  const [{ roles }, { permissions }] = await Promise.all([
    pageFetch<{ roles: Role[] }>('/admin/roles'),
    pageFetch<{ permissions: Permission[] }>('/admin/permissions'),
  ]);

  const byCategory = new Map<string, Permission[]>();
  for (const permission of permissions) {
    const category = permission.category ?? 'Other';
    const list = byCategory.get(category) ?? [];
    list.push(permission);
    byCategory.set(category, list);
  }

  const dangerous = permissions.filter((p) => p.isDangerous).length;
  const unassigned = roles.filter((r) => r.memberCount === 0).length;

  const field =
    'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-3 py-1.5 text-sm outline-none focus:border-(--color-accent)';

  return (
    <>
      <PageHeader
        title="Roles"
        subtitle="What each role may do. Permissions come from the modules; roles are yours."
      />

      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Roles" value={integer(roles.length)} />
          <Stat
            label="Nobody holds"
            value={integer(unassigned)}
            tone={unassigned > 0 ? 'bad' : 'neutral'}
            hint={unassigned > 0 ? 'defined but unused' : undefined}
          />
          <Stat label="Permissions available" value={integer(permissions.length)} />
          <Stat
            label="Marked dangerous"
            value={integer(dangerous)}
            hint="money, authority or statutory settings"
          />
        </div>
      </Card>

      {mayGrant ? (
        <Card className="mb-4">
          <details>
            <summary className="cursor-pointer text-sm font-medium">Create a role</summary>
            <ActionForm action={createRoleAction} className="mt-3">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <label htmlFor="code" className="mb-1 block text-xs text-(--color-muted)">
                    Code
                  </label>
                  <input
                    id="code"
                    name="code"
                    placeholder="STOREKEEPER"
                    className={`${field} uppercase`}
                  />
                </div>
                <div>
                  <label htmlFor="name" className="mb-1 block text-xs text-(--color-muted)">
                    Name
                  </label>
                  <input id="name" name="name" dir="auto" placeholder="Storekeeper" className={field} />
                </div>
                <div>
                  <label htmlFor="description" className="mb-1 block text-xs text-(--color-muted)">
                    Description
                  </label>
                  <input id="description" name="description" dir="auto" className={field} />
                </div>
              </div>
              <label className="mt-3 flex items-center gap-2 text-sm text-(--color-muted)">
                <input type="checkbox" name="isApprovalTarget" value="true" />
                {/* Worth its own tick box: an approval step can route to a role
                    rather than a named person, which is what keeps a workflow
                    working after somebody leaves. */}
                An approval step may be routed to this role
              </label>
              <div className="mt-3">
                <SubmitButton pendingLabel="Creating…">Create</SubmitButton>
              </div>
            </ActionForm>
          </details>
        </Card>
      ) : null}

      {roles.length === 0 ? (
        <Empty
          title="No roles yet"
          detail="Create one, tick what it may do, then give it to somebody on the People page."
        />
      ) : (
        <div className="space-y-4">
          {roles.map((role) => (
            <Card key={role.id}>
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className="font-medium">{role.name}</span>
                  <span className="numeric ms-2 text-xs text-(--color-muted)">{role.code}</span>
                  {role.isSystem ? (
                    <span className="ms-2">
                      <Badge tone="neutral">system</Badge>
                    </span>
                  ) : null}
                  {role.isApprovalTarget ? (
                    <span className="ms-2">
                      <Badge tone="neutral">approval target</Badge>
                    </span>
                  ) : null}
                  {role.description ? (
                    <p className="mt-1 text-sm text-(--color-muted)">{role.description}</p>
                  ) : null}
                </div>
                <span className="text-sm text-(--color-muted)">
                  {`${integer(role.memberCount)} ${role.memberCount === 1 ? 'person' : 'people'} · ${integer(role.permissionKeys.length)} of ${integer(permissions.length)} permissions`}
                </span>
              </div>

              <ActionForm action={setRolePermissionsAction}>
                <input type="hidden" name="roleId" value={role.id} />

                <div className="space-y-4">
                  {[...byCategory.entries()].map(([category, list]) => (
                    <fieldset key={category}>
                      <legend className="mb-1.5 text-xs font-medium uppercase tracking-wide text-(--color-muted)">
                        {category}
                      </legend>
                      <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
                        {list.map((permission) => (
                          <label
                            key={permission.key}
                            className="flex items-start gap-2 text-sm"
                            title={permission.description ?? undefined}
                          >
                            <input
                              type="checkbox"
                              name="permissionKeys"
                              value={permission.key}
                              defaultChecked={role.permissionKeys.includes(permission.key)}
                              disabled={!mayGrant}
                              className="mt-1"
                            />
                            <span>
                              <span className="block">
                                {permission.label}
                                {permission.isDangerous ? (
                                  <span className="ms-1.5">
                                    <Badge tone="bad">care</Badge>
                                  </span>
                                ) : null}
                              </span>
                              {/* The key, because it is what appears in the code,
                                  in a support question and in an audit log. */}
                              <span className="numeric block text-xs text-(--color-muted)">
                                {permission.key}
                              </span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ))}
                </div>

                {mayGrant ? (
                  <div className="mt-4">
                    <SubmitButton pendingLabel="Saving…">Save permissions</SubmitButton>
                  </div>
                ) : null}
              </ActionForm>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

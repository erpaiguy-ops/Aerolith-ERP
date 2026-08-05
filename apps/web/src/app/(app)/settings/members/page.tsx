import { ActionForm, SubmitButton } from '@/components/Action';
import { Badge, Card, PageHeader, Stat, Table, Td, Th } from '@/components/ui';
import { can } from '@/lib/actions';
import { pageFetch } from '@/lib/api';
import { date, integer } from '@/lib/format';
import { getMe } from '@/lib/session';

import { addMemberAction, setOwnerAction, setRolesAction, setStatusAction } from './actions';

interface Member {
  userId: string;
  email: string;
  name: string;
  status: string;
  isOwner: boolean;
  lastLoginAt: string | null;
  joinedAt: string | null;
  hasPassword: boolean;
  roles: { id: string; code: string; name: string }[];
}

interface Role {
  id: string;
  code: string;
  name: string;
  memberCount: number;
  permissionKeys: string[];
}

const STATUS_TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  active: 'good',
  invited: 'neutral',
  suspended: 'bad',
  removed: 'bad',
};

/**
 * The people in this workspace.
 *
 * Until now there were exactly as many users as a SQL script had inserted. The
 * RBAC schema, the services and 76 synced permissions were all there; nothing
 * could reach them, which made every permission gate in the rest of the
 * application untestable against a real non-owner.
 *
 * **Owner is called out, not buried in a list of roles.** An owner bypasses the
 * permission matrix completely — `requirePermission` returns early for them —
 * so it is not a role with a lot of ticks, it is the absence of checking. A
 * screen that renders it as one more badge teaches the wrong thing about it.
 */
export default async function MembersPage() {
  const me = await getMe();
  const mayManage = can(me.permissions, 'kernel.user.manage') || me.user.isOwner;
  const mayGrant = can(me.permissions, 'kernel.role.manage') || me.user.isOwner;

  const [{ members }, { roles }] = await Promise.all([
    pageFetch<{ members: Member[] }>('/admin/members'),
    pageFetch<{ roles: Role[] }>('/admin/roles'),
  ]);

  const active = members.filter((m) => m.status === 'active');
  const owners = active.filter((m) => m.isOwner);
  const withoutRoles = active.filter((m) => !m.isOwner && m.roles.length === 0);

  const field =
    'w-full rounded-md border border-(--color-line) bg-(--color-surface) px-3 py-1.5 text-sm outline-none focus:border-(--color-accent)';

  return (
    <>
      <PageHeader
        title="People"
        subtitle="Who can sign in to this workspace, and what they are allowed to do."
      />

      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Active" value={integer(active.length)} />
          <Stat
            label="Owners"
            value={integer(owners.length)}
            hint="bypass every permission check"
            tone={owners.length > 2 ? 'bad' : 'neutral'}
          />
          <Stat label="Roles" value={integer(roles.length)} />
          <Stat
            label="No role at all"
            value={integer(withoutRoles.length)}
            // Not an error, but almost always a mistake: they can sign in, and
            // the navigation will be empty because every entry is gated.
            tone={withoutRoles.length > 0 ? 'bad' : 'neutral'}
            hint={withoutRoles.length > 0 ? 'they will see an empty app' : undefined}
          />
        </div>
      </Card>

      {mayManage ? (
        <Card className="mb-4">
          <details>
            <summary className="cursor-pointer text-sm font-medium">Add somebody</summary>

            <p className="mt-3 text-sm text-(--color-muted)">
              {/* Honest about what this does. Pretending an invitation email went
                  out when no mail transport is configured is how somebody waits
                  three days for a link that was never sent. */}
              No invitation email is sent — this deployment has no mail transport
              configured. Set an initial password here and give it to them directly. If the
              address already has an account, that account is added to this workspace and its
              password is left alone.
            </p>

            <ActionForm action={addMemberAction} className="mt-3">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <label htmlFor="name" className="mb-1 block text-xs text-(--color-muted)">
                    Name
                  </label>
                  <input id="name" name="name" dir="auto" className={field} />
                </div>
                <div>
                  <label htmlFor="email" className="mb-1 block text-xs text-(--color-muted)">
                    Email
                  </label>
                  <input id="email" name="email" type="email" className={field} />
                </div>
                <div>
                  <label htmlFor="password" className="mb-1 block text-xs text-(--color-muted)">
                    Initial password (12 characters or more)
                  </label>
                  <input id="password" name="password" className={field} />
                </div>
              </div>

              {mayGrant && roles.length > 0 ? (
                <fieldset className="mt-3">
                  <legend className="mb-1 text-xs text-(--color-muted)">Roles</legend>
                  <div className="flex flex-wrap gap-3">
                    {roles.map((role) => (
                      <label key={role.id} className="flex items-center gap-1.5 text-sm">
                        <input type="checkbox" name="roleIds" value={role.id} />
                        {role.name}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}

              <div className="mt-3">
                <SubmitButton pendingLabel="Adding…">Add</SubmitButton>
              </div>
            </ActionForm>
          </details>
        </Card>
      ) : null}

      <Card>
        <Table
          head={
            <tr>
              <Th>Person</Th>
              <Th>Status</Th>
              <Th>Roles</Th>
              <Th>Last signed in</Th>
              {mayManage ? <Th /> : null}
            </tr>
          }
        >
          {members.map((member) => {
            const isSelf = member.userId === me.user.id;
            return (
              <tr key={member.userId} className="align-top">
                <Td>
                  <span className="block">{member.name}</span>
                  <span className="block text-xs text-(--color-muted)">{member.email}</span>
                  {!member.hasPassword ? (
                    <span className="mt-0.5 block">
                      <Badge tone="bad">no password set</Badge>
                    </span>
                  ) : null}
                </Td>
                <Td>
                  <Badge tone={STATUS_TONE[member.status] ?? 'neutral'}>{member.status}</Badge>
                  {member.isOwner ? (
                    <span className="mt-0.5 block">
                      {/* Deliberately loud. This is not "a role with everything
                          ticked" — it is the permission matrix not running. */}
                      <Badge tone="bad">owner · bypasses all checks</Badge>
                    </span>
                  ) : null}
                  {isSelf ? (
                    <span className="mt-0.5 block text-xs text-(--color-muted)">you</span>
                  ) : null}
                </Td>
                <Td>
                  {member.isOwner ? (
                    <span className="text-xs text-(--color-muted)">
                      Roles do not restrict an owner.
                    </span>
                  ) : mayGrant ? (
                    <ActionForm action={setRolesAction}>
                      <input type="hidden" name="userId" value={member.userId} />
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        {roles.map((role) => (
                          <label key={role.id} className="flex items-center gap-1.5 text-sm">
                            <input
                              type="checkbox"
                              name="roleIds"
                              value={role.id}
                              defaultChecked={member.roles.some((r) => r.id === role.id)}
                            />
                            {role.name}
                          </label>
                        ))}
                      </div>
                      <div className="mt-2">
                        <SubmitButton pendingLabel="Saving…">Save roles</SubmitButton>
                      </div>
                    </ActionForm>
                  ) : member.roles.length > 0 ? (
                    <span className="flex flex-wrap gap-1">
                      {member.roles.map((role) => (
                        <Badge key={role.id} tone="neutral">
                          {role.name}
                        </Badge>
                      ))}
                    </span>
                  ) : (
                    <span className="text-(--color-muted)">—</span>
                  )}
                </Td>
                <Td>
                  <span className="block">{date(member.lastLoginAt)}</span>
                  {member.joinedAt ? (
                    <span className="block text-xs text-(--color-muted)">
                      {`joined ${date(member.joinedAt)}`}
                    </span>
                  ) : null}
                </Td>
                {mayManage ? (
                  <Td>
                    <div className="flex flex-col items-start gap-2">
                      {member.status === 'active' ? (
                        <ActionForm action={setStatusAction}>
                          <input type="hidden" name="userId" value={member.userId} />
                          <input type="hidden" name="status" value="suspended" />
                          <SubmitButton tone="danger" pendingLabel="Suspending…">
                            {isSelf ? 'Suspend (you)' : 'Suspend'}
                          </SubmitButton>
                        </ActionForm>
                      ) : (
                        <ActionForm action={setStatusAction}>
                          <input type="hidden" name="userId" value={member.userId} />
                          <input type="hidden" name="status" value="active" />
                          <SubmitButton pendingLabel="Reinstating…">Reinstate</SubmitButton>
                        </ActionForm>
                      )}

                      {mayGrant && !isSelf ? (
                        <ActionForm action={setOwnerAction}>
                          <input type="hidden" name="userId" value={member.userId} />
                          <input
                            type="hidden"
                            name="isOwner"
                            value={member.isOwner ? 'false' : 'true'}
                          />
                          <SubmitButton
                            tone={member.isOwner ? 'normal' : 'danger'}
                            pendingLabel="Saving…"
                          >
                            {member.isOwner ? 'Remove owner' : 'Make owner'}
                          </SubmitButton>
                        </ActionForm>
                      ) : null}
                    </div>
                  </Td>
                ) : null}
              </tr>
            );
          })}
        </Table>
      </Card>
    </>
  );
}

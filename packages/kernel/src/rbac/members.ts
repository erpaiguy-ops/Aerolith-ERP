/**
 * Members and roles — the administration a workspace has to be able to do
 * itself.
 *
 * Everything below the surface already existed: `role`, `role_permission`,
 * `user_role` and `membership` have been in the schema since the first
 * migration, and 76 permissions are synced into the catalogue at every boot.
 * What did not exist was any way to use them, so a workspace had exactly the
 * users a SQL script had inserted.
 *
 * Two boundaries are worth naming, because they are not the same boundary:
 *
 * - `app_user` is GLOBAL. Email is unique across the whole deployment, and
 *   authentication reads it before any tenant is known, so it carries no RLS.
 * - `membership`, `role`, `role_permission` and `user_role` are tenant-scoped
 *   and RLS-guarded. The tenant boundary on a member list therefore comes from
 *   `membership`, never from `app_user`.
 *
 * That distinction is why adding a member is not simply "create a user".
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { hashPassword } from '../auth/password';
import { type Transaction } from '../db';
import * as schema from '../db/schema';
import { requireTenantContext } from '../tenancy/context';

export class MemberError extends Error {
  override readonly name = 'MemberError';
}

export interface MemberRow {
  userId: string;
  email: string;
  name: string;
  status: string;
  isOwner: boolean;
  locale: string;
  lastLoginAt: string | null;
  invitedAt: string | null;
  joinedAt: string | null;
  /** Whether the account has a password at all. Null means SSO-only or unset. */
  hasPassword: boolean;
  roles: { id: string; code: string; name: string }[];
}

/** Everyone in this workspace, with the roles they hold. */
export async function listMembers(tx: Transaction): Promise<MemberRow[]> {
  const { tenantId } = requireTenantContext();

  const rows = await tx
    .select({
      userId: schema.membership.userId,
      email: schema.appUser.email,
      name: schema.appUser.name,
      status: schema.membership.status,
      isOwner: schema.membership.isOwner,
      locale: schema.appUser.locale,
      lastLoginAt: sql<string | null>`${schema.appUser.lastLoginAt}`,
      invitedAt: sql<string | null>`${schema.membership.invitedAt}`,
      joinedAt: sql<string | null>`${schema.membership.joinedAt}`,
      hasPassword: sql<boolean>`${schema.appUser.passwordHash} is not null`,
    })
    .from(schema.membership)
    .innerJoin(schema.appUser, eq(schema.appUser.id, schema.membership.userId))
    .where(eq(schema.membership.tenantId, tenantId))
    .orderBy(asc(schema.appUser.name));

  if (rows.length === 0) return [];

  const assignments = await tx
    .select({
      userId: schema.userRole.userId,
      id: schema.role.id,
      code: schema.role.code,
      name: schema.role.name,
    })
    .from(schema.userRole)
    .innerJoin(schema.role, eq(schema.role.id, schema.userRole.roleId))
    .where(eq(schema.userRole.tenantId, tenantId));

  const byUser = new Map<string, { id: string; code: string; name: string }[]>();
  for (const row of assignments) {
    const list = byUser.get(row.userId) ?? [];
    list.push({ id: row.id, code: row.code, name: row.name });
    byUser.set(row.userId, list);
  }

  return rows.map((row) => ({ ...row, roles: byUser.get(row.userId) ?? [] }));
}

export interface AddMemberInput {
  email: string;
  name: string;
  /**
   * The initial password, handed to the person by whoever added them.
   *
   * Not an emailed invitation link, and the reason is worth stating rather than
   * hiding: this deployment has no mail transport configured, so an invitation
   * email would be a link nobody receives. A token table without a way to
   * deliver the token is a flow that cannot complete. When SMTP is wired, this
   * becomes the fallback and `membership.status = 'invited'` — which the enum
   * already has — becomes the normal path.
   */
  password?: string;
  roleIds?: string[];
  isOwner?: boolean;
}

export interface AddMemberResult {
  userId: string;
  /** True when this email had no account anywhere before. */
  accountCreated: boolean;
}

/**
 * Adds somebody to this workspace.
 *
 * The email may already belong to an account — someone who works for two
 * companies that both use this product has one login. In that case the existing
 * user is ATTACHED, and their name and password are left alone: a tenant admin
 * adding a colleague must not be able to rename or re-credential an account that
 * is not theirs.
 *
 * The result does not tell the caller which path was taken in any way they could
 * act on, because "does this email already have an account here" is a fact about
 * the whole deployment rather than about this workspace. Being already a member
 * of THIS workspace is different — that is tenant-local, the admin is entitled
 * to know it, and it throws.
 */
export async function addMember(
  tx: Transaction,
  input: AddMemberInput,
): Promise<AddMemberResult> {
  const { tenantId, userId: actorId } = requireTenantContext();
  const email = input.email.trim().toLowerCase();

  if (!email.includes('@')) throw new MemberError('That is not an email address.');
  if (!input.name.trim()) throw new MemberError('A name is required.');

  const [existing] = await tx
    .select({ id: schema.appUser.id })
    .from(schema.appUser)
    .where(eq(schema.appUser.email, email))
    .limit(1);

  let userId = existing?.id;
  const accountCreated = !existing;

  if (!existing) {
    if (!input.password || input.password.length < 12) {
      throw new MemberError('Set an initial password of at least 12 characters.');
    }
    const [created] = await tx
      .insert(schema.appUser)
      .values({
        email,
        name: input.name.trim(),
        passwordHash: await hashPassword(input.password),
      })
      .returning({ id: schema.appUser.id });
    userId = created!.id;
  }

  const [already] = await tx
    .select({ id: schema.membership.id, status: schema.membership.status })
    .from(schema.membership)
    .where(
      and(eq(schema.membership.tenantId, tenantId), eq(schema.membership.userId, userId!)),
    )
    .limit(1);

  if (already) {
    // Reinstating somebody who was removed is a normal thing to want; being told
    // "already a member" when they are suspended is not helpful.
    if (already.status === 'active') {
      throw new MemberError('That person is already a member of this workspace.');
    }
    await tx
      .update(schema.membership)
      .set({ status: 'active', updatedAt: new Date() })
      .where(eq(schema.membership.id, already.id));
  } else {
    await tx.insert(schema.membership).values({
      tenantId,
      userId: userId!,
      // Active, not invited: with no mail transport there is nothing for them to
      // accept. The status stays in the enum for when there is.
      status: 'active',
      isOwner: input.isOwner ?? false,
      invitedBy: actorId,
      invitedAt: new Date(),
      joinedAt: new Date(),
    });
  }

  if (input.roleIds?.length) await setMemberRoles(tx, userId!, input.roleIds);

  return { userId: userId!, accountCreated };
}

/**
 * Replaces a member's roles with exactly this set.
 *
 * Replace rather than add: a screen with tick boxes means "these are their
 * roles", and an add-only endpoint behind it silently ignores every unticked
 * box, which is the worst possible reading of a permissions screen.
 */
export async function setMemberRoles(
  tx: Transaction,
  userId: string,
  roleIds: string[],
): Promise<void> {
  const { tenantId, userId: actorId } = requireTenantContext();

  if (roleIds.length > 0) {
    // Roles are tenant-scoped and RLS would hide another tenant's row anyway,
    // but an id that resolves to nothing must fail loudly rather than quietly
    // grant fewer roles than the admin ticked.
    const found = await tx
      .select({ id: schema.role.id })
      .from(schema.role)
      .where(and(eq(schema.role.tenantId, tenantId), inArray(schema.role.id, roleIds)));

    if (found.length !== new Set(roleIds).size) {
      throw new MemberError('One of those roles does not exist in this workspace.');
    }
  }

  await tx
    .delete(schema.userRole)
    .where(and(eq(schema.userRole.tenantId, tenantId), eq(schema.userRole.userId, userId)));

  if (roleIds.length > 0) {
    await tx.insert(schema.userRole).values(
      [...new Set(roleIds)].map((roleId) => ({
        tenantId,
        userId,
        roleId,
        grantedBy: actorId,
      })),
    );
  }
}

/**
 * Suspends, reinstates or removes a member.
 *
 * The last owner cannot be demoted or removed. A workspace with no owner is one
 * nobody can administer — the permission matrix is the only way back in, and
 * granting `kernel.role.manage` requires somebody who already has it.
 */
export async function setMemberStatus(
  tx: Transaction,
  userId: string,
  changes: { status?: 'active' | 'suspended' | 'removed'; isOwner?: boolean },
): Promise<void> {
  const { tenantId } = requireTenantContext();

  const [member] = await tx
    .select({ id: schema.membership.id, isOwner: schema.membership.isOwner })
    .from(schema.membership)
    .where(and(eq(schema.membership.tenantId, tenantId), eq(schema.membership.userId, userId)))
    .limit(1);

  if (!member) throw new MemberError('That person is not a member of this workspace.');

  const losingOwner =
    member.isOwner && (changes.isOwner === false || changes.status === 'removed' || changes.status === 'suspended');

  if (losingOwner) {
    const [counted] = await tx
      .select({ owners: sql<number>`count(*)::int` })
      .from(schema.membership)
      .where(
        and(
          eq(schema.membership.tenantId, tenantId),
          eq(schema.membership.isOwner, true),
          eq(schema.membership.status, 'active'),
        ),
      );

    if ((counted?.owners ?? 0) <= 1) {
      throw new MemberError(
        'This is the last owner. Make somebody else an owner first, or the workspace ' +
          'becomes one nobody can administer.',
      );
    }
  }

  await tx
    .update(schema.membership)
    .set({
      ...(changes.status ? { status: changes.status } : {}),
      ...(changes.isOwner === undefined ? {} : { isOwner: changes.isOwner }),
      updatedAt: new Date(),
    })
    .where(eq(schema.membership.id, member.id));

  // A removed or suspended member keeps a live session until it expires
  // otherwise, which makes "removed" a statement of intent rather than a control.
  if (changes.status === 'removed' || changes.status === 'suspended') {
    await tx
      .update(schema.session)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.session.userId, userId), eq(schema.session.tenantId, tenantId)));
  }
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export interface RoleRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  isApprovalTarget: boolean;
  permissionKeys: string[];
  memberCount: number;
}

export async function listRoles(tx: Transaction): Promise<RoleRow[]> {
  const { tenantId } = requireTenantContext();

  const roles = await tx
    .select({
      id: schema.role.id,
      code: schema.role.code,
      name: schema.role.name,
      description: schema.role.description,
      isSystem: schema.role.isSystem,
      isApprovalTarget: schema.role.isApprovalTarget,
    })
    .from(schema.role)
    .where(eq(schema.role.tenantId, tenantId))
    .orderBy(asc(schema.role.name));

  if (roles.length === 0) return [];

  const grants = await tx
    .select({ roleId: schema.rolePermission.roleId, key: schema.rolePermission.permissionKey })
    .from(schema.rolePermission)
    .where(
      and(
        eq(schema.rolePermission.tenantId, tenantId),
        // Only allows. Denies exist in the schema and are deliberately not
        // surfaced yet: a tick box cannot express "deny beats allow everywhere",
        // and a UI that silently drops them would misreport what a role can do.
        eq(schema.rolePermission.effect, 'allow'),
      ),
    );

  const counts = await tx
    .select({ roleId: schema.userRole.roleId, members: sql<number>`count(*)::int` })
    .from(schema.userRole)
    .where(eq(schema.userRole.tenantId, tenantId))
    .groupBy(schema.userRole.roleId);

  const keysByRole = new Map<string, string[]>();
  for (const grant of grants) {
    const list = keysByRole.get(grant.roleId) ?? [];
    list.push(grant.key);
    keysByRole.set(grant.roleId, list);
  }
  const countByRole = new Map(counts.map((c) => [c.roleId, c.members]));

  return roles.map((role) => ({
    ...role,
    permissionKeys: (keysByRole.get(role.id) ?? []).sort(),
    memberCount: countByRole.get(role.id) ?? 0,
  }));
}

export async function createRole(
  tx: Transaction,
  input: { code: string; name: string; description?: string | null; isApprovalTarget?: boolean },
): Promise<{ roleId: string }> {
  const { tenantId } = requireTenantContext();

  const code = input.code.trim().toUpperCase().replace(/\s+/g, '_');
  if (!/^[A-Z0-9_]{2,64}$/.test(code)) {
    throw new MemberError('A role code is 2–64 letters, digits or underscores.');
  }
  if (!input.name.trim()) throw new MemberError('A role name is required.');

  const [clash] = await tx
    .select({ id: schema.role.id })
    .from(schema.role)
    .where(and(eq(schema.role.tenantId, tenantId), eq(schema.role.code, code)))
    .limit(1);
  if (clash) throw new MemberError(`A role with the code ${code} already exists.`);

  const [created] = await tx
    .insert(schema.role)
    .values({
      tenantId,
      code,
      name: input.name.trim(),
      description: input.description ?? null,
      isApprovalTarget: input.isApprovalTarget ?? false,
    })
    .returning({ id: schema.role.id });

  return { roleId: created!.id };
}

/**
 * Replaces a role's permissions with exactly this set.
 *
 * Unknown keys are rejected rather than stored. A permission key that no module
 * declares grants nothing and looks like it grants something, which is the
 * failure mode of every permissions screen that accepts free text.
 */
export async function setRolePermissions(
  tx: Transaction,
  roleId: string,
  permissionKeys: string[],
): Promise<void> {
  const { tenantId } = requireTenantContext();

  const [role] = await tx
    .select({ id: schema.role.id })
    .from(schema.role)
    .where(and(eq(schema.role.tenantId, tenantId), eq(schema.role.id, roleId)))
    .limit(1);
  if (!role) throw new MemberError('That role does not exist in this workspace.');

  const keys = [...new Set(permissionKeys)];

  if (keys.length > 0) {
    const known = await tx
      .select({ key: schema.permission.key })
      .from(schema.permission)
      .where(inArray(schema.permission.key, keys));

    if (known.length !== keys.length) {
      const found = new Set(known.map((k) => k.key));
      const unknown = keys.filter((k) => !found.has(k));
      throw new MemberError(`No module declares ${unknown.join(', ')}.`);
    }
  }

  await tx
    .delete(schema.rolePermission)
    .where(
      and(
        eq(schema.rolePermission.tenantId, tenantId),
        eq(schema.rolePermission.roleId, roleId),
        eq(schema.rolePermission.effect, 'allow'),
      ),
    );

  if (keys.length > 0) {
    await tx.insert(schema.rolePermission).values(
      keys.map((permissionKey) => ({ tenantId, roleId, permissionKey, effect: 'allow' as const })),
    );
  }
}

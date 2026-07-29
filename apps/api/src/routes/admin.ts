/**
 * Workspace administration — members, roles and the permission catalogue.
 *
 * Everything here was already in the kernel and unreachable: the schema, the
 * services and 76 synced permissions existed, and a workspace had exactly the
 * users a SQL script had inserted.
 *
 * The permission gates are the ones the kernel already declares —
 * `kernel.user.read`, `kernel.user.manage`, `kernel.role.manage` — which until
 * now had never been checked anywhere, because nothing asked for them.
 */
import {
  MemberError,
  addMember,
  createRole,
  listMembers,
  listRoles,
  schema,
  setMemberRoles,
  setMemberStatus,
  setRolePermissions,
  withTenant,
} from '@aerolith/kernel';
import { asc } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { authenticate, requirePermission, withPrincipal } from '../context';

const memberBody = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(12).optional(),
  roleIds: z.array(z.string().uuid()).optional(),
  isOwner: z.boolean().optional(),
});

const memberPatch = z.object({
  status: z.enum(['active', 'suspended', 'removed']).optional(),
  isOwner: z.boolean().optional(),
  roleIds: z.array(z.string().uuid()).optional(),
});

const roleBody = z.object({
  code: z.string().min(2).max(64),
  name: z.string().min(1),
  description: z.string().nullish(),
  isApprovalTarget: z.boolean().optional(),
  permissionKeys: z.array(z.string()).optional(),
});

const rolePatch = z.object({
  permissionKeys: z.array(z.string()),
});

/** A `MemberError` is a user error, not a fault: 409 with its own sentence. */
function asConflict(error: unknown, reply: FastifyReply): FastifyReply | never {
  if (error instanceof MemberError) return reply.code(409).send({ error: error.message });
  throw error;
}

export async function adminRoutes(app: FastifyInstance) {
  // --- Members ------------------------------------------------------------

  app.get('/admin/members', async (request) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.user.read');

    return withPrincipal(principal, () =>
      withTenant(async (tx) => ({ members: await listMembers(tx) })),
    );
  });

  app.post('/admin/members', async (request, reply) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.user.manage');

    const parsed = memberBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    // Making somebody an owner hands over the whole workspace — an owner
    // bypasses the permission matrix entirely. Managing users is not the same
    // authority as granting that, so it needs the role permission too.
    if (parsed.data.isOwner) requirePermission(principal, 'kernel.role.manage');

    try {
      return await withPrincipal(principal, () =>
        withTenant((tx) => addMember(tx, parsed.data)),
      );
    } catch (error) {
      return asConflict(error, reply);
    }
  });

  app.patch<{ Params: { userId: string } }>(
    '/admin/members/:userId',
    async (request, reply) => {
      const principal = await authenticate(request);
      requirePermission(principal, 'kernel.user.manage');

      const parsed = memberPatch.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
      }

      if (parsed.data.isOwner !== undefined) requirePermission(principal, 'kernel.role.manage');
      // Changing who holds which role IS changing what they may do, so it takes
      // the same authority as editing a role.
      if (parsed.data.roleIds) requirePermission(principal, 'kernel.role.manage');

      // Suspending yourself locks you out of the screen you did it on, and
      // removing your own last owner flag is caught deeper but reads better here.
      if (
        request.params.userId === principal.userId &&
        (parsed.data.status === 'suspended' || parsed.data.status === 'removed')
      ) {
        return reply.code(409).send({ error: 'You cannot suspend or remove yourself.' });
      }

      try {
        return await withPrincipal(principal, () =>
          withTenant(async (tx) => {
            if (parsed.data.status !== undefined || parsed.data.isOwner !== undefined) {
              await setMemberStatus(tx, request.params.userId, {
                status: parsed.data.status,
                isOwner: parsed.data.isOwner,
              });
            }
            if (parsed.data.roleIds) {
              await setMemberRoles(tx, request.params.userId, parsed.data.roleIds);
            }
            return { ok: true };
          }),
        );
      } catch (error) {
        return asConflict(error, reply);
      }
    },
  );

  // --- Roles --------------------------------------------------------------

  app.get('/admin/roles', async (request) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.user.read');

    return withPrincipal(principal, () =>
      withTenant(async (tx) => ({ roles: await listRoles(tx) })),
    );
  });

  app.post('/admin/roles', async (request, reply) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.role.manage');

    const parsed = roleBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      return await withPrincipal(principal, () =>
        withTenant(async (tx) => {
          const { roleId } = await createRole(tx, parsed.data);
          if (parsed.data.permissionKeys?.length) {
            await setRolePermissions(tx, roleId, parsed.data.permissionKeys);
          }
          return { roleId };
        }),
      );
    } catch (error) {
      return asConflict(error, reply);
    }
  });

  app.patch<{ Params: { id: string } }>('/admin/roles/:id', async (request, reply) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.role.manage');

    const parsed = rolePatch.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      return await withPrincipal(principal, () =>
        withTenant(async (tx) => {
          await setRolePermissions(tx, request.params.id, parsed.data.permissionKeys);
          return { ok: true };
        }),
      );
    } catch (error) {
      return asConflict(error, reply);
    }
  });

  /**
   * The permission catalogue.
   *
   * Global, not tenant-scoped: it is what the compiled-in modules declare, and
   * it is the same list for everybody. Grouped by category rather than by
   * module, because "Administration" and "Settings" are how a person thinks
   * about authority, while `kernel` versus `procurement` is how the code is
   * organised. The module is still on each row for the ones where it matters.
   */
  app.get('/admin/permissions', async (request) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.user.read');

    return withPrincipal(principal, () =>
      withTenant(async (tx) => {
        const permissions = await tx
          .select({
            key: schema.permission.key,
            moduleKey: schema.permission.moduleKey,
            label: schema.permission.label,
            description: schema.permission.description,
            category: schema.permission.category,
            isDangerous: schema.permission.isDangerous,
          })
          .from(schema.permission)
          .orderBy(asc(schema.permission.category), asc(schema.permission.key));

        return { permissions };
      }),
    );
  });
}

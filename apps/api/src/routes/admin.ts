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
  AUDIT_LOG_SORTS,
  MemberError,
  NumberSeriesError,
  addMember,
  createRole,
  listAuditActions,
  listAuditEntityTypes,
  listAuditEvents,
  listMembers,
  listNumberSeries,
  listRoles,
  parseListParams,
  schema,
  setMemberRoles,
  setMemberStatus,
  setRolePermissions,
  updateNumberSeries,
  withTenant,
} from '@aerolith/kernel';
import { asc } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { authenticate, requirePermission, withPrincipal } from '../context';

interface AuditQuery {
  page?: string;
  pageSize?: string;
  sort?: string;
  direction?: string;
  q?: string;
  entityType?: string;
  action?: string;
  actorId?: string;
}

const AUDIT_ACTIONS = new Set(schema.auditAction.enumValues as readonly string[]);

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

/**
 * `code` and `entityType` are deliberately absent.
 *
 * They are the identity a module's manifest declares and `allocateNumber`
 * looks a series up by — renaming either from a settings screen would silently
 * detach the series from the documents that ask for it, and the next purchase
 * order would fail to find a series at all. Everything editable here changes
 * how a number LOOKS, not which series answers for what.
 */
const numberSeriesBody = z.object({
  name: z.string().min(1).optional(),
  pattern: z.string().min(1).optional(),
  prefix: z.string().max(16).nullish(),
  suffix: z.string().max(16).nullish(),
  padding: z.number().int().min(1).max(12).optional(),
  increment: z.number().int().min(1).optional(),
  nextValue: z.number().int().min(1).optional(),
  isGapless: z.boolean().optional(),
  isActive: z.boolean().optional(),
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

  // --- Audit trail ---------------------------------------------------------

  /**
   * The audit trail, browsable rather than merely written.
   *
   * `entityHistory`/`actorActivity` in the kernel have existed since the first
   * migration and every mutation across five modules already calls
   * `recordAudit` — the table is full. Nothing before this route could read it
   * back except a raw SQL client.
   */
  app.get<{ Querystring: AuditQuery }>('/admin/audit', async (request) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.audit.read');

    const action =
      request.query.action && AUDIT_ACTIONS.has(request.query.action)
        ? (request.query.action as (typeof schema.auditAction.enumValues)[number])
        : undefined;

    const params = parseListParams(request.query, {
      sortable: AUDIT_LOG_SORTS,
      defaultSort: 'occurredAt',
      defaultDirection: 'desc',
    });

    return withPrincipal(principal, () =>
      withTenant(async (tx) => ({
        ...(await listAuditEvents(tx, params, {
          entityType: request.query.entityType,
          action,
          actorId: request.query.actorId,
        })),
        entityTypes: await listAuditEntityTypes(tx),
        actions: await listAuditActions(tx),
      })),
    );
  });

  // --- Number series ---------------------------------------------------------

  app.get('/admin/number-series', async (request) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.number_series.manage');

    return withPrincipal(principal, () =>
      withTenant(async (tx) => ({ series: await listNumberSeries(tx) })),
    );
  });

  app.patch<{ Params: { id: string } }>('/admin/number-series/:id', async (request, reply) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.number_series.manage');

    const parsed = numberSeriesBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      await withPrincipal(principal, () =>
        withTenant((tx) => updateNumberSeries(tx, { seriesId: request.params.id, ...parsed.data })),
      );
    } catch (error) {
      // 409, not 400: rewinding a counter or un-gapling a series is a
      // well-formed request that conflicts with numbers already issued.
      if (error instanceof NumberSeriesError) return reply.code(409).send({ error: error.message });
      throw error;
    }

    return { updated: true };
  });
}

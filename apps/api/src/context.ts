/**
 * Request authentication and tenant resolution.
 *
 * Every authenticated route runs inside a TenantContext, which is what the RLS
 * guard, the audit logger and the event bus all read from. A route that somehow
 * escapes it will fail loudly at `requireTenantContext()` rather than quietly
 * operating on the wrong tenant.
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  runWithTenantContext,
  schema,
  withTenantId,
  withoutTenantGuard,
  type TenantContext,
} from '@aerolith/kernel';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';

export class UnauthorizedError extends Error {
  readonly statusCode = 401;
  override readonly name = 'UnauthorizedError';
}

export class ForbiddenError extends Error {
  readonly statusCode = 403;
  override readonly name = 'ForbiddenError';
  constructor(permission: string) {
    super(`Missing permission: ${permission}`);
  }
}

export interface Principal {
  context: TenantContext;
  userId: string;
  isOwner: boolean;
}

/**
 * Resolves the session token to a user, tenant and permission set.
 *
 * The token is stored hashed, so a database leak does not hand over live
 * sessions.
 */
export async function authenticate(request: FastifyRequest): Promise<Principal> {
  const token = bearerToken(request);
  if (!token) throw new UnauthorizedError('No session token supplied.');

  const tokenHash = createHash('sha256').update(token).digest('hex');

  const rows = await withoutTenantGuard(async (tx) =>
    tx
      .select({
        session: schema.session,
        user: schema.appUser,
      })
      .from(schema.session)
      .innerJoin(schema.appUser, eq(schema.appUser.id, schema.session.userId))
      .where(
        and(
          eq(schema.session.tokenHash, tokenHash),
          gt(schema.session.expiresAt, new Date()),
          isNull(schema.session.revokedAt),
        ),
      )
      .limit(1),
  );

  const row = rows[0];
  if (!row) throw new UnauthorizedError('Session is invalid or expired.');

  // The tenant may be overridden per request for users who belong to several,
  // but only to one they are actually a member of.
  const requestedTenant = request.headers['x-tenant-id'];
  const tenantId =
    typeof requestedTenant === 'string' && requestedTenant
      ? requestedTenant
      : row.session.tenantId;

  if (!tenantId) throw new UnauthorizedError('Session is not bound to a tenant.');

  // membership, tenant, role and user_role are all tenant-scoped, so these
  // reads need the RLS guard set — without it they correctly return nothing
  // and every login fails.
  //
  // One transaction for all of them: it is a single guard, a single connection,
  // and it runs on every authenticated request.
  const resolved = await withTenantId(tenantId, async (tx) => {
    const [membership] = await tx
      .select()
      .from(schema.membership)
      .where(
        and(
          eq(schema.membership.userId, row.user.id),
          eq(schema.membership.tenantId, tenantId),
          eq(schema.membership.status, 'active'),
        ),
      )
      .limit(1);

    if (!membership) return null;

    const [tenant] = await tx
      .select()
      .from(schema.tenant)
      .where(and(eq(schema.tenant.id, tenantId), isNull(schema.tenant.deletedAt)))
      .limit(1);

    const roleRows = membership.isOwner
      ? []
      : await tx
          .select({
            permissionKey: schema.rolePermission.permissionKey,
            effect: schema.rolePermission.effect,
          })
          .from(schema.userRole)
          .innerJoin(
            schema.rolePermission,
            and(
              eq(schema.rolePermission.roleId, schema.userRole.roleId),
              eq(schema.rolePermission.tenantId, tenantId),
            ),
          )
          .where(
            and(eq(schema.userRole.tenantId, tenantId), eq(schema.userRole.userId, row.user.id)),
          );

    return { membership, tenant, roleRows };
  });

  if (!resolved) {
    // Deliberately the same error as a bad token: whether a given tenant exists
    // is not something an unauthorised caller should be able to probe.
    throw new UnauthorizedError('Session is invalid or expired.');
  }

  const { membership, tenant } = resolved;
  const permissions = membership.isOwner
    ? await allPermissionKeys()
    : collapsePermissions(resolved.roleRows);

  return {
    userId: row.user.id,
    isOwner: membership.isOwner,
    context: {
      tenantId,
      userId: row.user.id,
      actorType: 'user',
      legalEntityId: membership.legalEntityId,
      countryCode: tenant?.primaryCountryCode ?? undefined,
      locale: row.user.locale || tenant?.defaultLocale || 'en',
      timezone: row.user.timezone || tenant?.timezone || 'UTC',
      currencyCode: tenant?.baseCurrencyCode ?? undefined,
      requestId: requestId(request),
      permissions,
    },
  };
}

/** Runs a handler inside the principal's tenant context. */
export function withPrincipal<T>(principal: Principal, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext(principal.context, fn);
}

export function requirePermission(principal: Principal, permission: string): void {
  // An owner bypasses the matrix. Everything else is checked, including
  // explicit denies, which win over grants.
  if (principal.isOwner) return;
  if (!principal.context.permissions?.has(permission)) {
    throw new ForbiddenError(permission);
  }
}

/** `permission` is a global catalogue, so this needs no tenant guard. */
async function allPermissionKeys(): Promise<ReadonlySet<string>> {
  const all = await withoutTenantGuard(async (tx) =>
    tx.select({ key: schema.permission.key }).from(schema.permission),
  );
  return new Set(all.map((p) => p.key));
}

function collapsePermissions(
  rows: { permissionKey: string; effect: 'allow' | 'deny' }[],
): ReadonlySet<string> {
  const granted = new Set<string>();
  const denied = new Set<string>();
  for (const row of rows) {
    if (row.effect === 'deny') denied.add(row.permissionKey);
    else granted.add(row.permissionKey);
  }

  // A deny anywhere beats a grant anywhere — the safe direction.
  for (const key of denied) granted.delete(key);
  return granted;
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim() || null;
  }
  return null;
}

function requestId(request: FastifyRequest): string {
  const header = request.headers['x-request-id'];
  return typeof header === 'string' && /^[0-9a-f-]{36}$/i.test(header) ? header : randomUUID();
}

/**
 * Creating a customer.
 *
 * Stage 2 of docs/07-platform-operations.md, and the gap that mattered more
 * than the reporting: until this existed, nothing in the codebase created a
 * tenant. Onboarding meant hand-written SQL across six steps that have to
 * succeed together, and a half-provisioned tenant is worse than none — the
 * owner signs in and every screen fails on something absent, which costs more
 * to diagnose than the signup was worth.
 *
 * **Why this lives in `apps/api` and not the kernel.** Enabling a module needs
 * the module REGISTRY — which modules this deployment ships, what they depend
 * on, what number series they declare — and the registry is application-level
 * by design: the kernel must not know a module exists. Putting provisioning in
 * the kernel would either invert that dependency or duplicate `enableModule`'s
 * dependency resolution, and a second copy of that logic would drift.
 *
 * **Why the application role, not the platform role.** The platform role from
 * Stage 1 holds SELECT and nothing else, deliberately, so it cannot be used
 * here. Provisioning connects as `aerolith_app` and writes exactly the way the
 * application does: `kernel.tenant` and `kernel.app_user` carry no RLS policy
 * and are written without a guard, then everything tenant-scoped is written
 * under `withTenantId` for the tenant just created. No new credential and no
 * RLS bypass — the isolation model is unchanged, which is the point.
 */
import {
  adoptCountry,
  hashPassword,
  runWithTenantContext,
  schema,
  withTenantId,
  withoutTenantGuard,
  type Transaction,
} from '@aerolith/kernel';
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { enableModule } from './entitlements';

export class ProvisioningError extends Error {
  override readonly name = 'ProvisioningError';
}

export interface ProvisionTenantInput {
  /** Subdomain-safe. Lowercase letters, digits and hyphens. */
  slug: string;
  name: string;
  /** Must already be seeded — `adoptCountry` refuses an unknown pack. */
  countryCode: string;
  currencyCode: string;
  timezone?: string;
  /** Omitted means a live customer; a number starts a trial that many days out. */
  trialDays?: number;
  ownerEmail: string;
  ownerName: string;
  /** Handed to the owner directly. See the note on delivery below. */
  ownerPassword: string;
  moduleKeys: string[];
}

export interface ProvisionTenantResult {
  tenantId: string;
  slug: string;
  ownerUserId: string;
  ownerAccountCreated: boolean;
  modulesEnabled: string[];
  seriesCreated: number;
  requirementsAdopted: number;
  trialEndsAt: string | null;
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Creates a tenant, its owner, its country adoption and its entitlements.
 *
 * Not one transaction, and that is a deliberate departure from how this reads
 * in the plan. `kernel.tenant` has to be COMMITTED before the tenant-scoped
 * writes can see it: those run under `withTenantId`, which opens its own
 * transaction, and an uncommitted tenant row is invisible to it. So the shape
 * is: create the tenant and the user, then everything else against them, and
 * roll the tenant back by hand if a later step fails.
 *
 * The compensating delete is what keeps the "half-provisioned is worse than
 * none" promise. It is best-effort — if it fails too, the error names the
 * tenant so it can be removed by hand rather than lurking.
 */
export async function provisionTenant(
  input: ProvisionTenantInput,
): Promise<ProvisionTenantResult> {
  const slug = input.slug.trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) {
    throw new ProvisioningError(
      `"${slug}" is not a usable slug. Lowercase letters, digits and hyphens; it becomes a subdomain.`,
    );
  }

  const email = input.ownerEmail.trim().toLowerCase();
  if (!email.includes('@')) throw new ProvisioningError(`"${email}" is not an email address.`);
  if (input.moduleKeys.length === 0) {
    throw new ProvisioningError('A tenant with no modules can sign in and see nothing. Name at least one.');
  }

  const tenantId = randomUUID();
  const trialEndsAt =
    input.trialDays === undefined
      ? null
      : new Date(Date.now() + input.trialDays * 24 * 60 * 60 * 1000);

  // --- Tenant and owner account. Neither table carries RLS. -----------------
  const { ownerUserId, ownerAccountCreated } = await withoutTenantGuard(async (tx) => {
    const [existingSlug] = await tx
      .select({ id: schema.tenant.id })
      .from(schema.tenant)
      .where(eq(schema.tenant.slug, slug))
      .limit(1);
    if (existingSlug) throw new ProvisioningError(`The slug "${slug}" is already taken.`);

    await tx.insert(schema.tenant).values({
      id: tenantId,
      slug,
      name: input.name.trim(),
      status: input.trialDays === undefined ? 'active' : 'trial',
      primaryCountryCode: input.countryCode,
      baseCurrencyCode: input.currencyCode,
      timezone: input.timezone ?? 'UTC',
      trialEndsAt,
    });

    // The same email may already have an account: somebody who works for two
    // companies that both use this product has one login, which `addMember`
    // already assumes. Reusing it here keeps that true from the first day
    // rather than creating a second account that shadows theirs.
    const [existingUser] = await tx
      .select({ id: schema.appUser.id })
      .from(schema.appUser)
      .where(and(eq(schema.appUser.email, email), isNull(schema.appUser.deletedAt)))
      .limit(1);

    if (existingUser) return { ownerUserId: existingUser.id, ownerAccountCreated: false };

    const userId = randomUUID();
    await tx.insert(schema.appUser).values({
      id: userId,
      email,
      name: input.ownerName.trim(),
      locale: 'en',
      passwordHash: await hashPassword(input.ownerPassword),
    });
    return { ownerUserId: userId, ownerAccountCreated: true };
  });

  try {
    return await provisionTenantContents({
      ...input,
      slug,
      tenantId,
      ownerUserId,
      ownerAccountCreated,
      trialEndsAt,
    });
  } catch (error) {
    await rollbackTenant(tenantId, ownerAccountCreated ? ownerUserId : null, error);
    throw error;
  }
}

async function provisionTenantContents(args: {
  tenantId: string;
  slug: string;
  countryCode: string;
  moduleKeys: string[];
  ownerUserId: string;
  ownerAccountCreated: boolean;
  trialEndsAt: Date | null;
}): Promise<ProvisionTenantResult> {
  const { tenantId, ownerUserId } = args;

  // Everything below is tenant-scoped, so it needs both the RLS guard and the
  // AsyncLocalStorage context — `enableModule` audits, and `recordAudit` reads
  // the actor from that context. `actorType: 'system'` is honest: nobody was
  // signed in, this ran from an operator's terminal.
  return runWithTenantContext(
    {
      tenantId,
      userId: ownerUserId,
      actorType: 'system',
      locale: 'en',
      timezone: 'UTC',
      countryCode: args.countryCode,
      currencyCode: null,
      permissions: new Set<string>(),
      requestId: randomUUID(),
    } as never,
    async () =>
      withTenantId(tenantId, async (tx: Transaction) => {
        await tx.insert(schema.membership).values({
          tenantId,
          userId: ownerUserId,
          status: 'active',
          isOwner: true,
          joinedAt: new Date(),
        });

        // Before the modules: contract terms, tax codes and holidays all
        // resolve through the tenant's adopted copies, and a module enabled
        // against a tenant that has adopted nothing works until the first
        // screen that asks for a rule.
        const adoption = await adoptCountry(tx, {
          tenantId,
          countryCode: args.countryCode,
          isPrimary: true,
        });

        const modulesEnabled: string[] = [];
        let seriesCreated = 0;
        for (const moduleKey of args.moduleKeys) {
          const result = await enableModule(tx, { tenantId, moduleKey });
          // Dependencies are pulled in, so the same key can arrive twice.
          for (const key of result.enabled) {
            if (!modulesEnabled.includes(key)) modulesEnabled.push(key);
          }
          seriesCreated += result.seriesCreated;
        }

        return {
          tenantId,
          slug: args.slug,
          ownerUserId,
          ownerAccountCreated: args.ownerAccountCreated,
          modulesEnabled,
          seriesCreated,
          requirementsAdopted: adoption.requirementsCopied,
          trialEndsAt: args.trialEndsAt ? args.trialEndsAt.toISOString() : null,
        };
      }),
  );
}

/**
 * Undoes a failed provision.
 *
 * Deliberately narrow: it removes only the tenant row and, if this run created
 * it, the owner account. Everything else written so far hangs off the tenant by
 * a foreign key or by `tenant_id`, and leaving those rows behind is harmless —
 * they are unreachable once the tenant is gone, and a later provision uses a
 * fresh id. An owner account that already existed is never touched, because
 * deleting it would remove a person's access to a DIFFERENT workspace.
 */
async function rollbackTenant(
  tenantId: string,
  ownerUserIdToRemove: string | null,
  cause: unknown,
): Promise<void> {
  try {
    await withoutTenantGuard(async (tx) => {
      await tx.delete(schema.tenant).where(eq(schema.tenant.id, tenantId));
      if (ownerUserIdToRemove) {
        await tx.delete(schema.appUser).where(eq(schema.appUser.id, ownerUserIdToRemove));
      }
    });
  } catch (rollbackError) {
    // Reported, never swallowed, and never allowed to replace the real error:
    // the original failure is what needs fixing, and this line is what tells
    // somebody there is also a tenant row to clear by hand.
    console.error(
      `! provisioning failed AND rollback failed. Remove tenant ${tenantId} manually.`,
      rollbackError,
      '\noriginal failure:',
      cause,
    );
  }
}

export type TenantLifecycleAction = 'suspend' | 'resume' | 'delete';

/**
 * Suspends, resumes or soft-deletes a tenant.
 *
 * Suspension needs no new enforcement anywhere: `loadMemberships` already
 * refuses to log a user into a tenant whose status is not `active`, so this
 * takes effect on the next request and existing sessions stop working at their
 * next `/me`.
 *
 * Deletion is soft, always. A customer who leaves and comes back next month is
 * a customer, and a hard delete that ran against the wrong id is unrecoverable.
 * Purging is a separate, deliberately unbuilt operation — when it exists it
 * should require naming the tenant twice and a retention window that has
 * actually elapsed.
 */
export async function setTenantLifecycle(input: {
  tenantId: string;
  action: TenantLifecycleAction;
}): Promise<{ slug: string; status: string; deletedAt: string | null }> {
  return withoutTenantGuard(async (tx) => {
    const [existing] = await tx
      .select({
        id: schema.tenant.id,
        slug: schema.tenant.slug,
        status: schema.tenant.status,
        deletedAt: schema.tenant.deletedAt,
      })
      .from(schema.tenant)
      .where(eq(schema.tenant.id, input.tenantId))
      .limit(1);

    if (!existing) throw new ProvisioningError(`No tenant with id ${input.tenantId}.`);

    if (input.action === 'delete') {
      if (existing.deletedAt) throw new ProvisioningError(`"${existing.slug}" is already deleted.`);
      const deletedAt = new Date();
      await tx
        .update(schema.tenant)
        .set({ status: 'suspended', deletedAt, updatedAt: deletedAt })
        .where(eq(schema.tenant.id, input.tenantId));
      return { slug: existing.slug, status: 'suspended', deletedAt: deletedAt.toISOString() };
    }

    if (existing.deletedAt) {
      throw new ProvisioningError(
        `"${existing.slug}" is deleted. Restoring it is a separate decision from resuming it.`,
      );
    }

    const status = input.action === 'suspend' ? 'suspended' : 'active';
    await tx
      .update(schema.tenant)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.tenant.id, input.tenantId));

    return { slug: existing.slug, status, deletedAt: null };
  });
}

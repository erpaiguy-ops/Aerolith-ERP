/**
 * Request-scoped tenant context.
 *
 * Carried in AsyncLocalStorage so that every layer — repositories, the event
 * bus, the audit logger, the rule resolver — sees the acting tenant without it
 * being threaded through every signature. A missing context is a programming
 * error and throws rather than silently defaulting, because "silently defaulting"
 * in a multi-tenant system means leaking one customer's data to another.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type ActorType = 'user' | 'api_key' | 'system' | 'job';

export interface TenantContext {
  tenantId: string;
  /** Null for system and job actors. */
  userId: string | null;
  actorType: ActorType;
  /** Restricts the request to one operating entity when set. */
  legalEntityId?: string | null;
  /** Resolved at session start; drives country rules, formatting and templates. */
  countryCode?: string;
  locale: string;
  timezone: string;
  currencyCode?: string;
  /** Correlates logs, audit rows and events across module boundaries. */
  requestId: string;
  permissions?: ReadonlySet<string>;
}

const storage = new AsyncLocalStorage<TenantContext>();

export function runWithTenantContext<T>(context: TenantContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Throws when there is no context. Use where a tenant is required. */
export function requireTenantContext(): TenantContext {
  const context = storage.getStore();
  if (!context) {
    throw new MissingTenantContextError();
  }
  return context;
}

/** Returns undefined outside a request. Use for optional enrichment (logging). */
export function getTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

export function requireTenantId(): string {
  return requireTenantContext().tenantId;
}

/**
 * Elevates to a system actor within the same tenant — for background jobs and
 * event handlers, which act on behalf of the tenant but not of any user.
 */
export function runAsSystem<T>(
  tenantId: string,
  fn: () => T,
  overrides: Partial<TenantContext> = {},
): T {
  const parent = storage.getStore();
  return storage.run(
    {
      locale: 'en',
      timezone: 'UTC',
      requestId: parent?.requestId ?? crypto.randomUUID(),
      ...parent,
      ...overrides,
      tenantId,
      userId: null,
      actorType: 'system',
    },
    fn,
  );
}

export class MissingTenantContextError extends Error {
  override readonly name = 'MissingTenantContextError';
  constructor() {
    super(
      'No tenant context is active. Wrap the call in runWithTenantContext(), or ' +
        'use runAsSystem() for background work.',
    );
  }
}

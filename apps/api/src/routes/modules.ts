/**
 * Module and navigation endpoints.
 *
 * `/me` is where standalone-vs-unified becomes visible: the same binary returns
 * a single-module product to one tenant and the full ERP to another, based on
 * entitlement rows.
 */
import type { FastifyInstance } from 'fastify';

import { authenticate } from '../context';
import { modulesForTenant, navigationFor, registry } from '../bootstrap';

export async function moduleRoutes(app: FastifyInstance) {
  /** Everything this deployment could serve — the module catalogue. */
  app.get('/modules/catalogue', async () => ({
    modules: registry.all().map((module) => ({
      key: module.key,
      name: module.name,
      description: module.description,
      version: module.version,
      category: module.category,
      standalone: module.standalone,
      sellable: module.sellable,
      dependsOn: module.dependsOn,
      integratesWith: module.integratesWith,
    })),
  }));

  /** The signed-in user's world: their tenant's modules, their navigation. */
  app.get('/me', async (request) => {
    const principal = await authenticate(request);
    const modules = await modulesForTenant(principal.context.tenantId);
    const permissions = principal.context.permissions ?? new Set<string>();

    return {
      user: {
        id: principal.userId,
        locale: principal.context.locale,
        timezone: principal.context.timezone,
        isOwner: principal.isOwner,
      },
      tenant: {
        id: principal.context.tenantId,
        countryCode: principal.context.countryCode,
        currencyCode: principal.context.currencyCode,
      },
      modules: modules.ordered.map((m) => ({ key: m.key, name: m.name, version: m.version })),
      // Surfaced rather than swallowed: a tenant entitled to something this
      // deployment cannot serve should be told, not left wondering.
      unavailableModules: modules.skipped,
      navigation: navigationFor(modules, permissions),
      permissions: [...permissions].sort(),
    };
  });
}

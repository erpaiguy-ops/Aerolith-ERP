/**
 * Localisation admin API.
 *
 * These endpoints are what makes "country specifics are filled by the user"
 * concrete: list the countries, adopt one, then read and edit your own copy of
 * its requirements, tax codes and rules.
 */
import {
  adoptCountry,
  loadRuleSnapshot,
  resolveRule,
  schema,
  setTenantRule,
  validateRuleValue,
  withTenant,
} from '@aerolith/kernel';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  authenticate,
  requireAnyPermission,
  requirePermission,
  withPrincipal,
} from '../context';

/**
 * Reading the country pack is an administrative act, not a formatting one.
 *
 * Worth stating because it looks like the opposite: nothing here is needed to
 * render a date or a currency. Locale, timezone and currency reach the browser
 * on `/me`, so an ordinary user never calls these endpoints at all — the only
 * callers are the two Settings screens. That is why gating them does not
 * break anyone, and why `kernel.localisation.read` was declared in the first
 * place. It simply was never enforced.
 *
 * `…manage` passes too: it is the strictly stronger half of the pair, and the
 * Settings nav is gated on it, so requiring only `…read` here would hand a
 * workspace admin a menu entry leading to a 403.
 */
const READ_LOCALISATION = ['kernel.localisation.read', 'kernel.localisation.manage'];

const adoptBody = z.object({
  countryCode: z.string().length(2),
  isPrimary: z.boolean().optional(),
  overrides: z
    .object({
      locale: z.string().optional(),
      currencyCode: z.string().length(3).optional(),
      timezone: z.string().optional(),
      weekendDays: z.array(z.number().int().min(1).max(7)).optional(),
      fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
      taxRegimeCode: z.string().optional(),
      taxRegistrationNumber: z.string().optional(),
    })
    .optional(),
  refresh: z.boolean().optional(),
});

const ruleBody = z.object({
  value: z.unknown(),
  reason: z.string().optional(),
});

export async function localisationRoutes(app: FastifyInstance) {
  /** Countries available to adopt. Not tenant-scoped — this is the global master. */
  app.get('/localisation/countries', async (request) => {
    const principal = await authenticate(request);
    requireAnyPermission(principal, READ_LOCALISATION);

    return withPrincipal(principal, () =>
      withTenant(async (tx) => {
        const countries = await tx
          .select({
            code: schema.country.code,
            name: schema.country.name,
            nativeName: schema.country.nativeName,
            currencyCode: schema.country.currencyCode,
            packVersion: schema.country.packVersion,
            adminDivisionLabel: schema.country.adminDivisionLabel,
          })
          .from(schema.country)
          .where(eq(schema.country.isActive, true))
          .orderBy(asc(schema.country.name));

        return { countries };
      }),
    );
  });

  /** Everything the UI needs to render a country's forms: address shape, divisions. */
  app.get<{ Params: { code: string } }>('/localisation/countries/:code', async (request, reply) => {
    const principal = await authenticate(request);
    requireAnyPermission(principal, READ_LOCALISATION);

    return withPrincipal(principal, () =>
      withTenant(async (tx) => {
        const [country] = await tx
          .select()
          .from(schema.country)
          .where(eq(schema.country.code, request.params.code.toUpperCase()))
          .limit(1);

        if (!country) return reply.code(404).send({ error: 'Country not found.' });

        const divisions = await tx
          .select()
          .from(schema.countryAdminDivision)
          .where(eq(schema.countryAdminDivision.countryCode, country.code))
          .orderBy(asc(schema.countryAdminDivision.sortOrder));

        const requirements = await tx
          .select()
          .from(schema.requirementDefinition)
          .where(eq(schema.requirementDefinition.countryCode, country.code))
          .orderBy(asc(schema.requirementDefinition.sortOrder));

        return { country, divisions, requirements };
      }),
    );
  });

  /**
   * Adopt a country. Copies its requirements, tax codes and holidays into the
   * tenant's own editable tables.
   */
  app.post('/localisation/adopt', async (request, reply) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.localisation.manage');

    const parsed = adoptBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    return withPrincipal(principal, () =>
      withTenant(async (tx) =>
        adoptCountry(tx, { tenantId: principal.context.tenantId, ...parsed.data }),
      ),
    );
  });

  /** The tenant's own requirement set — the editable copy, not the master. */
  app.get<{ Querystring: { subject?: string } }>(
    '/localisation/requirements',
    async (request) => {
      const principal = await authenticate(request);
      requireAnyPermission(principal, READ_LOCALISATION);

      return withPrincipal(principal, () =>
        withTenant(async (tx) => {
          const requirements = await tx
            .select()
            .from(schema.tenantRequirement)
            .where(
              and(
                eq(schema.tenantRequirement.tenantId, principal.context.tenantId),
                eq(schema.tenantRequirement.isActive, true),
                request.query.subject
                  ? eq(schema.tenantRequirement.subject, request.query.subject as never)
                  : undefined,
              ),
            )
            .orderBy(asc(schema.tenantRequirement.sortOrder));

          return { requirements };
        }),
      );
    },
  );

  /** The tenant's tax codes, ready for an invoice line to reference. */
  app.get('/localisation/tax-codes', async (request) => {
    const principal = await authenticate(request);
    requireAnyPermission(principal, READ_LOCALISATION);

    return withPrincipal(principal, () =>
      withTenant(async (tx) => {
        const taxCodes = await tx
          .select()
          .from(schema.tenantTaxCode)
          .where(
            and(
              eq(schema.tenantTaxCode.tenantId, principal.context.tenantId),
              eq(schema.tenantTaxCode.isActive, true),
            ),
          )
          .orderBy(asc(schema.tenantTaxCode.sortOrder));

        return { taxCodes };
      }),
    );
  });

  /**
   * Resolved rules, with the layer each answer came from. The layer is the
   * point: an admin needs to see whether a number is theirs, their country's,
   * or a fallback.
   */
  app.get<{ Querystring: { domain?: string; asAt?: string } }>(
    '/localisation/rules',
    async (request, reply) => {
      const principal = await authenticate(request);
      requireAnyPermission(principal, READ_LOCALISATION);

      const countryCode = principal.context.countryCode;
      if (!countryCode) {
        return reply.code(409).send({ error: 'This tenant has not adopted a country yet.' });
      }

      const asAt = request.query.asAt ? new Date(request.query.asAt) : new Date();
      if (Number.isNaN(asAt.getTime())) {
        return reply.code(400).send({ error: 'Invalid asAt date.' });
      }

      return withPrincipal(principal, () =>
        withTenant(async (tx) => {
          const snapshot = await loadRuleSnapshot(tx, {
            tenantId: principal.context.tenantId,
            countryCode,
          });

          // The resolver answers "what is the value and who said so". An admin
          // screen also has to say WHAT the knob is, what shape a new value must
          // take, and whether it may be touched at all — a page of
          // `payroll.overtime.weekday_multiplier = 1.25` with no label is a page
          // nobody can safely edit.
          const definitions = await tx
            .select({
              key: schema.ruleDefinition.key,
              domain: schema.ruleDefinition.domain,
              label: schema.ruleDefinition.label,
              description: schema.ruleDefinition.description,
              valueType: schema.ruleDefinition.valueType,
              defaultValue: schema.ruleDefinition.defaultValue,
              unit: schema.ruleDefinition.unit,
              tenantOverridable: schema.ruleDefinition.tenantOverridable,
              ownerModule: schema.ruleDefinition.ownerModule,
            })
            .from(schema.ruleDefinition);

          const byKey = new Map(definitions.map((d) => [d.key, d]));

          // Everything is resolved, always. Resolution is a synchronous walk of
          // an already-loaded snapshot, so the whole set costs no more than a
          // slice of it, and both the summary and the domain list have to be
          // computed over all of it whatever the caller filtered to.
          const all = [...snapshot.definitions.keys()]
            .sort()
            .map((key) => ({ ...resolveRule(snapshot, key, asAt), ...byKey.get(key) }));

          /*
           * Filtered by the definition's `domain` COLUMN, not by key prefix.
           *
           * `resolveDomain` matches on the key, which is a different question
           * wearing the same name: 18 rules are declared in the `contract`
           * domain and only 4 of them have keys starting `contract.` — the rest
           * are `contracts.`, `estimation.` and `projects.`, because a module
           * declares which domain a knob BELONGS to independently of what it
           * called it. Prefix-matching here showed 4 of 18 under a chip labelled
           * "contract", which is worse than no filter: it looks complete.
           */
          const rules = request.query.domain
            ? all.filter((rule) => rule.domain === request.query.domain)
            : all;

          // Over the whole set, never the filtered slice. "How much of this
          // workspace's configuration is actually ours" is a question about the
          // workspace, and a figure that silently rescopes when a filter is set
          // is a figure that gets quoted wrongly. Same reasoning as the offcut
          // register's whole-register summary.
          const summary = {
            total: all.length,
            tenant: all.filter((r) => r.layer === 'tenant').length,
            country: all.filter((r) => r.layer === 'country').length,
            default: all.filter((r) => r.layer === 'default').length,
            statutory: all.filter((r) => r.tenantOverridable === false).length,
          };

          const domains = [...new Set(definitions.map((d) => d.domain))].sort();

          return { countryCode, asAt: asAt.toISOString(), domains, summary, rules };
        }),
      );
    },
  );

  /** Override one rule for this tenant. */
  app.put<{ Params: { key: string } }>(
    '/localisation/rules/:key',
    async (request, reply) => {
      const principal = await authenticate(request);
      requirePermission(principal, 'kernel.localisation.manage');

      const parsed = ruleBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
      }

      return withPrincipal(principal, () =>
        withTenant(async (tx) => {
          const [definition] = await tx
            .select()
            .from(schema.ruleDefinition)
            .where(eq(schema.ruleDefinition.key, request.params.key))
            .limit(1);

          if (!definition) {
            return reply.code(404).send({ error: `Unknown rule "${request.params.key}".` });
          }

          if (!definition.tenantOverridable) {
            return reply.code(403).send({
              error: `"${definition.key}" is statutory and cannot be overridden by a tenant.`,
            });
          }

          const validation = validateRuleValue(
            {
              key: definition.key,
              valueType: definition.valueType,
              defaultValue: definition.defaultValue,
              tenantOverridable: definition.tenantOverridable,
            },
            parsed.data.value,
          );

          if (!validation.ok) {
            return reply.code(400).send({ error: validation.error });
          }

          await setTenantRule(tx, {
            tenantId: principal.context.tenantId,
            key: definition.key,
            value: parsed.data.value,
            reason: parsed.data.reason,
          });

          return { key: definition.key, value: parsed.data.value, layer: 'tenant' };
        }),
      );
    },
  );
}

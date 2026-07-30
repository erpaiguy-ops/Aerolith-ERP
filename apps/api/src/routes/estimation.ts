/**
 * Estimation routes.
 *
 * The conversion endpoint at the bottom is the point of the whole wedge: a won
 * tender's priced build-ups become a Production work order with its parts, in
 * one transaction. Estimation does not import Production and Production does not
 * import Estimation — this route composes them.
 */
import { parseListParams, schema, withTenant } from '@aerolith/kernel';
import {
  ESTIMATE_SORTS,
  EstimationError,
  RATE_SORTS,
  TENDER_SORTS,
  createEstimate,
  createTender,
  currentRateLibrary,
  estimationSchema,
  getEstimateBillOfMaterials,
  getTenderDetail,
  listEstimates,
  listRates,
  listTenders,
  marginScenarios,
  recordBidDecision,
  recordOutcome,
  rollUp,
  submitEstimate,
} from '@aerolith/module-estimation';
import { createWorkOrder } from '@aerolith/module-production';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { modulesForTenant } from '../bootstrap';
import { authenticate, requirePermission, withPrincipal, type Principal } from '../context';

interface ListQuery {
  page?: string;
  pageSize?: string;
  sort?: string;
  direction?: string;
  q?: string;
  status?: string;
  libraryId?: string;
}

const MODULE = 'estimation';

async function requireModule(principal: Principal, reply: FastifyReply): Promise<boolean> {
  const modules = await modulesForTenant(principal.context.tenantId);
  if (!modules.enabled.has(MODULE)) {
    await reply.code(404).send({ error: 'Not found.' });
    return false;
  }
  return true;
}

const componentSchema = z.object({
  type: z.enum([
    'material',
    'labour',
    'machine',
    'finishing',
    'hardware',
    'subcontract',
    'transport',
    'other',
  ]),
  description: z.string().optional(),
  /** Links the component to stock, which is what lets a won estimate explode
   *  into a production BOM. */
  itemId: z.string().uuid().nullish(),
  quantityPerUnit: z.number().nonnegative(),
  unitRate: z.number().nonnegative(),
  wastagePercent: z.number().min(0).max(200).optional(),
});

const tenderBody = z.object({
  name: z.string().min(1),
  clientPartyId: z.string().uuid().nullish(),
  consultantPartyId: z.string().uuid().nullish(),
  mainContractorPartyId: z.string().uuid().nullish(),
  currencyCode: z.string().length(3).nullish(),
  submissionDueAt: z.string().datetime().nullish(),
  validityDays: z.number().int().positive().nullish(),
  siteAddress: z.record(z.string()).optional(),
  notes: z.string().nullish(),
});

const estimateBody = z.object({
  label: z.string().min(1),
  rateLibraryId: z.string().uuid().nullish(),
  overheadPercent: z.number().min(0).max(200).optional(),
  marginPercent: z.number().min(0).max(99.99).optional(),
  roundRatesTo: z.number().min(0).optional(),
  sections: z.array(z.object({ reference: z.string(), name: z.string() })).optional(),
  lines: z
    .array(
      z.object({
        reference: z.string().nullish(),
        description: z.string().min(1),
        quantity: z.number().nonnegative(),
        uomCode: z.string().nullish(),
        kind: z
          .enum(['measured', 'provisional_sum', 'prime_cost', 'dayworks', 'preliminaries', 'optional'])
          .optional(),
        sectionRef: z.string().nullish(),
        rateItemCode: z.string().nullish(),
        components: z.array(componentSchema).optional(),
        unitRate: z.number().nonnegative().optional(),
        marginPercent: z.number().min(0).max(99.99).nullish(),
        notes: z.string().nullish(),
      }),
    )
    .min(1),
});

export async function estimationRoutes(app: FastifyInstance) {
  // --- Tenders ------------------------------------------------------------

  app.post('/estimating/tenders', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'estimation.tender.write');

    const parsed = tenderBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    return withPrincipal(principal, () => withTenant((tx) => createTender(tx, parsed.data)));
  });

  app.get<{ Querystring: ListQuery & { bidDecision?: string; open?: string } }>(
    '/estimating/tenders',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'estimation.tender.read');

      const params = parseListParams(request.query, {
        sortable: TENDER_SORTS,
        // Soonest deadline first. A tender list ordered by anything else buries
        // the one that closes on Thursday, and a missed submission is the most
        // expensive failure this module has.
        defaultSort: 'submissionDueAt',
        defaultDirection: 'asc',
      });

      return withPrincipal(principal, () =>
        withTenant((tx) =>
          listTenders(tx, params, {
            status: request.query.status,
            bidDecision: request.query.bidDecision,
            openOnly: request.query.open === 'true',
          }),
        ),
      );
    },
  );

  app.get<{ Params: { id: string } }>('/estimating/tenders/:id', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'estimation.tender.read');

    const detail = await withPrincipal(principal, () =>
      withTenant((tx) => getTenderDetail(tx, request.params.id)),
    );

    if (!detail) return reply.code(404).send({ error: 'Tender not found.' });
    return detail;
  });

  app.post<{ Params: { id: string } }>(
    '/estimating/tenders/:id/bid-decision',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'estimation.tender.decide');

      const parsed = z
        .object({ decision: z.enum(['bid', 'no_bid']), reason: z.string().min(1) })
        .safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
      }

      try {
        await withPrincipal(principal, () =>
          withTenant((tx) => recordBidDecision(tx, { tenderId: request.params.id, ...parsed.data })),
        );
        return { recorded: true };
      } catch (error) {
        if (error instanceof EstimationError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/estimating/tenders/:id/outcome',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'estimation.tender.decide');

      const parsed = z
        .object({
          outcome: z.enum(['won', 'lost']),
          outcomeValue: z.number().nullish(),
          lostToPartyId: z.string().uuid().nullish(),
          lostReason: z.string().nullish(),
          winningValue: z.number().nullish(),
        })
        .safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
      }

      try {
        return await withPrincipal(principal, () =>
          withTenant((tx) => recordOutcome(tx, { tenderId: request.params.id, ...parsed.data })),
        );
      } catch (error) {
        if (error instanceof EstimationError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  // --- Estimates ----------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/estimating/tenders/:id/estimates',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'estimation.estimate.write');

      const parsed = estimateBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
      }

      try {
        return await withPrincipal(principal, () =>
          withTenant((tx) => createEstimate(tx, { tenderId: request.params.id, ...parsed.data })),
        );
      } catch (error) {
        if (error instanceof EstimationError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.get<{ Querystring: ListQuery & { tenderId?: string; submitted?: string } }>(
    '/estimating/estimates',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'estimation.estimate.read');

      const params = parseListParams(request.query, {
        sortable: ESTIMATE_SORTS,
        defaultSort: 'createdAt',
        defaultDirection: 'desc',
      });

      // Read from the PRINCIPAL, never from the query string. The same rule the
      // detail endpoint follows, and the reason the redaction lives in the
      // service rather than here.
      const canSeeMargin =
        principal.isOwner || principal.context.permissions?.has('estimation.margin.view');

      return withPrincipal(principal, () =>
        withTenant(async (tx) => {
          const page = await listEstimates(tx, params, {
            status: request.query.status,
            tenderId: request.query.tenderId,
            submittedOnly: request.query.submitted === 'true',
            canSeeMargin,
          });
          // Stated on the wire so the screen can say "you are not seeing cost"
          // rather than silently rendering a table with columns missing.
          return { ...page, marginVisible: Boolean(canSeeMargin) };
        }),
      );
    },
  );

  app.get<{ Params: { id: string } }>('/estimating/estimates/:id', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'estimation.estimate.read');

    // Cost and margin are a SEPARATE permission from viewing the estimate — a
    // site manager checking quantities should not see the margin.
    const canSeeMargin =
      principal.isOwner || principal.context.permissions?.has('estimation.margin.view');

    return withPrincipal(principal, () =>
      withTenant(async (tx) => {
        const [row] = await tx
          .select({
            estimate: estimationSchema.estimate,
            tenderNumber: estimationSchema.tender.number,
            tenderName: estimationSchema.tender.name,
            tenderStatus: estimationSchema.tender.status,
            clientName: schema.party.name,
            currencyCode: estimationSchema.tender.currencyCode,
          })
          .from(estimationSchema.estimate)
          .innerJoin(
            estimationSchema.tender,
            and(
              eq(estimationSchema.tender.id, estimationSchema.estimate.tenderId),
              eq(estimationSchema.tender.tenantId, principal.context.tenantId),
            ),
          )
          .leftJoin(
            schema.party,
            and(
              eq(schema.party.id, estimationSchema.tender.clientPartyId),
              eq(schema.party.tenantId, principal.context.tenantId),
            ),
          )
          .where(
            and(
              eq(estimationSchema.estimate.tenantId, principal.context.tenantId),
              eq(estimationSchema.estimate.id, request.params.id),
            ),
          )
          .limit(1);

        if (!row) return reply.code(404).send({ error: 'Estimate not found.' });
        const { estimate, ...meta } = row;

        const lines = await tx
          .select()
          .from(estimationSchema.estimateLine)
          .where(eq(estimationSchema.estimateLine.estimateId, estimate.id))
          .orderBy(asc(estimationSchema.estimateLine.lineNumber));

        return {
          ...meta,
          estimate: canSeeMargin
            ? estimate
            : { ...estimate, totalCost: undefined, marginPercent: undefined },
          lines: canSeeMargin
            ? lines
            : lines.map((l) => ({ ...l, unitCost: undefined, lineCost: undefined })),
          marginVisible: canSeeMargin,
        };
      }),
    );
  });

  /** What-if pricing before submission. */
  app.post<{ Params: { id: string } }>(
    '/estimating/estimates/:id/scenarios',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'estimation.margin.view');

      const parsed = z
        .object({
          margins: z
            .array(z.object({ label: z.string(), marginPercent: z.number().min(0).max(99.99) }))
            .min(1)
            .max(10),
        })
        .safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
      }

      return withPrincipal(principal, () =>
        withTenant(async (tx) => {
          const lines = await tx
            .select()
            .from(estimationSchema.estimateLine)
            .where(
              and(
                eq(estimationSchema.estimateLine.tenantId, principal.context.tenantId),
                eq(estimationSchema.estimateLine.estimateId, request.params.id),
              ),
            );

          if (lines.length === 0) {
            return reply.code(404).send({ error: 'Estimate not found or has no lines.' });
          }

          const domainLines = lines.map((l) => ({
            id: l.id,
            quantity: Number(l.quantity),
            unitRate: Number(l.unitRate),
            totalCost: Number(l.unitCost),
            isProvisional: l.kind === 'provisional_sum' || l.kind === 'prime_cost',
            isOptional: l.kind === 'optional',
          }));

          return {
            current: rollUp(domainLines),
            scenarios: marginScenarios(domainLines, parsed.data.margins),
          };
        }),
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    '/estimating/estimates/:id/submit',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'estimation.estimate.submit');

      try {
        return await withPrincipal(principal, () =>
          withTenant((tx) => submitEstimate(tx, { estimateId: request.params.id })),
        );
      } catch (error) {
        if (error instanceof EstimationError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  // --- The wedge: won tender becomes a work order -------------------------

  /**
   * Converts a won estimate into a Production work order.
   *
   * The estimate becomes the budget becomes the production BOM — the continuity
   * that is the entire pitch. Estimation and Production do not know about each
   * other; this route joins them in one transaction.
   */
  app.post<{ Params: { id: string } }>(
    '/estimating/estimates/:id/convert-to-work-order',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'estimation.estimate.write');

      const modules = await modulesForTenant(principal.context.tenantId);
      if (!modules.enabled.has('production')) {
        // Honest rather than silent: the tenant has not bought the module that
        // would receive the work order.
        return reply.code(409).send({
          error: 'Production is not enabled for this tenant, so no work order can be raised.',
        });
      }

      const parsed = z
        .object({
          routingId: z.string().uuid().nullish(),
          projectId: z.string().uuid().nullish(),
          /** Only these estimate lines become parts. Defaults to all measured lines. */
          lineIds: z.array(z.string().uuid()).optional(),
        })
        .safeParse(request.body ?? {});

      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
      }

      return withPrincipal(principal, () =>
        withTenant(async (tx) => {
          const [row] = await tx
            .select({ estimate: estimationSchema.estimate, tender: estimationSchema.tender })
            .from(estimationSchema.estimate)
            .innerJoin(
              estimationSchema.tender,
              eq(estimationSchema.tender.id, estimationSchema.estimate.tenderId),
            )
            .where(
              and(
                eq(estimationSchema.estimate.tenantId, principal.context.tenantId),
                eq(estimationSchema.estimate.id, request.params.id),
              ),
            )
            .limit(1);

          if (!row) return reply.code(404).send({ error: 'Estimate not found.' });
          if (row.tender.status !== 'won') {
            return reply.code(409).send({
              error: `Cannot raise a work order from a tender that is "${row.tender.status}".`,
            });
          }

          const bom = await getEstimateBillOfMaterials(tx, row.estimate.id);

          // Each measured line becomes a part. Provisional sums and options do
          // not get made.
          const eligible = bom.lines.filter(
            ({ line }) =>
              line.kind === 'measured' &&
              (!parsed.data.lineIds || parsed.data.lineIds.includes(line.id)),
          );

          if (eligible.length === 0) {
            return reply.code(409).send({ error: 'No measured lines to convert.' });
          }

          // Dimensions live on the material component's item, so a part without
          // one cannot be cut. Report it rather than inventing a size.
          const parts = eligible
            .map(({ line, components }) => {
              const material = components.find((c) => c.type === 'material' && c.itemId);
              if (!material?.itemId) return null;

              return {
                label: line.description.slice(0, 200),
                materialItemId: material.itemId,
                // Placeholder geometry: the real dimensions come from the shop
                // drawing, which Projects will carry. Quantity and material are
                // what the estimate actually knows.
                lengthMm: 1,
                widthMm: 1,
                quantity: Math.max(1, Math.round(Number(line.quantity))),
                notes: `From estimate line ${line.lineNumber}${line.reference ? ` (${line.reference})` : ''}`,
              };
            })
            .filter((p): p is NonNullable<typeof p> => p !== null);

          if (parts.length === 0) {
            return reply.code(409).send({
              error:
                'No estimate line has a material component linked to an item, so no parts ' +
                'can be raised. Link the rate build-ups to stock items first.',
            });
          }

          const created = await createWorkOrder(tx, {
            description: `${row.tender.name} — ${row.estimate.label}`,
            quantity: 1,
            projectId: parsed.data.projectId ?? row.tender.projectId,
            routingId: parsed.data.routingId,
            sourceModule: 'estimation',
            sourceEntityType: 'estimation.estimate',
            sourceEntityId: row.estimate.id,
            notes: `Converted from tender ${row.tender.number}`,
            parts,
          });

          return {
            ...created,
            tenderNumber: row.tender.number,
            linesConverted: parts.length,
            linesSkipped: eligible.length - parts.length,
            materialDemand: bom.materialDemand,
          };
        }),
      );
    },
  );

  /** The material a won estimate implies — for procurement and planning. */
  app.get<{ Params: { id: string } }>(
    '/estimating/estimates/:id/bill-of-materials',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'estimation.estimate.read');

      return withPrincipal(principal, () =>
        withTenant(async (tx) => {
          const bom = await getEstimateBillOfMaterials(tx, request.params.id);
          if (bom.lines.length === 0) {
            return reply.code(404).send({ error: 'Estimate not found or has no lines.' });
          }

          const itemIds = bom.materialDemand.map((d) => d.itemId);
          const items =
            itemIds.length === 0
              ? []
              : await tx
                  .select({ id: schema.item.id, code: schema.item.code, name: schema.item.name })
                  .from(schema.item)
                  .where(eq(schema.item.tenantId, principal.context.tenantId));

          return {
            materialDemand: bom.materialDemand.map((d) => ({
              ...d,
              itemCode: items.find((i) => i.id === d.itemId)?.code ?? null,
              itemName: items.find((i) => i.id === d.itemId)?.name ?? null,
            })),
            lineCount: bom.lines.length,
          };
        }),
      );
    },
  );

  // --- Rate library -------------------------------------------------------

  app.get<{ Querystring: ListQuery & { category?: string; inactive?: string } }>(
    '/estimating/rates',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'estimation.rate_library.read');

      const params = parseListParams(request.query, {
        sortable: RATE_SORTS,
        defaultSort: 'code',
        defaultDirection: 'asc',
      });

      return withPrincipal(principal, () =>
        withTenant(async (tx) => {
          // The library header travels with the page because a rate means
          // nothing without knowing which version of the library it came from —
          // that is the whole reason estimates pin a library in the first place.
          const library = await currentRateLibrary(tx);
          const page = await listRates(tx, params, {
            libraryId: request.query.libraryId ?? library?.id,
            category: request.query.category,
            includeInactive: request.query.inactive === 'true',
          });
          return { ...page, library };
        }),
      );
    },
  );
}

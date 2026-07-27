/**
 * Contract administration routes.
 *
 * The endpoint worth reading is `POST /contracts/:id/applications/from-progress`
 * at the bottom. It values a payment application from Projects' measured
 * progress — the last link in the chain that runs BOQ → build-up → budget → cut
 * parts → scanned progress → payment application. Contracts does not import
 * Projects and Projects does not import Contracts; this route composes them.
 */
import { parseListParams, withTenant } from '@aerolith/kernel';
import {
  ContractsError,
  activateContract,
  approveVariation,
  certifyApplication,
  contractsSchema,
  createContract,
  createPaymentApplication,
  createVariation,
  getContractPosition,
  getNoticeExposure,
  getVariationPosition,
  listContracts,
  recordPracticalCompletion,
  scheduleRetentionRelease,
  submitApplication,
} from '@aerolith/module-contracts';
import { ProjectsError, getWbsRollUp, projectsSchema } from '@aerolith/module-projects';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { modulesForTenant } from '../bootstrap';
import { authenticate, requirePermission, withPrincipal, type Principal } from '../context';

const MODULE = 'contracts';

async function requireModule(principal: Principal, reply: FastifyReply): Promise<boolean> {
  const modules = await modulesForTenant(principal.context.tenantId);
  if (!modules.enabled.has(MODULE)) {
    await reply.code(404).send({ error: 'Not found.' });
    return false;
  }
  return true;
}

const contractBody = z.object({
  name: z.string().min(1),
  side: z.enum(['receivable', 'payable']).optional(),
  projectId: z.string().uuid().nullish(),
  counterpartyId: z.string().uuid().nullish(),
  externalReference: z.string().nullish(),
  form: z.string().nullish(),
  currencyCode: z.string().length(3).nullish(),
  countryCode: z.string().length(2),
  originalSum: z.number().nonnegative(),
  advanceAmount: z.number().nonnegative().optional(),
  ldPerDay: z.number().nonnegative().nullish(),
  ldCapPercent: z.number().min(0).max(100).nullish(),
  awardedOn: z.string().date().nullish(),
  contractCompletionDate: z.string().date().nullish(),
  sourceTenderId: z.string().uuid().nullish(),
  sourceEstimateId: z.string().uuid().nullish(),
  overrides: z
    .object({
      retentionPercent: z.number().min(0).max(100).optional(),
      retentionCapPercent: z.number().min(0).max(100).optional(),
      paymentTermDays: z.number().int().positive().optional(),
      defectsLiabilityMonths: z.number().int().nonnegative().optional(),
      noticePeriodDays: z.number().int().nonnegative().optional(),
      taxPercent: z.number().min(0).max(100).optional(),
    })
    .optional(),
  lines: z
    .array(
      z.object({
        reference: z.string().nullish(),
        sectionName: z.string().nullish(),
        description: z.string().min(1),
        quantity: z.number(),
        uomCode: z.string().nullish(),
        unitRate: z.number(),
        kind: z.string().optional(),
        sourceEstimateLineId: z.string().uuid().nullish(),
        wbsNodeId: z.string().uuid().nullish(),
      }),
    )
    .optional(),
});

const variationBody = z.object({
  title: z.string().min(1),
  description: z.string().nullish(),
  basis: z.enum(['contract_rates', 'pro_rata', 'star_rate', 'dayworks', 'lump_sum']).optional(),
  lines: z
    .array(
      z.object({
        description: z.string().min(1),
        // Signed: a negative quantity is an omission, which is a variation too.
        quantity: z.number(),
        uomCode: z.string().nullish(),
        unitRate: z.number(),
        unitCost: z.number().nullish(),
        sourceContractLineId: z.string().uuid().nullish(),
        wbsNodeId: z.string().uuid().nullish(),
      }),
    )
    .optional(),
  dayworks: z
    .object({
      labour: z.array(z.object({ hours: z.number(), rate: z.number() })).default([]),
      materials: z.array(z.object({ quantity: z.number(), rate: z.number() })).default([]),
      plant: z.array(z.object({ hours: z.number(), rate: z.number() })).default([]),
      labourUpliftPercent: z.number().optional(),
      materialUpliftPercent: z.number().optional(),
      plantUpliftPercent: z.number().optional(),
    })
    .optional(),
  lumpSumValue: z.number().optional(),
  lumpSumCost: z.number().optional(),
  ohpPercent: z.number().min(0).max(100).optional(),
  instructionReference: z.string().nullish(),
  instructedOn: z.string().date().nullish(),
  instructedBy: z.string().nullish(),
  instructionDocumentId: z.string().uuid().nullish(),
  eotClaimedDays: z.number().int().nullish(),
  percentExecuted: z.number().min(0).max(100).optional(),
});

const applicationBody = z.object({
  periodTo: z.string().date(),
  periodFrom: z.string().date().nullish(),
  workDoneToDate: z.number(),
  variationsToDate: z.number().optional(),
  materialsOnSite: z.number().nonnegative().optional(),
  materialsOnSitePercent: z.number().min(0).max(100).optional(),
  backChargesToDate: z.number().nonnegative().optional(),
  liquidatedDamagesToDate: z.number().nonnegative().optional(),
  retentionReleased: z.number().nonnegative().optional(),
  taxPercent: z.number().min(0).max(100).optional(),
  countryCode: z.string().length(2).optional(),
  notes: z.string().nullish(),
  lines: z
    .array(
      z.object({
        contractLineId: z.string().uuid().nullish(),
        variationId: z.string().uuid().nullish(),
        description: z.string().min(1),
        uomCode: z.string().nullish(),
        unitRate: z.number(),
        quantityContract: z.number().nullish(),
        quantityToDate: z.number(),
      }),
    )
    .optional(),
});


const CONTRACT_SORTS = [
  'number',
  'name',
  'status',
  'currentSum',
  'contractCompletionDate',
  'createdAt',
] as const;

export async function contractRoutes(app: FastifyInstance) {
  // --- The index ----------------------------------------------------------

  app.get<{
    Querystring: {
      page?: string;
      pageSize?: string;
      sort?: string;
      direction?: string;
      q?: string;
      status?: string;
      side?: string;
      projectId?: string;
    };
  }>('/contracts', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'contracts.contract.read');

    const params = parseListParams(request.query, {
      sortable: CONTRACT_SORTS,
      defaultSort: 'createdAt',
      defaultDirection: 'desc',
    });

    const side =
      request.query.side === 'receivable' || request.query.side === 'payable'
        ? request.query.side
        : undefined;

    return withPrincipal(principal, () =>
      withTenant((tx) =>
        listContracts(tx, params, {
          status: request.query.status,
          side,
          projectId: request.query.projectId,
        }),
      ),
    );
  });

  // --- Contracts ----------------------------------------------------------

  app.post('/contracts', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'contracts.contract.write');

    const parsed = contractBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    // `terms` comes back in the response deliberately: the user should see that
    // 10% retention and 60-day terms arrived from the UAE country pack rather
    // than from a default someone guessed.
    return withPrincipal(principal, () => withTenant((tx) => createContract(tx, parsed.data)));
  });

  app.post<{ Params: { id: string } }>('/contracts/:id/activate', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'contracts.contract.execute');

    const parsed = z
      .object({ commencedOn: z.string().date().nullish() })
      .safeParse(request.body ?? {});

    try {
      await withPrincipal(principal, () =>
        withTenant((tx) =>
          activateContract(tx, {
            contractId: request.params.id,
            commencedOn: parsed.success ? parsed.data.commencedOn : null,
          }),
        ),
      );
      return { activated: true };
    } catch (error) {
      if (error instanceof ContractsError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>('/contracts/:id/position', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'contracts.contract.read');

    try {
      return await withPrincipal(principal, () =>
        withTenant((tx) => getContractPosition(tx, { contractId: request.params.id })),
      );
    } catch (error) {
      if (error instanceof ContractsError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>(
    '/contracts/:id/practical-completion',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'contracts.contract.execute');

      const parsed = z
        .object({ practicalCompletionOn: z.string().date() })
        .safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
      }

      try {
        return await withPrincipal(principal, () =>
          withTenant((tx) =>
            recordPracticalCompletion(tx, { contractId: request.params.id, ...parsed.data }),
          ),
        );
      } catch (error) {
        if (error instanceof ContractsError) return reply.code(409).send({ error: error.message });
        throw error;
      }
    },
  );

  // --- Variations ---------------------------------------------------------

  app.post<{ Params: { id: string } }>('/contracts/:id/variations', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'contracts.variation.write');

    const parsed = variationBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      return await withPrincipal(principal, () =>
        withTenant((tx) =>
          createVariation(tx, { contractId: request.params.id, ...parsed.data }),
        ),
      );
    } catch (error) {
      if (error instanceof ContractsError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>('/contracts/variations/:id/approve', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'contracts.variation.approve');

    const parsed = z
      .object({
        approvedValue: z.number(),
        approvedOn: z.string().date(),
        reference: z.string().nullish(),
        eotGrantedDays: z.number().int().nullish(),
      })
      .safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      return await withPrincipal(principal, () =>
        withTenant((tx) => approveVariation(tx, { variationId: request.params.id, ...parsed.data })),
      );
    } catch (error) {
      if (error instanceof ContractsError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>('/contracts/:id/variations', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'contracts.variation.read');

    try {
      return await withPrincipal(principal, () =>
        withTenant(async (tx) => {
          const rows = await tx
            .select()
            .from(contractsSchema.variation)
            .where(
              and(
                eq(contractsSchema.variation.tenantId, principal.context.tenantId),
                eq(contractsSchema.variation.contractId, request.params.id),
              ),
            )
            .orderBy(asc(contractsSchema.variation.numberValue));

          return {
            variations: rows,
            position: await getVariationPosition(tx, { contractId: request.params.id }),
          };
        }),
      );
    } catch (error) {
      if (error instanceof ContractsError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  /** Variations running out of notice time, soonest deadline first. */
  app.get<{ Params: { id: string }; Querystring: { warnWithinDays?: string } }>(
    '/contracts/:id/notice-exposure',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'contracts.variation.read');

      try {
        const at_risk = await withPrincipal(principal, () =>
          withTenant((tx) =>
            getNoticeExposure(tx, {
              contractId: request.params.id,
              warnWithinDays: request.query.warnWithinDays
                ? Number(request.query.warnWithinDays)
                : undefined,
            }),
          ),
        );

        return {
          atRisk: at_risk,
          timeBarredCount: at_risk.filter((r) => r.status.isTimeBarred).length,
          timeBarredValue: at_risk
            .filter((r) => r.status.isTimeBarred)
            .reduce((sum, r) => sum + r.value, 0),
        };
      } catch (error) {
        if (error instanceof ContractsError) return reply.code(404).send({ error: error.message });
        throw error;
      }
    },
  );

  // --- Payment applications -----------------------------------------------

  app.post<{ Params: { id: string } }>('/contracts/:id/applications', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'contracts.application.write');

    const parsed = applicationBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      return await withPrincipal(principal, () =>
        withTenant((tx) =>
          createPaymentApplication(tx, { contractId: request.params.id, ...parsed.data }),
        ),
      );
    } catch (error) {
      if (error instanceof ContractsError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>('/contracts/applications/:id/submit', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'contracts.application.submit');

    const parsed = z.object({ submittedOn: z.string().date() }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      return await withPrincipal(principal, () =>
        withTenant((tx) =>
          submitApplication(tx, { applicationId: request.params.id, ...parsed.data }),
        ),
      );
    } catch (error) {
      if (error instanceof ContractsError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>('/contracts/applications/:id/certify', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'contracts.application.certify');

    const parsed = z
      .object({
        certifiedNet: z.number(),
        certifiedTax: z.number().optional(),
        certifiedOn: z.string().date(),
        certificateReference: z.string().nullish(),
        disallowedReason: z.string().nullish(),
      })
      .safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      return await withPrincipal(principal, () =>
        withTenant((tx) =>
          certifyApplication(tx, { applicationId: request.params.id, ...parsed.data }),
        ),
      );
    } catch (error) {
      if (error instanceof ContractsError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  // --- Retention ----------------------------------------------------------

  app.post<{ Params: { id: string } }>('/contracts/:id/retention/schedule', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'contracts.retention.release');

    try {
      return await withPrincipal(principal, () =>
        withTenant((tx) => scheduleRetentionRelease(tx, { contractId: request.params.id })),
      );
    } catch (error) {
      if (error instanceof ContractsError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  // --- The composition ----------------------------------------------------

  /**
   * Values a payment application from measured site progress.
   *
   * This is the last link in the chain and the part no generic ERP joins up. The
   * WBS roll-up gives earned value per node; each node's contract lines are
   * valued at that percentage; the total becomes `workDoneToDate` on a cumulative
   * application. One transaction, both modules, neither importing the other.
   *
   * Only nodes carrying a `wbsNodeId` on a contract line contribute. That
   * deliberately excludes preliminaries and anything not in the contract BOQ,
   * which must never be certified as measured work — and the response says how
   * much was skipped rather than quietly rounding it in.
   */
  app.post<{ Params: { id: string } }>(
    '/contracts/:id/applications/from-progress',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'contracts.application.write');

      const modules = await modulesForTenant(principal.context.tenantId);
      if (!modules.enabled.has('projects')) {
        return reply.code(409).send({
          error:
            'Valuing from progress needs the Projects module. Enter measured quantities ' +
            'directly instead.',
        });
      }

      const parsed = applicationBody
        .omit({ workDoneToDate: true, lines: true })
        .extend({ projectId: z.string().uuid() })
        .safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
      }

      try {
        return await withPrincipal(principal, () =>
          withTenant(async (tx) => {
            const rollUp = await getWbsRollUp(tx, { projectId: parsed.data.projectId });

            const lines = await tx
              .select()
              .from(contractsSchema.contractLine)
              .where(
                and(
                  eq(contractsSchema.contractLine.tenantId, principal.context.tenantId),
                  eq(contractsSchema.contractLine.contractId, request.params.id),
                ),
              )
              .orderBy(asc(contractsSchema.contractLine.lineNumber));

            if (lines.length === 0) {
              return reply.code(409).send({
                error: 'This contract has no BOQ, so there is nothing to value against progress.',
              });
            }

            const nodeNames = await tx
              .select({ id: projectsSchema.wbsNode.id, code: projectsSchema.wbsNode.code })
              .from(projectsSchema.wbsNode)
              .where(
                and(
                  eq(projectsSchema.wbsNode.tenantId, principal.context.tenantId),
                  eq(projectsSchema.wbsNode.projectId, parsed.data.projectId),
                ),
              );
            const codeById = new Map(nodeNames.map((n) => [n.id, n.code]));

            const valued: {
              contractLineId: string;
              description: string;
              uomCode: string | null;
              unitRate: number;
              quantityContract: number;
              quantityToDate: number;
              percentComplete: number;
              wbsCode: string | null;
            }[] = [];
            const unlinked: string[] = [];

            for (const line of lines) {
              const node = line.wbsNodeId ? rollUp.get(line.wbsNodeId) : undefined;
              if (!node) {
                unlinked.push(line.reference ?? String(line.lineNumber));
                continue;
              }

              const quantityContract = Number(line.quantity);
              valued.push({
                contractLineId: line.id,
                description: line.description,
                uomCode: line.uomCode,
                unitRate: Number(line.unitRate),
                quantityContract,
                quantityToDate: quantityContract * (node.percentComplete / 100),
                percentComplete: node.percentComplete,
                wbsCode: codeById.get(line.wbsNodeId!) ?? null,
              });
            }

            if (valued.length === 0) {
              return reply.code(409).send({
                error:
                  'No contract line is linked to a WBS node, so progress cannot value ' +
                  'this application. Link the BOQ to the work breakdown first.',
              });
            }

            const workDoneToDate = valued.reduce(
              (sum, l) => sum + l.quantityToDate * l.unitRate,
              0,
            );

            const created = await createPaymentApplication(tx, {
              contractId: request.params.id,
              ...parsed.data,
              workDoneToDate,
              lines: valued,
            });

            return {
              ...created,
              valuedFromProgress: {
                linesValued: valued.length,
                // Named, not counted: "3 lines skipped" is a number nobody
                // investigates, and an unvalued BOQ line is unbilled work.
                linesUnlinked: unlinked,
                workDoneToDate,
              },
            };
          }),
        );
      } catch (error) {
        if (error instanceof ContractsError || error instanceof ProjectsError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );
}

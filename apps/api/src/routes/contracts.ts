/**
 * Contract administration routes.
 *
 * The endpoint worth reading is `POST /contracts/:id/applications/from-progress`
 * at the bottom. It values a payment application from Projects' measured
 * progress — the last link in the chain that runs BOQ → build-up → budget → cut
 * parts → scanned progress → payment application. Contracts does not import
 * Projects and Projects does not import Contracts; this route composes them.
 */
import { parseListParams, schema, withTenant } from '@aerolith/kernel';
import {
  BACK_CHARGE_SORTS,
  BackChargeError,
  CORRESPONDENCE_SORTS,
  ContractsError,
  CorrespondenceError,
  RETENTION_SORTS,
  SUBMITTAL_SORTS,
  SubmittalError,
  activateContract,
  approveVariation,
  certifyApplication,
  contractsSchema,
  createBackCharge,
  createContract,
  createCorrespondence,
  createPaymentApplication,
  createSubmittal,
  createVariation,
  getContractPosition,
  getNoticeExposure,
  getSubmittalDetail,
  getVariationPosition,
  listBackCharges,
  listContracts,
  listCorrespondence,
  listPaymentApplications,
  listRetention,
  listSubmittals,
  listVariations,
  noticeStatus,
  recordReview,
  recordVariationNotice,
  recordPracticalCompletion,
  scheduleRetentionRelease,
  submitApplication,
  submitRevision,
  summariseRetention,
  updateBackCharge,
  updateCorrespondence,
} from '@aerolith/module-contracts';
import { ProjectsError, getWbsRollUp, projectsSchema } from '@aerolith/module-projects';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { modulesForTenant } from '../bootstrap';
import { renderApplicationPdf } from '../documents/paymentApplication';
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

const backChargeBody = z.object({
  reference: z.string().min(1).max(48),
  description: z.string().min(1),
  category: z.enum(['damage', 'attendance', 'rectification', 'materials', 'other']).optional(),
  amount: z.number().positive(),
  incurredOn: z.string().date(),
  sourceSnagId: z.string().uuid().nullish(),
  documentIds: z.array(z.string().uuid()).optional(),
});

const updateBackChargeBody = backChargeBody
  .omit({ reference: true })
  .partial()
  .extend({
    status: z.enum(['raised', 'notified', 'agreed', 'disputed', 'recovered', 'written_off']).optional(),
    notifiedOn: z.string().date().nullish(),
    agreedAmount: z.number().nonnegative().nullish(),
  });

const correspondenceBody = z.object({
  type: z.enum(['rfi', 'notice', 'eot_claim', 'ncr', 'instruction', 'letter']),
  reference: z.string().min(1).max(64),
  subject: z.string().min(1),
  direction: z.enum(['incoming', 'outgoing']).optional(),
  issuedOn: z.string().date(),
  responseDueOn: z.string().date().nullish(),
  isContractual: z.boolean().optional(),
  documentId: z.string().uuid().nullish(),
});

const updateCorrespondenceBody = z.object({
  respondedOn: z.string().date().nullish(),
  status: z.enum(['open', 'responded', 'closed', 'overdue']).optional(),
  responseDueOn: z.string().date().nullish(),
  variationId: z.string().uuid().nullish(),
  documentId: z.string().uuid().nullish(),
});

const submittalBody = z.object({
  title: z.string().min(1),
  submittalType: z.enum([
    'shop_drawing',
    'material_sample',
    'method_statement',
    'product_data',
    'mock_up',
    'other',
  ]),
  specSection: z.string().nullish(),
});

const submittalRevisionBody = z.object({
  documentId: z.string().uuid().nullish(),
  submittedOn: z.string().date(),
  dueOn: z.string().date().nullish(),
});

const submittalReviewBody = z.object({
  decision: z.enum(['approved', 'approved_as_noted', 'revise_resubmit', 'rejected']),
  reviewedOn: z.string().date(),
  reviewComments: z.string().nullish(),
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


const VARIATION_SORTS = [
  'number',
  'title',
  'status',
  'instructedOn',
  'quotedValue',
  'createdAt',
] as const;

const APPLICATION_SORTS = [
  'number',
  'status',
  'periodTo',
  'dueOn',
  'totalApplied',
  'createdAt',
] as const;

const CONTRACT_SORTS = [
  'number',
  'name',
  'status',
  'currentSum',
  'contractCompletionDate',
  'createdAt',
] as const;

interface ListQuery {
  page?: string;
  pageSize?: string;
  sort?: string;
  direction?: string;
  q?: string;
  status?: string;
}

export async function contractRoutes(app: FastifyInstance) {
  // --- Registers ----------------------------------------------------------

  app.get<{
    Querystring: ListQuery & {
      contractId?: string;
      type?: string;
      open?: string;
      contractual?: string;
    };
  }>('/contracts/correspondence', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'contracts.contract.read');

    const params = parseListParams(request.query, {
      sortable: CORRESPONDENCE_SORTS,
      // Soonest response deadline first. This register exists because a notice
      // nobody answered on time is an entitlement quietly lost.
      defaultSort: 'responseDueOn',
      defaultDirection: 'asc',
    });

    return withPrincipal(principal, () =>
      withTenant((tx) =>
        listCorrespondence(tx, params, {
          contractId: request.query.contractId,
          type: request.query.type,
          status: request.query.status,
          openOnly: request.query.open === 'true',
          contractualOnly: request.query.contractual === 'true',
        }),
      ),
    );
  });

  app.post<{ Params: { id: string } }>('/contracts/:id/correspondence', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'contracts.correspondence.manage');

    const parsed = correspondenceBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      return await withPrincipal(principal, () =>
        withTenant((tx) =>
          createCorrespondence(tx, { contractId: request.params.id, ...parsed.data }),
        ),
      );
    } catch (error) {
      if (error instanceof CorrespondenceError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>('/contracts/correspondence/:id', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'contracts.correspondence.manage');

    const parsed = updateCorrespondenceBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      await withPrincipal(principal, () =>
        withTenant((tx) =>
          updateCorrespondence(tx, { correspondenceId: request.params.id, ...parsed.data }),
        ),
      );
    } catch (error) {
      if (error instanceof CorrespondenceError) return reply.code(409).send({ error: error.message });
      throw error;
    }

    return { updated: true };
  });

  app.get<{
    Querystring: ListQuery & { contractId?: string; ballInCourt?: string; open?: string };
  }>('/contracts/submittals', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'contracts.submittal.manage');

    const params = parseListParams(request.query, {
      sortable: SUBMITTAL_SORTS,
      defaultSort: 'dueOn',
      defaultDirection: 'asc',
    });

    return withPrincipal(principal, () =>
      withTenant((tx) =>
        listSubmittals(tx, params, {
          contractId: request.query.contractId,
          status: request.query.status,
          ballInCourt: request.query.ballInCourt,
          openOnly: request.query.open === 'true',
        }),
      ),
    );
  });

  app.get<{ Params: { id: string } }>('/contracts/submittals/:id', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'contracts.submittal.manage');

    const detail = await withPrincipal(principal, () =>
      withTenant((tx) => getSubmittalDetail(tx, request.params.id)),
    );
    if (!detail) return reply.code(404).send({ error: 'Submittal not found.' });
    return detail;
  });

  app.post<{ Params: { id: string } }>('/contracts/:id/submittals', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'contracts.submittal.manage');

    const parsed = submittalBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      return await withPrincipal(principal, () =>
        withTenant((tx) => createSubmittal(tx, { contractId: request.params.id, ...parsed.data })),
      );
    } catch (error) {
      if (error instanceof SubmittalError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>(
    '/contracts/submittals/:id/revisions',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'contracts.submittal.manage');

      const parsed = submittalRevisionBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
      }

      try {
        return await withPrincipal(principal, () =>
          withTenant((tx) =>
            submitRevision(tx, { submittalId: request.params.id, ...parsed.data }),
          ),
        );
      } catch (error) {
        if (error instanceof SubmittalError) return reply.code(409).send({ error: error.message });
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/contracts/submittals/:id/review',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'contracts.submittal.manage');

      const parsed = submittalReviewBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
      }

      try {
        await withPrincipal(principal, () =>
          withTenant((tx) => recordReview(tx, { submittalId: request.params.id, ...parsed.data })),
        );
      } catch (error) {
        if (error instanceof SubmittalError) return reply.code(409).send({ error: error.message });
        throw error;
      }

      return { reviewed: true };
    },
  );

  app.get<{ Querystring: ListQuery & { contractId?: string; state?: string } }>(
    '/contracts/retention',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'contracts.contract.read');

      const params = parseListParams(request.query, {
        sortable: RETENTION_SORTS,
        defaultSort: 'dueOn',
        defaultDirection: 'asc',
      });

      const state =
        request.query.state === 'held' ||
        request.query.state === 'due' ||
        request.query.state === 'released'
          ? request.query.state
          : undefined;

      return withPrincipal(principal, () =>
        withTenant(async (tx) => {
          // The summary spans the register, not the page. The total held is the
          // number this screen exists to produce and it must not change as
          // somebody pages through it.
          const [page, summary] = await Promise.all([
            listRetention(tx, params, { contractId: request.query.contractId, state }),
            summariseRetention(tx, { contractId: request.query.contractId }),
          ]);
          return { ...page, summary };
        }),
      );
    },
  );

  app.get<{ Querystring: ListQuery & { contractId?: string } }>(
    '/contracts/back-charges',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'contracts.contract.read');

      const params = parseListParams(request.query, {
        sortable: BACK_CHARGE_SORTS,
        defaultSort: 'incurredOn',
        defaultDirection: 'desc',
      });

      return withPrincipal(principal, () =>
        withTenant((tx) =>
          listBackCharges(tx, params, {
            contractId: request.query.contractId,
            status: request.query.status,
          }),
        ),
      );
    },
  );

  app.post<{ Params: { id: string } }>('/contracts/:id/back-charges', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'contracts.back_charge.manage');

    const parsed = backChargeBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      return await withPrincipal(principal, () =>
        withTenant((tx) =>
          createBackCharge(tx, { contractId: request.params.id, ...parsed.data }),
        ),
      );
    } catch (error) {
      if (error instanceof BackChargeError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>('/contracts/back-charges/:id', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'contracts.back_charge.manage');

    const parsed = updateBackChargeBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      await withPrincipal(principal, () =>
        withTenant((tx) => updateBackCharge(tx, { backChargeId: request.params.id, ...parsed.data })),
      );
    } catch (error) {
      if (error instanceof BackChargeError) return reply.code(409).send({ error: error.message });
      throw error;
    }

    return { updated: true };
  });

  // --- The index ----------------------------------------------------------

  /**
   * Variations across every contract, with the notice clock resolved per row.
   *
   * Sorted by instruction date descending by default: the newest instruction is
   * the one whose clock has most recently started, and the register is read to
   * find out what still needs a notice.
   */
  app.get<{
    Querystring: {
      page?: string;
      pageSize?: string;
      sort?: string;
      direction?: string;
      q?: string;
      status?: string;
      contractId?: string;
      atRisk?: string;
    };
  }>('/contracts/variations', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'contracts.variation.read');

    const params = parseListParams(request.query, {
      sortable: VARIATION_SORTS,
      defaultSort: 'instructedOn',
      defaultDirection: 'desc',
    });

    return withPrincipal(principal, () =>
      withTenant((tx) =>
        listVariations(tx, params, {
          status: request.query.status,
          contractId: request.query.contractId,
          atRiskOnly: request.query.atRisk === 'true',
        }),
      ),
    );
  });

  /**
   * Payment applications across every contract.
   *
   * Registered BEFORE `/contracts/:id/...` would otherwise claim it: Fastify
   * routes on specificity rather than declaration order, so this is safe, but
   * keeping it adjacent to the contract list is where a reader looks for it.
   */
  app.get<{
    Querystring: {
      page?: string;
      pageSize?: string;
      sort?: string;
      direction?: string;
      q?: string;
      status?: string;
      contractId?: string;
      outstanding?: string;
    };
  }>('/contracts/applications', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'contracts.application.read');

    const params = parseListParams(request.query, {
      sortable: APPLICATION_SORTS,
      // Most recent period first: an applications register is read newest-down,
      // because the one being argued about is nearly always the last one.
      defaultSort: 'periodTo',
      defaultDirection: 'desc',
    });

    return withPrincipal(principal, () =>
      withTenant((tx) =>
        listPaymentApplications(tx, params, {
          status: request.query.status,
          contractId: request.query.contractId,
          outstandingOnly: request.query.outstanding === 'true',
        }),
      ),
    );
  });

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

  /**
   * One variation, with its priced lines and the notice clock resolved.
   *
   * The clock comes from the server for the same reason it does on the register:
   * it is a contractual rule depending on the contract's own notice period, and
   * two clients disagreeing about whether a claim is still alive because their
   * machines disagree about the date is not a bug worth having. Both call the
   * same domain function — that, not the list query, is the single place.
   */
  app.get<{ Params: { id: string } }>('/contracts/variations/:id', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'contracts.variation.read');

    return withPrincipal(principal, () =>
      withTenant(async (tx) => {
        const tenantId = principal.context.tenantId;

        const [row] = await tx
          .select()
          .from(contractsSchema.variation)
          .where(
            and(
              eq(contractsSchema.variation.tenantId, tenantId),
              eq(contractsSchema.variation.id, request.params.id),
            ),
          );

        if (!row) return reply.code(404).send({ error: 'Not found.' });

        const [head] = await tx
          .select({
            id: contractsSchema.contract.id,
            number: contractsSchema.contract.number,
            name: contractsSchema.contract.name,
            currencyCode: contractsSchema.contract.currencyCode,
            noticePeriodDays: contractsSchema.contract.noticePeriodDays,
          })
          .from(contractsSchema.contract)
          .where(
            and(
              eq(contractsSchema.contract.tenantId, tenantId),
              eq(contractsSchema.contract.id, row.contractId),
            ),
          );

        const lines = await tx
          .select()
          .from(contractsSchema.variationLine)
          .where(
            and(
              eq(contractsSchema.variationLine.tenantId, tenantId),
              eq(contractsSchema.variationLine.variationId, request.params.id),
            ),
          )
          .orderBy(asc(contractsSchema.variationLine.lineNumber));

        // No instruction date means no event for the clock to run from, which is
        // a real state — an identified-but-uninstructed variation has no
        // deadline yet — and is reported as null rather than as "not barred".
        const notice =
          row.instructedOn && head?.noticePeriodDays != null
            ? noticeStatus({
                eventOn: new Date(`${row.instructedOn}T00:00:00Z`),
                noticePeriodDays: head.noticePeriodDays,
                noticeGivenOn: row.noticeGivenOn
                  ? new Date(`${row.noticeGivenOn}T00:00:00Z`)
                  : null,
              })
            : null;

        return {
          variation: row,
          contract: head ?? null,
          lines,
          notice: notice
            ? {
                deadlineOn: notice.deadlineOn.toISOString().slice(0, 10),
                daysRemaining: notice.daysRemaining,
                isGiven: notice.isGiven,
                isTimeBarred: notice.isTimeBarred,
                wasLate: notice.wasLate,
              }
            : null,
        };
      }),
    );
  });

  /**
   * Records that written notice was given.
   *
   * `contracts.variation.write` rather than the approval permission: giving
   * notice is administrative and time-critical, and gating it behind the person
   * who approves variations is how a deadline gets missed while somebody is on
   * leave.
   */
  app.post<{ Params: { id: string } }>('/contracts/variations/:id/notice', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'contracts.variation.write');

    const parsed = z
      .object({
        noticeGivenOn: z.string().date(),
        noticeReference: z.string().trim().min(1).nullish(),
      })
      .safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      return await withPrincipal(principal, () =>
        withTenant((tx) =>
          recordVariationNotice(tx, { variationId: request.params.id, ...parsed.data }),
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

  /**
   * One payment application, with its measured lines and the contract it sits on.
   *
   * The contract's number and currency come back with it rather than being
   * fetched separately: a certificate screen that renders an amount without
   * naming the currency is a screen nobody can safely act on.
   */
  app.get<{ Params: { id: string } }>('/contracts/applications/:id', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'contracts.application.read');

    return withPrincipal(principal, () =>
      withTenant(async (tx) => {
        const tenantId = principal.context.tenantId;

        const [application] = await tx
          .select()
          .from(contractsSchema.paymentApplication)
          .where(
            and(
              eq(contractsSchema.paymentApplication.tenantId, tenantId),
              eq(contractsSchema.paymentApplication.id, request.params.id),
            ),
          );

        if (!application) return reply.code(404).send({ error: 'Not found.' });

        const [head] = await tx
          .select({
            id: contractsSchema.contract.id,
            number: contractsSchema.contract.number,
            name: contractsSchema.contract.name,
            currencyCode: contractsSchema.contract.currencyCode,
            paymentTermDays: contractsSchema.contract.paymentTermDays,
            retentionPercent: contractsSchema.contract.retentionPercent,
          })
          .from(contractsSchema.contract)
          .where(
            and(
              eq(contractsSchema.contract.tenantId, tenantId),
              eq(contractsSchema.contract.id, application.contractId),
            ),
          );

        const lines = await tx
          .select()
          .from(contractsSchema.paymentApplicationLine)
          .where(
            and(
              eq(contractsSchema.paymentApplicationLine.tenantId, tenantId),
              eq(contractsSchema.paymentApplicationLine.applicationId, request.params.id),
            ),
          );

        return { application, contract: head ?? null, lines };
      }),
    );
  });

  /**
   * The application as a PDF you can send to the client.
   *
   * Generated on demand rather than stored, because the certified figures change
   * after submission and a stored file would be the version before the client
   * replied. The document is a view of the record; the record is the record.
   *
   * `Content-Disposition: attachment` with the application's own number as the
   * filename: what lands in somebody's downloads folder should be findable a
   * month later, and `download.pdf` is not.
   */
  app.get<{ Params: { id: string } }>(
    '/contracts/applications/:id/pdf',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'contracts.application.read');

      const tenantId = principal.context.tenantId;

      const document = await withPrincipal(principal, () =>
        withTenant(async (tx) => {
          const [application] = await tx
            .select()
            .from(contractsSchema.paymentApplication)
            .where(
              and(
                eq(contractsSchema.paymentApplication.tenantId, tenantId),
                eq(contractsSchema.paymentApplication.id, request.params.id),
              ),
            );

          if (!application) return null;

          const [head] = await tx
            .select()
            .from(contractsSchema.contract)
            .where(
              and(
                eq(contractsSchema.contract.tenantId, tenantId),
                eq(contractsSchema.contract.id, application.contractId),
              ),
            );

          const lines = await tx
            .select()
            .from(contractsSchema.paymentApplicationLine)
            .where(
              and(
                eq(contractsSchema.paymentApplicationLine.tenantId, tenantId),
                eq(contractsSchema.paymentApplicationLine.applicationId, request.params.id),
              ),
            )
            .orderBy(asc(contractsSchema.paymentApplicationLine.createdAt));

          // `tenant` is keyed on its own id under RLS rather than on
          // `tenant_id`, which is why this reads back the row rather than
          // trusting the request context for the letterhead.
          const [tenant] = await tx
            .select()
            .from(schema.tenant)
            .where(eq(schema.tenant.id, tenantId));

          // The TRN belongs to a LEGAL ENTITY, not to the workspace: a group
          // with a Dubai company and a Doha branch has two, and putting the
          // wrong one on a tax invoice is a filing problem rather than a
          // cosmetic one. A contract does not currently name its entity, so
          // this takes the default and will take the contract's the day that
          // column exists.
          const [entity] = await tx
            .select({ taxRegistrationNumber: schema.legalEntity.taxRegistrationNumber })
            .from(schema.legalEntity)
            .where(
              and(
                eq(schema.legalEntity.tenantId, tenantId),
                eq(schema.legalEntity.isDefault, true),
              ),
            )
            .limit(1);

          const [project] = head?.projectId
            ? await tx
                .select({ code: schema.project.code, name: schema.project.name })
                .from(schema.project)
                .where(
                  and(eq(schema.project.tenantId, tenantId), eq(schema.project.id, head.projectId)),
                )
            : [];

          const [client] = head?.counterpartyId
            ? await tx
                .select({ name: schema.party.name })
                .from(schema.party)
                .where(
                  and(
                    eq(schema.party.tenantId, tenantId),
                    eq(schema.party.id, head.counterpartyId),
                  ),
                )
            : [];

          return renderApplicationPdf({
            tenant: {
              name: tenant?.name ?? 'Aerolith',
              locale: principal.context.locale ?? tenant?.defaultLocale ?? 'en',
              currencyCode: tenant?.baseCurrencyCode ?? null,
              taxRegistrationNumber: entity?.taxRegistrationNumber ?? null,
            },
            contract: head
              ? {
                  number: head.number,
                  name: head.name,
                  currencyCode: head.currencyCode,
                  paymentTermDays: head.paymentTermDays,
                  retentionPercent: head.retentionPercent,
                }
              : null,
            project: project ?? null,
            client: client ?? null,
            application,
            lines,
          });
        }),
      );

      if (!document) return reply.code(404).send({ error: 'Not found.' });

      const [row] = await withPrincipal(principal, () =>
        withTenant((tx) =>
          tx
            .select({ number: contractsSchema.paymentApplication.number })
            .from(contractsSchema.paymentApplication)
            .where(eq(contractsSchema.paymentApplication.id, request.params.id)),
        ),
      );

      return reply
        .header('content-type', 'application/pdf')
        .header(
          'content-disposition',
          `attachment; filename="${(row?.number ?? 'payment-application').replace(/[^A-Za-z0-9._-]/g, '-')}.pdf"`,
        )
        .send(Buffer.from(document));
    },
  );

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

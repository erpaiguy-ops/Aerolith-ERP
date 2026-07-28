/**
 * Projects routes.
 *
 * Note the margin gate on the position endpoint: `projects.cost.read` gets you
 * the cost report, and `projects.margin.view` is what gets you the forecast
 * margin beside it. A site engineer needs the first and rarely the second.
 */
import { parseListParams, withTenant } from '@aerolith/kernel';
import {
  COST_SORTS,
  PROGRESS_SORTS,
  ProjectsError,
  SNAG_SORTS,
  approveBudget,
  createBudgetVersion,
  createWbs,
  getCostEntries,
  listCostEntries,
  listProgress,
  listSnags,
  getCostSummary,
  summariseCosts,
  getProjectPosition,
  getWbsRollUp,
  listProjects,
  postCost,
  projectsSchema,
  recordCommitment,
  recordProgress,
  reverseCost,
} from '@aerolith/module-projects';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { modulesForTenant } from '../bootstrap';
import { authenticate, requirePermission, withPrincipal, type Principal } from '../context';

const MODULE = 'projects';

async function requireModule(principal: Principal, reply: FastifyReply): Promise<boolean> {
  const modules = await modulesForTenant(principal.context.tenantId);
  if (!modules.enabled.has(MODULE)) {
    await reply.code(404).send({ error: 'Not found.' });
    return false;
  }
  return true;
}

const costCategorySchema = z.enum([
  'material',
  'labour',
  'machine',
  'finishing',
  'hardware',
  'subcontract',
  'transport',
  'preliminaries',
  'contingency',
  'other',
]);

const wbsBody = z.object({
  nodes: z
    .array(
      z.object({
        code: z.string().min(1),
        name: z.string().min(1),
        parentCode: z.string().nullish(),
        ruleOfCredit: z
          .enum(['binary', 'started_finished', 'units', 'milestone', 'manual'])
          .optional(),
        unitsPlanned: z.number().nonnegative().nullish(),
        uomCode: z.string().nullish(),
        creditMilestones: z
          .array(
            z.object({
              key: z.string().min(1),
              label: z.string().optional(),
              weightPercent: z.number().min(0).max(100),
            }),
          )
          .optional(),
      }),
    )
    .min(1),
});

const budgetBody = z.object({
  source: z.enum(['estimate', 'manual', 'variation']).optional(),
  sourceEstimateId: z.string().uuid().nullish(),
  sourceVariationId: z.string().uuid().nullish(),
  contingencyAmount: z.number().nonnegative().optional(),
  note: z.string().nullish(),
  lines: z
    .array(
      z.object({
        wbsCode: z.string().nullish(),
        category: costCategorySchema,
        description: z.string().min(1),
        quantity: z.number().optional(),
        uomCode: z.string().nullish(),
        unitCost: z.number().optional(),
        lineCost: z.number(),
        lineValue: z.number().optional(),
        sourceEstimateLineId: z.string().uuid().nullish(),
        itemId: z.string().uuid().nullish(),
      }),
    )
    .min(1),
});

const progressBody = z.object({
  periodEnd: z.string().date(),
  measurements: z
    .array(
      z.object({
        wbsCode: z.string().min(1),
        unitsComplete: z.number().nonnegative().optional(),
        started: z.boolean().optional(),
        finished: z.boolean().optional(),
        milestonesAchieved: z.array(z.string()).optional(),
        manualPercent: z.number().min(0).max(100).optional(),
        evidenceDocumentId: z.string().uuid().nullish(),
        note: z.string().nullish(),
      }),
    )
    .min(1),
});

/**
 * Columns this list may be sorted by.
 *
 * A whitelist rather than validation: Drizzle parameterises values but never
 * identifiers, so a sort key taken from the query string and interpolated is an
 * injection however carefully it is escaped afterwards.
 */
const PROJECT_SORTS = [
  'code',
  'name',
  'status',
  'contractValue',
  'endDate',
  'createdAt',
] as const;

interface ListQuery {
  page?: string;
  pageSize?: string;
  sort?: string;
  direction?: string;
  q?: string;
  status?: string;
  projectId?: string;
}

export async function projectRoutes(app: FastifyInstance) {
  // --- Registers ----------------------------------------------------------
  //
  // Cross-project on purpose. The per-project views already exist; these answer
  // "where is the business", which no per-project screen can produce.

  app.get<{ Querystring: ListQuery & { severity?: string; open?: string; overdue?: string } }>(
    '/projects/snags',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'projects.snag.read');

      const params = parseListParams(request.query, {
        sortable: SNAG_SORTS,
        // By target date: a snag list ordered any other way buries the one that
        // was due last week, and critical snags are what stop a handover.
        defaultSort: 'targetDate',
        defaultDirection: 'asc',
      });

      return withPrincipal(principal, () =>
        withTenant((tx) =>
          listSnags(tx, params, {
            projectId: request.query.projectId,
            status: request.query.status,
            severity: request.query.severity,
            openOnly: request.query.open === 'true',
            overdueOnly: request.query.overdue === 'true',
          }),
        ),
      );
    },
  );

  app.get<{ Querystring: ListQuery & { category?: string; kind?: string; hideReversed?: string } }>(
    '/projects/costs',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'projects.cost.read');

      const params = parseListParams(request.query, {
        sortable: COST_SORTS,
        defaultSort: 'postedOn',
        defaultDirection: 'desc',
      });

      const kind =
        request.query.kind === 'accrual' || request.query.kind === 'actual'
          ? request.query.kind
          : undefined;

      return withPrincipal(principal, () =>
        withTenant(async (tx) => {
          const [page, summary] = await Promise.all([
            listCostEntries(tx, params, {
              projectId: request.query.projectId,
              category: request.query.category,
              kind,
              hideReversed: request.query.hideReversed === 'true',
            }),
            summariseCosts(tx, { projectId: request.query.projectId }),
          ]);
          return { ...page, summary };
        }),
      );
    },
  );

  app.get<{ Querystring: ListQuery & { periodEnd?: string; selfAssessed?: string } }>(
    '/projects/progress',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      // `projects.project.read`, because there is no progress-specific READ
      // permission — only `progress.record`, which is a write. Measured progress
      // is part of a project's position and no more sensitive than it; gating a
      // read behind a write permission would deny it to everyone who is meant to
      // see the number and not allowed to change it.
      requirePermission(principal, 'projects.project.read');

      const params = parseListParams(request.query, {
        sortable: PROGRESS_SORTS,
        defaultSort: 'periodEnd',
        defaultDirection: 'desc',
      });

      return withPrincipal(principal, () =>
        withTenant((tx) =>
          listProgress(tx, params, {
            projectId: request.query.projectId,
            periodEnd: request.query.periodEnd,
            selfAssessedOnly: request.query.selfAssessed === 'true',
          }),
        ),
      );
    },
  );

  // --- The index ----------------------------------------------------------

  app.get<{
    Querystring: {
      page?: string;
      pageSize?: string;
      sort?: string;
      direction?: string;
      q?: string;
      status?: string;
    };
  }>('/projects', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'projects.project.read');

    const params = parseListParams(request.query, {
      sortable: PROJECT_SORTS,
      // Newest first. A project list opened cold is nearly always somebody
      // looking for the job they just heard about, not the one from 2019.
      defaultSort: 'createdAt',
      defaultDirection: 'desc',
    });

    return withPrincipal(principal, () =>
      withTenant((tx) => listProjects(tx, params, { status: request.query.status })),
    );
  });

  // --- Work breakdown -----------------------------------------------------

  app.post<{ Params: { id: string } }>('/projects/:id/wbs', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'projects.wbs.manage');

    const parsed = wbsBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      const result = await withPrincipal(principal, () =>
        withTenant((tx) => createWbs(tx, { projectId: request.params.id, nodes: parsed.data.nodes })),
      );
      return { created: result.created };
    } catch (error) {
      if (error instanceof ProjectsError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>('/projects/:id/wbs', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'projects.project.read');

    return withPrincipal(principal, () =>
      withTenant(async (tx) => {
        const nodes = await tx
          .select()
          .from(projectsSchema.wbsNode)
          .where(
            and(
              eq(projectsSchema.wbsNode.tenantId, principal.context.tenantId),
              eq(projectsSchema.wbsNode.projectId, request.params.id),
            ),
          )
          .orderBy(asc(projectsSchema.wbsNode.path));

        const rolled = await getWbsRollUp(tx, { projectId: request.params.id });

        return {
          nodes: nodes.map((node) => {
            const roll = rolled.get(node.id);
            return {
              ...node,
              // The node's own figures are on the row; these are the subtree's,
              // which is what a tree view actually renders.
              rolledUpBudgetValue: roll?.totalBudgetValue ?? 0,
              rolledUpPercentComplete: roll?.percentComplete ?? 0,
              rolledUpEarnedValue: roll?.earnedValue ?? 0,
              containsManualClaims: roll?.containsManualClaims ?? false,
            };
          }),
        };
      }),
    );
  });

  // --- Budget -------------------------------------------------------------

  app.post<{ Params: { id: string } }>('/projects/:id/budgets', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'projects.project.write');

    const parsed = budgetBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      return await withPrincipal(principal, () =>
        withTenant((tx) =>
          createBudgetVersion(tx, { projectId: request.params.id, ...parsed.data }),
        ),
      );
    } catch (error) {
      if (error instanceof ProjectsError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>('/projects/budgets/:id/approve', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'projects.budget.approve');

    try {
      return await withPrincipal(principal, () =>
        withTenant((tx) => approveBudget(tx, { budgetId: request.params.id })),
      );
    } catch (error) {
      if (error instanceof ProjectsError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  // --- Progress -----------------------------------------------------------

  app.post<{ Params: { id: string } }>('/projects/:id/progress', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'projects.progress.record');

    const parsed = progressBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    // A typed percentage is a different act from a measurement, so it needs the
    // dangerous permission even though it arrives on the same endpoint.
    if (parsed.data.measurements.some((m) => m.manualPercent !== undefined)) {
      requirePermission(principal, 'projects.progress.override');
    }

    try {
      return await withPrincipal(principal, () =>
        withTenant((tx) => recordProgress(tx, { projectId: request.params.id, ...parsed.data })),
      );
    } catch (error) {
      if (error instanceof ProjectsError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  // --- Cost ---------------------------------------------------------------

  app.post<{ Params: { id: string } }>('/projects/:id/costs', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'projects.cost.post');

    const parsed = z
      .object({
        wbsNodeId: z.string().uuid().nullish(),
        postedOn: z.string().date(),
        category: costCategorySchema,
        description: z.string().min(1),
        sourceModule: z.string().min(1),
        sourceEntityType: z.string().nullish(),
        sourceEntityId: z.string().uuid().nullish(),
        amount: z.number(),
        currencyCode: z.string().length(3).nullish(),
        quantity: z.number().nullish(),
        uomCode: z.string().nullish(),
        isAccrual: z.boolean().optional(),
      })
      .safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    return withPrincipal(principal, () =>
      withTenant((tx) => postCost(tx, { projectId: request.params.id, ...parsed.data })),
    );
  });

  app.post<{ Params: { id: string } }>('/projects/costs/:id/reverse', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'projects.cost.post');

    const parsed = z
      .object({ postedOn: z.string().date(), reason: z.string().min(1) })
      .safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      return await withPrincipal(principal, () =>
        withTenant((tx) => reverseCost(tx, { entryId: request.params.id, ...parsed.data })),
      );
    } catch (error) {
      if (error instanceof ProjectsError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>('/projects/:id/costs', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'projects.cost.read');

    return withPrincipal(principal, () =>
      withTenant(async (tx) => ({
        summary: await getCostSummary(tx, { projectId: request.params.id }),
        entries: await getCostEntries(tx, { projectId: request.params.id }),
      })),
    );
  });

  app.post<{ Params: { id: string } }>('/projects/:id/commitments', async (request, reply) => {
    const principal = await authenticate(request);
    if (!(await requireModule(principal, reply))) return reply;
    requirePermission(principal, 'projects.cost.post');

    const parsed = z
      .object({
        wbsNodeId: z.string().uuid().nullish(),
        type: z.enum(['purchase_order', 'subcontract', 'other']),
        reference: z.string().min(1),
        partyId: z.string().uuid().nullish(),
        description: z.string().nullish(),
        category: costCategorySchema,
        committedAmount: z.number().nonnegative(),
        currencyCode: z.string().length(3).nullish(),
        sourceModule: z.string().min(1),
        sourceEntityId: z.string().uuid().nullish(),
        expectedOn: z.string().date().nullish(),
      })
      .safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    return withPrincipal(principal, () =>
      withTenant((tx) => recordCommitment(tx, { projectId: request.params.id, ...parsed.data })),
    );
  });

  // --- Commercial position ------------------------------------------------

  /**
   * Earned value, forecast cost and — for those allowed to see it — forecast
   * margin. `contractValue` is a query parameter because on a live job it is the
   * contract sum including approved variations, which lives in Contract
   * Administration; Projects must not import it.
   */
  app.get<{ Params: { id: string }; Querystring: { contractValue?: string; plannedValue?: string; method?: string } }>(
    '/projects/:id/position',
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!(await requireModule(principal, reply))) return reply;
      requirePermission(principal, 'projects.cost.read');

      const method = request.query.method;
      if (method && !['budget_rate', 'performance_rate', 'cost_and_schedule'].includes(method)) {
        return reply.code(400).send({ error: `Unknown forecast method "${method}".` });
      }

      const position = await withPrincipal(principal, () =>
        withTenant((tx) =>
          getProjectPosition(tx, {
            projectId: request.params.id,
            contractValue: request.query.contractValue
              ? Number(request.query.contractValue)
              : undefined,
            plannedValue: request.query.plannedValue ? Number(request.query.plannedValue) : undefined,
            method: method as never,
          }),
        ),
      );

      const canSeeMargin =
        principal.isOwner || principal.context.permissions?.has('projects.margin.view');
      if (canSeeMargin) return position;

      // Cost performance without the margin. The overrun stays visible — that is
      // the site team's problem to fix — while what the company makes on the job
      // does not. Built by naming what is returned rather than by deleting keys,
      // so a field added to MarginPosition later is hidden by default.
      return {
        summary: position.summary,
        metrics: position.metrics,
        forecast: position.forecast,
        budgetAtCompletion: position.budgetAtCompletion,
        forecastCost: position.forecastCost,
        marginHidden: true,
      };
    },
  );
}

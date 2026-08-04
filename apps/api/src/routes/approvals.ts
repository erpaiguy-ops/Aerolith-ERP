/**
 * Approval inbox and decisions.
 *
 * Deliberately generic: it serves purchase orders, variations, stock write-offs
 * and everything a future module registers, because the engine does not know
 * what any of them are.
 */
import { decide, recall, schema, withTenant } from '@aerolith/kernel';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { authenticate, requirePermission, withPrincipal } from '../context';
import {
  WorkflowError,
  approvableEntityTypes,
  createWorkflow,
  listWorkflows,
  publishWorkflowVersion,
  updateWorkflow,
} from '../workflows';

const decideBody = z.object({
  decision: z.enum(['approved', 'rejected']),
  comment: z.string().max(4000).optional(),
  documentIds: z.array(z.string().uuid()).optional(),
});

const APPROVER_TYPES = [
  'role',
  'user',
  'manager_of_requester',
  'department_head',
  'project_manager',
  'legal_entity_owner',
  'cost_centre_owner',
  'dynamic',
] as const;

const stepSchema = z.object({
  sequence: z.number().int().min(1),
  name: z.string().min(1),
  approverType: z.enum(APPROVER_TYPES),
  approverRef: z.string().optional(),
  quorum: z.enum(['all', 'any', 'majority', 'count']).optional(),
  quorumCount: z.number().int().min(1).optional(),
  slaHours: z.number().int().min(1).optional(),
  skipIfRequester: z.boolean().optional(),
  requireComment: z.boolean().optional(),
  conditions: z
    .array(
      z.object({
        field: z.string().min(1),
        operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'contains', 'exists']),
        value: z.unknown(),
      }),
    )
    .optional(),
});

const workflowBody = z.object({
  entityType: z.string().min(1),
  code: z.string().min(2).max(64),
  name: z.string().min(1),
  description: z.string().nullish(),
  priority: z.number().int().optional(),
  fallbackBehaviour: z.enum(['block', 'auto_approve']).optional(),
  steps: z.array(stepSchema).min(1),
});

const workflowPatch = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullish(),
  priority: z.number().int().optional(),
  isActive: z.boolean().optional(),
  fallbackBehaviour: z.enum(['block', 'auto_approve']).optional(),
});

const publishBody = z.object({ steps: z.array(stepSchema).min(1) });

export async function approvalRoutes(app: FastifyInstance) {
  /** What is waiting on me. */
  app.get<{ Querystring: { state?: string } }>('/approvals/inbox', async (request) => {
    const principal = await authenticate(request);
    const state = (request.query.state ?? 'pending') as typeof schema.approvalState.enumValues[number];

    return withPrincipal(principal, () =>
      withTenant(async (tx) => {
        // The requester is joined by name. `requestedBy` is a uuid, and an inbox
        // that says a purchase order is "waiting on you from
        // 9f3c…-…-…" tells an approver nothing they can act on.
        const requester = schema.appUser;

        const tasks = await tx
          .select({
            task: schema.approvalTask,
            instance: schema.approvalInstance,
            requestedByName: requester.name,
            requestedByEmail: requester.email,
          })
          .from(schema.approvalTask)
          .innerJoin(
            schema.approvalInstance,
            eq(schema.approvalInstance.id, schema.approvalTask.instanceId),
          )
          .leftJoin(requester, eq(requester.id, schema.approvalInstance.requestedBy))
          .where(
            and(
              eq(schema.approvalTask.tenantId, principal.context.tenantId),
              eq(schema.approvalTask.approverId, principal.userId),
              eq(schema.approvalTask.state, state),
            ),
          )
          // Overdue first, then oldest — the order an approver actually wants.
          // Nulls last, or a task with no deadline sorts above one that is late.
          .orderBy(
            sql`${schema.approvalTask.dueAt} asc nulls last`,
            asc(schema.approvalTask.openedAt),
          );

        const now = new Date();

        return {
          tasks: tasks.map(({ task, instance, requestedByName, requestedByEmail }) => ({
            taskId: task.id,
            stepName: task.stepName,
            openedAt: task.openedAt,
            dueAt: task.dueAt,
            isOverdue: task.dueAt !== null && task.dueAt < now,
            // Set when somebody delegated their authority to the caller. Shown,
            // because deciding on another person's behalf is a different act
            // from deciding on your own.
            delegatedFrom: task.delegatedFrom,
            request: {
              instanceId: instance.id,
              entityType: instance.entityType,
              entityId: instance.entityId,
              entityLabel: instance.entityLabel,
              moduleKey: instance.moduleKey,
              amount: instance.amount,
              currencyCode: instance.currencyCode,
              requestedBy: instance.requestedBy,
              requestedByName: requestedByName ?? requestedByEmail ?? null,
              requestedAt: instance.requestedAt,
            },
          })),
        };
      }),
    );
  });

  /**
   * How many decisions are waiting on the caller.
   *
   * Its own endpoint because the shell needs it on every page and must not pay
   * for the whole inbox to render a number in the sidebar.
   */
  app.get('/approvals/count', async (request) => {
    const principal = await authenticate(request);

    return withPrincipal(principal, () =>
      withTenant(async (tx) => {
        const [row] = await tx
          .select({
            pending: sql<number>`count(*)::int`,
            overdue: sql<number>`count(*) filter (
              where ${schema.approvalTask.dueAt} is not null
                and ${schema.approvalTask.dueAt} < now()
            )::int`,
          })
          .from(schema.approvalTask)
          .where(
            and(
              eq(schema.approvalTask.tenantId, principal.context.tenantId),
              eq(schema.approvalTask.approverId, principal.userId),
              eq(schema.approvalTask.state, 'pending'),
            ),
          );

        return { pending: row?.pending ?? 0, overdue: row?.overdue ?? 0 };
      }),
    );
  });

  /** What I have submitted, and where it has got to. */
  app.get('/approvals/submitted', async (request) => {
    const principal = await authenticate(request);

    return withPrincipal(principal, () =>
      withTenant(async (tx) => {
        const instances = await tx
          .select()
          .from(schema.approvalInstance)
          .where(
            and(
              eq(schema.approvalInstance.tenantId, principal.context.tenantId),
              eq(schema.approvalInstance.requestedBy, principal.userId),
            ),
          )
          .orderBy(desc(schema.approvalInstance.requestedAt))
          .limit(100);

        if (instances.length === 0) return { requests: [] };

        // Named, not identified. "Waiting on 9f3c…" is not an answer to the
        // only question this screen is asked, which is who to go and ask.
        const pending = await tx
          .select({
            instanceId: schema.approvalTask.instanceId,
            approverId: schema.approvalTask.approverId,
            approverName: schema.appUser.name,
            approverEmail: schema.appUser.email,
            stepName: schema.approvalTask.stepName,
            dueAt: schema.approvalTask.dueAt,
          })
          .from(schema.approvalTask)
          .leftJoin(schema.appUser, eq(schema.appUser.id, schema.approvalTask.approverId))
          .where(
            and(
              eq(schema.approvalTask.state, 'pending'),
              inArray(
                schema.approvalTask.instanceId,
                instances.map((i) => i.id),
              ),
            ),
          );

        const now = new Date();

        return {
          requests: instances.map((instance) => ({
            ...instance,
            waitingOn: pending
              .filter((p) => p.instanceId === instance.id)
              .map((p) => ({
                approverId: p.approverId,
                approverName: p.approverName ?? p.approverEmail ?? null,
                stepName: p.stepName,
                isOverdue: p.dueAt !== null && p.dueAt < now,
              })),
          })),
        };
      }),
    );
  });

  /** The full decision trail for one request. */
  app.get<{ Params: { id: string } }>('/approvals/:id/history', async (request, reply) => {
    const principal = await authenticate(request);

    return withPrincipal(principal, () =>
      withTenant(async (tx) => {
        const [instance] = await tx
          .select()
          .from(schema.approvalInstance)
          .where(eq(schema.approvalInstance.id, request.params.id))
          .limit(1);

        if (!instance) return reply.code(404).send({ error: 'Approval request not found.' });

        // Sequential: both queries share this transaction's single connection.
        const actions = await tx
          .select({
            action: schema.approvalAction,
            actorName: schema.appUser.name,
            actorEmail: schema.appUser.email,
          })
          .from(schema.approvalAction)
          .leftJoin(schema.appUser, eq(schema.appUser.id, schema.approvalAction.actorId))
          .where(eq(schema.approvalAction.instanceId, instance.id))
          .orderBy(asc(schema.approvalAction.actedAt));

        const tasks = await tx
          .select({
            task: schema.approvalTask,
            approverName: schema.appUser.name,
            approverEmail: schema.appUser.email,
          })
          .from(schema.approvalTask)
          .leftJoin(schema.appUser, eq(schema.appUser.id, schema.approvalTask.approverId))
          .where(eq(schema.approvalTask.instanceId, instance.id))
          .orderBy(asc(schema.approvalTask.sequence));

        return {
          instance,
          // The decision trail is the point of this endpoint: who decided what,
          // when, and what they said about it. A trail of uuids is not a trail.
          actions: actions.map(({ action, actorName, actorEmail }) => ({
            ...action,
            actorName: actorName ?? actorEmail ?? null,
          })),
          tasks: tasks.map(({ task, approverName, approverEmail }) => ({
            ...task,
            approverName: approverName ?? approverEmail ?? null,
          })),
        };
      }),
    );
  });

  /** Approve or reject. Authorisation is the task assignment itself. */
  app.post<{ Params: { taskId: string } }>(
    '/approvals/tasks/:taskId/decide',
    async (request, reply) => {
      const principal = await authenticate(request);

      const parsed = decideBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
      }

      try {
        return await withPrincipal(principal, () =>
          withTenant((tx) => decide(tx, { taskId: request.params.taskId, ...parsed.data })),
        );
      } catch (error) {
        // The engine's guards — wrong approver, already decided, comment
        // required — are user errors, not server faults.
        return reply.code(409).send({ error: (error as Error).message });
      }
    },
  );

  /** Withdraw my own request. */
  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/approvals/:id/recall',
    async (request, reply) => {
      const principal = await authenticate(request);

      try {
        await withPrincipal(principal, () =>
          withTenant((tx) =>
            recall(tx, { instanceId: request.params.id, reason: request.body?.reason }),
          ),
        );
        return { recalled: true };
      } catch (error) {
        return reply.code(409).send({ error: (error as Error).message });
      }
    },
  );

  // --- Workflow definitions --------------------------------------------------
  //
  // The engine could route, resolve, hold a quorum and pin a running instance
  // to its version; nothing could create the workflow it routes by.

  app.get('/approvals/workflows', async (request) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.approval_workflow.manage');

    return withPrincipal(principal, () =>
      withTenant(async (tx) => ({
        workflows: await listWorkflows(tx),
        // Sent with the list so the create form can offer only entity types
        // something actually submits for approval.
        approvableEntityTypes: approvableEntityTypes(),
      })),
    );
  });

  app.post('/approvals/workflows', async (request, reply) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.approval_workflow.manage');

    const parsed = workflowBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      return await withPrincipal(principal, () =>
        withTenant((tx) => createWorkflow(tx, parsed.data)),
      );
    } catch (error) {
      if (error instanceof WorkflowError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>('/approvals/workflows/:id', async (request, reply) => {
    const principal = await authenticate(request);
    requirePermission(principal, 'kernel.approval_workflow.manage');

    const parsed = workflowPatch.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
    }

    try {
      await withPrincipal(principal, () =>
        withTenant((tx) => updateWorkflow(tx, { workflowId: request.params.id, ...parsed.data })),
      );
    } catch (error) {
      if (error instanceof WorkflowError) return reply.code(409).send({ error: error.message });
      throw error;
    }

    return { updated: true };
  });

  /** Publishes a new version. The previous one is left exactly as it was. */
  app.post<{ Params: { id: string } }>(
    '/approvals/workflows/:id/versions',
    async (request, reply) => {
      const principal = await authenticate(request);
      requirePermission(principal, 'kernel.approval_workflow.manage');

      const parsed = publishBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request.', issues: parsed.error.issues });
      }

      try {
        return await withPrincipal(principal, () =>
          withTenant((tx) =>
            publishWorkflowVersion(tx, { workflowId: request.params.id, steps: parsed.data.steps }),
          ),
        );
      } catch (error) {
        if (error instanceof WorkflowError) return reply.code(409).send({ error: error.message });
        throw error;
      }
    },
  );
}

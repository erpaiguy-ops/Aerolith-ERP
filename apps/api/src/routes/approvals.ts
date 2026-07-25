/**
 * Approval inbox and decisions.
 *
 * Deliberately generic: it serves purchase orders, variations, stock write-offs
 * and everything a future module registers, because the engine does not know
 * what any of them are.
 */
import { decide, recall, schema, withTenant } from '@aerolith/kernel';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { authenticate, withPrincipal } from '../context';

const decideBody = z.object({
  decision: z.enum(['approved', 'rejected']),
  comment: z.string().max(4000).optional(),
  documentIds: z.array(z.string().uuid()).optional(),
});

export async function approvalRoutes(app: FastifyInstance) {
  /** What is waiting on me. */
  app.get<{ Querystring: { state?: string } }>('/approvals/inbox', async (request) => {
    const principal = await authenticate(request);
    const state = (request.query.state ?? 'pending') as typeof schema.approvalState.enumValues[number];

    return withPrincipal(principal, () =>
      withTenant(async (tx) => {
        const tasks = await tx
          .select({
            task: schema.approvalTask,
            instance: schema.approvalInstance,
          })
          .from(schema.approvalTask)
          .innerJoin(
            schema.approvalInstance,
            eq(schema.approvalInstance.id, schema.approvalTask.instanceId),
          )
          .where(
            and(
              eq(schema.approvalTask.tenantId, principal.context.tenantId),
              eq(schema.approvalTask.approverId, principal.userId),
              eq(schema.approvalTask.state, state),
            ),
          )
          // Overdue first, then oldest — the order an approver actually wants.
          .orderBy(asc(schema.approvalTask.dueAt), asc(schema.approvalTask.openedAt));

        return {
          tasks: tasks.map(({ task, instance }) => ({
            taskId: task.id,
            stepName: task.stepName,
            openedAt: task.openedAt,
            dueAt: task.dueAt,
            isOverdue: task.dueAt !== null && task.dueAt < new Date(),
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
              requestedAt: instance.requestedAt,
            },
          })),
        };
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

        const pending = await tx
          .select({
            instanceId: schema.approvalTask.instanceId,
            approverId: schema.approvalTask.approverId,
            stepName: schema.approvalTask.stepName,
          })
          .from(schema.approvalTask)
          .where(
            and(
              eq(schema.approvalTask.state, 'pending'),
              inArray(
                schema.approvalTask.instanceId,
                instances.map((i) => i.id),
              ),
            ),
          );

        return {
          requests: instances.map((instance) => ({
            ...instance,
            waitingOn: pending
              .filter((p) => p.instanceId === instance.id)
              .map((p) => ({ approverId: p.approverId, stepName: p.stepName })),
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
          .select()
          .from(schema.approvalAction)
          .where(eq(schema.approvalAction.instanceId, instance.id))
          .orderBy(asc(schema.approvalAction.actedAt));

        const tasks = await tx
          .select()
          .from(schema.approvalTask)
          .where(eq(schema.approvalTask.instanceId, instance.id))
          .orderBy(asc(schema.approvalTask.sequence));

        return { instance, actions, tasks };
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
}

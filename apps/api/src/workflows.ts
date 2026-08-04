/**
 * Approval workflow definitions — who signs off what, and at which value.
 *
 * `kernel.approval_workflow.manage` was declared from the start and gated
 * nothing. The engine could route an approval, resolve approvers, hold a
 * quorum and pin a running instance to the version it started under; what it
 * could not do was let anybody CREATE the workflow it routes by. Every
 * workflow in existence came from a seed script.
 *
 * **Editing publishes a new version, never mutates the old one.** That is not
 * a nicety — `approval_instance` holds a foreign key to the exact
 * `approval_workflow_version` it started under, precisely so that changing the
 * matrix cannot corrupt in-flight approvals. A service that edited a
 * definition in place would silently rewrite the rules a half-finished
 * approval is being judged by, which is the bug the version table exists to
 * make impossible.
 *
 * The validation below is all of the "this step can never be satisfied" class.
 * `resolveApprovers` returns an empty list for a `role` or `user` step with no
 * `approverRef`, and an approval that reaches a step with no approvers is
 * stuck with nothing to tell the requester — so it is refused at publish time,
 * where there is somebody to tell.
 */
import {
  recordAudit,
  requireTenantContext,
  schema,
  type Transaction,
  type WorkflowDefinition,
  type WorkflowStepDefinition,
} from '@aerolith/kernel';
import { and, desc, eq, sql } from 'drizzle-orm';

import { registry } from './bootstrap';

export class WorkflowError extends Error {
  override readonly name = 'WorkflowError';
}

/** Approver types that name something specific and are useless without it. */
const NEEDS_REF = new Set(['role', 'user']);

/** Every entity type some enabled module says can be approved. */
export function approvableEntityTypes(): string[] {
  return [...new Set(registry.all().flatMap((m) => m.approvableEntities ?? []))].sort();
}

/**
 * Rejects a definition that would produce an approval nobody can act on.
 *
 * Pure, so it can be reasoned about without a database, and called on every
 * publish rather than only on create — a version 4 that cannot be approved is
 * no better than a version 1 that cannot.
 */
export function validateWorkflowDefinition(definition: WorkflowDefinition): void {
  if (!definition.steps || definition.steps.length === 0) {
    throw new WorkflowError('A workflow needs at least one step, or nothing is being approved.');
  }

  const seen = new Set<string>();
  for (const step of definition.steps) {
    if (!Number.isInteger(step.sequence) || step.sequence < 1) {
      throw new WorkflowError(`Step "${step.name}" needs a sequence of 1 or more.`);
    }
    if (!step.name?.trim()) {
      throw new WorkflowError('Every step needs a name — it is what an approver is shown.');
    }

    if (NEEDS_REF.has(step.approverType) && !step.approverRef?.trim()) {
      // The engine resolves this to nobody, and an approval that reaches a
      // step with no approvers waits forever with nothing to say why.
      throw new WorkflowError(
        `Step "${step.name}" approves by ${step.approverType} but names no ${
          step.approverType === 'role' ? 'role' : 'user'
        }. It would resolve to nobody and the approval would stall.`,
      );
    }

    if (step.quorum === 'count') {
      if (!step.quorumCount || step.quorumCount < 1) {
        throw new WorkflowError(
          `Step "${step.name}" needs a quorum count of 1 or more when the rule is "count".`,
        );
      }
    }

    // Two steps at the same sequence run in parallel, which is legitimate —
    // but two identically-named ones at the same sequence are indistinguishable
    // in an inbox.
    const key = `${step.sequence}:${step.name.trim().toLowerCase()}`;
    if (seen.has(key)) {
      throw new WorkflowError(
        `Two steps named "${step.name}" run at sequence ${step.sequence}. An approver would see the same task twice with no way to tell them apart.`,
      );
    }
    seen.add(key);
  }
}

export interface WorkflowRow {
  id: string;
  entityType: string;
  code: string;
  name: string;
  description: string | null;
  priority: number;
  isActive: boolean;
  fallbackBehaviour: string;
  /** The version an approval started today would be pinned to. */
  currentVersion: number | null;
  currentVersionId: string | null;
  steps: WorkflowStepDefinition[];
  /** Approvals still running under ANY version of this workflow. */
  inFlight: number;
}

export async function listWorkflows(tx: Transaction): Promise<WorkflowRow[]> {
  const { approvalWorkflow, approvalWorkflowVersion, approvalInstance } = schema;

  const rows = await tx
    .select({
      id: approvalWorkflow.id,
      entityType: approvalWorkflow.entityType,
      code: approvalWorkflow.code,
      name: approvalWorkflow.name,
      description: approvalWorkflow.description,
      priority: approvalWorkflow.priority,
      isActive: approvalWorkflow.isActive,
      fallbackBehaviour: approvalWorkflow.fallbackBehaviour,
      currentVersion: approvalWorkflowVersion.version,
      currentVersionId: approvalWorkflowVersion.id,
      definition: approvalWorkflowVersion.definition,
    })
    .from(approvalWorkflow)
    .leftJoin(
      approvalWorkflowVersion,
      and(
        eq(approvalWorkflowVersion.workflowId, approvalWorkflow.id),
        eq(approvalWorkflowVersion.isCurrent, true),
      ),
    )
    .orderBy(approvalWorkflow.entityType, approvalWorkflow.priority);

  // In-flight counts drive the warning on the edit screen: republishing while
  // approvals are running is safe BECAUSE of version pinning, and saying so
  // where the button is beats hoping somebody read the design doc.
  const counts = await tx
    .select({
      workflowId: approvalWorkflowVersion.workflowId,
      running: sql<number>`count(*)::int`,
    })
    .from(approvalInstance)
    .innerJoin(
      approvalWorkflowVersion,
      eq(approvalWorkflowVersion.id, approvalInstance.workflowVersionId),
    )
    .where(eq(approvalInstance.state, 'pending'))
    .groupBy(approvalWorkflowVersion.workflowId);

  const runningByWorkflow = new Map(counts.map((c) => [c.workflowId, c.running]));

  return rows.map((row) => ({
    id: row.id,
    entityType: row.entityType,
    code: row.code,
    name: row.name,
    description: row.description,
    priority: row.priority,
    isActive: row.isActive,
    fallbackBehaviour: row.fallbackBehaviour,
    currentVersion: row.currentVersion,
    currentVersionId: row.currentVersionId,
    steps: row.definition?.steps ?? [],
    inFlight: runningByWorkflow.get(row.id) ?? 0,
  }));
}

export interface CreateWorkflowInput {
  entityType: string;
  code: string;
  name: string;
  description?: string | null;
  priority?: number;
  fallbackBehaviour?: string;
  steps: WorkflowStepDefinition[];
  conditions?: WorkflowDefinition['conditions'];
}

export async function createWorkflow(
  tx: Transaction,
  input: CreateWorkflowInput,
): Promise<{ workflowId: string; version: number }> {
  const { tenantId, userId } = requireTenantContext();

  if (!approvableEntityTypes().includes(input.entityType)) {
    // A workflow on an entity nothing submits for approval is a rule that
    // never runs — better refused than left looking configured.
    throw new WorkflowError(
      `Nothing submits "${input.entityType}" for approval. Approvable entities are declared by the modules that own them.`,
    );
  }

  const definition: WorkflowDefinition = {
    entityType: input.entityType,
    conditions: input.conditions ?? [],
    steps: input.steps,
  };
  validateWorkflowDefinition(definition);

  const [workflow] = await tx
    .insert(schema.approvalWorkflow)
    .values({
      tenantId,
      entityType: input.entityType,
      code: input.code,
      name: input.name,
      description: input.description,
      priority: input.priority ?? 100,
      fallbackBehaviour: input.fallbackBehaviour ?? 'block',
    })
    .onConflictDoNothing({
      target: [schema.approvalWorkflow.tenantId, schema.approvalWorkflow.code],
    })
    .returning({ id: schema.approvalWorkflow.id });

  if (!workflow) {
    throw new WorkflowError(`"${input.code}" is already in use by another workflow.`);
  }

  await tx.insert(schema.approvalWorkflowVersion).values({
    tenantId,
    workflowId: workflow.id,
    version: 1,
    definition,
    publishedBy: userId,
    isCurrent: true,
  });

  await recordAudit(tx, {
    moduleKey: 'kernel',
    entityType: 'kernel.approval_workflow',
    entityId: workflow.id,
    entityLabel: input.code,
    action: 'create',
    reason: `Workflow created for ${input.entityType}.`,
  });

  return { workflowId: workflow.id, version: 1 };
}

/**
 * Publishes a new version. The previous one stays exactly as it was.
 *
 * Nothing here updates a definition: `isCurrent` moves to the new row and the
 * old row is left untouched, so every running instance keeps being judged by
 * the rules it started under.
 */
export async function publishWorkflowVersion(
  tx: Transaction,
  input: { workflowId: string; steps: WorkflowStepDefinition[]; conditions?: WorkflowDefinition['conditions'] },
): Promise<{ version: number }> {
  const { tenantId, userId } = requireTenantContext();

  const [workflow] = await tx
    .select()
    .from(schema.approvalWorkflow)
    .where(
      and(
        eq(schema.approvalWorkflow.tenantId, tenantId),
        eq(schema.approvalWorkflow.id, input.workflowId),
      ),
    );
  if (!workflow) throw new WorkflowError('Workflow not found.');

  const definition: WorkflowDefinition = {
    entityType: workflow.entityType,
    conditions: input.conditions ?? [],
    steps: input.steps,
  };
  validateWorkflowDefinition(definition);

  const [latest] = await tx
    .select({ version: schema.approvalWorkflowVersion.version })
    .from(schema.approvalWorkflowVersion)
    .where(eq(schema.approvalWorkflowVersion.workflowId, input.workflowId))
    .orderBy(desc(schema.approvalWorkflowVersion.version))
    .limit(1);

  const version = (latest?.version ?? 0) + 1;

  // Demote first, then insert: the partial index that finds "the current
  // version" tolerates neither two currents nor, briefly, none.
  await tx
    .update(schema.approvalWorkflowVersion)
    .set({ isCurrent: false, updatedAt: new Date() })
    .where(eq(schema.approvalWorkflowVersion.workflowId, input.workflowId));

  await tx.insert(schema.approvalWorkflowVersion).values({
    tenantId,
    workflowId: input.workflowId,
    version,
    definition,
    publishedBy: userId,
    isCurrent: true,
  });

  await recordAudit(tx, {
    moduleKey: 'kernel',
    entityType: 'kernel.approval_workflow',
    entityId: input.workflowId,
    entityLabel: workflow.code,
    action: 'update',
    reason: `Published version ${version}. Approvals already running keep version ${version - 1}.`,
  });

  return { version };
}

export async function updateWorkflow(
  tx: Transaction,
  input: {
    workflowId: string;
    name?: string;
    description?: string | null;
    priority?: number;
    isActive?: boolean;
    fallbackBehaviour?: string;
  },
): Promise<void> {
  const { tenantId } = requireTenantContext();

  const [existing] = await tx
    .select()
    .from(schema.approvalWorkflow)
    .where(
      and(
        eq(schema.approvalWorkflow.tenantId, tenantId),
        eq(schema.approvalWorkflow.id, input.workflowId),
      ),
    );
  if (!existing) throw new WorkflowError('Workflow not found.');

  await tx
    .update(schema.approvalWorkflow)
    .set({
      name: input.name ?? existing.name,
      description: input.description !== undefined ? input.description : existing.description,
      priority: input.priority ?? existing.priority,
      isActive: input.isActive ?? existing.isActive,
      fallbackBehaviour: input.fallbackBehaviour ?? existing.fallbackBehaviour,
      updatedAt: new Date(),
    })
    .where(eq(schema.approvalWorkflow.id, input.workflowId));

  await recordAudit(tx, {
    moduleKey: 'kernel',
    entityType: 'kernel.approval_workflow',
    entityId: input.workflowId,
    entityLabel: existing.code,
    action: 'update',
  });
}

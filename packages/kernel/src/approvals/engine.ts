/**
 * Approval engine runtime.
 *
 * Every module calls `requestApproval()` and never implements approval logic of
 * its own. The engine emits kernel events at each transition, so modules react
 * to the outcome without the engine knowing they exist.
 *
 * Three behaviours here are the ones that get retrofitted painfully if left out:
 * version pinning (an in-flight approval keeps its original rules), delegation,
 * and self-approval prevention.
 */
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import { type Transaction } from '../db';
import {
  approvalAction,
  approvalDelegation,
  approvalInstance,
  approvalTask,
  approvalWorkflow,
  approvalWorkflowVersion,
  role,
  userRole,
  type WorkflowDefinition,
  type WorkflowStepDefinition,
} from '../db/schema';
import { emit } from '../events/bus';
import { requireTenantContext } from '../tenancy/context';
import {
  type ApprovalContext,
  planSteps,
  quorumMet,
  selectWorkflow,
} from './conditions';

/**
 * Resolves approver types the kernel cannot answer alone — `manager_of_requester`
 * needs the HR module, `project_manager` needs Projects. Modules register a
 * resolver; if none is registered the step is reported as unresolvable rather
 * than silently skipped.
 */
export type ApproverResolver = (input: {
  tx: Transaction;
  tenantId: string;
  step: WorkflowStepDefinition;
  context: ApprovalContext;
  requestedBy: string;
}) => Promise<string[]>;

export class ApproverResolverRegistry {
  private readonly resolvers = new Map<string, ApproverResolver>();

  register(approverType: string, resolver: ApproverResolver): this {
    this.resolvers.set(approverType, resolver);
    return this;
  }

  get(approverType: string): ApproverResolver | undefined {
    return this.resolvers.get(approverType);
  }
}

export const approverResolvers = new ApproverResolverRegistry();

// ---------------------------------------------------------------------------

export class NoMatchingWorkflowError extends Error {
  override readonly name = 'NoMatchingWorkflowError';
  constructor(entityType: string) {
    super(
      `No approval workflow matches "${entityType}" for this document. Configure one, ` +
        'or set the workflow fallback to auto-approve.',
    );
  }
}

export class NoApproversError extends Error {
  override readonly name = 'NoApproversError';
  constructor(stepName: string, detail: string) {
    super(`Approval step "${stepName}" resolved to nobody: ${detail}`);
  }
}

export interface RequestApprovalInput {
  entityType: string;
  entityId: string;
  moduleKey: string;
  entityLabel?: string;
  /** The values routing decisions are made from. Snapshotted onto the instance. */
  context: ApprovalContext;
  amount?: number | string | null;
  currencyCode?: string | null;
  legalEntityId?: string | null;
}

export interface RequestApprovalResult {
  instanceId: string | null;
  state: 'pending' | 'approved';
  /** Populated when the entity needed no approval at all. */
  autoApprovedReason?: string;
  pendingApprovers: string[];
}

export async function requestApproval(
  tx: Transaction,
  input: RequestApprovalInput,
): Promise<RequestApprovalResult> {
  const { tenantId, userId } = requireTenantContext();
  if (!userId) {
    throw new Error('An approval must be requested by a user, not a system actor.');
  }

  const workflows = await tx
    .select({
      id: approvalWorkflow.id,
      priority: approvalWorkflow.priority,
      fallbackBehaviour: approvalWorkflow.fallbackBehaviour,
      versionId: approvalWorkflowVersion.id,
      definition: approvalWorkflowVersion.definition,
    })
    .from(approvalWorkflow)
    .innerJoin(
      approvalWorkflowVersion,
      and(
        eq(approvalWorkflowVersion.workflowId, approvalWorkflow.id),
        eq(approvalWorkflowVersion.isCurrent, true),
      ),
    )
    .where(
      and(
        eq(approvalWorkflow.tenantId, tenantId),
        eq(approvalWorkflow.entityType, input.entityType),
        eq(approvalWorkflow.isActive, true),
      ),
    );

  const selected = selectWorkflow(
    workflows.map((w) => ({ id: w.id, priority: w.priority, definition: w.definition })),
    input.context,
  );

  if (!selected) {
    // No workflow matched. Whether that means "approve" or "stop" is a tenant
    // policy decision, never a default we pick for them.
    const anyBlocking = workflows.some((w) => w.fallbackBehaviour === 'block');
    if (workflows.length > 0 && anyBlocking) {
      throw new NoMatchingWorkflowError(input.entityType);
    }
    return {
      instanceId: null,
      state: 'approved',
      autoApprovedReason: 'No approval workflow is configured for this document type.',
      pendingApprovers: [],
    };
  }

  const chosen = workflows.find((w) => w.id === selected.id)!;
  const sequences = planSteps(selected.definition, input.context);

  if (sequences.length === 0) {
    return {
      instanceId: null,
      state: 'approved',
      autoApprovedReason: 'No approval step applies at this value.',
      pendingApprovers: [],
    };
  }

  const [instance] = await tx
    .insert(approvalInstance)
    .values({
      tenantId,
      entityType: input.entityType,
      entityId: input.entityId,
      entityLabel: input.entityLabel,
      moduleKey: input.moduleKey,
      workflowVersionId: chosen.versionId,
      state: 'pending',
      currentSequence: sequences[0]![0]!.sequence,
      requestedBy: userId,
      context: input.context,
      amount: input.amount === null || input.amount === undefined ? null : String(input.amount),
      currencyCode: input.currencyCode,
      legalEntityId: input.legalEntityId,
    })
    .returning({ id: approvalInstance.id });

  const instanceId = instance!.id;

  const opened = await openSequence(tx, {
    instanceId,
    tenantId,
    steps: sequences[0]!,
    context: input.context,
    requestedBy: userId,
  });

  // Everyone in the first sequence is the requester, and all steps allow the
  // skip: nothing to approve. Advance rather than parking it forever.
  if (opened.length === 0) {
    return finishInstance(tx, {
      instanceId,
      definition: selected.definition,
      sequences,
      fromSequenceIndex: 0,
      context: input.context,
      requestedBy: userId,
      input,
    });
  }

  await emit(tx, {
    type: 'kernel.approval.requested',
    sourceModule: 'kernel',
    aggregateType: 'kernel.approval_instance',
    aggregateId: instanceId,
    payload: {
      entityType: input.entityType,
      entityId: input.entityId,
      moduleKey: input.moduleKey,
      approvers: opened,
      amount: input.amount ?? null,
    },
  });

  return { instanceId, state: 'pending', pendingApprovers: opened };
}

// ---------------------------------------------------------------------------

export interface DecideInput {
  taskId: string;
  decision: 'approved' | 'rejected';
  comment?: string;
  documentIds?: string[];
}

export interface DecideResult {
  instanceId: string;
  instanceState: 'pending' | 'approved' | 'rejected';
  /** Approvers opened by advancing to the next sequence. */
  nextApprovers: string[];
}

export async function decide(tx: Transaction, input: DecideInput): Promise<DecideResult> {
  const { tenantId, userId } = requireTenantContext();
  if (!userId) throw new Error('An approval decision must be made by a user.');

  const [task] = await tx
    .select()
    .from(approvalTask)
    .where(and(eq(approvalTask.id, input.taskId), eq(approvalTask.tenantId, tenantId)))
    .limit(1)
    .for('update');

  if (!task) throw new Error(`Approval task ${input.taskId} not found.`);
  if (task.state !== 'pending') {
    throw new Error(`This approval has already been ${task.state}.`);
  }
  if (task.approverId !== userId) {
    throw new Error('This approval is assigned to somebody else.');
  }

  const [instance] = await tx
    .select()
    .from(approvalInstance)
    .where(eq(approvalInstance.id, task.instanceId))
    .limit(1)
    .for('update');

  if (!instance) throw new Error('Approval instance not found.');
  if (instance.state !== 'pending') {
    throw new Error(`This request is already ${instance.state}.`);
  }

  const [version] = await tx
    .select({ definition: approvalWorkflowVersion.definition })
    .from(approvalWorkflowVersion)
    .where(eq(approvalWorkflowVersion.id, instance.workflowVersionId))
    .limit(1);

  // Pinned at submission: editing the workflow does not change an approval
  // that is already in flight.
  const definition = version!.definition;
  const sequences = planSteps(definition, instance.context);
  const sequenceIndex = sequences.findIndex((steps) => steps[0]!.sequence === task.sequence);
  const currentSteps = sequences[sequenceIndex] ?? [];
  const step = currentSteps.find((s) => s.name === task.stepName) ?? currentSteps[0];

  if (step?.requireComment && !input.comment?.trim()) {
    throw new Error(`Step "${step.name}" requires a comment.`);
  }

  const now = new Date();
  await tx
    .update(approvalTask)
    .set({ state: input.decision, respondedAt: now, updatedAt: now })
    .where(eq(approvalTask.id, task.id));

  await tx.insert(approvalAction).values({
    tenantId,
    instanceId: instance.id,
    taskId: task.id,
    sequence: task.sequence,
    actorId: userId,
    decision: input.decision,
    comment: input.comment,
    documentIds: input.documentIds,
  });

  // --- Rejection stops everything ----------------------------------------
  if (input.decision === 'rejected') {
    await tx
      .update(approvalInstance)
      .set({ state: 'rejected', completedAt: now, updatedAt: now })
      .where(eq(approvalInstance.id, instance.id));

    await tx
      .update(approvalTask)
      .set({ state: 'cancelled', updatedAt: now })
      .where(and(eq(approvalTask.instanceId, instance.id), eq(approvalTask.state, 'pending')));

    await emit(tx, {
      type: 'kernel.approval.rejected',
      sourceModule: 'kernel',
      aggregateType: 'kernel.approval_instance',
      aggregateId: instance.id,
      payload: {
        entityType: instance.entityType,
        entityId: instance.entityId,
        moduleKey: instance.moduleKey,
        rejectedBy: userId,
        comment: input.comment ?? null,
      },
    });

    return { instanceId: instance.id, instanceState: 'rejected', nextApprovers: [] };
  }

  // --- Is this sequence satisfied? ---------------------------------------
  const siblings = await tx
    .select({ state: approvalTask.state })
    .from(approvalTask)
    .where(
      and(eq(approvalTask.instanceId, instance.id), eq(approvalTask.sequence, task.sequence)),
    );

  const approvals = siblings.filter((s) => s.state === 'approved').length;

  if (step && !quorumMet(step, approvals, siblings.length)) {
    return { instanceId: instance.id, instanceState: 'pending', nextApprovers: [] };
  }

  // Quorum reached — anyone still pending on this sequence no longer needs to act.
  await tx
    .update(approvalTask)
    .set({ state: 'skipped', updatedAt: now })
    .where(
      and(
        eq(approvalTask.instanceId, instance.id),
        eq(approvalTask.sequence, task.sequence),
        eq(approvalTask.state, 'pending'),
      ),
    );

  const result = await finishInstance(tx, {
    instanceId: instance.id,
    definition,
    sequences,
    fromSequenceIndex: sequenceIndex,
    context: instance.context,
    requestedBy: instance.requestedBy,
    input: {
      entityType: instance.entityType,
      entityId: instance.entityId,
      moduleKey: instance.moduleKey,
      context: instance.context,
    },
  });

  return {
    instanceId: instance.id,
    instanceState: result.state === 'approved' ? 'approved' : 'pending',
    nextApprovers: result.pendingApprovers,
  };
}

/** The requester withdrawing their own request. */
export async function recall(
  tx: Transaction,
  input: { instanceId: string; reason?: string },
): Promise<void> {
  const { tenantId, userId } = requireTenantContext();

  const [instance] = await tx
    .select()
    .from(approvalInstance)
    .where(and(eq(approvalInstance.id, input.instanceId), eq(approvalInstance.tenantId, tenantId)))
    .limit(1);

  if (!instance) throw new Error('Approval instance not found.');
  if (instance.requestedBy !== userId) {
    throw new Error('Only the requester may recall a request.');
  }
  if (instance.state !== 'pending') {
    throw new Error(`This request is already ${instance.state}.`);
  }

  const now = new Date();
  await tx
    .update(approvalInstance)
    .set({ state: 'recalled', completedAt: now, updatedAt: now })
    .where(eq(approvalInstance.id, instance.id));

  await tx
    .update(approvalTask)
    .set({ state: 'cancelled', updatedAt: now })
    .where(and(eq(approvalTask.instanceId, instance.id), eq(approvalTask.state, 'pending')));

  await tx.insert(approvalAction).values({
    tenantId,
    instanceId: instance.id,
    sequence: instance.currentSequence,
    actorId: userId!,
    decision: 'recalled',
    comment: input.reason,
  });

  await emit(tx, {
    type: 'kernel.approval.recalled',
    sourceModule: 'kernel',
    aggregateType: 'kernel.approval_instance',
    aggregateId: instance.id,
    payload: {
      entityType: instance.entityType,
      entityId: instance.entityId,
      moduleKey: instance.moduleKey,
    },
  });
}

// ---------------------------------------------------------------------------

/** Advances past `fromSequenceIndex`, opening the next sequence that has approvers. */
async function finishInstance(
  tx: Transaction,
  args: {
    instanceId: string;
    definition: WorkflowDefinition;
    sequences: WorkflowStepDefinition[][];
    fromSequenceIndex: number;
    context: ApprovalContext;
    requestedBy: string;
    input: { entityType: string; entityId: string; moduleKey: string; context: ApprovalContext };
  },
): Promise<RequestApprovalResult> {
  const { tenantId } = requireTenantContext();
  const now = new Date();

  for (let index = args.fromSequenceIndex + 1; index < args.sequences.length; index += 1) {
    const steps = args.sequences[index]!;
    const opened = await openSequence(tx, {
      instanceId: args.instanceId,
      tenantId,
      steps,
      context: args.context,
      requestedBy: args.requestedBy,
    });

    if (opened.length > 0) {
      await tx
        .update(approvalInstance)
        .set({ currentSequence: steps[0]!.sequence, updatedAt: now })
        .where(eq(approvalInstance.id, args.instanceId));

      await emit(tx, {
        type: 'kernel.approval.step_opened',
        sourceModule: 'kernel',
        aggregateType: 'kernel.approval_instance',
        aggregateId: args.instanceId,
        payload: { ...args.input, sequence: steps[0]!.sequence, approvers: opened },
      });

      return { instanceId: args.instanceId, state: 'pending', pendingApprovers: opened };
    }
  }

  await tx
    .update(approvalInstance)
    .set({ state: 'approved', completedAt: now, updatedAt: now })
    .where(eq(approvalInstance.id, args.instanceId));

  await emit(tx, {
    type: 'kernel.approval.approved',
    sourceModule: 'kernel',
    aggregateType: 'kernel.approval_instance',
    aggregateId: args.instanceId,
    payload: args.input,
  });

  return { instanceId: args.instanceId, state: 'approved', pendingApprovers: [] };
}

/** Creates the tasks for one sequence. Returns the approver ids actually opened. */
async function openSequence(
  tx: Transaction,
  args: {
    instanceId: string;
    tenantId: string;
    steps: WorkflowStepDefinition[];
    context: ApprovalContext;
    requestedBy: string;
  },
): Promise<string[]> {
  const opened: string[] = [];

  for (const step of args.steps) {
    let approvers = await resolveApprovers(tx, {
      tenantId: args.tenantId,
      step,
      context: args.context,
      requestedBy: args.requestedBy,
    });

    // Self-approval prevention. Only allowed where the step opts in, because
    // silently letting a requester approve their own document defeats the point.
    if (step.skipIfRequester !== false) {
      approvers = approvers.filter((id) => id !== args.requestedBy);
    }

    approvers = await applyDelegations(tx, {
      tenantId: args.tenantId,
      approvers,
      entityType: String(args.context.entityType ?? ''),
    });

    const unique = [...new Set(approvers)];
    if (unique.length === 0) continue;

    const dueAt = step.slaHours
      ? new Date(Date.now() + step.slaHours * 3_600_000)
      : null;

    await tx.insert(approvalTask).values(
      unique.map((approverId) => ({
        tenantId: args.tenantId,
        instanceId: args.instanceId,
        sequence: step.sequence,
        stepName: step.name,
        approverId,
        state: 'pending' as const,
        dueAt,
      })),
    );

    opened.push(...unique);
  }

  return opened;
}

async function resolveApprovers(
  tx: Transaction,
  args: {
    tenantId: string;
    step: WorkflowStepDefinition;
    context: ApprovalContext;
    requestedBy: string;
  },
): Promise<string[]> {
  const { step } = args;

  if (step.approverType === 'user') {
    return step.approverRef ? [step.approverRef] : [];
  }

  if (step.approverType === 'role') {
    if (!step.approverRef) return [];
    const rows = await tx
      .select({ userId: userRole.userId })
      .from(userRole)
      .innerJoin(role, eq(role.id, userRole.roleId))
      .where(
        and(
          eq(userRole.tenantId, args.tenantId),
          eq(role.tenantId, args.tenantId),
          eq(role.code, step.approverRef),
        ),
      );
    return rows.map((r) => r.userId);
  }

  // Everything else needs a module that may not be installed.
  const resolver = approverResolvers.get(step.approverType);
  if (!resolver) {
    throw new NoApproversError(
      step.name,
      `no resolver is registered for approver type "${step.approverType}". The module ` +
        'that provides it is probably not enabled for this tenant.',
    );
  }

  return resolver({
    tx,
    tenantId: args.tenantId,
    step,
    context: args.context,
    requestedBy: args.requestedBy,
  });
}

/** Redirects approvers who are out of office. */
async function applyDelegations(
  tx: Transaction,
  args: { tenantId: string; approvers: string[]; entityType: string },
): Promise<string[]> {
  if (args.approvers.length === 0) return args.approvers;

  const now = new Date();
  const delegations = await tx
    .select()
    .from(approvalDelegation)
    .where(
      and(
        eq(approvalDelegation.tenantId, args.tenantId),
        eq(approvalDelegation.isActive, true),
        inArray(approvalDelegation.fromUserId, args.approvers),
        lte(approvalDelegation.startsAt, now),
        gte(approvalDelegation.endsAt, now),
      ),
    )
    .orderBy(asc(approvalDelegation.startsAt));

  if (delegations.length === 0) return args.approvers;

  return args.approvers.map((approverId) => {
    const delegation = delegations.find(
      (d) =>
        d.fromUserId === approverId &&
        (!d.entityTypes || d.entityTypes.length === 0 || d.entityTypes.includes(args.entityType)),
    );
    return delegation?.toUserId ?? approverId;
  });
}

// ---------------------------------------------------------------------------

/**
 * Finds tasks past their SLA. Run on a schedule; the caller decides whether to
 * remind, escalate or auto-approve based on the step's `onSlaBreach`.
 */
export async function findOverdueTasks(
  tx: Transaction,
  options: { limit?: number } = {},
): Promise<
  { taskId: string; instanceId: string; approverId: string; dueAt: Date; remindersSent: number }[]
> {
  const rows = await tx
    .select({
      taskId: approvalTask.id,
      instanceId: approvalTask.instanceId,
      approverId: approvalTask.approverId,
      dueAt: approvalTask.dueAt,
      remindersSent: approvalTask.remindersSent,
    })
    .from(approvalTask)
    .where(
      and(
        eq(approvalTask.state, 'pending'),
        sql`${approvalTask.dueAt} is not null and ${approvalTask.dueAt} < now()`,
      ),
    )
    .orderBy(asc(approvalTask.dueAt))
    .limit(options.limit ?? 100);

  return rows.filter((r): r is typeof r & { dueAt: Date } => r.dueAt !== null);
}

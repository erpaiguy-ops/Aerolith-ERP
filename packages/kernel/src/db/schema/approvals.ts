/**
 * Approval engine — kernel capability used by every module.
 *
 * Workflows are DATA, not code, because every tenant's delegation-of-authority
 * matrix differs and no two contractors agree on who signs off a 250k variation.
 *
 * Four things here that are painful to retrofit and so are built in from the
 * start: workflow VERSION PINNING (an in-flight approval keeps the rules it
 * started under), DELEGATION, SLA ESCALATION, and parallel steps with quorum.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { kernel, tenantColumn, timestamps } from '../columns';

export const approvalState = kernel.enum('approval_state', [
  'draft',
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'recalled',
  'expired',
  /** Task only: quorum was reached by others, so this approver need not act. */
  'skipped',
]);

export const approverType = kernel.enum('approver_type', [
  'role',
  'user',
  'manager_of_requester',
  'department_head',
  'project_manager',
  'legal_entity_owner',
  'cost_centre_owner',
  'dynamic', // resolved by a module-registered resolver
]);

export const approvalDecision = kernel.enum('approval_decision', [
  'approved',
  'rejected',
  'delegated',
  'recalled',
  'escalated',
  'auto_approved',
  'skipped',
]);

/** How many approvers in a parallel step must act. */
export const quorumRule = kernel.enum('quorum_rule', ['all', 'any', 'majority', 'count']);

// ---------------------------------------------------------------------------

export const approvalWorkflow = kernel.table(
  'approval_workflow',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    /** e.g. 'procurement.purchase_order', 'contracts.variation'. */
    entityType: varchar('entity_type', { length: 96 }).notNull(),
    code: varchar('code', { length: 64 }).notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Lower number wins when several workflows match an entity. */
    priority: integer('priority').notNull().default(100),
    isActive: boolean('is_active').notNull().default(true),
    /** Nobody matched? Approve automatically, or block and warn an admin. */
    fallbackBehaviour: varchar('fallback_behaviour', { length: 16 })
      .notNull()
      .default('block'),
    ...timestamps(),
  },
  (t) => [
    unique('approval_workflow_uq').on(t.tenantId, t.code),
    index('approval_workflow_entity_idx').on(t.tenantId, t.entityType, t.isActive),
  ],
);

/**
 * An immutable snapshot of a workflow. Editing a workflow creates a new version;
 * running instances keep pointing at the old one. Without this, changing the
 * approval matrix corrupts every in-flight approval — a genuinely nasty class of
 * bug to discover in production.
 */
export const approvalWorkflowVersion = kernel.table(
  'approval_workflow_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => approvalWorkflow.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    /** Full frozen definition — conditions and steps — as published. */
    definition: jsonb('definition').$type<WorkflowDefinition>().notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
    publishedBy: uuid('published_by'),
    isCurrent: boolean('is_current').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('approval_workflow_version_uq').on(t.workflowId, t.version),
    index('approval_workflow_version_current_idx').on(t.tenantId, t.workflowId, t.isCurrent),
  ],
);

export type WorkflowCondition = {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'contains' | 'exists';
  /**
   * Optional because `exists` takes no operand — "has a project been set" is a
   * complete condition on its own. `evaluateCondition` already treats a missing
   * value as well-defined in every branch (comparisons fail closed, `in`/`nin`
   * guard on `Array.isArray`), so this documents behaviour that was already
   * there rather than introducing it.
   */
  value?: unknown;
};

export type WorkflowStepDefinition = {
  sequence: number;
  name: string;
  approverType: (typeof approverType.enumValues)[number];
  /** Role code, user id, or resolver key depending on `approverType`. */
  approverRef?: string;
  /** Steps sharing a sequence run in parallel. */
  quorum?: (typeof quorumRule.enumValues)[number];
  quorumCount?: number;
  slaHours?: number;
  onSlaBreach?: 'escalate' | 'auto_approve' | 'notify_only';
  escalateTo?: { approverType: string; approverRef?: string };
  /** Step runs only when these hold — how amount thresholds are expressed. */
  conditions?: WorkflowCondition[];
  /** Requester is an approver on this step: skip it rather than self-approve. */
  skipIfRequester?: boolean;
  allowDelegation?: boolean;
  requireComment?: boolean;
  /** Require re-authentication for high-value steps. */
  requireMfa?: boolean;
};

export type WorkflowDefinition = {
  entityType: string;
  conditions: WorkflowCondition[];
  steps: WorkflowStepDefinition[];
  /** Any change to these fields after submission restarts the approval. */
  resetOnFieldChange?: string[];
};

/** A running approval. */
export const approvalInstance = kernel.table(
  'approval_instance',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    entityType: varchar('entity_type', { length: 96 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    entityLabel: text('entity_label'),
    moduleKey: varchar('module_key', { length: 64 }).notNull(),

    workflowVersionId: uuid('workflow_version_id')
      .notNull()
      .references(() => approvalWorkflowVersion.id),
    state: approvalState('state').notNull().default('pending'),
    currentSequence: integer('current_sequence').notNull().default(1),

    requestedBy: uuid('requested_by').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),

    /**
     * The entity values the routing decision was made from, captured at
     * submission. Keeps the audit answerable years later, when the source
     * document has been amended a dozen times.
     */
    context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
    /** Denormalised for threshold reporting and approver dashboards. */
    amount: numeric('amount', { precision: 18, scale: 2 }),
    currencyCode: varchar('currency_code', { length: 3 }),
    legalEntityId: uuid('legal_entity_id'),

    dueAt: timestamp('due_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    index('approval_instance_entity_idx').on(t.tenantId, t.entityType, t.entityId),
    index('approval_instance_state_idx').on(t.tenantId, t.state, t.dueAt),
    index('approval_instance_requester_idx').on(t.tenantId, t.requestedBy),
  ],
);

/**
 * One row per resolved approver per step — created when the step opens. This is
 * what the "my approvals" inbox queries, so it carries its own index.
 */
export const approvalTask = kernel.table(
  'approval_task',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => approvalInstance.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    stepName: text('step_name').notNull(),
    approverId: uuid('approver_id').notNull(),
    /** Set when this task exists because someone delegated it. */
    delegatedFrom: uuid('delegated_from'),
    state: approvalState('state').notNull().default('pending'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp('due_at', { withTimezone: true }),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    remindersSent: integer('reminders_sent').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    index('approval_task_inbox_idx').on(t.tenantId, t.approverId, t.state, t.dueAt),
    index('approval_task_instance_idx').on(t.instanceId, t.sequence),
  ],
);

/** Append-only decision log. */
export const approvalAction = kernel.table(
  'approval_action',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => approvalInstance.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id'),
    sequence: integer('sequence').notNull(),
    actorId: uuid('actor_id').notNull(),
    decision: approvalDecision('decision').notNull(),
    comment: text('comment'),
    /** Attachments supporting the decision. */
    documentIds: uuid('document_ids').array(),
    delegatedTo: uuid('delegated_to'),
    actedAt: timestamp('acted_at', { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index('approval_action_instance_idx').on(t.instanceId, t.actedAt)],
);

/** Out-of-office / delegation of authority. */
export const approvalDelegation = kernel.table(
  'approval_delegation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    fromUserId: uuid('from_user_id').notNull(),
    toUserId: uuid('to_user_id').notNull(),
    /** Null = all entity types. */
    entityTypes: text('entity_types').array(),
    /** Cap what the delegate may approve, in tenant base currency. */
    maxAmount: numeric('max_amount', { precision: 18, scale: 2 }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    reason: text('reason'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    index('approval_delegation_active_idx').on(t.tenantId, t.fromUserId, t.startsAt, t.endsAt),
  ],
);

/**
 * Delegation-of-authority matrix — the tabular view finance teams actually
 * maintain. Generates or validates workflows rather than replacing them.
 */
export const authorityLimit = kernel.table(
  'authority_limit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    legalEntityId: uuid('legal_entity_id'),
    roleId: uuid('role_id'),
    userId: uuid('user_id'),
    entityType: varchar('entity_type', { length: 96 }).notNull(),
    minAmount: numeric('min_amount', { precision: 18, scale: 2 }).notNull().default('0'),
    maxAmount: numeric('max_amount', { precision: 18, scale: 2 }),
    currencyCode: varchar('currency_code', { length: 3 }).notNull(),
    costCentreIds: uuid('cost_centre_ids').array().default(sql`'{}'::uuid[]`),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [index('authority_limit_lookup_idx').on(t.tenantId, t.entityType, t.isActive)],
);

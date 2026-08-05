/**
 * Workflow condition evaluation and step planning.
 *
 * Pure functions over a plain context object — no database, no framework. The
 * routing decision for a 250,000 AED variation is the kind of logic that must be
 * exhaustively testable without standing anything up.
 */
import type { WorkflowCondition, WorkflowDefinition, WorkflowStepDefinition } from '../db/schema';

export type ApprovalContext = Record<string, unknown>;

/**
 * Reads a possibly nested path, e.g. "supplier.country" or "amount".
 * Returns undefined rather than throwing — a missing field is a condition that
 * does not match, not a crash mid-approval.
 */
export function readPath(context: ApprovalContext, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (value, key) =>
        value !== null && typeof value === 'object'
          ? (value as Record<string, unknown>)[key]
          : undefined,
      context,
    );
}

export function evaluateCondition(condition: WorkflowCondition, context: ApprovalContext): boolean {
  const actual = readPath(context, condition.field);
  const expected = condition.value;

  switch (condition.operator) {
    case 'exists':
      return expected === false ? actual === undefined || actual === null : actual !== undefined && actual !== null;
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toComparable(actual);
      const b = toComparable(expected);
      if (a === null || b === null) return false;
      if (condition.operator === 'gt') return a > b;
      if (condition.operator === 'gte') return a >= b;
      if (condition.operator === 'lt') return a < b;
      return a <= b;
    }
    case 'in':
      return Array.isArray(expected) && expected.includes(actual as never);
    case 'nin':
      return Array.isArray(expected) && !expected.includes(actual as never);
    case 'contains':
      if (Array.isArray(actual)) return actual.includes(expected as never);
      return typeof actual === 'string' && typeof expected === 'string'
        ? actual.toLowerCase().includes(expected.toLowerCase())
        : false;
    default:
      return false;
  }
}

/** All conditions must hold. An empty list matches everything. */
export function matchesConditions(
  conditions: readonly WorkflowCondition[] | undefined,
  context: ApprovalContext,
): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every((condition) => evaluateCondition(condition, context));
}

export interface WorkflowCandidate {
  id: string;
  priority: number;
  definition: WorkflowDefinition;
}

/**
 * Picks the workflow for an entity.
 *
 * Lowest `priority` wins so specific rules can be layered above general ones —
 * "variations over 500k go to the board" at priority 10, "all variations" at
 * 100. Ties break on id so the choice is deterministic; two workflows at the
 * same priority matching the same document is a configuration problem the admin
 * screen should surface, not something to resolve by luck.
 */
export function selectWorkflow(
  candidates: readonly WorkflowCandidate[],
  context: ApprovalContext,
): WorkflowCandidate | null {
  const matching = candidates
    .filter((candidate) => matchesConditions(candidate.definition.conditions, context))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  return matching[0] ?? null;
}

/**
 * The steps that actually apply, grouped into sequences.
 *
 * Steps whose conditions do not hold are dropped — that is how amount
 * thresholds work. Steps sharing a sequence run in parallel.
 */
export function planSteps(
  definition: WorkflowDefinition,
  context: ApprovalContext,
): WorkflowStepDefinition[][] {
  const applicable = definition.steps
    .filter((step) => matchesConditions(step.conditions, context))
    .sort((a, b) => a.sequence - b.sequence);

  const grouped = new Map<number, WorkflowStepDefinition[]>();
  for (const step of applicable) {
    const existing = grouped.get(step.sequence);
    if (existing) existing.push(step);
    else grouped.set(step.sequence, [step]);
  }

  return [...grouped.entries()].sort(([a], [b]) => a - b).map(([, steps]) => steps);
}

/**
 * Whether a parallel step is satisfied.
 *
 * `count` without `quorumCount` falls back to requiring one approval rather
 * than zero — a misconfigured quorum must never auto-approve.
 */
export function quorumMet(
  step: WorkflowStepDefinition,
  approvals: number,
  totalApprovers: number,
): boolean {
  switch (step.quorum ?? 'all') {
    case 'any':
      return approvals >= 1;
    case 'majority':
      return approvals > totalApprovers / 2;
    case 'count':
      return approvals >= Math.max(1, step.quorumCount ?? 1);
    case 'all':
    default:
      return approvals >= totalApprovers;
  }
}

/**
 * Whether a change to an entity invalidates its in-flight approval.
 *
 * Someone approving a 40,000 purchase order that is then edited to 400,000 has
 * not approved 400,000.
 */
export function requiresReapproval(
  definition: WorkflowDefinition,
  before: ApprovalContext,
  after: ApprovalContext,
): boolean {
  const watched = definition.resetOnFieldChange ?? [];
  return watched.some((field) => !Object.is(readPath(before, field), readPath(after, field)));
}

function toComparable(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    // Money arrives from Postgres numeric as a string; compare it as a number.
    const parsed = Number(value);
    if (!Number.isNaN(parsed) && value.trim() !== '') return parsed;
    const asDate = Date.parse(value);
    return Number.isNaN(asDate) ? null : asDate;
  }
  return null;
}

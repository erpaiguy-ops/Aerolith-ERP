/**
 * Project delivery: WBS, budgets, progress and the cost ledger.
 *
 * No import of Estimation, Production or Contracts. Seeding a budget from a won
 * estimate is composed at the application layer, which may depend on both; this
 * module accepts budget lines and does not care where they came from.
 */
import {
  emit,
  listResult,
  recordAudit,
  requireTenantContext,
  schema,
  searchPattern,
  type ListParams,
  type ListResult,
  type Transaction,
} from '@aerolith/kernel';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';

import {
  budget,
  budgetLine,
  commitment,
  costEntry,
  progressEntry,
  projectDetail,
  wbsNode,
} from '../db/schema';
import {
  earnedValueMetrics,
  forecast,
  marginPosition,
  type EarnedValueInput,
  type ForecastMethod,
  type MarginPosition,
} from '../domain/earnedValue';
import {
  nodeProgressPercent,
  projectProgress,
  rollUpProgress,
  type ProgressInput,
  type RolledUpNode,
  type RuleOfCredit,
  type WbsNode as DomainNode,
} from '../domain/progress';

export const MODULE_KEY = 'projects';

export class ProjectsError extends Error {
  override readonly name = 'ProjectsError';
}

type CostCategory =
  | 'material'
  | 'labour'
  | 'machine'
  | 'finishing'
  | 'hardware'
  | 'subcontract'
  | 'transport'
  | 'preliminaries'
  | 'contingency'
  | 'other';

const num = (value: string | null | undefined): number => (value == null ? 0 : Number(value));

// ---------------------------------------------------------------------------
// Work breakdown structure
// ---------------------------------------------------------------------------

export interface WbsNodeInput {
  code: string;
  name: string;
  /** Code of the parent, not its id — a WBS is authored top-down by code. */
  parentCode?: string | null;
  ruleOfCredit?: RuleOfCredit;
  unitsPlanned?: number | null;
  uomCode?: string | null;
  creditMilestones?: { key: string; label?: string; weightPercent: number }[];
  sortOrder?: number;
}

/**
 * Creates a whole work breakdown in one pass.
 *
 * Parents are resolved by code and must appear before their children. That
 * ordering requirement is a deliberate constraint rather than a two-pass
 * resolution: a WBS whose parents come after its children is almost always a
 * malformed import, and accepting it silently produces a tree nobody can read.
 */
export async function createWbs(
  tx: Transaction,
  input: { projectId: string; nodes: WbsNodeInput[] },
): Promise<{ created: number; idsByCode: Map<string, string> }> {
  const { tenantId } = requireTenantContext();
  const idsByCode = new Map<string, string>();
  const pathsByCode = new Map<string, string>();

  for (const [index, node] of input.nodes.entries()) {
    let parentId: string | null = null;
    let path = node.code;
    let depth = 0;

    if (node.parentCode) {
      parentId = idsByCode.get(node.parentCode) ?? null;
      if (!parentId) {
        throw new ProjectsError(
          `WBS node "${node.code}" names parent "${node.parentCode}", which has not been ` +
            'created yet. Parents must be listed before their children.',
        );
      }
      const parentPath = pathsByCode.get(node.parentCode)!;
      path = `${parentPath}/${node.code}`;
      depth = parentPath.split('/').length;
    }

    if (node.ruleOfCredit === 'milestone') {
      const total = (node.creditMilestones ?? []).reduce((s, m) => s + m.weightPercent, 0);
      if (Math.abs(total - 100) > 0.01) {
        throw new ProjectsError(
          `WBS node "${node.code}" uses milestone credit, so its milestone weights must ` +
            `total 100%; they total ${total.toFixed(2)}%.`,
        );
      }
    }

    const [created] = await tx
      .insert(wbsNode)
      .values({
        tenantId,
        projectId: input.projectId,
        parentId,
        code: node.code,
        name: node.name,
        path,
        depth,
        sortOrder: node.sortOrder ?? index,
        ruleOfCredit: node.ruleOfCredit ?? 'manual',
        unitsPlanned: node.unitsPlanned == null ? null : String(node.unitsPlanned),
        uomCode: node.uomCode,
        creditMilestones: node.creditMilestones ?? [],
      })
      .returning({ id: wbsNode.id });

    idsByCode.set(node.code, created!.id);
    pathsByCode.set(node.code, path);
  }

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'projects.wbs',
    entityId: input.projectId,
    action: 'create',
    metadata: { nodeCount: input.nodes.length },
  });

  return { created: input.nodes.length, idsByCode };
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface BudgetLineInput {
  /** WBS code, resolved here so callers do not have to hold ids. */
  wbsCode?: string | null;
  category: CostCategory;
  description: string;
  quantity?: number;
  uomCode?: string | null;
  unitCost?: number;
  lineCost: number;
  lineValue?: number;
  sourceEstimateLineId?: string | null;
  itemId?: string | null;
}

export interface CreateBudgetInput {
  projectId: string;
  lines: BudgetLineInput[];
  source?: 'estimate' | 'manual' | 'variation';
  sourceEstimateId?: string | null;
  sourceVariationId?: string | null;
  contingencyAmount?: number;
  note?: string | null;
}

/**
 * Creates the next budget version.
 *
 * Never edits the previous one. When a variation is approved the job's budget
 * grows, and the record of what it was expected to cost before that must
 * survive — otherwise an overrun quietly becomes the plan and the loss is gone
 * from the numbers before anyone has to explain it.
 */
export async function createBudgetVersion(
  tx: Transaction,
  input: CreateBudgetInput,
): Promise<{ budgetId: string; version: number; totalCost: number; totalValue: number }> {
  const { tenantId, userId } = requireTenantContext();

  const existing = await tx
    .select({ version: budget.version })
    .from(budget)
    .where(and(eq(budget.tenantId, tenantId), eq(budget.projectId, input.projectId)))
    .orderBy(asc(budget.version));

  const version = existing.length === 0 ? 1 : Math.max(...existing.map((r) => r.version)) + 1;

  const totalCost = input.lines.reduce((sum, l) => sum + l.lineCost, 0);
  const totalValue = input.lines.reduce((sum, l) => sum + (l.lineValue ?? 0), 0);

  const [created] = await tx
    .insert(budget)
    .values({
      tenantId,
      projectId: input.projectId,
      version,
      status: 'draft',
      source: input.source ?? 'manual',
      sourceEstimateId: input.sourceEstimateId,
      sourceVariationId: input.sourceVariationId,
      totalCost: totalCost.toFixed(2),
      totalValue: totalValue.toFixed(2),
      contingencyAmount: (input.contingencyAmount ?? 0).toFixed(2),
      note: input.note,
      createdBy: userId,
    })
    .returning({ id: budget.id });

  const budgetId = created!.id;

  const nodes = await tx
    .select({ id: wbsNode.id, code: wbsNode.code })
    .from(wbsNode)
    .where(and(eq(wbsNode.tenantId, tenantId), eq(wbsNode.projectId, input.projectId)));
  const nodeIdByCode = new Map(nodes.map((n) => [n.code, n.id]));

  for (const line of input.lines) {
    let wbsNodeId: string | null = null;
    if (line.wbsCode) {
      wbsNodeId = nodeIdByCode.get(line.wbsCode) ?? null;
      if (!wbsNodeId) {
        throw new ProjectsError(
          `Budget line references WBS code "${line.wbsCode}", which does not exist on this project.`,
        );
      }
    }

    await tx.insert(budgetLine).values({
      tenantId,
      budgetId,
      wbsNodeId,
      sourceEstimateLineId: line.sourceEstimateLineId,
      itemId: line.itemId,
      category: line.category,
      description: line.description,
      quantity: (line.quantity ?? 0).toFixed(4),
      uomCode: line.uomCode,
      unitCost: (line.unitCost ?? 0).toFixed(4),
      lineCost: line.lineCost.toFixed(2),
      lineValue: (line.lineValue ?? 0).toFixed(2),
    });
  }

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'projects.budget',
    entityId: budgetId,
    entityLabel: `v${version}`,
    action: 'create',
    metadata: { source: input.source ?? 'manual', totalCost, lineCount: input.lines.length },
  });

  return { budgetId, version, totalCost, totalValue };
}

/**
 * Approves a budget version and makes it the baseline.
 *
 * Supersedes the previous approved version and refreshes the cached per-node
 * budget figures the progress roll-up weights by. Those caches are rebuilt from
 * `budget_line` rather than incremented, so they cannot drift.
 */
export async function approveBudget(
  tx: Transaction,
  input: { budgetId: string },
): Promise<{ projectId: string; version: number }> {
  const { tenantId, userId } = requireTenantContext();

  const [target] = await tx
    .select({ id: budget.id, projectId: budget.projectId, version: budget.version, status: budget.status })
    .from(budget)
    .where(and(eq(budget.tenantId, tenantId), eq(budget.id, input.budgetId)));

  if (!target) throw new ProjectsError('Budget not found.');
  if (target.status === 'approved') throw new ProjectsError('Budget is already approved.');
  if (target.status === 'superseded') {
    throw new ProjectsError('A superseded budget cannot be approved; create a new version.');
  }

  await tx
    .update(budget)
    .set({ status: 'superseded', updatedAt: new Date() })
    .where(
      and(
        eq(budget.tenantId, tenantId),
        eq(budget.projectId, target.projectId),
        eq(budget.status, 'approved'),
      ),
    );

  await tx
    .update(budget)
    .set({ status: 'approved', approvedBy: userId, approvedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(budget.tenantId, tenantId), eq(budget.id, input.budgetId)));

  // Rebuild the per-node cache from the approved lines. Nodes with no lines are
  // reset to zero, so a line moved between versions cannot leave a stale weight
  // behind inflating a parent's percentage.
  await tx
    .update(wbsNode)
    .set({ budgetCost: '0', budgetValue: '0', updatedAt: new Date() })
    .where(and(eq(wbsNode.tenantId, tenantId), eq(wbsNode.projectId, target.projectId)));

  const totals = await tx
    .select({
      wbsNodeId: budgetLine.wbsNodeId,
      cost: sql<string>`sum(${budgetLine.lineCost})`,
      value: sql<string>`sum(${budgetLine.lineValue})`,
    })
    .from(budgetLine)
    .where(and(eq(budgetLine.tenantId, tenantId), eq(budgetLine.budgetId, input.budgetId)))
    .groupBy(budgetLine.wbsNodeId);

  for (const total of totals) {
    if (!total.wbsNodeId) continue;
    await tx
      .update(wbsNode)
      .set({
        budgetCost: num(total.cost).toFixed(2),
        budgetValue: num(total.value).toFixed(2),
        updatedAt: new Date(),
      })
      .where(and(eq(wbsNode.tenantId, tenantId), eq(wbsNode.id, total.wbsNodeId)));
  }

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'projects.budget',
    entityId: input.budgetId,
    entityLabel: `v${target.version}`,
    action: 'approve',
  });

  await emit(tx, {
    type: 'projects.budget.approved',
    sourceModule: MODULE_KEY,
    aggregateType: 'projects.budget',
    aggregateId: input.budgetId,
    payload: { projectId: target.projectId, version: target.version },
  });

  return { projectId: target.projectId, version: target.version };
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export interface RecordProgressInput {
  projectId: string;
  /** Period end, ISO date. Progress is measured for a period, not a moment. */
  periodEnd: string;
  measurements: {
    wbsCode: string;
    unitsComplete?: number;
    started?: boolean;
    finished?: boolean;
    milestonesAchieved?: string[];
    manualPercent?: number;
    evidenceDocumentId?: string | null;
    note?: string | null;
  }[];
}

export interface RecordProgressResult {
  periodEnd: string;
  measured: number;
  percentComplete: number;
  earnedValue: number;
  budgetValue: number;
  containsManualClaims: boolean;
}

/**
 * Records measured progress for a period and rolls it up.
 *
 * The rule of credit on each node decides what evidence is accepted; a units
 * measurement on a milestone node is ignored rather than quietly accepted, which
 * would let anyone bypass the rule by sending the wrong field. Re-measuring a
 * period replaces that period's row — see the schema note on why two rows for
 * one period is worse than one row that changed.
 */
export async function recordProgress(
  tx: Transaction,
  input: RecordProgressInput,
): Promise<RecordProgressResult> {
  const { tenantId, userId } = requireTenantContext();

  const nodes = await tx
    .select()
    .from(wbsNode)
    .where(and(eq(wbsNode.tenantId, tenantId), eq(wbsNode.projectId, input.projectId)));

  if (nodes.length === 0) {
    throw new ProjectsError('This project has no work breakdown to measure against.');
  }

  const byCode = new Map(nodes.map((n) => [n.code, n]));

  for (const measurement of input.measurements) {
    const node = byCode.get(measurement.wbsCode);
    if (!node) {
      throw new ProjectsError(`WBS code "${measurement.wbsCode}" does not exist on this project.`);
    }

    const achieved = new Set(measurement.milestonesAchieved ?? []);
    const progress: ProgressInput = {
      ruleOfCredit: node.ruleOfCredit,
      unitsPlanned: node.unitsPlanned == null ? undefined : num(node.unitsPlanned),
      unitsComplete: measurement.unitsComplete,
      started: measurement.started,
      finished: measurement.finished,
      milestones: node.creditMilestones.map((m) => ({
        key: m.key,
        weightPercent: m.weightPercent,
        achieved: achieved.has(m.key),
      })),
      manualPercent: measurement.manualPercent,
    };

    const percent = nodeProgressPercent(progress);
    const earned = num(node.budgetValue) * (percent / 100);

    const values = {
      tenantId,
      projectId: input.projectId,
      wbsNodeId: node.id,
      periodEnd: input.periodEnd,
      ruleOfCredit: node.ruleOfCredit,
      unitsComplete:
        measurement.unitsComplete == null ? null : measurement.unitsComplete.toFixed(4),
      unitsPlanned: node.unitsPlanned,
      started: measurement.started ?? false,
      finished: measurement.finished ?? false,
      milestonesAchieved: progress.milestones ?? [],
      manualPercent: measurement.manualPercent == null ? null : measurement.manualPercent.toFixed(3),
      percentComplete: percent.toFixed(3),
      earnedValue: earned.toFixed(2),
      evidenceDocumentId: measurement.evidenceDocumentId,
      measuredBy: userId,
      note: measurement.note,
    };

    await tx
      .insert(progressEntry)
      .values(values)
      .onConflictDoUpdate({
        target: [progressEntry.wbsNodeId, progressEntry.periodEnd],
        set: { ...values, updatedAt: new Date() },
      });

    await tx
      .update(wbsNode)
      .set({
        percentComplete: percent.toFixed(3),
        lastMeasuredOn: input.periodEnd,
        updatedAt: new Date(),
      })
      .where(and(eq(wbsNode.tenantId, tenantId), eq(wbsNode.id, node.id)));
  }

  const refreshed = await tx
    .select({
      id: wbsNode.id,
      parentId: wbsNode.parentId,
      budgetValue: wbsNode.budgetValue,
      budgetCost: wbsNode.budgetCost,
      percentComplete: wbsNode.percentComplete,
      ruleOfCredit: wbsNode.ruleOfCredit,
    })
    .from(wbsNode)
    .where(and(eq(wbsNode.tenantId, tenantId), eq(wbsNode.projectId, input.projectId)));

  const summary = projectProgress(
    refreshed.map((n) => ({
      id: n.id,
      parentId: n.parentId,
      budgetValue: num(n.budgetValue),
      budgetCost: num(n.budgetCost),
      // The percentage is already resolved on the node, so the roll-up is fed a
      // `manual` input carrying it verbatim. Re-deriving from the rule here
      // would double-apply the manual ceiling to a node measured last month.
      progress: { ruleOfCredit: 'manual', manualPercent: num(n.percentComplete) },
    })),
  );

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'projects.progress',
    entityId: input.projectId,
    entityLabel: input.periodEnd,
    action: 'update',
    metadata: {
      periodEnd: input.periodEnd,
      measured: input.measurements.length,
      percentComplete: summary.percentComplete,
    },
  });

  await emit(tx, {
    type: 'projects.progress.recorded',
    sourceModule: MODULE_KEY,
    aggregateType: 'kernel.project',
    aggregateId: input.projectId,
    payload: {
      periodEnd: input.periodEnd,
      percentComplete: summary.percentComplete,
      earnedValue: summary.earnedValue,
    },
  });

  return {
    periodEnd: input.periodEnd,
    measured: input.measurements.length,
    percentComplete: summary.percentComplete,
    earnedValue: summary.earnedValue,
    budgetValue: summary.budgetValue,
    containsManualClaims: refreshed.some((n) => n.ruleOfCredit === 'manual'),
  };
}

/** The WBS with progress rolled up. For the tree view and for reporting. */
export async function getWbsRollUp(
  tx: Transaction,
  input: { projectId: string },
): Promise<Map<string, RolledUpNode>> {
  const { tenantId } = requireTenantContext();

  const nodes = await tx
    .select({
      id: wbsNode.id,
      parentId: wbsNode.parentId,
      budgetValue: wbsNode.budgetValue,
      budgetCost: wbsNode.budgetCost,
      percentComplete: wbsNode.percentComplete,
    })
    .from(wbsNode)
    .where(and(eq(wbsNode.tenantId, tenantId), eq(wbsNode.projectId, input.projectId)))
    .orderBy(asc(wbsNode.path));

  const domain: DomainNode[] = nodes.map((n) => ({
    id: n.id,
    parentId: n.parentId,
    budgetValue: num(n.budgetValue),
    budgetCost: num(n.budgetCost),
    // The percentage is already resolved on the node, so the roll-up is fed a
    // `manual` input carrying it verbatim. Re-deriving from the rule here would
    // double-apply the manual ceiling to a node measured last month.
    progress: { ruleOfCredit: 'manual', manualPercent: num(n.percentComplete) },
  }));

  return rollUpProgress(domain);
}

// ---------------------------------------------------------------------------
// Cost ledger
// ---------------------------------------------------------------------------

export interface PostCostInput {
  projectId: string;
  wbsNodeId?: string | null;
  postedOn: string;
  category: CostCategory;
  description: string;
  sourceModule: string;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
  amount: number;
  currencyCode?: string | null;
  quantity?: number | null;
  uomCode?: string | null;
  isAccrual?: boolean;
}

/**
 * Posts an actual cost against a job. The only way anything enters the ledger.
 *
 * Every other module calls this — Inventory on a material issue, Production on a
 * labour booking, Procurement on an invoice. Keeping the write in one place is
 * what makes `sourceModule` and `sourceEntityId` trustworthy, and therefore what
 * makes any figure on a cost report traceable to the transaction behind it.
 */
export async function postCost(tx: Transaction, input: PostCostInput): Promise<{ entryId: string }> {
  const { tenantId, userId } = requireTenantContext();

  if (!Number.isFinite(input.amount)) {
    throw new ProjectsError('Cost amount must be a finite number.');
  }

  const [created] = await tx
    .insert(costEntry)
    .values({
      tenantId,
      projectId: input.projectId,
      wbsNodeId: input.wbsNodeId,
      postedOn: input.postedOn,
      category: input.category,
      description: input.description,
      sourceModule: input.sourceModule,
      sourceEntityType: input.sourceEntityType,
      sourceEntityId: input.sourceEntityId,
      amount: input.amount.toFixed(2),
      currencyCode: input.currencyCode,
      quantity: input.quantity == null ? null : input.quantity.toFixed(4),
      uomCode: input.uomCode,
      isAccrual: input.isAccrual ?? false,
      postedBy: userId,
    })
    .returning({ id: costEntry.id });

  return { entryId: created!.id };
}

/**
 * Reverses a cost entry.
 *
 * A compensating entry, never a delete — the database refuses a delete anyway,
 * which is the point. Both rows stay visible so the correction is part of the
 * record rather than a gap in it.
 */
export async function reverseCost(
  tx: Transaction,
  input: { entryId: string; postedOn: string; reason: string },
): Promise<{ entryId: string }> {
  const { tenantId, userId } = requireTenantContext();

  const [original] = await tx
    .select()
    .from(costEntry)
    .where(and(eq(costEntry.tenantId, tenantId), eq(costEntry.id, input.entryId)));

  if (!original) throw new ProjectsError('Cost entry not found.');
  if (original.reversesEntryId) {
    throw new ProjectsError('That entry is itself a reversal; reverse the original instead.');
  }

  const [existingReversal] = await tx
    .select({ id: costEntry.id })
    .from(costEntry)
    .where(and(eq(costEntry.tenantId, tenantId), eq(costEntry.reversesEntryId, input.entryId)));

  if (existingReversal) throw new ProjectsError('That entry has already been reversed.');

  const [created] = await tx
    .insert(costEntry)
    .values({
      tenantId,
      projectId: original.projectId,
      wbsNodeId: original.wbsNodeId,
      postedOn: input.postedOn,
      category: original.category,
      description: `Reversal: ${original.description}`,
      sourceModule: original.sourceModule,
      sourceEntityType: original.sourceEntityType,
      sourceEntityId: original.sourceEntityId,
      amount: (-num(original.amount)).toFixed(2),
      currencyCode: original.currencyCode,
      isAccrual: original.isAccrual,
      reversesEntryId: original.id,
      postedBy: userId,
    })
    .returning({ id: costEntry.id });

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'projects.cost_entry',
    entityId: input.entryId,
    action: 'update',
    reason: input.reason,
    metadata: { reversalId: created!.id, amount: num(original.amount) },
  });

  return { entryId: created!.id };
}

// ---------------------------------------------------------------------------
// Job costing
// ---------------------------------------------------------------------------

export interface CostSummary {
  projectId: string;
  budgetAtCompletion: number;
  budgetValue: number;
  actualCost: number;
  accruedCost: number;
  openCommitments: number;
  /** Budgeted REVENUE earned. What a payment application values against. */
  earnedValue: number;
  /**
   * Budgeted COST earned — EVM's BCWP.
   *
   * Reported separately from `earnedValue` and never interchangeable with it.
   * CPI is earned cost over actual cost; feeding it earned revenue instead
   * overstates the index by exactly the job's margin, so a job losing money
   * reports a CPI comfortably above 1.0 right up until the final account.
   */
  earnedCost: number;
  percentComplete: number;
  byCategory: { category: CostCategory; budget: number; actual: number; variance: number }[];
}

/**
 * Actual and committed cost against budget, by category.
 *
 * Actual cost INCLUDES accruals: a job whose invoices are late is not a job that
 * is under budget. `accruedCost` is reported alongside so the accrued portion is
 * visible rather than merely included.
 */
export async function getCostSummary(
  tx: Transaction,
  input: { projectId: string },
): Promise<CostSummary> {
  const { tenantId } = requireTenantContext();

  const [approvedBudget] = await tx
    .select({ id: budget.id, totalCost: budget.totalCost, totalValue: budget.totalValue })
    .from(budget)
    .where(
      and(
        eq(budget.tenantId, tenantId),
        eq(budget.projectId, input.projectId),
        eq(budget.status, 'approved'),
      ),
    );

  const budgetByCategory = approvedBudget
    ? await tx
        .select({
          category: budgetLine.category,
          cost: sql<string>`sum(${budgetLine.lineCost})`,
        })
        .from(budgetLine)
        .where(and(eq(budgetLine.tenantId, tenantId), eq(budgetLine.budgetId, approvedBudget.id)))
        .groupBy(budgetLine.category)
    : [];

  const actualByCategory = await tx
    .select({
      category: costEntry.category,
      amount: sql<string>`sum(${costEntry.amount})`,
      accrued: sql<string>`sum(case when ${costEntry.isAccrual} then ${costEntry.amount} else 0 end)`,
    })
    .from(costEntry)
    .where(and(eq(costEntry.tenantId, tenantId), eq(costEntry.projectId, input.projectId)))
    .groupBy(costEntry.category);

  const [commitments] = await tx
    .select({
      // The exposure of an open commitment is what is left on it, not its face
      // value: the invoiced part is already in the cost ledger, and adding both
      // double-counts every part-delivered purchase order on the job.
      open: sql<string>`sum(greatest(${commitment.committedAmount} - ${commitment.invoicedAmount}, 0))`,
    })
    .from(commitment)
    .where(
      and(
        eq(commitment.tenantId, tenantId),
        eq(commitment.projectId, input.projectId),
        eq(commitment.status, 'open'),
      ),
    );

  const rollUp = await getWbsRollUp(tx, { projectId: input.projectId });
  const roots = [...rollUp.values()].filter((n) => n.parentId == null);
  const earnedValue = roots.reduce((sum, n) => sum + n.earnedValue, 0);
  const earnedCost = roots.reduce((sum, n) => sum + n.earnedCost, 0);
  const wbsBudgetValue = roots.reduce((sum, n) => sum + n.totalBudgetValue, 0);

  const categories = new Set<string>([
    ...budgetByCategory.map((b) => b.category),
    ...actualByCategory.map((a) => a.category),
  ]);

  const byCategory = [...categories].map((category) => {
    const budgeted = num(budgetByCategory.find((b) => b.category === category)?.cost);
    const actual = num(actualByCategory.find((a) => a.category === category)?.amount);
    return {
      category: category as CostCategory,
      budget: budgeted,
      actual,
      variance: budgeted - actual,
    };
  });

  return {
    projectId: input.projectId,
    budgetAtCompletion: num(approvedBudget?.totalCost),
    budgetValue: num(approvedBudget?.totalValue),
    actualCost: actualByCategory.reduce((sum, a) => sum + num(a.amount), 0),
    accruedCost: actualByCategory.reduce((sum, a) => sum + num(a.accrued), 0),
    openCommitments: num(commitments?.open),
    earnedValue,
    earnedCost,
    percentComplete: wbsBudgetValue > 0 ? (earnedValue / wbsBudgetValue) * 100 : 0,
    byCategory,
  };
}

export interface ProjectPosition extends MarginPosition {
  metrics: ReturnType<typeof earnedValueMetrics>;
  forecast: ReturnType<typeof forecast>;
  summary: CostSummary;
}

/**
 * The full commercial position: earned value, forecast cost and forecast margin.
 *
 * `contractValue` is passed in rather than read, because on a live job it is the
 * contract sum including approved variations — which lives in Contract
 * Administration, a module this one must not import. The application layer
 * supplies it; without Contracts, the budget's revenue side is used instead.
 */
export async function getProjectPosition(
  tx: Transaction,
  input: {
    projectId: string;
    contractValue?: number;
    plannedValue?: number;
    method?: ForecastMethod;
  },
): Promise<ProjectPosition> {
  const { tenantId } = requireTenantContext();
  const summary = await getCostSummary(tx, { projectId: input.projectId });

  const [detail] = await tx
    .select({ tenderMarginPercent: projectDetail.tenderMarginPercent })
    .from(projectDetail)
    .where(and(eq(projectDetail.tenantId, tenantId), eq(projectDetail.projectId, input.projectId)));

  // Both sides in COST terms: budget at completion is the cost budget and actual
  // cost is the ledger, so earned value has to be the cost-weighted roll-up.
  // `summary.earnedValue` is the revenue figure and does not belong here.
  const evInput: EarnedValueInput = {
    budgetAtCompletion: summary.budgetAtCompletion,
    plannedValue: input.plannedValue,
    earnedValue: summary.earnedCost,
    actualCost: summary.actualCost,
    openCommitments: summary.openCommitments,
  };

  const method = input.method ?? 'performance_rate';

  return {
    ...marginPosition(
      {
        ...evInput,
        contractValue: input.contractValue ?? summary.budgetValue,
        tenderMarginPercent: detail?.tenderMarginPercent
          ? num(detail.tenderMarginPercent)
          : undefined,
      },
      method,
    ),
    metrics: earnedValueMetrics(evInput),
    forecast: forecast(evInput, method),
    summary,
  };
}

// ---------------------------------------------------------------------------
// Commitments
// ---------------------------------------------------------------------------

export interface RecordCommitmentInput {
  projectId: string;
  wbsNodeId?: string | null;
  type: 'purchase_order' | 'subcontract' | 'other';
  reference: string;
  partyId?: string | null;
  description?: string | null;
  category: CostCategory;
  committedAmount: number;
  currencyCode?: string | null;
  sourceModule: string;
  sourceEntityId?: string | null;
  expectedOn?: string | null;
}

/** Records money promised. Upserts on (sourceModule, reference) so a revised PO
 *  moves the commitment rather than creating a second one. */
export async function recordCommitment(
  tx: Transaction,
  input: RecordCommitmentInput,
): Promise<{ commitmentId: string }> {
  const { tenantId } = requireTenantContext();

  const values = {
    tenantId,
    projectId: input.projectId,
    wbsNodeId: input.wbsNodeId,
    type: input.type,
    reference: input.reference,
    partyId: input.partyId,
    description: input.description,
    category: input.category,
    committedAmount: input.committedAmount.toFixed(2),
    currencyCode: input.currencyCode,
    sourceModule: input.sourceModule,
    sourceEntityId: input.sourceEntityId,
    expectedOn: input.expectedOn,
  };

  const [created] = await tx
    .insert(commitment)
    .values(values)
    .onConflictDoUpdate({
      target: [commitment.tenantId, commitment.sourceModule, commitment.reference],
      set: {
        committedAmount: values.committedAmount,
        wbsNodeId: values.wbsNodeId,
        expectedOn: values.expectedOn,
        updatedAt: new Date(),
      },
    })
    .returning({ id: commitment.id });

  return { commitmentId: created!.id };
}

/**
 * Relieves a commitment as it converts to actual cost, and closes it when spent.
 *
 * A commitment left open after its invoices arrive double-counts the money —
 * once as an actual and once as a future certainty — which makes the forecast
 * worse the further the job progresses.
 */
export async function relieveCommitment(
  tx: Transaction,
  input: { commitmentId: string; invoicedAmount: number },
): Promise<{ remaining: number; closed: boolean }> {
  const { tenantId } = requireTenantContext();

  const [row] = await tx
    .select()
    .from(commitment)
    .where(and(eq(commitment.tenantId, tenantId), eq(commitment.id, input.commitmentId)));

  if (!row) throw new ProjectsError('Commitment not found.');

  const invoiced = num(row.invoicedAmount) + input.invoicedAmount;
  const remaining = Math.max(0, num(row.committedAmount) - invoiced);
  const closed = remaining <= 0.005;

  await tx
    .update(commitment)
    .set({
      invoicedAmount: invoiced.toFixed(2),
      status: closed ? 'closed' : 'open',
      updatedAt: new Date(),
    })
    .where(and(eq(commitment.tenantId, tenantId), eq(commitment.id, input.commitmentId)));

  return { remaining, closed };
}

/** Cost entries for a set of WBS nodes. Used by the drill-down from any figure. */
export async function getCostEntries(
  tx: Transaction,
  input: { projectId: string; wbsNodeIds?: string[] },
): Promise<(typeof costEntry.$inferSelect)[]> {
  const { tenantId } = requireTenantContext();

  const conditions = [eq(costEntry.tenantId, tenantId), eq(costEntry.projectId, input.projectId)];
  if (input.wbsNodeIds && input.wbsNodeIds.length > 0) {
    conditions.push(inArray(costEntry.wbsNodeId, input.wbsNodeIds));
  }

  return tx.select().from(costEntry).where(and(...conditions)).orderBy(asc(costEntry.postedOn));
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface ProjectListRow {
  id: string;
  code: string;
  name: string;
  status: string;
  currencyCode: string | null;
  contractValue: number | null;
  startDate: string | null;
  endDate: string | null;
  countryCode: string | null;
  /** From the module's own detail row. Null when the project has no detail yet. */
  healthStatus: string | null;
  forecastEndDate: string | null;
  /** Days late against the baseline. Negative is early. Null without both dates. */
  scheduleVarianceDays: number | null;
}

/**
 * A page of projects, for the index screen.
 *
 * Left-joined to `project_detail` rather than inner-joined: a project created by
 * Estimation or Contracts has a `kernel.project` row and no Projects detail until
 * somebody opens it here. An inner join would silently hide exactly the projects
 * a user is looking for.
 *
 * Deliberately does NOT compute earned value per row. That needs the WBS roll-up
 * and the cost ledger for every project on the page, which is a query per row on
 * the one screen a user hits first. Health status is the PM's own summary and is
 * already on the row; the real numbers are one click away.
 */
export async function listProjects(
  tx: Transaction,
  params: ListParams,
  filters: { status?: string } = {},
): Promise<ListResult<ProjectListRow>> {
  const { tenantId } = requireTenantContext();

  const conditions = [
    eq(schema.project.tenantId, tenantId),
    // Soft-deleted projects are gone as far as any list is concerned. Without
    // this they come back, and a user who deleted something watching it reappear
    // stops trusting delete everywhere else in the product.
    isNull(schema.project.deletedAt),
  ];

  if (filters.status) conditions.push(eq(schema.project.status, filters.status));

  if (params.search) {
    const pattern = searchPattern(params.search);
    conditions.push(
      or(
        ilike(schema.project.code, pattern),
        ilike(schema.project.name, pattern),
      )!,
    );
  }

  const where = and(...conditions);

  const sortColumn = {
    code: schema.project.code,
    name: schema.project.name,
    status: schema.project.status,
    contractValue: schema.project.contractValue,
    endDate: schema.project.endDate,
    createdAt: schema.project.createdAt,
  }[params.sort as string] ?? schema.project.createdAt;

  const rows = await tx
    .select({
      id: schema.project.id,
      code: schema.project.code,
      name: schema.project.name,
      status: schema.project.status,
      currencyCode: schema.project.currencyCode,
      contractValue: schema.project.contractValue,
      startDate: schema.project.startDate,
      endDate: schema.project.endDate,
      countryCode: schema.project.countryCode,
      healthStatus: projectDetail.healthStatus,
      forecastEndDate: projectDetail.forecastEndDate,
      baselineEndDate: projectDetail.baselineEndDate,
    })
    .from(schema.project)
    .leftJoin(
      projectDetail,
      and(
        eq(projectDetail.projectId, schema.project.id),
        eq(projectDetail.tenantId, tenantId),
      ),
    )
    .where(where)
    // Tie-broken on id. Without it, rows sharing a status sort arbitrarily and
    // can appear on two pages or none as the user pages through.
    .orderBy(
      params.direction === 'asc' ? asc(sortColumn) : desc(sortColumn),
      asc(schema.project.id),
    )
    .limit(params.pageSize)
    .offset(params.offset);

  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(schema.project)
    .where(where);

  return listResult(
    rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      status: row.status,
      currencyCode: row.currencyCode,
      contractValue: row.contractValue == null ? null : num(row.contractValue),
      startDate: row.startDate,
      endDate: row.endDate,
      countryCode: row.countryCode,
      healthStatus: row.healthStatus,
      forecastEndDate: row.forecastEndDate,
      scheduleVarianceDays: daysBetween(row.baselineEndDate, row.forecastEndDate),
    })),
    counted?.total ?? 0,
    params,
  );
}

/** Whole days from `from` to `to`. Null unless both are present. */
function daysBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return Math.round(ms / 86_400_000);
}

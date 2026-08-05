/**
 * Physical progress measurement.
 *
 * The single most common way a construction project lies to its owners is by
 * reporting progress as an average of percentages. Twenty WBS nodes, nineteen of
 * them trivial and complete, one of them the whole job and untouched: the
 * average says 95%, the truth says 5%.
 *
 * So progress here is ALWAYS value-weighted, and the weight is the budget. A
 * node with no budget contributes nothing to the parent's percentage, which is
 * correct — it costs nothing and earns nothing.
 *
 * The second lie is self-assessed percentages. "About 80% done" is 80% for
 * months. Rules of credit exist to stop that: they replace an opinion with a
 * countable fact wherever a countable fact exists.
 */

export type RuleOfCredit =
  /** Nothing until finished. Brutal, honest, right for short tasks. */
  | 'binary'
  /** 20% for starting, 80% only on completion. The classic anti-drift rule. */
  | 'started_finished'
  /** Progress = units done / units planned. The best rule when units exist. */
  | 'units'
  /** Weighted milestones within the node. Right for design and procurement. */
  | 'milestone'
  /** A human types a number. Allowed, but marked, and capped short of 100%. */
  | 'manual';

export interface ProgressMilestone {
  key: string;
  /** Share of the node this milestone represents. Must total 100 across the node. */
  weightPercent: number;
  achieved: boolean;
}

export interface ProgressInput {
  ruleOfCredit: RuleOfCredit;
  /** For `units`. */
  unitsPlanned?: number;
  unitsComplete?: number;
  /** For `binary` and `started_finished`. */
  started?: boolean;
  finished?: boolean;
  /** For `milestone`. */
  milestones?: ProgressMilestone[];
  /** For `manual`. */
  manualPercent?: number;
}

export class ProgressError extends Error {
  override readonly name = 'ProgressError';
}

/**
 * The ceiling on a self-assessed percentage.
 *
 * A manual claim cannot reach 100%: only marking the node finished does that.
 * Without this, "100% complete" arrives weeks before the work does and the
 * project's own reporting stops being able to tell you anything.
 */
export const MANUAL_PROGRESS_CEILING = 95;

/** Percentage complete for one node, from whichever evidence its rule demands. */
export function nodeProgressPercent(input: ProgressInput): number {
  switch (input.ruleOfCredit) {
    case 'binary':
      return input.finished ? 100 : 0;

    case 'started_finished':
      if (input.finished) return 100;
      return input.started ? 20 : 0;

    case 'units': {
      const planned = input.unitsPlanned ?? 0;
      const complete = input.unitsComplete ?? 0;
      if (planned <= 0) {
        // No denominator, so no honest percentage. Finished is still knowable.
        return input.finished ? 100 : 0;
      }
      // Over-delivery is capped: 110 units of a 100-unit node is 100% complete
      // and a quantity variation, not 110% progress.
      return Math.min(100, (complete / planned) * 100);
    }

    case 'milestone': {
      const milestones = input.milestones ?? [];
      if (milestones.length === 0) return input.finished ? 100 : 0;

      const totalWeight = milestones.reduce((sum, m) => sum + m.weightPercent, 0);
      if (Math.abs(totalWeight - 100) > 0.01) {
        throw new ProgressError(
          `Milestone weights must total 100%, got ${totalWeight.toFixed(2)}%.`,
        );
      }
      return milestones.filter((m) => m.achieved).reduce((sum, m) => sum + m.weightPercent, 0);
    }

    case 'manual': {
      if (input.finished) return 100;
      const claimed = input.manualPercent ?? 0;
      if (claimed < 0) throw new ProgressError('Progress cannot be negative.');
      return Math.min(MANUAL_PROGRESS_CEILING, claimed);
    }
  }
}

// ---------------------------------------------------------------------------
// Roll-up
// ---------------------------------------------------------------------------

export interface WbsNode {
  id: string;
  parentId?: string | null;
  /** Budgeted REVENUE for this node — the weight. Zero for grouping nodes. */
  budgetValue: number;
  /**
   * Budgeted COST for this node.
   *
   * Carried alongside the revenue weight because earned value has to be
   * expressed in the same units as the thing it is compared against, and the two
   * comparisons want different units: a payment application values work at
   * contract rates (revenue), while CPI divides earned value by actual cost and
   * is meaningless unless both sides are costs. Rolling up only one of them and
   * using it for both overstates CPI by exactly the job's margin.
   */
  budgetCost?: number;
  /** Absent on a parent node: a parent's progress is derived, never claimed. */
  progress?: ProgressInput;
  /**
   * Whether this node's percentage was SELF-ASSESSED rather than measured.
   *
   * Defaults to the progress input's rule, which is right when that input
   * carries the raw measurement. It has to be settable because a caller reading
   * nodes back from the database already holds a resolved percentage and passes
   * it through a `manual` carrier — re-deriving from the rule there would
   * double-apply the manual ceiling to a node measured last month.
   *
   * Without this the carrier makes EVERY node look self-assessed and the "some
   * of this figure is an opinion" warning is on permanently. A warning that is
   * always on is not a warning: it trains people to ignore the one occasion it
   * matters.
   */
  selfAssessed?: boolean;
}

export interface RolledUpNode {
  id: string;
  parentId?: string | null;
  /** This node's own budget plus everything beneath it. */
  totalBudgetValue: number;
  totalBudgetCost: number;
  percentComplete: number;
  /** Budgeted revenue actually earned: totalBudgetValue x percent. */
  earnedValue: number;
  /** Budgeted cost actually earned — EVM's BCWP, the input to CPI. */
  earnedCost: number;
  /** True when any measurement beneath this node was self-assessed. */
  containsManualClaims: boolean;
  childIds: string[];
}

/**
 * Rolls physical progress up a WBS tree, weighting every node by its budget.
 *
 * Returns a map so a caller can read any node without walking the tree again.
 * Cycles and orphaned parents are errors, not silent data loss — a WBS that does
 * not form a tree gives a total that does not reconcile, and nobody ever finds
 * out why.
 */
export function rollUpProgress(nodes: WbsNode[]): Map<string, RolledUpNode> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();

  for (const node of nodes) {
    if (node.parentId != null) {
      if (!byId.has(node.parentId)) {
        throw new ProgressError(`WBS node ${node.id} references a parent that does not exist.`);
      }
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node.id);
      children.set(node.parentId, siblings);
    }
  }

  const result = new Map<string, RolledUpNode>();
  const visiting = new Set<string>();

  const visit = (id: string): RolledUpNode => {
    const cached = result.get(id);
    if (cached) return cached;

    if (visiting.has(id)) {
      throw new ProgressError(`WBS contains a cycle through node ${id}.`);
    }
    visiting.add(id);

    const node = byId.get(id)!;
    const childIds = children.get(id) ?? [];
    const rolledChildren = childIds.map(visit);

    // A leaf earns on its own measurement. A parent earns the sum of what its
    // children earned, plus whatever it was measured on itself — a node may
    // legitimately carry both budget and children (a "supply and install" node
    // with sub-tasks beneath it).
    const ownPercent = node.progress ? nodeProgressPercent(node.progress) / 100 : 0;
    const ownCost = node.budgetCost ?? 0;

    let totalBudget = node.budgetValue;
    let totalCost = ownCost;
    let earned = node.progress ? node.budgetValue * ownPercent : 0;
    let earnedCost = node.progress ? ownCost * ownPercent : 0;
    let manual = node.selfAssessed ?? node.progress?.ruleOfCredit === 'manual';

    for (const child of rolledChildren) {
      totalBudget += child.totalBudgetValue;
      totalCost += child.totalBudgetCost;
      earned += child.earnedValue;
      earnedCost += child.earnedCost;
      manual = manual || child.containsManualClaims;
    }

    const rolled: RolledUpNode = {
      id,
      parentId: node.parentId ?? null,
      totalBudgetValue: totalBudget,
      totalBudgetCost: totalCost,
      // Zero budget means no weight and therefore no meaningful percentage.
      // Reporting 0% would read as "nothing done" — which is a different claim
      // from "there is nothing here to measure".
      percentComplete: totalBudget > 0 ? (earned / totalBudget) * 100 : 0,
      earnedValue: earned,
      earnedCost,
      containsManualClaims: manual,
      childIds,
    };

    visiting.delete(id);
    result.set(id, rolled);
    return rolled;
  };

  for (const node of nodes) visit(node.id);
  return result;
}

/** Overall project progress: the roots, weighted together. */
export function projectProgress(nodes: WbsNode[]): {
  percentComplete: number;
  budgetValue: number;
  earnedValue: number;
  budgetCost: number;
  earnedCost: number;
  containsManualClaims: boolean;
} {
  const rolled = rollUpProgress(nodes);
  const roots = [...rolled.values()].filter((n) => n.parentId == null);

  const budgetValue = roots.reduce((sum, n) => sum + n.totalBudgetValue, 0);
  const earnedValue = roots.reduce((sum, n) => sum + n.earnedValue, 0);

  return {
    percentComplete: budgetValue > 0 ? (earnedValue / budgetValue) * 100 : 0,
    budgetValue,
    earnedValue,
    budgetCost: roots.reduce((sum, n) => sum + n.totalBudgetCost, 0),
    earnedCost: roots.reduce((sum, n) => sum + n.earnedCost, 0),
    containsManualClaims: roots.some((n) => n.containsManualClaims),
  };
}

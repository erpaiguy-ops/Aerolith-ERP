import { describe, expect, it } from 'vitest';

import type { WorkflowDefinition, WorkflowStepDefinition } from '../db/schema';
import {
  evaluateCondition,
  matchesConditions,
  planSteps,
  quorumMet,
  readPath,
  requiresReapproval,
  selectWorkflow,
} from './conditions';

describe('readPath', () => {
  it('reads a nested path', () => {
    expect(readPath({ supplier: { country: 'AE' } }, 'supplier.country')).toBe('AE');
  });

  it('returns undefined rather than throwing on a missing branch', () => {
    expect(readPath({}, 'supplier.country.region')).toBeUndefined();
  });
});

describe('evaluateCondition', () => {
  const context = { amount: 75000, status: 'draft', tags: ['urgent'], supplier: { country: 'AE' } };

  it('compares numbers', () => {
    expect(evaluateCondition({ field: 'amount', operator: 'gt', value: 50000 }, context)).toBe(true);
    expect(evaluateCondition({ field: 'amount', operator: 'gt', value: 80000 }, context)).toBe(false);
    expect(evaluateCondition({ field: 'amount', operator: 'lte', value: 75000 }, context)).toBe(true);
  });

  it('compares money that arrives from Postgres as a string', () => {
    // numeric columns come back as strings; a threshold must still work.
    expect(
      evaluateCondition({ field: 'amount', operator: 'gt', value: 50000 }, { amount: '75000.00' }),
    ).toBe(true);
  });

  it('does not compare non-numeric strings as numbers', () => {
    expect(
      evaluateCondition({ field: 'status', operator: 'gt', value: 5 }, context),
    ).toBe(false);
  });

  it('handles membership', () => {
    expect(
      evaluateCondition({ field: 'status', operator: 'in', value: ['draft', 'submitted'] }, context),
    ).toBe(true);
    expect(
      evaluateCondition({ field: 'status', operator: 'nin', value: ['approved'] }, context),
    ).toBe(true);
  });

  it('handles contains for arrays and strings', () => {
    expect(evaluateCondition({ field: 'tags', operator: 'contains', value: 'urgent' }, context)).toBe(true);
    expect(evaluateCondition({ field: 'status', operator: 'contains', value: 'DRA' }, context)).toBe(true);
  });

  it('handles existence in both directions', () => {
    expect(evaluateCondition({ field: 'amount', operator: 'exists', value: true }, context)).toBe(true);
    expect(evaluateCondition({ field: 'missing', operator: 'exists', value: true }, context)).toBe(false);
    expect(evaluateCondition({ field: 'missing', operator: 'exists', value: false }, context)).toBe(true);
  });

  it('treats a missing field as not matching rather than throwing', () => {
    expect(evaluateCondition({ field: 'nope', operator: 'gt', value: 1 }, context)).toBe(false);
  });
});

describe('matchesConditions', () => {
  it('requires every condition to hold', () => {
    const context = { amount: 60000, category: 'capex' };
    expect(
      matchesConditions(
        [
          { field: 'amount', operator: 'gt', value: 50000 },
          { field: 'category', operator: 'eq', value: 'capex' },
        ],
        context,
      ),
    ).toBe(true);

    expect(
      matchesConditions(
        [
          { field: 'amount', operator: 'gt', value: 50000 },
          { field: 'category', operator: 'eq', value: 'opex' },
        ],
        context,
      ),
    ).toBe(false);
  });

  it('matches everything when there are no conditions', () => {
    expect(matchesConditions([], { anything: 1 })).toBe(true);
    expect(matchesConditions(undefined, {})).toBe(true);
  });
});

describe('selectWorkflow', () => {
  const general: WorkflowDefinition = { entityType: 'po', conditions: [], steps: [] };
  const highValue: WorkflowDefinition = {
    entityType: 'po',
    conditions: [{ field: 'amount', operator: 'gte', value: 500000 }],
    steps: [],
  };

  const candidates = [
    { id: 'w-general', priority: 100, definition: general },
    { id: 'w-high', priority: 10, definition: highValue },
  ];

  it('picks the specific workflow when its conditions hold', () => {
    expect(selectWorkflow(candidates, { amount: 750000 })?.id).toBe('w-high');
  });

  it('falls back to the general workflow below the threshold', () => {
    expect(selectWorkflow(candidates, { amount: 1000 })?.id).toBe('w-general');
  });

  it('returns null when nothing matches', () => {
    expect(selectWorkflow([candidates[1]!], { amount: 1000 })).toBeNull();
  });

  it('breaks ties deterministically', () => {
    const tied = [
      { id: 'b', priority: 50, definition: general },
      { id: 'a', priority: 50, definition: general },
    ];
    expect(selectWorkflow(tied, {})?.id).toBe('a');
  });
});

describe('planSteps', () => {
  const step = (
    sequence: number,
    name: string,
    extra: Partial<WorkflowStepDefinition> = {},
  ): WorkflowStepDefinition => ({
    sequence,
    name,
    approverType: 'role',
    approverRef: 'manager',
    ...extra,
  });

  it('groups steps sharing a sequence so they run in parallel', () => {
    const definition: WorkflowDefinition = {
      entityType: 'po',
      conditions: [],
      steps: [step(1, 'QS'), step(1, 'Commercial'), step(2, 'Director')],
    };

    const planned = planSteps(definition, {});
    expect(planned).toHaveLength(2);
    expect(planned[0]!.map((s) => s.name)).toEqual(['QS', 'Commercial']);
    expect(planned[1]!.map((s) => s.name)).toEqual(['Director']);
  });

  it('drops steps whose conditions do not hold — this is how thresholds work', () => {
    const definition: WorkflowDefinition = {
      entityType: 'po',
      conditions: [],
      steps: [
        step(1, 'Manager'),
        step(2, 'Director', { conditions: [{ field: 'amount', operator: 'gt', value: 100000 }] }),
      ],
    };

    expect(planSteps(definition, { amount: 5000 }).flat().map((s) => s.name)).toEqual(['Manager']);
    expect(planSteps(definition, { amount: 500000 }).flat().map((s) => s.name)).toEqual([
      'Manager',
      'Director',
    ]);
  });

  it('orders sequences ascending regardless of declaration order', () => {
    const definition: WorkflowDefinition = {
      entityType: 'po',
      conditions: [],
      steps: [step(3, 'Third'), step(1, 'First'), step(2, 'Second')],
    };

    expect(planSteps(definition, {}).map((group) => group[0]!.name)).toEqual([
      'First',
      'Second',
      'Third',
    ]);
  });
});

describe('quorumMet', () => {
  const base: WorkflowStepDefinition = { sequence: 1, name: 'Board', approverType: 'role' };

  it('defaults to requiring everyone', () => {
    expect(quorumMet(base, 2, 3)).toBe(false);
    expect(quorumMet(base, 3, 3)).toBe(true);
  });

  it('supports any, majority and an explicit count', () => {
    expect(quorumMet({ ...base, quorum: 'any' }, 1, 5)).toBe(true);
    expect(quorumMet({ ...base, quorum: 'majority' }, 2, 4)).toBe(false);
    expect(quorumMet({ ...base, quorum: 'majority' }, 3, 4)).toBe(true);
    expect(quorumMet({ ...base, quorum: 'count', quorumCount: 2 }, 2, 5)).toBe(true);
  });

  it('never auto-approves on a misconfigured count', () => {
    // quorum: 'count' with no number must not mean "zero approvals needed".
    expect(quorumMet({ ...base, quorum: 'count' }, 0, 5)).toBe(false);
    expect(quorumMet({ ...base, quorum: 'count' }, 1, 5)).toBe(true);
  });
});

describe('requiresReapproval', () => {
  const definition: WorkflowDefinition = {
    entityType: 'po',
    conditions: [],
    steps: [],
    resetOnFieldChange: ['amount', 'supplierId'],
  };

  it('flags a change to a watched field', () => {
    // Approving 40,000 is not approving 400,000.
    expect(requiresReapproval(definition, { amount: 40000 }, { amount: 400000 })).toBe(true);
  });

  it('ignores a change to an unwatched field', () => {
    expect(
      requiresReapproval(definition, { amount: 40000, note: 'a' }, { amount: 40000, note: 'b' }),
    ).toBe(false);
  });

  it('never resets when nothing is watched', () => {
    expect(
      requiresReapproval({ entityType: 'po', conditions: [], steps: [] }, { amount: 1 }, { amount: 2 }),
    ).toBe(false);
  });
});

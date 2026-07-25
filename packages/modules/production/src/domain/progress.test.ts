import { describe, expect, it } from 'vitest';

import {
  canStartOperation,
  operationProgress,
  operatorMinutes,
  workOrderProgress,
  type OperationSummary,
  type Scan,
  type ScanType,
} from './progress';

const T = (minutes: number) => new Date(Date.UTC(2026, 2, 2, 8, minutes, 0));

let seq = 0;
const scan = (
  operationId: string,
  type: ScanType,
  atMinutes: number,
  over: Partial<Scan> = {},
): Scan => ({
  id: `s${(seq += 1)}`,
  operationId,
  type,
  quantity: 1,
  operatorId: 'op-1',
  scannedAt: T(atMinutes),
  ...over,
});

describe('operationProgress', () => {
  it('is pending with no scans', () => {
    const progress = operationProgress('op-a', [], 10);
    expect(progress.state).toBe('pending');
    expect(progress.completedQuantity).toBe(0);
  });

  it('measures active minutes between start and complete', () => {
    const progress = operationProgress(
      'op-a',
      [scan('op-a', 'start', 0), scan('op-a', 'complete', 45, { quantity: 10 })],
      10,
    );

    expect(progress.activeMinutes).toBe(45);
    expect(progress.completedQuantity).toBe(10);
    expect(progress.state).toBe('completed');
  });

  it('excludes paused time from active minutes', () => {
    // A job left on a machine over lunch did not take an extra hour of machine
    // time; charging it would make every cost variance meaningless.
    const progress = operationProgress(
      'op-a',
      [
        scan('op-a', 'start', 0),
        scan('op-a', 'pause', 20),
        scan('op-a', 'resume', 80),
        scan('op-a', 'complete', 100, { quantity: 5 }),
      ],
      5,
    );

    expect(progress.activeMinutes).toBe(40);
    expect(progress.pausedMinutes).toBe(60);
  });

  it('reports paused while the job is sitting', () => {
    const progress = operationProgress(
      'op-a',
      [scan('op-a', 'start', 0), scan('op-a', 'pause', 20)],
      10,
    );

    expect(progress.state).toBe('paused');
  });

  it('treats a duplicate start as a re-scan, not a restart', () => {
    // Barcode guns double-fire. Resetting the clock would silently lose time.
    const progress = operationProgress(
      'op-a',
      [
        scan('op-a', 'start', 0),
        scan('op-a', 'start', 5),
        scan('op-a', 'complete', 30, { quantity: 1 }),
      ],
      1,
    );

    expect(progress.activeMinutes).toBe(30);
    expect(progress.startedAt).toEqual(T(0));
  });

  it('accumulates partial completions', () => {
    const progress = operationProgress(
      'op-a',
      [
        scan('op-a', 'start', 0),
        scan('op-a', 'complete', 30, { quantity: 4 }),
        scan('op-a', 'start', 40),
        scan('op-a', 'complete', 70, { quantity: 6 }),
      ],
      10,
    );

    expect(progress.completedQuantity).toBe(10);
    expect(progress.state).toBe('completed');
  });

  it('counts rejects separately and does not credit them to the target', () => {
    const progress = operationProgress(
      'op-a',
      [
        scan('op-a', 'start', 0),
        scan('op-a', 'complete', 30, { quantity: 8 }),
        scan('op-a', 'reject', 35, { quantity: 2, reasonCode: 'CHIP' }),
      ],
      10,
    );

    expect(progress.completedQuantity).toBe(8);
    expect(progress.rejectedQuantity).toBe(2);
    // 8 good of 10 required — not finished.
    expect(progress.state).toBe('in_progress');
  });

  it('reopens a completed operation when a part comes back for rework', () => {
    const progress = operationProgress(
      'op-a',
      [
        scan('op-a', 'start', 0),
        scan('op-a', 'complete', 30, { quantity: 10 }),
        scan('op-a', 'rework', 90, { quantity: 1 }),
      ],
      10,
    );

    expect(progress.reworkQuantity).toBe(1);
    expect(progress.completedAt).toBeNull();
  });

  it('ignores scans belonging to other operations', () => {
    const progress = operationProgress(
      'op-a',
      [scan('op-b', 'complete', 10, { quantity: 99 }), scan('op-a', 'complete', 20, { quantity: 1 })],
      1,
    );

    expect(progress.completedQuantity).toBe(1);
  });

  it('lists every operator who touched it', () => {
    const progress = operationProgress(
      'op-a',
      [
        scan('op-a', 'start', 0, { operatorId: 'zara' }),
        scan('op-a', 'complete', 30, { operatorId: 'amir', quantity: 1 }),
      ],
      1,
    );

    expect(progress.operators).toEqual(['amir', 'zara']);
  });
});

describe('workOrderProgress', () => {
  const operations: OperationSummary[] = [
    { id: 'op-saw', sequence: 1, name: 'Cut', isQualityGate: false, targetQuantity: 10 },
    { id: 'op-edge', sequence: 2, name: 'Edge', isQualityGate: false, targetQuantity: 10 },
    { id: 'op-qc', sequence: 3, name: 'QC', isQualityGate: true, targetQuantity: 10 },
  ];

  it('is zero with no scans', () => {
    const progress = workOrderProgress(operations, []);
    expect(progress.percentComplete).toBe(0);
    expect(progress.currentOperationName).toBe('Cut');
  });

  it('weights operations evenly, not by planned minutes', () => {
    // Minute-weighting reports a job 80% done while it still has to cure for a
    // day — exactly the misleading number a PM then gives a client.
    const scans = [scan('op-saw', 'complete', 30, { quantity: 10 })];
    expect(workOrderProgress(operations, scans).percentComplete).toBeCloseTo(33.3, 1);
  });

  it('names the operation the job is currently at', () => {
    const scans = [scan('op-saw', 'complete', 30, { quantity: 10 })];
    const progress = workOrderProgress(operations, scans);

    expect(progress.currentOperationSequence).toBe(2);
    expect(progress.currentOperationName).toBe('Edge');
  });

  it('reports completion when every operation is done', () => {
    const scans = [
      scan('op-saw', 'complete', 30, { quantity: 10 }),
      scan('op-edge', 'complete', 60, { quantity: 10 }),
      scan('op-qc', 'complete', 90, { quantity: 10 }),
    ];
    const progress = workOrderProgress(operations, scans);

    expect(progress.percentComplete).toBe(100);
    expect(progress.completedAt).toEqual(T(90));
    expect(progress.currentOperationSequence).toBeNull();
  });

  it('flags a job blocked at a failed quality gate', () => {
    // The point of a gate is that it stops things. It must be visible on the
    // board, not discovered at packing.
    const scans = [
      scan('op-saw', 'complete', 30, { quantity: 10 }),
      scan('op-edge', 'complete', 60, { quantity: 10 }),
      scan('op-qc', 'reject', 90, { quantity: 3, reasonCode: 'FINISH' }),
    ];
    const progress = workOrderProgress(operations, scans);

    expect(progress.isBlocked).toBe(true);
    expect(progress.blockedReason).toMatch(/quality gate/i);
    expect(progress.totalRejected).toBe(3);
  });

  it('sums active minutes across every station', () => {
    const scans = [
      scan('op-saw', 'start', 0),
      scan('op-saw', 'complete', 30, { quantity: 10 }),
      scan('op-edge', 'start', 40),
      scan('op-edge', 'complete', 60, { quantity: 10 }),
    ];

    expect(workOrderProgress(operations, scans).totalActiveMinutes).toBe(50);
  });

  it('handles a work order with no operations', () => {
    const progress = workOrderProgress([], []);
    expect(progress.percentComplete).toBe(0);
    expect(progress.totalOperations).toBe(0);
  });
});

describe('canStartOperation', () => {
  const operations: OperationSummary[] = [
    { id: 'op-saw', sequence: 1, name: 'Cut', isQualityGate: false, targetQuantity: 10 },
    { id: 'op-edge', sequence: 2, name: 'Edge', isQualityGate: false, targetQuantity: 10 },
    { id: 'op-asm', sequence: 3, name: 'Assemble', isQualityGate: false, targetQuantity: 10 },
  ];

  it('allows the first operation with no history', () => {
    expect(canStartOperation(operations, [], 1)).toEqual({ allowed: true });
  });

  it('stops a part skipping the edgebander', () => {
    // Someone scans at assembly while the part is still on the saw. This is the
    // rule that catches it.
    const scans = [scan('op-saw', 'complete', 30, { quantity: 10 })];
    const result = canStartOperation(operations, scans, 3);

    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/Edge.*not complete/i);
  });

  it('allows the next operation once the previous is finished', () => {
    const scans = [scan('op-saw', 'complete', 30, { quantity: 10 })];
    expect(canStartOperation(operations, scans, 2)).toEqual({ allowed: true });
  });

  it('blocks everything behind a failed quality gate', () => {
    const gated: OperationSummary[] = [
      { id: 'op-qc', sequence: 1, name: 'QC', isQualityGate: true, targetQuantity: 10 },
      { id: 'op-pack', sequence: 2, name: 'Pack', isQualityGate: false, targetQuantity: 10 },
    ];
    const scans = [
      scan('op-qc', 'complete', 30, { quantity: 4 }),
      scan('op-qc', 'reject', 35, { quantity: 6 }),
    ];

    const result = canStartOperation(gated, scans, 2);
    expect(result.allowed).toBe(false);
  });
});

describe('operatorMinutes', () => {
  it('attributes worked minutes to the operator who started the job', () => {
    const scans = [
      scan('op-a', 'start', 0, { operatorId: 'zara' }),
      scan('op-a', 'complete', 30, { operatorId: 'zara', quantity: 1 }),
      scan('op-b', 'start', 40, { operatorId: 'amir' }),
      scan('op-b', 'complete', 100, { operatorId: 'amir', quantity: 1 }),
    ];

    const totals = operatorMinutes(scans);
    expect(totals.get('zara')).toBe(30);
    expect(totals.get('amir')).toBe(60);
  });

  it('does not count paused time', () => {
    const scans = [
      scan('op-a', 'start', 0, { operatorId: 'zara' }),
      scan('op-a', 'pause', 10, { operatorId: 'zara' }),
      scan('op-a', 'resume', 70, { operatorId: 'zara' }),
      scan('op-a', 'complete', 80, { operatorId: 'zara', quantity: 1 }),
    ];

    expect(operatorMinutes(scans).get('zara')).toBe(20);
  });

  it('returns nothing when no scans carry an operator', () => {
    const scans = [scan('op-a', 'start', 0, { operatorId: null })];
    expect(operatorMinutes(scans).size).toBe(0);
  });
});

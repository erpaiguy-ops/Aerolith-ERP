/**
 * WIP position from scans.
 *
 * Everything a factory manager wants to know — where the job is, how long it
 * actually took, who did it, what got rejected — is derived from barcode scans
 * rather than from anybody filling in a form. Forms get filled in at the end of
 * the week from memory; scans happen because the operator needs the machine to
 * accept the part.
 *
 * These are pure reducers over a scan list, so the same code answers the live
 * shop-floor board and a report on a job that closed last year.
 */

export type ScanType = 'start' | 'complete' | 'pause' | 'resume' | 'reject' | 'rework';

export interface Scan {
  id: string;
  operationId: string;
  partId?: string | null;
  type: ScanType;
  quantity: number;
  operatorId?: string | null;
  scannedAt: Date;
  reasonCode?: string | null;
}

export type OperationState =
  | 'pending'
  | 'ready'
  | 'in_progress'
  | 'paused'
  | 'completed'
  | 'skipped';

export interface OperationProgress {
  operationId: string;
  state: OperationState;
  completedQuantity: number;
  rejectedQuantity: number;
  reworkQuantity: number;
  /** Minutes actually worked, excluding pauses. */
  activeMinutes: number;
  /** Minutes the job sat paused at this station. */
  pausedMinutes: number;
  startedAt: Date | null;
  completedAt: Date | null;
  operators: string[];
}

/**
 * Reduces one operation's scans to its position.
 *
 * Pauses are excluded from active time deliberately: a job left on a machine
 * over lunch did not take an extra hour of machine time, and charging it to the
 * job makes every cost variance meaningless.
 */
export function operationProgress(
  operationId: string,
  scans: readonly Scan[],
  targetQuantity: number,
): OperationProgress {
  const ordered = [...scans]
    .filter((s) => s.operationId === operationId)
    .sort((a, b) => a.scannedAt.getTime() - b.scannedAt.getTime());

  const progress: OperationProgress = {
    operationId,
    state: 'pending',
    completedQuantity: 0,
    rejectedQuantity: 0,
    reworkQuantity: 0,
    activeMinutes: 0,
    pausedMinutes: 0,
    startedAt: null,
    completedAt: null,
    operators: [],
  };

  if (ordered.length === 0) return progress;

  const operators = new Set<string>();
  let runningSince: Date | null = null;
  let pausedSince: Date | null = null;

  for (const scan of ordered) {
    if (scan.operatorId) operators.add(scan.operatorId);

    switch (scan.type) {
      case 'start':
        progress.startedAt ??= scan.scannedAt;
        // A second start without a complete is a re-scan, not a restart; keep
        // the earliest running clock rather than resetting it.
        runningSince ??= scan.scannedAt;
        pausedSince = null;
        break;

      case 'pause':
        if (runningSince) {
          progress.activeMinutes += minutesBetween(runningSince, scan.scannedAt);
          runningSince = null;
        }
        pausedSince ??= scan.scannedAt;
        break;

      case 'resume':
        if (pausedSince) {
          progress.pausedMinutes += minutesBetween(pausedSince, scan.scannedAt);
          pausedSince = null;
        }
        runningSince ??= scan.scannedAt;
        break;

      case 'complete':
        progress.completedQuantity += scan.quantity;
        if (runningSince) {
          progress.activeMinutes += minutesBetween(runningSince, scan.scannedAt);
          runningSince = null;
        }
        progress.completedAt = scan.scannedAt;
        break;

      case 'reject':
        progress.rejectedQuantity += scan.quantity;
        if (runningSince) {
          progress.activeMinutes += minutesBetween(runningSince, scan.scannedAt);
          runningSince = null;
        }
        break;

      case 'rework':
        progress.reworkQuantity += scan.quantity;
        // Rework reopens the operation — the part is coming back through.
        progress.completedAt = null;
        break;
    }
  }

  progress.activeMinutes = round(progress.activeMinutes, 2);
  progress.pausedMinutes = round(progress.pausedMinutes, 2);
  progress.operators = [...operators].sort();

  // Good parts through the station. Rejects do not count toward the target.
  const good = progress.completedQuantity;

  if (pausedSince) progress.state = 'paused';
  else if (good >= targetQuantity && targetQuantity > 0) progress.state = 'completed';
  else if (runningSince || good > 0) progress.state = 'in_progress';
  else progress.state = 'ready';

  return progress;
}

export interface WorkOrderProgress {
  /** 0-100, weighted by operation, not by part count. */
  percentComplete: number;
  currentOperationSequence: number | null;
  currentOperationName: string | null;
  completedOperations: number;
  totalOperations: number;
  totalActiveMinutes: number;
  totalRejected: number;
  startedAt: Date | null;
  completedAt: Date | null;
  isBlocked: boolean;
  blockedReason: string | null;
}

export interface OperationSummary {
  id: string;
  sequence: number;
  name: string;
  isQualityGate: boolean;
  targetQuantity: number;
}

/**
 * Rolls operation progress up to the work order.
 *
 * Progress is weighted evenly across operations rather than by planned minutes.
 * That is deliberate: minute-weighting makes a job appear 80% done while it
 * still has to go through the booth and cure for a day, which is exactly the
 * misleading number a project manager then reports to a client.
 */
export function workOrderProgress(
  operations: readonly OperationSummary[],
  scans: readonly Scan[],
): WorkOrderProgress {
  if (operations.length === 0) {
    return {
      percentComplete: 0,
      currentOperationSequence: null,
      currentOperationName: null,
      completedOperations: 0,
      totalOperations: 0,
      totalActiveMinutes: 0,
      totalRejected: 0,
      startedAt: null,
      completedAt: null,
      isBlocked: false,
      blockedReason: null,
    };
  }

  const ordered = [...operations].sort((a, b) => a.sequence - b.sequence);
  const progresses = ordered.map((op) => ({
    operation: op,
    progress: operationProgress(op.id, scans, op.targetQuantity),
  }));

  const completed = progresses.filter((p) => p.progress.state === 'completed');
  const current = progresses.find((p) => p.progress.state !== 'completed');

  const starts = progresses.map((p) => p.progress.startedAt).filter((d): d is Date => d !== null);
  const allDone = completed.length === ordered.length;
  const ends = progresses.map((p) => p.progress.completedAt).filter((d): d is Date => d !== null);

  // A failed quality gate blocks everything behind it — that is the point of a
  // gate, and it must be visible on the board rather than discovered at packing.
  const failedGate = progresses.find(
    (p) => p.operation.isQualityGate && p.progress.rejectedQuantity > 0 && p.progress.state !== 'completed',
  );

  return {
    percentComplete: round((completed.length / ordered.length) * 100, 1),
    currentOperationSequence: current?.operation.sequence ?? null,
    currentOperationName: current?.operation.name ?? null,
    completedOperations: completed.length,
    totalOperations: ordered.length,
    totalActiveMinutes: round(
      progresses.reduce((sum, p) => sum + p.progress.activeMinutes, 0),
      2,
    ),
    totalRejected: progresses.reduce((sum, p) => sum + p.progress.rejectedQuantity, 0),
    startedAt: starts.length > 0 ? new Date(Math.min(...starts.map((d) => d.getTime()))) : null,
    completedAt: allDone && ends.length > 0
      ? new Date(Math.max(...ends.map((d) => d.getTime())))
      : null,
    isBlocked: failedGate !== undefined,
    blockedReason: failedGate
      ? `Failed quality gate at operation ${failedGate.operation.sequence} (${failedGate.operation.name}).`
      : null,
  };
}

/**
 * Whether an operation may be started.
 *
 * The rule that stops a part skipping the edgebander because someone scanned it
 * at assembly: every earlier operation must be complete, and no quality gate
 * behind it may have failed.
 */
export function canStartOperation(
  operations: readonly OperationSummary[],
  scans: readonly Scan[],
  sequence: number,
): { allowed: true } | { allowed: false; reason: string } {
  const earlier = operations
    .filter((op) => op.sequence < sequence)
    .sort((a, b) => a.sequence - b.sequence);

  for (const op of earlier) {
    const progress = operationProgress(op.id, scans, op.targetQuantity);

    if (progress.state !== 'completed') {
      return {
        allowed: false,
        reason: `Operation ${op.sequence} (${op.name}) is not complete.`,
      };
    }
    if (op.isQualityGate && progress.rejectedQuantity > progress.completedQuantity) {
      return {
        allowed: false,
        reason: `Quality gate at operation ${op.sequence} (${op.name}) has not passed.`,
      };
    }
  }

  return { allowed: true };
}

/** Minutes each operator spent actively working, for the productivity report. */
export function operatorMinutes(scans: readonly Scan[]): Map<string, number> {
  const byOperation = new Map<string, Scan[]>();
  for (const scan of scans) {
    const existing = byOperation.get(scan.operationId);
    if (existing) existing.push(scan);
    else byOperation.set(scan.operationId, [scan]);
  }

  const totals = new Map<string, number>();

  for (const operationScans of byOperation.values()) {
    const ordered = [...operationScans].sort(
      (a, b) => a.scannedAt.getTime() - b.scannedAt.getTime(),
    );

    let runningSince: Date | null = null;
    let operator: string | null = null;

    for (const scan of ordered) {
      if (scan.type === 'start' || scan.type === 'resume') {
        runningSince ??= scan.scannedAt;
        operator = scan.operatorId ?? operator;
      } else if (['complete', 'pause', 'reject'].includes(scan.type)) {
        if (runningSince && operator) {
          totals.set(
            operator,
            round((totals.get(operator) ?? 0) + minutesBetween(runningSince, scan.scannedAt), 2),
          );
        }
        runningSince = null;
      }
    }
  }

  return totals;
}

function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / 60_000);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

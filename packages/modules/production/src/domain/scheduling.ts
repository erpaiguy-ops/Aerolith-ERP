/**
 * Production scheduling.
 *
 * Pure functions over plain objects — no database, no framework. Scheduling is
 * the logic a factory manager argues with, so it has to be exhaustively testable
 * without standing anything up.
 *
 * The joinery-specific part is BATCH operations with CURE time. A spray booth
 * takes forty doors in the time it takes one, and then the cure clock runs
 * regardless of load. Generic MRP models finishing per unit, which either
 * wildly over-estimates the booth or ignores the cure — and cure is where
 * joinery jobs actually lose days.
 */

export interface WorkCentreCapacity {
  id: string;
  capacityUnits: number;
  workingMinutesPerDay: number;
  isBatchProcess: boolean;
  batchCapacityUnits?: number | null;
  costPerHour?: number | null;
}

export interface OperationSpec {
  sequence: number;
  workCentreId: string;
  setupMinutes: number;
  runMinutesPerUnit: number;
  /** Idle time AFTER the operation. The job waits; the station does not. */
  cureMinutes: number;
}

export interface OperationDuration {
  sequence: number;
  /** Time the work centre is occupied. This is what consumes capacity. */
  occupancyMinutes: number;
  /** Idle time after it, during which the station is free for other work. */
  cureMinutes: number;
  /** Occupancy + cure — how long before the NEXT operation can start. */
  elapsedMinutes: number;
  /** Number of batch loads, for a batch station. Always 1 for a unit station. */
  loads: number;
}

/**
 * How long one operation takes for a given quantity.
 *
 * Unit station:  setup + quantity × runRate
 * Batch station: loads × (setup + runRate), where a load is the booth's capacity
 *
 * The batch case is the important one. Forty doors through a booth that holds
 * forty is ONE load, not forty run-times. Forty-one doors is two loads, and the
 * step change is exactly what makes a factory manager reorganise a job.
 */
export function operationDuration(
  operation: OperationSpec,
  quantity: number,
  centre: WorkCentreCapacity,
): OperationDuration {
  if (quantity <= 0) {
    return {
      sequence: operation.sequence,
      occupancyMinutes: 0,
      cureMinutes: 0,
      elapsedMinutes: 0,
      loads: 0,
    };
  }

  let occupancyMinutes: number;
  let loads: number;

  if (centre.isBatchProcess) {
    const capacity = Math.max(1, centre.batchCapacityUnits ?? 1);
    loads = Math.ceil(quantity / capacity);
    // Each load pays setup and one run — the load is processed as a unit.
    occupancyMinutes = loads * (operation.setupMinutes + operation.runMinutesPerUnit);
  } else {
    loads = 1;
    occupancyMinutes = operation.setupMinutes + quantity * operation.runMinutesPerUnit;
  }

  // Parallel stations of the same kind share the load. Setup is NOT divided —
  // each station still has to be set up.
  const parallel = Math.max(1, centre.capacityUnits);
  if (parallel > 1 && !centre.isBatchProcess) {
    const runPortion = quantity * operation.runMinutesPerUnit;
    occupancyMinutes = operation.setupMinutes + runPortion / parallel;
  }

  // Cure runs once per load, and loads cure concurrently only if the racking
  // allows it — assume they do not, which is the conservative estimate.
  const cureMinutes = operation.cureMinutes * (centre.isBatchProcess ? loads : 1);

  return {
    sequence: operation.sequence,
    occupancyMinutes: round(occupancyMinutes, 2),
    cureMinutes: round(cureMinutes, 2),
    elapsedMinutes: round(occupancyMinutes + cureMinutes, 2),
    loads,
  };
}

export interface ScheduledOperation extends OperationDuration {
  startAt: Date;
  /** When the station is released — before the cure finishes. */
  occupancyEndAt: Date;
  /** When the next operation may begin. */
  readyAt: Date;
  workCentreId: string;
}

export interface ScheduleOptions {
  /** Minutes available per day, when the centre does not state its own. */
  defaultWorkingMinutesPerDay?: number;
  /**
   * Whether cure time runs overnight. It does — paint does not stop drying at
   * five o'clock — whereas machining does not. Getting this wrong makes every
   * finishing estimate a day long.
   */
  cureRunsOutsideWorkingHours?: boolean;
}

/**
 * Forward-schedules a routing from a start time.
 *
 * Deliberately infinite-capacity: it assumes the work centre is free when the
 * job arrives. Finite-capacity scheduling needs the queue at every station and
 * belongs in a planning board, not here. This answers "how long does this job
 * take if nothing is in its way", which is what a quotation needs.
 */
export function scheduleOperations(
  operations: readonly OperationSpec[],
  quantity: number,
  centres: ReadonlyMap<string, WorkCentreCapacity>,
  startAt: Date,
  options: ScheduleOptions = {},
): ScheduledOperation[] {
  const cureRunsOutside = options.cureRunsOutsideWorkingHours ?? true;
  const defaultMinutes = options.defaultWorkingMinutesPerDay ?? 480;

  const ordered = [...operations].sort((a, b) => a.sequence - b.sequence);
  const scheduled: ScheduledOperation[] = [];
  let cursor = new Date(startAt);

  for (const operation of ordered) {
    const centre = centres.get(operation.workCentreId);
    if (!centre) {
      throw new Error(
        `Operation ${operation.sequence} names work centre ${operation.workCentreId}, which ` +
          'does not exist. A routing cannot be scheduled against a missing station.',
      );
    }

    const duration = operationDuration(operation, quantity, centre);
    const workingMinutes = centre.workingMinutesPerDay || defaultMinutes;

    const occupancyEndAt = addWorkingMinutes(cursor, duration.occupancyMinutes, workingMinutes);
    const readyAt = cureRunsOutside
      ? new Date(occupancyEndAt.getTime() + duration.cureMinutes * 60_000)
      : addWorkingMinutes(occupancyEndAt, duration.cureMinutes, workingMinutes);

    scheduled.push({
      ...duration,
      workCentreId: operation.workCentreId,
      startAt: new Date(cursor),
      occupancyEndAt,
      readyAt,
    });

    cursor = readyAt;
  }

  return scheduled;
}

/**
 * Advances a timestamp by working minutes, rolling over days.
 *
 * Simplified: a working day is a contiguous block starting at the cursor's time
 * of day. Real shift patterns, breaks and the GCC summer midday break belong in
 * a calendar service that reads the kernel's country rules — this is the
 * arithmetic underneath it.
 */
export function addWorkingMinutes(from: Date, minutes: number, workingMinutesPerDay: number): Date {
  if (minutes <= 0) return new Date(from);
  const perDay = Math.max(1, workingMinutesPerDay);

  const wholeDays = Math.floor(minutes / perDay);
  const remainder = minutes - wholeDays * perDay;

  const result = new Date(from);
  result.setUTCDate(result.getUTCDate() + wholeDays);
  result.setUTCMinutes(result.getUTCMinutes() + remainder);
  return result;
}

/** Total lead time for a routing, in minutes. */
export function totalLeadMinutes(scheduled: readonly ScheduledOperation[]): number {
  if (scheduled.length === 0) return 0;
  const first = scheduled[0]!;
  const last = scheduled[scheduled.length - 1]!;
  return round((last.readyAt.getTime() - first.startAt.getTime()) / 60_000, 2);
}

/**
 * Machine and labour cost of a routing.
 *
 * Costs OCCUPANCY, not elapsed time: a job curing in the rack is not costing
 * booth time. Charging cure hours would inflate every finished job.
 */
export function routingCost(
  scheduled: readonly ScheduledOperation[],
  centres: ReadonlyMap<string, WorkCentreCapacity>,
): { totalCost: number; byWorkCentre: Map<string, number> } {
  const byWorkCentre = new Map<string, number>();
  let totalCost = 0;

  for (const operation of scheduled) {
    const centre = centres.get(operation.workCentreId);
    const rate = centre?.costPerHour;
    if (!rate) continue;

    const cost = round((operation.occupancyMinutes / 60) * rate, 4);
    byWorkCentre.set(operation.workCentreId, round((byWorkCentre.get(operation.workCentreId) ?? 0) + cost, 4));
    totalCost = round(totalCost + cost, 4);
  }

  return { totalCost, byWorkCentre };
}

/**
 * How many spray loads a set of parts needs, grouped by finish.
 *
 * Parts of different colours cannot share a load — that is what makes finishing
 * a batch problem rather than a queue. Splitting a job across two colours
 * doubles the booth time even if the part count is unchanged, which is the kind
 * of thing an estimator needs told before quoting.
 */
export function planFinishingBatches(
  parts: readonly { partId: string; quantity: number; colourCode?: string | null; sheenCode?: string | null }[],
  boothCapacity: number,
  coats = 1,
): { colourCode: string | null; sheenCode: string | null; loads: number; quantity: number }[] {
  const capacity = Math.max(1, boothCapacity);
  const grouped = new Map<
    string,
    { colourCode: string | null; sheenCode: string | null; quantity: number }
  >();

  for (const part of parts) {
    const colourCode = part.colourCode ?? null;
    const sheenCode = part.sheenCode ?? null;
    const key = `${colourCode ?? ''}|${sheenCode ?? ''}`;
    const existing = grouped.get(key);
    if (existing) existing.quantity += part.quantity;
    else grouped.set(key, { colourCode, sheenCode, quantity: part.quantity });
  }

  return [...grouped.values()]
    .map((group) => ({
      ...group,
      // Every coat is a separate pass through the booth.
      loads: Math.ceil(group.quantity / capacity) * Math.max(1, coats),
    }))
    .sort((a, b) => b.quantity - a.quantity);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

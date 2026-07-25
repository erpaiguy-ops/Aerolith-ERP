import { describe, expect, it } from 'vitest';

import {
  addWorkingMinutes,
  operationDuration,
  planFinishingBatches,
  routingCost,
  scheduleOperations,
  totalLeadMinutes,
  type OperationSpec,
  type WorkCentreCapacity,
} from './scheduling';

const centre = (over: Partial<WorkCentreCapacity> = {}): WorkCentreCapacity => ({
  id: 'wc-saw',
  capacityUnits: 1,
  workingMinutesPerDay: 480,
  isBatchProcess: false,
  ...over,
});

const op = (over: Partial<OperationSpec> = {}): OperationSpec => ({
  sequence: 1,
  workCentreId: 'wc-saw',
  setupMinutes: 15,
  runMinutesPerUnit: 2,
  cureMinutes: 0,
  ...over,
});

describe('operationDuration — unit stations', () => {
  it('is setup plus quantity times run rate', () => {
    const result = operationDuration(op(), 40, centre());
    expect(result.occupancyMinutes).toBe(15 + 40 * 2);
    expect(result.loads).toBe(1);
  });

  it('still charges setup for a single unit', () => {
    // The setup cost is why small batches are expensive, and it must show.
    expect(operationDuration(op(), 1, centre()).occupancyMinutes).toBe(17);
  });

  it('is zero for zero quantity', () => {
    const result = operationDuration(op(), 0, centre());
    expect(result.occupancyMinutes).toBe(0);
    expect(result.loads).toBe(0);
  });

  it('splits run time across parallel stations but not setup', () => {
    // Two edgebanders halve the running, but each still needs setting up.
    const result = operationDuration(op(), 40, centre({ capacityUnits: 2 }));
    expect(result.occupancyMinutes).toBe(15 + (40 * 2) / 2);
  });
});

describe('operationDuration — batch stations', () => {
  const booth = centre({
    id: 'wc-booth',
    isBatchProcess: true,
    batchCapacityUnits: 40,
  });

  const spray = op({ workCentreId: 'wc-booth', setupMinutes: 20, runMinutesPerUnit: 30, cureMinutes: 240 });

  it('treats a full load as one pass, not one pass per part', () => {
    // 40 doors through a booth that holds 40 is ONE load. Generic MRP would
    // charge 40 x 30 minutes here and quote a week.
    const result = operationDuration(spray, 40, booth);
    expect(result.loads).toBe(1);
    expect(result.occupancyMinutes).toBe(50);
  });

  it('steps to two loads at one part over capacity', () => {
    // The step change is exactly what makes a foreman resequence a job.
    const result = operationDuration(spray, 41, booth);
    expect(result.loads).toBe(2);
    expect(result.occupancyMinutes).toBe(100);
  });

  it('charges cure once per load', () => {
    expect(operationDuration(spray, 40, booth).cureMinutes).toBe(240);
    expect(operationDuration(spray, 41, booth).cureMinutes).toBe(480);
  });

  it('separates occupancy from elapsed — the booth is free while curing', () => {
    const result = operationDuration(spray, 40, booth);
    expect(result.occupancyMinutes).toBe(50);
    expect(result.elapsedMinutes).toBe(290);
  });

  it('defaults to a capacity of one rather than dividing by zero', () => {
    const badlyConfigured = centre({ isBatchProcess: true, batchCapacityUnits: null });
    expect(operationDuration(spray, 5, badlyConfigured).loads).toBe(5);
  });
});

describe('addWorkingMinutes', () => {
  const start = new Date('2026-03-02T08:00:00Z');

  it('adds minutes within a day', () => {
    expect(addWorkingMinutes(start, 120, 480).toISOString()).toBe('2026-03-02T10:00:00.000Z');
  });

  it('rolls into the next day past the shift length', () => {
    // 600 minutes at 480/day is one full day plus two hours.
    const result = addWorkingMinutes(start, 600, 480);
    expect(result.getUTCDate()).toBe(3);
    expect(result.getUTCHours()).toBe(10);
  });

  it('returns the same instant for zero or negative minutes', () => {
    expect(addWorkingMinutes(start, 0, 480).getTime()).toBe(start.getTime());
    expect(addWorkingMinutes(start, -50, 480).getTime()).toBe(start.getTime());
  });
});

describe('scheduleOperations', () => {
  const centres = new Map<string, WorkCentreCapacity>([
    ['wc-saw', centre({ id: 'wc-saw' })],
    ['wc-edge', centre({ id: 'wc-edge' })],
    ['wc-booth', centre({ id: 'wc-booth', isBatchProcess: true, batchCapacityUnits: 40 })],
  ]);

  const routing: OperationSpec[] = [
    { sequence: 1, workCentreId: 'wc-saw', setupMinutes: 15, runMinutesPerUnit: 2, cureMinutes: 0 },
    { sequence: 2, workCentreId: 'wc-edge', setupMinutes: 10, runMinutesPerUnit: 1, cureMinutes: 0 },
    { sequence: 3, workCentreId: 'wc-booth', setupMinutes: 20, runMinutesPerUnit: 30, cureMinutes: 240 },
  ];

  const start = new Date('2026-03-02T08:00:00Z');

  it('runs operations in sequence, each starting when the last is ready', () => {
    const scheduled = scheduleOperations(routing, 40, centres, start);

    expect(scheduled).toHaveLength(3);
    for (let i = 1; i < scheduled.length; i += 1) {
      expect(scheduled[i]!.startAt.getTime()).toBe(scheduled[i - 1]!.readyAt.getTime());
    }
  });

  it('sorts by sequence regardless of input order', () => {
    const scheduled = scheduleOperations([...routing].reverse(), 10, centres, start);
    expect(scheduled.map((s) => s.sequence)).toEqual([1, 2, 3]);
  });

  it('lets cure run overnight, because paint does not stop drying at five', () => {
    const scheduled = scheduleOperations(routing, 40, centres, start, {
      cureRunsOutsideWorkingHours: true,
    });
    const booth = scheduled[2]!;

    // 240 minutes of cure is exactly four wall-clock hours after the booth
    // releases, not half a working day.
    expect(booth.readyAt.getTime() - booth.occupancyEndAt.getTime()).toBe(240 * 60_000);
  });

  it('stretches cure across shifts when told it does not run overnight', () => {
    const scheduled = scheduleOperations(routing, 40, centres, start, {
      cureRunsOutsideWorkingHours: false,
    });
    const booth = scheduled[2]!;

    expect(booth.readyAt.getTime()).toBeGreaterThan(booth.occupancyEndAt.getTime());
  });

  it('names the missing work centre rather than failing obscurely', () => {
    expect(() =>
      scheduleOperations(
        [{ sequence: 1, workCentreId: 'wc-ghost', setupMinutes: 0, runMinutesPerUnit: 1, cureMinutes: 0 }],
        1,
        centres,
        start,
      ),
    ).toThrow(/wc-ghost/);
  });

  it('handles an empty routing', () => {
    expect(scheduleOperations([], 10, centres, start)).toEqual([]);
    expect(totalLeadMinutes([])).toBe(0);
  });

  it('reports lead time from first start to last ready', () => {
    const scheduled = scheduleOperations(routing, 40, centres, start);
    const lead = totalLeadMinutes(scheduled);

    // Saw 95 + edge 50 + booth 50 + cure 240 = 435.
    expect(lead).toBe(435);
  });
});

describe('routingCost', () => {
  const centres = new Map<string, WorkCentreCapacity>([
    ['wc-saw', centre({ id: 'wc-saw', costPerHour: 120 })],
    ['wc-booth', centre({ id: 'wc-booth', isBatchProcess: true, batchCapacityUnits: 40, costPerHour: 90 })],
  ]);

  const routing: OperationSpec[] = [
    { sequence: 1, workCentreId: 'wc-saw', setupMinutes: 15, runMinutesPerUnit: 2, cureMinutes: 0 },
    { sequence: 2, workCentreId: 'wc-booth', setupMinutes: 20, runMinutesPerUnit: 30, cureMinutes: 240 },
  ];

  it('costs occupancy, not elapsed time', () => {
    // A job curing in the rack is not costing booth time. Charging the cure
    // would inflate every finished job.
    const scheduled = scheduleOperations(routing, 40, centres, new Date('2026-03-02T08:00:00Z'));
    const { totalCost, byWorkCentre } = routingCost(scheduled, centres);

    // Saw: 95 min at 120/hr = 190. Booth: 50 min at 90/hr = 75.
    expect(byWorkCentre.get('wc-saw')).toBeCloseTo(190, 2);
    expect(byWorkCentre.get('wc-booth')).toBeCloseTo(75, 2);
    expect(totalCost).toBeCloseTo(265, 2);
  });

  it('skips work centres with no rate rather than costing them at zero silently', () => {
    const noRate = new Map<string, WorkCentreCapacity>([['wc-saw', centre({ id: 'wc-saw' })]]);
    const scheduled = scheduleOperations([routing[0]!], 10, noRate, new Date());

    expect(routingCost(scheduled, noRate).totalCost).toBe(0);
    expect(routingCost(scheduled, noRate).byWorkCentre.size).toBe(0);
  });
});

describe('planFinishingBatches', () => {
  it('groups parts by finish, because a load cannot mix colours', () => {
    const batches = planFinishingBatches(
      [
        { partId: 'a', quantity: 20, colourCode: 'RAL9010' },
        { partId: 'b', quantity: 10, colourCode: 'RAL9010' },
        { partId: 'c', quantity: 5, colourCode: 'RAL7016' },
      ],
      40,
    );

    expect(batches).toHaveLength(2);
    expect(batches[0]).toMatchObject({ colourCode: 'RAL9010', quantity: 30, loads: 1 });
    expect(batches[1]).toMatchObject({ colourCode: 'RAL7016', quantity: 5, loads: 1 });
  });

  it('shows that splitting a job across two colours costs two loads', () => {
    // 40 doors in one colour is one load; 20 + 20 in two colours is two, for
    // the same part count. Estimators need told this before quoting.
    const single = planFinishingBatches([{ partId: 'a', quantity: 40, colourCode: 'X' }], 40);
    const split = planFinishingBatches(
      [
        { partId: 'a', quantity: 20, colourCode: 'X' },
        { partId: 'b', quantity: 20, colourCode: 'Y' },
      ],
      40,
    );

    expect(single.reduce((s, b) => s + b.loads, 0)).toBe(1);
    expect(split.reduce((s, b) => s + b.loads, 0)).toBe(2);
  });

  it('multiplies loads by the number of coats', () => {
    const batches = planFinishingBatches([{ partId: 'a', quantity: 40, colourCode: 'X' }], 40, 3);
    expect(batches[0]!.loads).toBe(3);
  });

  it('separates sheens as well as colours', () => {
    const batches = planFinishingBatches(
      [
        { partId: 'a', quantity: 10, colourCode: 'X', sheenCode: 'matt' },
        { partId: 'b', quantity: 10, colourCode: 'X', sheenCode: 'satin' },
      ],
      40,
    );

    expect(batches).toHaveLength(2);
  });

  it('treats unspecified finish as its own group rather than crashing', () => {
    const batches = planFinishingBatches([{ partId: 'a', quantity: 5 }], 40);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.colourCode).toBeNull();
  });

  it('handles an empty part list', () => {
    expect(planFinishingBatches([], 40)).toEqual([]);
  });
});

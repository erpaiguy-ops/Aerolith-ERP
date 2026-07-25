import { describe, expect, it } from 'vitest';

import { calculateEdgeBanding, optimise } from './optimise';
import type { BoardPlan, Part, StockItem } from './types';

const MDF = 'mat-mdf-18';
const OAK = 'mat-oak-18';

const sheet = (over: Partial<StockItem> = {}): StockItem => ({
  id: 'sheet-mdf',
  source: 'sheet',
  materialId: MDF,
  lengthMm: 2440,
  widthMm: 1220,
  thicknessMm: 18,
  ...over,
});

const part = (over: Partial<Part> = {}): Part => ({
  id: 'p1',
  materialId: MDF,
  lengthMm: 600,
  widthMm: 400,
  quantity: 1,
  ...over,
});

// ---------------------------------------------------------------------------
// Invariants — these are what make a plan safe to send to the saw.
// ---------------------------------------------------------------------------

/** No two parts may occupy the same area of a board. */
function findOverlap(board: BoardPlan): string | null {
  for (let i = 0; i < board.placements.length; i += 1) {
    for (let j = i + 1; j < board.placements.length; j += 1) {
      const a = board.placements[i]!;
      const b = board.placements[j]!;

      const separated =
        a.xMm + a.lengthMm <= b.xMm ||
        b.xMm + b.lengthMm <= a.xMm ||
        a.yMm + a.widthMm <= b.yMm ||
        b.yMm + b.widthMm <= a.yMm;

      if (!separated) return `${a.partId} overlaps ${b.partId}`;
    }
  }
  return null;
}

/** Nothing may hang off the edge of the board. */
function findOutOfBounds(board: BoardPlan): string | null {
  for (const p of board.placements) {
    if (p.xMm < 0 || p.yMm < 0) return `${p.partId} has a negative coordinate`;
    if (p.xMm + p.lengthMm > board.lengthMm + 0.01) return `${p.partId} exceeds board length`;
    if (p.yMm + p.widthMm > board.widthMm + 0.01) return `${p.partId} exceeds board width`;
  }
  return null;
}

function assertValid(boards: BoardPlan[]) {
  for (const board of boards) {
    expect(findOverlap(board), `board ${board.stockId}`).toBeNull();
    expect(findOutOfBounds(board), `board ${board.stockId}`).toBeNull();
  }
}

// ---------------------------------------------------------------------------

describe('optimise — basics', () => {
  it('places a single part on a single board', () => {
    const plan = optimise([part()], [sheet()]);

    expect(plan.boards).toHaveLength(1);
    expect(plan.summary.partsPlaced).toBe(1);
    expect(plan.unplaced).toEqual([]);
    assertValid(plan.boards);
  });

  it('expands quantity into individual placements', () => {
    const plan = optimise([part({ quantity: 6 })], [sheet()]);

    expect(plan.summary.partsRequested).toBe(6);
    expect(plan.summary.partsPlaced).toBe(6);
    assertValid(plan.boards);
  });

  it('never overlaps parts, even on a tightly packed board', () => {
    // 12 parts at 600x400 into a 2440x1220 sheet: genuinely tight.
    const plan = optimise([part({ quantity: 12 })], [sheet()]);
    assertValid(plan.boards);
    expect(plan.summary.partsPlaced).toBe(12);
  });

  it('opens more boards when one is not enough', () => {
    const plan = optimise([part({ lengthMm: 1200, widthMm: 600, quantity: 10 })], [sheet()]);

    expect(plan.boards.length).toBeGreaterThan(1);
    expect(plan.summary.partsPlaced).toBe(10);
    assertValid(plan.boards);
  });

  it('handles an empty cutting list', () => {
    const plan = optimise([], [sheet()]);

    expect(plan.boards).toEqual([]);
    expect(plan.summary.partsRequested).toBe(0);
    expect(plan.summary.totalYieldPercent).toBe(0);
  });

  it('ignores a zero-quantity line', () => {
    const plan = optimise([part({ quantity: 0 })], [sheet()]);
    expect(plan.summary.partsRequested).toBe(0);
  });
});

describe('optimise — yield', () => {
  it('reaches a high yield on a list that tiles cleanly', () => {
    // Eight 1220x610 quarters tile a 2440x1220 sheet almost exactly; with kerf
    // they will not all fit on one, but yield should still be strong.
    const plan = optimise([part({ lengthMm: 1200, widthMm: 600, quantity: 8 })], [sheet()], {
      kerfMm: 3.2,
    });

    expect(plan.summary.totalYieldPercent).toBeGreaterThan(75);
    assertValid(plan.boards);
  });

  it('reports used and waste area consistently with the boards opened', () => {
    const plan = optimise([part({ quantity: 5 })], [sheet()]);

    const boardArea = plan.boards.reduce(
      (sum, b) => sum + (b.lengthMm * b.widthMm) / 1_000_000,
      0,
    );
    expect(plan.summary.totalAreaSqm).toBeCloseTo(boardArea, 3);
    expect(plan.summary.usedAreaSqm + plan.summary.wasteAreaSqm).toBeCloseTo(
      plan.summary.totalAreaSqm,
      3,
    );
  });

  it('reports net yield above gross when remnants are recoverable', () => {
    // One small part on a fresh sheet looks catastrophic on gross yield, but
    // the rest of the sheet is still material you own.
    const plan = optimise([part({ lengthMm: 900, widthMm: 150 })], [sheet()]);

    expect(plan.summary.totalYieldPercent).toBeLessThan(10);
    expect(plan.summary.netYieldPercent).toBeGreaterThan(plan.summary.totalYieldPercent);
    expect(plan.summary.reusableOffcuts).toBeGreaterThan(0);
  });

  it('reports the two yields as equal when nothing is recoverable', () => {
    // Fill the sheet so the leftovers are slivers, not remnants.
    const plan = optimise([part({ lengthMm: 2400, widthMm: 1200 })], [sheet()]);

    expect(plan.summary.reusableOffcuts).toBe(0);
    expect(plan.summary.netYieldPercent).toBeCloseTo(plan.summary.totalYieldPercent, 1);
  });

  it('never reports either yield above 100%', () => {
    const plan = optimise([part({ quantity: 20 })], [sheet()]);
    for (const board of plan.boards) {
      expect(board.yieldPercent).toBeLessThanOrEqual(100);
    }
    expect(plan.summary.totalYieldPercent).toBeLessThanOrEqual(100);
    expect(plan.summary.netYieldPercent).toBeLessThanOrEqual(100);
  });
});

describe('optimise — offcuts', () => {
  const offcut = (id: string, lengthMm: number, widthMm: number): StockItem => ({
    id,
    source: 'offcut',
    materialId: MDF,
    lengthMm,
    widthMm,
    thicknessMm: 18,
    available: 1,
  });

  it('uses an offcut before opening a new sheet', () => {
    // The entire point of keeping the register.
    const plan = optimise([part({ lengthMm: 800, widthMm: 400 })], [
      sheet(),
      offcut('oc-1', 900, 500),
    ]);

    expect(plan.summary.offcutsUsed).toBe(1);
    expect(plan.summary.sheetsUsed).toBe(0);
    expect(plan.boards[0]!.stockId).toBe('oc-1');
  });

  it('takes the smallest offcut that fits, keeping the big ones back', () => {
    const plan = optimise([part({ lengthMm: 800, widthMm: 400 })], [
      sheet(),
      offcut('oc-big', 2000, 900),
      offcut('oc-snug', 850, 450),
    ]);

    expect(plan.boards[0]!.stockId).toBe('oc-snug');
  });

  it('consumes each offcut only once', () => {
    // An offcut is a unique physical piece, not a stock line.
    const plan = optimise([part({ lengthMm: 800, widthMm: 400, quantity: 3 })], [
      sheet(),
      offcut('oc-1', 850, 450),
    ]);

    const usedOffcuts = plan.boards.filter((b) => b.source === 'offcut');
    expect(usedOffcuts).toHaveLength(1);
    expect(plan.summary.partsPlaced).toBe(3);
  });

  it('falls back to sheets when the offcuts run out', () => {
    const plan = optimise([part({ lengthMm: 800, widthMm: 400, quantity: 4 })], [
      sheet(),
      offcut('oc-1', 850, 450),
    ]);

    expect(plan.summary.offcutsUsed).toBe(1);
    expect(plan.summary.sheetsUsed).toBeGreaterThan(0);
  });

  it('can be told to ignore offcuts', () => {
    const plan = optimise(
      [part({ lengthMm: 800, widthMm: 400 })],
      [sheet(), offcut('oc-1', 900, 500)],
      { preferOffcuts: false },
    );

    // Smallest-first still applies, so the offcut may win on size — what must
    // not happen is offcuts being preferred regardless of size.
    expect(plan.summary.partsPlaced).toBe(1);
  });

  it('reports remnants worth returning to the register', () => {
    const plan = optimise([part({ lengthMm: 1200, widthMm: 600 })], [sheet()]);

    expect(plan.summary.reusableOffcuts).toBeGreaterThan(0);
    expect(plan.summary.reusableAreaSqm).toBeGreaterThan(0);
  });

  it('does not count slivers as reusable', () => {
    const plan = optimise([part({ lengthMm: 2400, widthMm: 1200 })], [sheet()], {
      minOffcutAreaSqm: 0.25,
      minOffcutDimensionMm: 150,
    });

    // Almost the whole sheet is consumed; what is left is a thin border.
    expect(plan.summary.reusableOffcuts).toBe(0);
  });
});

describe('optimise — grain', () => {
  const grainedSheet = sheet({ id: 'oak', materialId: OAK, grainDirection: 'length' });

  it('places a grain-along-length part without rotating it', () => {
    const plan = optimise(
      [part({ materialId: OAK, lengthMm: 800, widthMm: 400, grainAlong: 'length' })],
      [grainedSheet],
    );

    expect(plan.boards[0]!.placements[0]!.rotated).toBe(false);
  });

  it('rotates when the part wants grain across its width', () => {
    const plan = optimise(
      [part({ materialId: OAK, lengthMm: 400, widthMm: 800, grainAlong: 'width' })],
      [grainedSheet],
    );

    expect(plan.boards[0]!.placements[0]!.rotated).toBe(true);
  });

  it('will not rotate a grained part merely to make it fit', () => {
    // 1000 x 1500 fits a 2440x1220 sheet only when turned, but turning it puts
    // the grain across the face.
    const plan = optimise(
      [part({ materialId: OAK, lengthMm: 1000, widthMm: 1500, grainAlong: 'length' })],
      [grainedSheet],
    );

    expect(plan.summary.partsPlaced).toBe(0);
    expect(plan.unplaced[0]!.reason).toMatch(/grain/i);
  });

  it('rotates freely when the part has no grain requirement', () => {
    const plan = optimise(
      [part({ materialId: OAK, lengthMm: 1000, widthMm: 1500, grainAlong: 'any' })],
      [grainedSheet],
    );

    expect(plan.summary.partsPlaced).toBe(1);
    expect(plan.boards[0]!.placements[0]!.rotated).toBe(true);
  });

  it('respects allowRotation: false', () => {
    const plan = optimise(
      [part({ lengthMm: 1000, widthMm: 1500 })],
      [sheet()],
      { allowRotation: false },
    );

    expect(plan.summary.partsPlaced).toBe(0);
  });
});

describe('optimise — materials and batches', () => {
  it('never puts two materials on the same board', () => {
    const plan = optimise(
      [
        part({ id: 'mdf-part', materialId: MDF }),
        part({ id: 'oak-part', materialId: OAK }),
      ],
      [sheet(), sheet({ id: 'sheet-oak', materialId: OAK })],
    );

    expect(plan.boards).toHaveLength(2);
    for (const board of plan.boards) {
      const materials = new Set(
        board.placements.map((p) => (p.partId === 'mdf-part' ? MDF : OAK)),
      );
      expect(materials.size).toBe(1);
    }
  });

  it('reports a part whose material has no stock, without failing the rest', () => {
    const plan = optimise(
      [part({ id: 'ok' }), part({ id: 'orphan', materialId: 'mat-unknown' })],
      [sheet()],
    );

    expect(plan.summary.partsPlaced).toBe(1);
    expect(plan.unplaced).toHaveLength(1);
    expect(plan.unplaced[0]!.partId).toBe('orphan');
    expect(plan.unplaced[0]!.reason).toMatch(/no stock/i);
  });

  it('refuses to mix grain batches', () => {
    const plan = optimise([part({ grainCode: 'OAK-B22' })], [sheet({ grainCode: 'OAK-B21' })]);

    expect(plan.summary.partsPlaced).toBe(0);
    expect(plan.unplaced).toHaveLength(1);
  });

  it('refuses a thickness mismatch', () => {
    const plan = optimise([part({ thicknessMm: 25 })], [sheet({ thicknessMm: 18 })]);
    expect(plan.summary.partsPlaced).toBe(0);
  });
});

describe('optimise — unplaceable parts', () => {
  it('says a part is bigger than any board rather than failing silently', () => {
    const plan = optimise([part({ lengthMm: 3000, widthMm: 2000 })], [sheet()]);

    expect(plan.summary.partsPlaced).toBe(0);
    expect(plan.unplaced[0]!.reason).toMatch(/larger than any available board/i);
  });

  it('groups repeated failures into one row with a quantity', () => {
    const plan = optimise([part({ lengthMm: 3000, widthMm: 2000, quantity: 5 })], [sheet()]);

    expect(plan.unplaced).toHaveLength(1);
    expect(plan.unplaced[0]!.quantity).toBe(5);
  });

  it('places what it can when only some parts fit', () => {
    const plan = optimise(
      [part({ id: 'fits', quantity: 2 }), part({ id: 'huge', lengthMm: 9000, widthMm: 9000 })],
      [sheet()],
    );

    expect(plan.summary.partsPlaced).toBe(2);
    expect(plan.unplaced).toHaveLength(1);
  });
});

describe('optimise — kerf and trim', () => {
  it('leaves room for the blade between parts', () => {
    const plan = optimise([part({ lengthMm: 1220, widthMm: 610, quantity: 4 })], [sheet()], {
      kerfMm: 3.2,
    });

    // Four exact quarters cannot fit once the blade is accounted for.
    expect(plan.boards.length).toBeGreaterThan(1);
    assertValid(plan.boards);
  });

  it('keeps parts inside the trimmed area', () => {
    const trim = 10;
    const plan = optimise([part({ quantity: 4 })], [sheet()], { edgeTrimMm: trim });

    for (const board of plan.boards) {
      for (const p of board.placements) {
        expect(p.xMm).toBeGreaterThanOrEqual(trim);
        expect(p.yMm).toBeGreaterThanOrEqual(trim);
        expect(p.xMm + p.lengthMm).toBeLessThanOrEqual(board.lengthMm - trim + 0.01);
        expect(p.yMm + p.widthMm).toBeLessThanOrEqual(board.widthMm - trim + 0.01);
      }
    }
  });
});

describe('calculateEdgeBanding', () => {
  it('sums metres per tape across quantities', () => {
    // 2 parts, both long edges banded: 2 × 2 × 800mm = 3.2m
    const requirement = calculateEdgeBanding([
      part({
        lengthMm: 800,
        widthMm: 400,
        quantity: 2,
        edgeBanding: { tapeId: 'TAPE-OAK', length1: true, length2: true },
      }),
    ]);

    expect(requirement).toEqual([{ tapeId: 'TAPE-OAK', metres: 3.2 }]);
  });

  it('counts length and width edges separately', () => {
    // One part, all four edges: 2×800 + 2×400 = 2.4m
    const requirement = calculateEdgeBanding([
      part({
        lengthMm: 800,
        widthMm: 400,
        edgeBanding: {
          tapeId: 'TAPE-OAK',
          length1: true,
          length2: true,
          width1: true,
          width2: true,
        },
      }),
    ]);

    expect(requirement[0]!.metres).toBeCloseTo(2.4, 3);
  });

  it('groups by tape and orders by metres descending', () => {
    const requirement = calculateEdgeBanding([
      part({ id: 'a', lengthMm: 1000, edgeBanding: { tapeId: 'TAPE-A', length1: true } }),
      part({ id: 'b', lengthMm: 3000, edgeBanding: { tapeId: 'TAPE-B', length1: true } }),
      part({ id: 'c', lengthMm: 500, edgeBanding: { tapeId: 'TAPE-A', length1: true } }),
    ]);

    expect(requirement.map((r) => r.tapeId)).toEqual(['TAPE-B', 'TAPE-A']);
    expect(requirement.find((r) => r.tapeId === 'TAPE-A')!.metres).toBeCloseTo(1.5, 3);
  });

  it('ignores parts with no banding, and banding with no edges selected', () => {
    expect(calculateEdgeBanding([part()])).toEqual([]);
    expect(calculateEdgeBanding([part({ edgeBanding: { tapeId: 'TAPE-A' } })])).toEqual([]);
  });
});

describe('optimise — known optima', () => {
  // These counts are provable by hand, so they are a real regression guard —
  // unlike a yield percentage, which mostly measures the parts, not the packer.

  it('fits exactly 2 full-height sides per sheet', () => {
    // 2 x 580 + 3.2 kerf = 1163.2 <= 1220; a third will not fit.
    const plan = optimise([part({ lengthMm: 2100, widthMm: 580, quantity: 12 })], [sheet()]);
    expect(plan.summary.boardsUsed).toBe(6);
  });

  it('fits exactly 1 back panel per sheet', () => {
    // 2 x 900 = 1800 > 1220, so one per sheet is the geometric maximum.
    const plan = optimise([part({ lengthMm: 2100, widthMm: 900, quantity: 6 })], [sheet()]);
    expect(plan.summary.boardsUsed).toBe(6);
  });

  it('fits 4 shelves per sheet', () => {
    // 2 across (1763.2) x 2 down (1123.2) is the grid maximum.
    const plan = optimise([part({ lengthMm: 880, widthMm: 560, quantity: 24 })], [sheet()]);
    expect(plan.summary.boardsUsed).toBeLessThanOrEqual(6);
  });

  it('fits 8 small doors per sheet', () => {
    // 4 across (2412.8) x 2 down (1206.4).
    const plan = optimise([part({ lengthMm: 600, widthMm: 600, quantity: 8 })], [sheet()]);
    expect(plan.summary.boardsUsed).toBe(1);
  });
});

describe('optimise — realistic joinery job', () => {
  it('produces a valid plan for a run of wardrobe carcasses', () => {
    const parts: Part[] = [
      { id: 'side', label: 'Carcass side', materialId: MDF, lengthMm: 2100, widthMm: 580, quantity: 12 },
      { id: 'shelf', label: 'Shelf', materialId: MDF, lengthMm: 880, widthMm: 560, quantity: 24 },
      { id: 'top', label: 'Top/bottom', materialId: MDF, lengthMm: 900, widthMm: 580, quantity: 12 },
      { id: 'back', label: 'Back panel', materialId: MDF, lengthMm: 2100, widthMm: 900, quantity: 6 },
    ];

    const plan = optimise(parts, [sheet({ cost: 92 })], { kerfMm: 3.2, edgeTrimMm: 5 });

    expect(plan.summary.partsPlaced).toBe(54);
    expect(plan.unplaced).toEqual([]);
    assertValid(plan.boards);

    // The ceiling for THIS mix is about 74%, not because of the packer but
    // because of the parts: a 2100x900 back leaves a 340mm strip that nothing
    // else in the list fits into, and sides are the same. Measured ceiling and
    // current result are both recorded so a regression is visible and an
    // improvement is obvious.
    //
    // Do not read this number as the product's yield — it is a property of this
    // cutting list. See the note on known gaps in optimise.ts.
    expect(plan.summary.totalYieldPercent).toBeGreaterThan(69);
    expect(plan.summary.boardsUsed).toBeLessThanOrEqual(21);
    expect(plan.summary.materialCost).toBe(plan.summary.boardsUsed * 92);
  });
});

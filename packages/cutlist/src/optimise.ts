/**
 * 2D guillotine cutting-stock optimiser.
 *
 * Guillotine, not free-form nesting, because that is what a panel saw physically
 * does: every cut runs the full width of the piece it is cutting. A layout that
 * ignores that is undeliverable on the shop floor however good its yield looks.
 *
 * Approach: first-fit-decreasing with free-rectangle tracking.
 *
 *  1. Parts are sorted largest-area first. Placing big parts while boards are
 *     empty is what makes the small ones fit in the gaps afterwards.
 *  2. Each open board keeps a list of free rectangles. A part is placed in the
 *     one that leaves the least waste (best-area-fit).
 *  3. Placing splits that rectangle in two, guillotine style, choosing the split
 *     that leaves the LARGER single piece — one big usable remnant is worth more
 *     than two awkward strips.
 *  4. When nothing fits, a new board opens. Offcuts are tried before sheets, and
 *     the smallest usable offcut is taken first, so the big remnants stay on the
 *     rack for big parts.
 *
 * This is a heuristic, not an optimum — 2D bin packing is NP-hard.
 *
 * Measured behaviour, so nobody has to guess:
 *
 *  - It reaches the grid-optimal count per sheet on every part shape tested
 *    (see optimise.test.ts, "known optima").
 *  - Achieved yield depends almost entirely on the PARTS, not on the algorithm.
 *    A mix of awkward large panels has a low geometric ceiling no packer can
 *    beat: the wardrobe job in the tests tops out near 74% because a 2100x900
 *    back leaves a 340mm strip nothing else fits into. Friendlier mixes reach
 *    the low 80s.
 *  - Known gap: it does not find layouts that combine a grid with a rotated
 *    part in the leftover strip, which is worth roughly one sheet in twenty on
 *    mixes like the wardrobe job. Closing it needs a real search rather than a
 *    greedy pass; noted rather than hidden.
 */
import type {
  BoardPlan,
  CutlistOptions,
  CutlistPlan,
  EdgeBandingRequirement,
  Part,
  Placement,
  Remnant,
  StockItem,
  UnplacedPart,
} from './types';

const DEFAULTS = {
  kerfMm: 3.2,
  edgeTrimMm: 0,
  preferOffcuts: true,
  minOffcutAreaSqm: 0.25,
  minOffcutDimensionMm: 150,
  allowRotation: true,
} satisfies Required<CutlistOptions>;

interface FreeRect {
  x: number;
  y: number;
  length: number; // along the board's length axis
  width: number; // along the board's width axis
}

interface OpenBoard {
  stock: StockItem;
  /** Instance id — one stock sheet type can open many boards. */
  instance: number;
  free: FreeRect[];
  placements: Placement[];
}

/** One unit of a part. Quantities are expanded so each piece is placed on its own. */
interface Unit {
  part: Part;
  index: number;
}

/**
 * How to order parts before packing, and how to score a candidate position.
 *
 * No single combination wins on every cutting list — a list of long rails packs
 * best one way, a list of square panels another. Rather than guess, the packer
 * runs the whole portfolio and keeps the best result.
 *
 * Measured over 60 randomised cutting lists this saves about 1% of boards
 * against the single classic heuristic (area-sorted, best-area-fit). Small, but
 * every pass is sub-millisecond, so it is free — and 1% of sheet goods across a
 * year is not nothing. It is kept for that reason, not because it transforms
 * the result.
 */
type SortKey = 'area' | 'longest-side' | 'length' | 'width' | 'perimeter';
type FitScore = 'best-area' | 'best-short-side' | 'best-long-side';

interface Strategy {
  sort: SortKey;
  score: FitScore;
}

const STRATEGIES: Strategy[] = [
  { sort: 'area', score: 'best-area' },
  { sort: 'area', score: 'best-short-side' },
  { sort: 'longest-side', score: 'best-area' },
  { sort: 'longest-side', score: 'best-short-side' },
  { sort: 'length', score: 'best-short-side' },
  { sort: 'width', score: 'best-short-side' },
  { sort: 'perimeter', score: 'best-area' },
  { sort: 'area', score: 'best-long-side' },
];

export function optimise(
  parts: readonly Part[],
  stock: readonly StockItem[],
  options: CutlistOptions = {},
): CutlistPlan {
  const opts = { ...DEFAULTS, ...options };

  const units = expand(parts);
  const requested = units.length;

  // Parts of different materials can never share a board, so each material is
  // an independent problem. Solving them separately also keeps the search small.
  const byMaterial = groupBy(units, (u) => u.part.materialId);

  const boards: BoardPlan[] = [];
  const unplaced: UnplacedPart[] = [];

  for (const [materialId, materialUnits] of byMaterial) {
    const materialStock = stock.filter((s) => s.materialId === materialId);

    if (materialStock.length === 0) {
      unplaced.push(...summariseUnplaced(materialUnits, 'No stock defined for this material.'));
      continue;
    }

    const result = packMaterial(materialUnits, materialStock, opts);
    boards.push(...result.boards);
    unplaced.push(...result.unplaced);
  }

  return buildPlan(boards, unplaced, parts, requested, opts);
}

// ---------------------------------------------------------------------------

/**
 * Packs one material, trying every strategy and keeping the best plan.
 *
 * "Best" is fewest boards first, then highest yield. Fewest boards is what the
 * customer pays for; yield breaks ties between plans using the same number.
 */
function packMaterial(
  units: Unit[],
  stock: readonly StockItem[],
  opts: Required<CutlistOptions>,
): { boards: BoardPlan[]; unplaced: UnplacedPart[] } {
  let best: { boards: BoardPlan[]; unplaced: UnplacedPart[] } | null = null;

  for (const strategy of STRATEGIES) {
    const candidate = packWith(units, stock, opts, strategy);
    if (!best || isBetter(candidate, best)) best = candidate;
  }

  return best ?? { boards: [], unplaced: [] };
}

function isBetter(
  candidate: { boards: BoardPlan[]; unplaced: UnplacedPart[] },
  incumbent: { boards: BoardPlan[]; unplaced: UnplacedPart[] },
): boolean {
  const unplacedCandidate = candidate.unplaced.reduce((s, u) => s + u.quantity, 0);
  const unplacedIncumbent = incumbent.unplaced.reduce((s, u) => s + u.quantity, 0);

  // Placing everything beats any yield improvement.
  if (unplacedCandidate !== unplacedIncumbent) return unplacedCandidate < unplacedIncumbent;

  // Sheets cost money; offcuts are already paid for. Count sheets first.
  const sheets = (p: { boards: BoardPlan[] }) =>
    p.boards.filter((b) => b.source === 'sheet').length;
  if (sheets(candidate) !== sheets(incumbent)) return sheets(candidate) < sheets(incumbent);

  if (candidate.boards.length !== incumbent.boards.length) {
    return candidate.boards.length < incumbent.boards.length;
  }

  const used = (p: { boards: BoardPlan[] }) => p.boards.reduce((s, b) => s + b.usedAreaSqm, 0);
  const total = (p: { boards: BoardPlan[] }) =>
    p.boards.reduce((s, b) => s + (b.lengthMm * b.widthMm) / 1_000_000, 0);

  const yieldOf = (p: { boards: BoardPlan[] }) => (total(p) === 0 ? 0 : used(p) / total(p));
  return yieldOf(candidate) > yieldOf(incumbent);
}

function packWith(
  units: Unit[],
  stock: readonly StockItem[],
  opts: Required<CutlistOptions>,
  strategy: Strategy,
): { boards: BoardPlan[]; unplaced: UnplacedPart[] } {
  const sorted = sortUnits(units, strategy.sort);

  const open: OpenBoard[] = [];
  const remainingStock = new Map<string, number>(
    stock.map((s) => [s.id, s.available ?? (s.source === 'offcut' ? 1 : Number.POSITIVE_INFINITY)]),
  );
  const failed: { unit: Unit; reason: string }[] = [];

  for (const unit of sorted) {
    if (placeOnExisting(unit, open, opts, strategy.score)) continue;

    const board = openBoard(unit, stock, remainingStock, open.length, opts);
    if (!board) {
      failed.push({
        unit,
        reason: describeWhyNoBoard(unit, stock, opts),
      });
      continue;
    }

    open.push(board);

    if (!placeOnExisting(unit, [board], opts, strategy.score)) {
      // Should not happen — openBoard only returns a board the part fits on.
      failed.push({ unit, reason: 'Part did not fit the board opened for it.' });
      open.pop();
    }
  }

  return {
    boards: open.map((board) => finishBoard(board, opts)),
    unplaced: summariseFailures(failed),
  };
}

function sortUnits(units: Unit[], key: SortKey): Unit[] {
  const measure = (u: Unit): number => {
    const { lengthMm: l, widthMm: w } = u.part;
    switch (key) {
      case 'area':
        return l * w;
      case 'longest-side':
        return Math.max(l, w);
      case 'length':
        return l;
      case 'width':
        return w;
      case 'perimeter':
        return 2 * (l + w);
    }
  };

  return [...units].sort((a, b) => {
    const diff = measure(b) - measure(a);
    if (diff !== 0) return diff;
    // Deterministic tie-break, so a plan is reproducible run to run.
    const areaDiff = area(b.part) - area(a.part);
    if (areaDiff !== 0) return areaDiff;
    return a.part.id.localeCompare(b.part.id) || a.index - b.index;
  });
}

/**
 * Tries every open board, taking the best position under the given score.
 *
 * `best-short-side` usually beats `best-area`: it minimises the SMALLER leftover
 * dimension, which avoids carving free space into long thin slivers that nothing
 * subsequently fits into. `best-area` is better when the parts tile evenly.
 */
function placeOnExisting(
  unit: Unit,
  open: OpenBoard[],
  opts: Required<CutlistOptions>,
  score: FitScore,
): boolean {
  let best:
    | { board: OpenBoard; rectIndex: number; rotated: boolean; primary: number; secondary: number }
    | null = null;

  for (const board of open) {
    for (const [rectIndex, rect] of board.free.entries()) {
      for (const rotated of orientations(unit.part, board.stock, opts)) {
        const placedLength = rotated ? unit.part.widthMm : unit.part.lengthMm;
        const placedWidth = rotated ? unit.part.lengthMm : unit.part.widthMm;

        if (placedLength > rect.length || placedWidth > rect.width) continue;

        const leftoverLength = rect.length - placedLength;
        const leftoverWidth = rect.width - placedWidth;
        const areaWaste = rect.length * rect.width - placedLength * placedWidth;

        let primary: number;
        let secondary: number;
        switch (score) {
          case 'best-short-side':
            primary = Math.min(leftoverLength, leftoverWidth);
            secondary = Math.max(leftoverLength, leftoverWidth);
            break;
          case 'best-long-side':
            primary = Math.max(leftoverLength, leftoverWidth);
            secondary = Math.min(leftoverLength, leftoverWidth);
            break;
          case 'best-area':
          default:
            primary = areaWaste;
            secondary = Math.min(leftoverLength, leftoverWidth);
            break;
        }

        if (
          !best ||
          primary < best.primary ||
          (primary === best.primary && secondary < best.secondary)
        ) {
          best = { board, rectIndex, rotated, primary, secondary };
        }
      }
    }
  }

  if (!best) return false;

  const rect = best.board.free[best.rectIndex]!;
  const placedLength = best.rotated ? unit.part.widthMm : unit.part.lengthMm;
  const placedWidth = best.rotated ? unit.part.lengthMm : unit.part.widthMm;

  best.board.placements.push({
    partId: unit.part.id,
    label: unit.part.label,
    xMm: round(rect.x, 2),
    yMm: round(rect.y, 2),
    lengthMm: placedLength,
    widthMm: placedWidth,
    rotated: best.rotated,
  });

  best.board.free.splice(best.rectIndex, 1, ...splitRect(rect, placedLength, placedWidth, opts.kerfMm));
  return true;
}

/**
 * Splits a free rectangle after a part is placed in its corner.
 *
 * Two guillotine options; take the one whose LARGER piece is bigger. Keeping one
 * substantial rectangle beats keeping two mediocre ones, both for the parts
 * still to place and for what ends up back on the offcut rack.
 */
function splitRect(rect: FreeRect, usedLength: number, usedWidth: number, kerf: number): FreeRect[] {
  const restLength = rect.length - usedLength - kerf;
  const restWidth = rect.width - usedWidth - kerf;

  // Option A — cut across the length first: a full-width strip plus a stub.
  const a: FreeRect[] = [
    { x: rect.x + usedLength + kerf, y: rect.y, length: restLength, width: rect.width },
    { x: rect.x, y: rect.y + usedWidth + kerf, length: usedLength, width: restWidth },
  ];

  // Option B — cut along the width first: a full-length strip plus a stub.
  const b: FreeRect[] = [
    { x: rect.x + usedLength + kerf, y: rect.y, length: restLength, width: usedWidth },
    { x: rect.x, y: rect.y + usedWidth + kerf, length: rect.length, width: restWidth },
  ];

  const largest = (rects: FreeRect[]) => Math.max(...rects.map((r) => r.length * r.width));
  const chosen = largest(a) >= largest(b) ? a : b;

  return chosen.filter((r) => r.length > 0 && r.width > 0);
}

/** Opens the cheapest board the part fits on, preferring offcuts. */
function openBoard(
  unit: Unit,
  stock: readonly StockItem[],
  remaining: Map<string, number>,
  instance: number,
  opts: Required<CutlistOptions>,
): OpenBoard | null {
  const candidates = stock
    .filter((s) => (remaining.get(s.id) ?? 0) > 0)
    .filter((s) => partFitsStock(unit.part, s, opts))
    .sort((a, b) => {
      if (opts.preferOffcuts && a.source !== b.source) {
        // Offcuts first — using them is the whole point of the register.
        return a.source === 'offcut' ? -1 : 1;
      }
      // Then the smallest that fits, so big stock stays available.
      return a.lengthMm * a.widthMm - b.lengthMm * b.widthMm;
    });

  const chosen = candidates[0];
  if (!chosen) return null;

  remaining.set(chosen.id, (remaining.get(chosen.id) ?? 0) - 1);

  const trim = opts.edgeTrimMm;
  return {
    stock: chosen,
    instance,
    free: [
      {
        x: trim,
        y: trim,
        length: chosen.lengthMm - trim * 2,
        width: chosen.widthMm - trim * 2,
      },
    ],
    placements: [],
  };
}

// ---------------------------------------------------------------------------

/**
 * The orientations a part may be placed in on a given board.
 *
 * `false` means as-is; `true` means turned 90°. Grain is what restricts this: a
 * door face with the grain running across it is a defect, not a saving.
 */
function orientations(part: Part, stock: StockItem, opts: Required<CutlistOptions>): boolean[] {
  const grainAlong = part.grainAlong ?? 'any';

  if (!opts.allowRotation) return [false];
  if (grainAlong === 'any' || stock.grainDirection == null) return [false, true];

  // As-is puts the part's length along the board's length.
  const asIsAxis = grainAlong === 'length' ? 'length' : 'width';
  const rotatedAxis = grainAlong === 'length' ? 'width' : 'length';

  const allowed: boolean[] = [];
  if (asIsAxis === stock.grainDirection) allowed.push(false);
  if (rotatedAxis === stock.grainDirection) allowed.push(true);
  return allowed;
}

function partFitsStock(part: Part, stock: StockItem, opts: Required<CutlistOptions>): boolean {
  if (
    part.thicknessMm != null &&
    stock.thicknessMm != null &&
    Math.abs(part.thicknessMm - stock.thicknessMm) > 0.5
  ) {
    return false;
  }
  if (part.grainCode && stock.grainCode && part.grainCode !== stock.grainCode) return false;
  if (part.colourCode && stock.colourCode && part.colourCode !== stock.colourCode) return false;

  const usableLength = stock.lengthMm - opts.edgeTrimMm * 2;
  const usableWidth = stock.widthMm - opts.edgeTrimMm * 2;

  return orientations(part, stock, opts).some((rotated) => {
    const l = rotated ? part.widthMm : part.lengthMm;
    const w = rotated ? part.lengthMm : part.widthMm;
    return l <= usableLength && w <= usableWidth;
  });
}

/** Why no board could be opened — actionable, not just "failed". */
function describeWhyNoBoard(
  unit: Unit,
  stock: readonly StockItem[],
  opts: Required<CutlistOptions>,
): string {
  const sameMaterial = stock.filter((s) => s.materialId === unit.part.materialId);
  if (sameMaterial.length === 0) return 'No stock defined for this material.';

  const anyBigEnough = sameMaterial.some((s) => {
    const l = Math.max(unit.part.lengthMm, unit.part.widthMm);
    const w = Math.min(unit.part.lengthMm, unit.part.widthMm);
    return (
      l <= Math.max(s.lengthMm, s.widthMm) - opts.edgeTrimMm * 2 &&
      w <= Math.min(s.lengthMm, s.widthMm) - opts.edgeTrimMm * 2
    );
  });

  if (!anyBigEnough) return 'Part is larger than any available board.';
  return 'Part fits no board once grain direction and batch are respected.';
}

// ---------------------------------------------------------------------------

function finishBoard(board: OpenBoard, opts: Required<CutlistOptions>): BoardPlan {
  const usedAreaSqm = board.placements.reduce(
    (sum, p) => sum + (p.lengthMm * p.widthMm) / 1_000_000,
    0,
  );
  const boardAreaSqm = (board.stock.lengthMm * board.stock.widthMm) / 1_000_000;

  const remnants: Remnant[] = board.free
    .map((rect) => ({
      lengthMm: round(rect.length, 2),
      widthMm: round(rect.width, 2),
      areaSqm: round((rect.length * rect.width) / 1_000_000, 4),
      usable:
        rect.length >= opts.minOffcutDimensionMm &&
        rect.width >= opts.minOffcutDimensionMm &&
        (rect.length * rect.width) / 1_000_000 >= opts.minOffcutAreaSqm,
    }))
    .sort((a, b) => b.areaSqm - a.areaSqm);

  return {
    stockId: board.stock.id,
    source: board.stock.source,
    materialId: board.stock.materialId,
    lengthMm: board.stock.lengthMm,
    widthMm: board.stock.widthMm,
    placements: board.placements,
    remnants,
    yieldPercent: boardAreaSqm === 0 ? 0 : round((usedAreaSqm / boardAreaSqm) * 100, 2),
    usedAreaSqm: round(usedAreaSqm, 4),
    wasteAreaSqm: round(boardAreaSqm - usedAreaSqm, 4),
    cost: board.stock.cost,
  };
}

function buildPlan(
  boards: BoardPlan[],
  unplaced: UnplacedPart[],
  parts: readonly Part[],
  requested: number,
  opts: Required<CutlistOptions>,
): CutlistPlan {
  void opts;

  const partsPlaced = boards.reduce((sum, b) => sum + b.placements.length, 0);
  const totalAreaSqm = boards.reduce(
    (sum, b) => sum + (b.lengthMm * b.widthMm) / 1_000_000,
    0,
  );
  const usedAreaSqm = boards.reduce((sum, b) => sum + b.usedAreaSqm, 0);
  const reusable = boards.flatMap((b) => b.remnants.filter((r) => r.usable));

  const materialCost = boards.reduce((sum, b) => sum + (b.cost ?? 0), 0);
  const reusableAreaSqm = reusable.reduce((sum, r) => sum + r.areaSqm, 0);
  // Area genuinely consumed: everything opened, less what goes back on the rack.
  const consumedAreaSqm = Math.max(0, totalAreaSqm - reusableAreaSqm);

  return {
    boards,
    unplaced,
    edgeBanding: calculateEdgeBanding(parts),
    summary: {
      boardsUsed: boards.length,
      sheetsUsed: boards.filter((b) => b.source === 'sheet').length,
      offcutsUsed: boards.filter((b) => b.source === 'offcut').length,
      partsPlaced,
      partsRequested: requested,
      totalYieldPercent: totalAreaSqm === 0 ? 0 : round((usedAreaSqm / totalAreaSqm) * 100, 2),
      netYieldPercent:
        consumedAreaSqm === 0 ? 0 : round(Math.min(100, (usedAreaSqm / consumedAreaSqm) * 100), 2),
      totalAreaSqm: round(totalAreaSqm, 4),
      usedAreaSqm: round(usedAreaSqm, 4),
      wasteAreaSqm: round(totalAreaSqm - usedAreaSqm, 4),
      reusableOffcuts: reusable.length,
      reusableAreaSqm: round(reusableAreaSqm, 4),
      materialCost: materialCost > 0 ? round(materialCost, 2) : undefined,
    },
  };
}

/**
 * Edge banding required, in metres per tape.
 *
 * Ordered off the plan and consumed by the edgebander, so it is worth getting
 * right: L1/L2 run the part's length, W1/W2 its width.
 */
export function calculateEdgeBanding(parts: readonly Part[]): EdgeBandingRequirement[] {
  const totals = new Map<string, number>();

  for (const part of parts) {
    const banding = part.edgeBanding;
    if (!banding) continue;

    const lengthEdges = (banding.length1 ? 1 : 0) + (banding.length2 ? 1 : 0);
    const widthEdges = (banding.width1 ? 1 : 0) + (banding.width2 ? 1 : 0);
    const metres =
      ((lengthEdges * part.lengthMm + widthEdges * part.widthMm) * part.quantity) / 1000;

    if (metres === 0) continue;
    totals.set(banding.tapeId, (totals.get(banding.tapeId) ?? 0) + metres);
  }

  return [...totals.entries()]
    .map(([tapeId, metres]) => ({ tapeId, metres: round(metres, 3) }))
    .sort((a, b) => b.metres - a.metres);
}

// ---------------------------------------------------------------------------

function expand(parts: readonly Part[]): Unit[] {
  const units: Unit[] = [];
  for (const part of parts) {
    const quantity = Math.max(0, Math.floor(part.quantity));
    for (let index = 0; index < quantity; index += 1) {
      units.push({ part, index });
    }
  }
  return units;
}

function summariseUnplaced(units: Unit[], reason: string): UnplacedPart[] {
  return summariseFailures(units.map((unit) => ({ unit, reason })));
}

function summariseFailures(failures: { unit: Unit; reason: string }[]): UnplacedPart[] {
  const grouped = new Map<string, UnplacedPart>();

  for (const { unit, reason } of failures) {
    const key = `${unit.part.id}:${reason}`;
    const existing = grouped.get(key);
    if (existing) existing.quantity += 1;
    else {
      grouped.set(key, {
        partId: unit.part.id,
        label: unit.part.label,
        quantity: 1,
        reason,
      });
    }
  }

  return [...grouped.values()];
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const existing = grouped.get(k);
    if (existing) existing.push(item);
    else grouped.set(k, [item]);
  }
  return grouped;
}

function area(part: Part): number {
  return part.lengthMm * part.widthMm;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Offcut matching — the joinery-specific core.
 *
 * Given a required part and the offcuts on the rack, decide which remnant it
 * can be cut from. Generic ERPs cannot do this because they hold "0.4 sheets of
 * 18mm MDF", which is not a thing you can cut anything out of.
 *
 * Pure functions with no database and no framework: this is the logic the
 * cutlist optimiser will call in a tight loop, and eventually in a worker or in
 * WASM, so it stays dependency-free.
 *
 * Conventions
 * -----------
 * All dimensions are millimetres.
 *
 * `grainDirection` on a panel says which of ITS dimensions the grain runs along.
 * `grainAlong` on a part says which of the PART's dimensions the grain must run
 * along. 'any' means the part has no grain requirement — plain MDF, a hidden
 * carcass panel — and may be rotated freely.
 */

export type Axis = 'length' | 'width';
export type GrainRequirement = Axis | 'any';

export interface Panel {
  id: string;
  lengthMm: number;
  widthMm: number;
  thicknessMm?: number | null;
  /** Null for a material with no visible grain. */
  grainDirection?: Axis | null;
  grainCode?: string | null;
  colourCode?: string | null;
}

export interface RequiredPart {
  lengthMm: number;
  widthMm: number;
  thicknessMm?: number | null;
  grainAlong?: GrainRequirement;
  grainCode?: string | null;
  colourCode?: string | null;
}

export interface CutOptions {
  /** Saw blade width. Removed from the panel on every cut. */
  kerfMm?: number;
  /** Trim removed from the panel's edges before any part is taken. */
  edgeTrimMm?: number;
  /** Thickness must match within this tolerance. */
  thicknessToleranceMm?: number;
}

const DEFAULTS = { kerfMm: 3.2, edgeTrimMm: 0, thicknessToleranceMm: 0.5 };

export type Orientation = 'as_is' | 'rotated';

export interface FitResult {
  fits: boolean;
  orientation?: Orientation;
  /** Panel area minus part area, in m². Lower is a tighter, better fit. */
  wasteSqm?: number;
  reason?: string;
}

/**
 * Can `part` be cut from `panel`?
 *
 * Tries both orientations. Rotation is allowed when the grain requirement still
 * holds after turning the part 90°, which for a grained material means the
 * panel's grain must run along the panel dimension the part's grain axis now
 * lies on.
 */
export function fits(panel: Panel, part: RequiredPart, options: CutOptions = {}): FitResult {
  const { kerfMm, edgeTrimMm, thicknessToleranceMm } = { ...DEFAULTS, ...options };

  if (part.lengthMm <= 0 || part.widthMm <= 0) {
    return { fits: false, reason: 'Part dimensions must be positive.' };
  }

  if (
    part.thicknessMm != null &&
    panel.thicknessMm != null &&
    Math.abs(part.thicknessMm - panel.thicknessMm) > thicknessToleranceMm
  ) {
    return { fits: false, reason: 'Thickness does not match.' };
  }

  // Grain and colour batch must match where both are specified — mixing them is
  // a visible defect and a rejected installation.
  if (part.grainCode && panel.grainCode && part.grainCode !== panel.grainCode) {
    return { fits: false, reason: 'Grain batch does not match.' };
  }
  if (part.colourCode && panel.colourCode && part.colourCode !== panel.colourCode) {
    return { fits: false, reason: 'Colour batch does not match.' };
  }

  const usableLength = panel.lengthMm - edgeTrimMm * 2;
  const usableWidth = panel.widthMm - edgeTrimMm * 2;
  if (usableLength <= 0 || usableWidth <= 0) {
    return { fits: false, reason: 'Panel is smaller than its edge trim.' };
  }

  const grainAlong: GrainRequirement = part.grainAlong ?? 'any';
  const candidates: { orientation: Orientation; along: number; across: number; grainOk: boolean }[] =
    [
      {
        orientation: 'as_is',
        along: part.lengthMm,
        across: part.widthMm,
        grainOk: grainSatisfied(grainAlong, panel.grainDirection, 'as_is'),
      },
      {
        orientation: 'rotated',
        along: part.widthMm,
        across: part.lengthMm,
        grainOk: grainSatisfied(grainAlong, panel.grainDirection, 'rotated'),
      },
    ];

  let sawGrainFailure = false;

  for (const candidate of candidates) {
    const dimensionOk =
      candidate.along + kerfMm <= usableLength && candidate.across + kerfMm <= usableWidth;

    if (!dimensionOk) continue;
    if (!candidate.grainOk) {
      sawGrainFailure = true;
      continue;
    }

    const wasteSqm = round(
      (panel.lengthMm * panel.widthMm - part.lengthMm * part.widthMm) / 1_000_000,
      4,
    );
    return { fits: true, orientation: candidate.orientation, wasteSqm };
  }

  // `sawGrainFailure` is only ever set after the dimension check passed, so if
  // it is set the part physically fits and grain is the real blocker. That is
  // the actionable message — the operator can choose a different panel rather
  // than concluding the part is too big.
  if (sawGrainFailure) {
    return { fits: false, reason: 'Grain runs the wrong way.' };
  }
  return { fits: false, reason: 'Part does not fit the panel.' };
}

function grainSatisfied(
  required: GrainRequirement,
  panelGrain: Axis | null | undefined,
  orientation: Orientation,
): boolean {
  // No requirement, or a material with no grain: rotate freely.
  if (required === 'any' || panelGrain == null) return true;

  // As-is, the part's length lies along the panel's length.
  // Rotated, the part's length lies along the panel's width.
  const partAxisOnPanel: Axis =
    required === 'length'
      ? orientation === 'as_is'
        ? 'length'
        : 'width'
      : orientation === 'as_is'
        ? 'width'
        : 'length';

  return partAxisOnPanel === panelGrain;
}

/**
 * Picks the offcut to cut a part from.
 *
 * Deliberately the SMALLEST panel that fits, not the first or the largest.
 * Consuming a big sheet for a small part destroys the value of the register —
 * the whole point is to keep large remnants available for large parts.
 */
export function selectBestOffcut(
  panels: readonly Panel[],
  part: RequiredPart,
  options: CutOptions = {},
): { panel: Panel; fit: FitResult } | null {
  let best: { panel: Panel; fit: FitResult } | null = null;

  for (const panel of panels) {
    const fit = fits(panel, part, options);
    if (!fit.fits) continue;

    if (!best || (fit.wasteSqm ?? Infinity) < (best.fit.wasteSqm ?? Infinity)) {
      best = { panel, fit };
    }
  }

  return best;
}

export interface UsabilityRule {
  /** Below this area, a remnant is scrap. */
  minimumAreaSqm: number;
  /** Below this on either dimension it cannot be handled safely on the saw. */
  minimumDimensionMm: number;
}

export const DEFAULT_USABILITY: UsabilityRule = {
  minimumAreaSqm: 0.25,
  minimumDimensionMm: 150,
};

/**
 * Is a remnant worth registering?
 *
 * Registering everything fills the rack and the database with slivers nobody
 * will ever cut; registering nothing throws away real money. This is the line,
 * and it is tenant-configurable through the module's rules.
 */
export function isUsableOffcut(
  panel: Pick<Panel, 'lengthMm' | 'widthMm'>,
  rule: UsabilityRule = DEFAULT_USABILITY,
): boolean {
  if (panel.lengthMm < rule.minimumDimensionMm || panel.widthMm < rule.minimumDimensionMm) {
    return false;
  }
  return areaSqm(panel) >= rule.minimumAreaSqm;
}

/**
 * The remnants left after cutting a part from a panel, guillotine style.
 *
 * A guillotine cut runs the full width of the piece — which is what a panel saw
 * physically does — so removing a part leaves exactly two rectangles. Which two
 * depends on whether the first cut is along the length or across it, and the
 * choice matters: it decides whether you keep one useful large piece or two
 * awkward strips.
 *
 * The strategy here maximises the AREA OF THE LARGEST remnant, because one big
 * usable piece is worth more than two marginal ones.
 */
export function guillotineRemnants(
  panel: Panel,
  part: RequiredPart,
  options: CutOptions = {},
): Panel[] {
  const { kerfMm } = { ...DEFAULTS, ...options };
  const fit = fits(panel, part, options);
  if (!fit.fits) return [];

  const partAlong = fit.orientation === 'rotated' ? part.widthMm : part.lengthMm;
  const partAcross = fit.orientation === 'rotated' ? part.lengthMm : part.widthMm;

  const remainingLength = panel.lengthMm - partAlong - kerfMm;
  const remainingWidth = panel.widthMm - partAcross - kerfMm;

  // Option A — first cut across the length: a full-width offcut plus a stub.
  const optionA: Panel[] = [
    { ...panel, id: `${panel.id}:A1`, lengthMm: remainingLength, widthMm: panel.widthMm },
    { ...panel, id: `${panel.id}:A2`, lengthMm: partAlong, widthMm: remainingWidth },
  ];

  // Option B — first cut along the width: a full-length offcut plus a stub.
  const optionB: Panel[] = [
    { ...panel, id: `${panel.id}:B1`, lengthMm: panel.lengthMm, widthMm: remainingWidth },
    { ...panel, id: `${panel.id}:B2`, lengthMm: remainingLength, widthMm: partAcross },
  ];

  const largest = (pieces: Panel[]) => Math.max(...pieces.map((p) => areaSqm(p)));
  const chosen = largest(optionA) >= largest(optionB) ? optionA : optionB;

  return chosen.filter((piece) => piece.lengthMm > 0 && piece.widthMm > 0);
}

/**
 * Material yield: the proportion of a panel that ends up as parts.
 *
 * The number a factory manager looks at every morning. Anything under about 70%
 * on sheet goods means the nesting or the ordering is wrong.
 */
export function yieldPercent(panel: Panel, parts: readonly RequiredPart[]): number {
  const panelArea = areaSqm(panel);
  if (panelArea === 0) return 0;

  const partArea = parts.reduce(
    (sum, part) => sum + (part.lengthMm * part.widthMm) / 1_000_000,
    0,
  );

  return round((partArea / panelArea) * 100, 2);
}

export function areaSqm(panel: Pick<Panel, 'lengthMm' | 'widthMm'>): number {
  return round((panel.lengthMm * panel.widthMm) / 1_000_000, 4);
}

/**
 * Cost of an offcut, apportioned from its parent sheet by area.
 *
 * A 1200x600 remnant of a 2440x1220 sheet carries the same cost per m² as the
 * sheet did. Valuing remnants at zero overstates the margin on the job that
 * created them and understates the one that consumes them.
 */
export function offcutCost(
  parentSheet: Pick<Panel, 'lengthMm' | 'widthMm'>,
  parentUnitCost: number,
  remnant: Pick<Panel, 'lengthMm' | 'widthMm'>,
): number {
  const parentArea = areaSqm(parentSheet);
  if (parentArea === 0) return 0;
  return round((areaSqm(remnant) / parentArea) * parentUnitCost, 6);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

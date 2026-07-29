/**
 * Cutlist optimisation — types.
 *
 * Zero dependencies, not even Node. This package runs in the API, in a worker,
 * in the browser, and is the natural candidate to compile to WASM when a big
 * nest gets slow. Keep it that way.
 *
 * All dimensions are millimetres. All areas are square metres.
 */

export type Axis = 'length' | 'width';
export type GrainRequirement = Axis | 'any';

/** A part the job needs, from a BOM or a cutting list. */
export interface Part {
  id: string;
  /** Free text for the layout drawing and the label. */
  label?: string;
  /** kernel.item — the material. Parts of different materials never share a board. */
  materialId: string;
  lengthMm: number;
  widthMm: number;
  thicknessMm?: number | null;
  quantity: number;
  /** Which of the part's own dimensions the grain must run along. */
  grainAlong?: GrainRequirement;
  grainCode?: string | null;
  colourCode?: string | null;
  /**
   * Which edges get banding, and with what. Drives the edge-banding schedule
   * and, more importantly, the OVERSIZE: a part that gets 2mm tape must be cut
   * 2mm undersize or it comes out wrong.
   */
  edgeBanding?: EdgeBanding;
}

export interface EdgeBanding {
  /** Tape identifier, e.g. an item code. Metres are reported per tape. */
  tapeId: string;
  thicknessMm?: number;
  /** Which edges: L1/L2 are the long edges, W1/W2 the short ones. */
  length1?: boolean;
  length2?: boolean;
  width1?: boolean;
  width2?: boolean;
}

/** Something a part can be cut from — a full sheet or a remnant. */
export interface StockItem {
  id: string;
  source: 'sheet' | 'offcut';
  materialId: string;
  lengthMm: number;
  widthMm: number;
  thicknessMm?: number | null;
  grainDirection?: Axis | null;
  grainCode?: string | null;
  colourCode?: string | null;
  /** Cost of the whole piece. Used to cost the plan and each part. */
  cost?: number;
  /** How many are available. Offcuts are unique; sheets are usually unlimited. */
  available?: number;
}

export interface CutlistOptions {
  /** Saw blade width, removed on every cut. */
  kerfMm?: number;
  /**
   * Trim taken off a FULL SHEET's edges before anything is cut from it.
   *
   * Not applied to offcuts. A remnant's edges are saw cuts and the factory edge
   * it came from was trimmed when the sheet was first opened; taking another
   * pass off all four sides removes material for no reason. It is also the
   * difference between a remnant being usable and not — a 1180x620 piece
   * trimmed again is 1160x600, which will not take the 1180x580 shelf it was
   * kept for.
   */
  edgeTrimMm?: number;
  /**
   * Use offcuts before opening new sheets. On by default — it is the entire
   * point of keeping the register.
   */
  preferOffcuts?: boolean;
  /** Remnants worth returning to the offcut register. */
  minOffcutAreaSqm?: number;
  minOffcutDimensionMm?: number;
  /** Allow a part with no grain requirement to be turned 90°. */
  allowRotation?: boolean;
}

export interface Placement {
  partId: string;
  label?: string;
  /** Position of the part's lower-left corner on the board. */
  xMm: number;
  yMm: number;
  /** Dimensions AS PLACED — swapped when the part was rotated. */
  lengthMm: number;
  widthMm: number;
  rotated: boolean;
}

export interface Remnant {
  lengthMm: number;
  widthMm: number;
  areaSqm: number;
  /** False for a piece too small or too narrow to be worth keeping. */
  usable: boolean;
}

export interface BoardPlan {
  /** Which stock item this board is. */
  stockId: string;
  source: 'sheet' | 'offcut';
  materialId: string;
  lengthMm: number;
  widthMm: number;
  placements: Placement[];
  remnants: Remnant[];
  /** Proportion of the board that becomes parts. */
  yieldPercent: number;
  usedAreaSqm: number;
  wasteAreaSqm: number;
  cost?: number;
}

export interface EdgeBandingRequirement {
  tapeId: string;
  metres: number;
}

export interface UnplacedPart {
  partId: string;
  label?: string;
  quantity: number;
  reason: string;
}

export interface CutlistPlan {
  boards: BoardPlan[];
  unplaced: UnplacedPart[];
  edgeBanding: EdgeBandingRequirement[];
  summary: {
    boardsUsed: number;
    sheetsUsed: number;
    offcutsUsed: number;
    partsPlaced: number;
    partsRequested: number;
    /**
     * Parts area as a proportion of ALL board area opened. The pessimistic
     * number: it treats a large reusable remnant as waste.
     */
    totalYieldPercent: number;
    /**
     * Parts area as a proportion of board area actually CONSUMED — that is,
     * excluding remnants big enough to go back on the rack.
     *
     * This is the economically honest figure. Opening a fresh sheet to cut one
     * plinth looks catastrophic on `totalYieldPercent` and barely registers
     * here, because the rest of the sheet is still material you own. Report
     * both: the first tells you how well the nest packed, the second how much
     * material the job actually cost.
     */
    netYieldPercent: number;
    totalAreaSqm: number;
    usedAreaSqm: number;
    wasteAreaSqm: number;
    /** Remnants worth returning to the register, and their area. */
    reusableOffcuts: number;
    reusableAreaSqm: number;
    materialCost?: number;
  };
}

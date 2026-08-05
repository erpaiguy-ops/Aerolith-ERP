/**
 * @aerolith/cutlist — panel cutting optimisation.
 *
 * Zero dependencies by design: runs in the API, in a worker, in the browser, and
 * is the natural candidate to compile to WASM when a large nest gets slow.
 */
export { calculateEdgeBanding, optimise } from './optimise';
export { renderBoardSvg, renderPlanSvgs, toCuttingList, type LayoutOptions } from './layout';
export type {
  Axis,
  BoardPlan,
  CutlistOptions,
  CutlistPlan,
  EdgeBanding,
  EdgeBandingRequirement,
  GrainRequirement,
  Part,
  Placement,
  Remnant,
  StockItem,
  UnplacedPart,
} from './types';

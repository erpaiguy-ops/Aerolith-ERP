export { inventoryModule } from './manifest';

export * as inventorySchema from './db/schema';
export { INVENTORY_TENANT_TABLES, inventory } from './db/schema';

export {
  NegativeStockError,
  apportionLandedCost,
  applyAdjustment,
  applyIssue,
  applyReceipt,
  positionValue,
  toNumber,
  toNumeric,
  type CostingMethod,
  type StockPosition,
} from './domain/costing';

export {
  DEFAULT_USABILITY,
  areaSqm,
  fits,
  guillotineRemnants,
  isUsableOffcut,
  offcutCost,
  selectBestOffcut,
  yieldPercent,
  type Axis,
  type CutOptions,
  type FitResult,
  type GrainRequirement,
  type Orientation,
  type Panel,
  type RequiredPart,
  type UsabilityRule,
} from './domain/offcuts';

export {
  InvalidMovementError,
  MODULE_KEY,
  postMovement,
  stockOnHand,
  type CreateMovementInput,
  type MovementLineInput,
  type PostMovementResult,
} from './service/movements';

export {
  COUNT_SORTS,
  MOVEMENT_SORTS,
  ITEM_SORTS,
  OFFCUT_SORTS,
  STOCK_SORTS,
  listItems,
  listMovements,
  listOffcuts,
  listStockCounts,
  listStockOnHand,
  summariseOffcuts,
  type ItemListRow,
  type MovementListRow,
  type OffcutListRow,
  type OffcutSummary,
  type StockCountListRow,
  type StockListRow,
} from './service/registers';

export { INVENTORY_RLS, buildInventoryRls, buildInventoryGrants } from './db/security';

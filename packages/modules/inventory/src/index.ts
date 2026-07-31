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
  approveMovement,
  postMovement,
  rejectMovement,
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
  getItemDetail,
  getStockCountDetail,
  listItems,
  listMovements,
  listOffcuts,
  listStockCounts,
  listStockOnHand,
  summariseOffcuts,
  type ItemDetail,
  type ItemListRow,
  type MovementListRow,
  type OffcutListRow,
  type OffcutSummary,
  type StockCountDetail,
  type StockCountLineRow,
  type StockCountListRow,
  type StockListRow,
} from './service/registers';

export {
  ItemError,
  createItem,
  setItemCustomFields,
  updateItem,
  type CreateItemInput,
  type UpdateItemInput,
} from './service/items';

export {
  StockCountError,
  createStockCount,
  generateCountSheet,
  recordCountLine,
  reconcileStockCount,
  type CreateStockCountInput,
  type ReconcileStockCountInput,
  type RecordCountLineInput,
} from './service/counts';

export { INVENTORY_RLS, buildInventoryRls, buildInventoryGrants } from './db/security';

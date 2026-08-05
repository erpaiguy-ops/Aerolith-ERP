export { productionModule } from './manifest';

export * as productionSchema from './db/schema';
export {
  PRODUCTION_APPEND_ONLY_TABLES,
  PRODUCTION_TENANT_TABLES,
  production,
} from './db/schema';
export { PRODUCTION_RLS, buildProductionGrants, buildProductionRls } from './db/security';

export {
  addWorkingMinutes,
  operationDuration,
  planFinishingBatches,
  routingCost,
  scheduleOperations,
  totalLeadMinutes,
  type OperationDuration,
  type OperationSpec,
  type ScheduleOptions,
  type ScheduledOperation,
  type WorkCentreCapacity,
} from './domain/scheduling';

export {
  canStartOperation,
  operationProgress,
  operatorMinutes,
  workOrderProgress,
  type OperationProgress,
  type OperationState,
  type OperationSummary,
  type Scan,
  type ScanType,
  type WorkOrderProgress,
} from './domain/progress';

export {
  MODULE_KEY,
  WorkOrderError,
  createWorkOrder,
  estimateCompletion,
  getWorkOrderProgress,
  recordScan,
  releaseWorkOrder,
  saveCuttingPlan,
  type CreateWorkOrderInput,
  type CreateWorkOrderResult,
  type PartInput,
  type RecordScanInput,
  type RecordScanResult,
} from './service/workOrders';

export {
  CUTTING_PLAN_SORTS,
  FINISHING_SORTS,
  ROUTING_SORTS,
  WORK_ORDER_SORTS,
  cuttingPlanOffcutIds,
  getCuttingPlan,
  getRoutingDetail,
  listCuttingPlans,
  listFinishingBatches,
  listRoutings,
  listWorkOrders,
  type CuttingPlanDetail,
  type CuttingPlanListRow,
  type FinishingBatchListRow,
  type RoutingDetail,
  type RoutingListRow,
  type RoutingOperationDetail,
  type WorkOrderListRow,
} from './service/registers';

export {
  RoutingError,
  addRoutingOperation,
  createRouting,
  createWorkCentre,
  removeRoutingOperation,
  updateRouting,
  updateRoutingOperation,
  updateWorkCentre,
  type AddRoutingOperationInput,
  type CreateRoutingInput,
  type CreateWorkCentreInput,
  type UpdateRoutingInput,
  type UpdateRoutingOperationInput,
  type UpdateWorkCentreInput,
} from './service/routings';

export {
  FinishingError,
  createFinishingBatch,
  updateFinishingBatchStatus,
  type CreateFinishingBatchInput,
  type FinishingBatchPartInput,
  type FinishingStatus,
  type UpdateFinishingBatchStatusInput,
} from './service/finishing';

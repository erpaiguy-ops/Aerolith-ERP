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

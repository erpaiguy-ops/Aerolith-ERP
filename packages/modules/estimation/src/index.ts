export { estimationModule } from './manifest';

export * as estimationSchema from './db/schema';
export { ESTIMATION_TENANT_TABLES, estimation } from './db/schema';
export { ESTIMATION_RLS, buildEstimationGrants, buildEstimationRls } from './db/security';

export {
  BuildUpError,
  calculateBuildUp,
  marginScenarios,
  marginToMarkup,
  markupToMargin,
  rollUp,
  rollUpBySection,
  suggestRateFromActuals,
  type BuildUpComponent,
  type BuildUpOptions,
  type BuildUpResult,
  type ComponentBreakdown,
  type ComponentType,
  type EstimateLine,
  type HistoricalActual,
  type MarginScenario,
  type RateSuggestion,
  type RollUp,
} from './domain/buildUp';

export {
  EstimationError,
  MODULE_KEY,
  createEstimate,
  createTender,
  getEstimateBillOfMaterials,
  recordBidDecision,
  recordOutcome,
  submitEstimate,
  type CreateEstimateInput,
  type CreateEstimateResult,
  type CreateTenderInput,
  type EstimateLineInput,
} from './service/estimates';

export {
  ESTIMATE_SORTS,
  RATE_SORTS,
  TENDER_SORTS,
  currentRateLibrary,
  getTenderDetail,
  listEstimates,
  listRates,
  listTenders,
  type EstimateListRow,
  type RateLibraryHeader,
  type RateListRow,
  type TenderDetail,
  type TenderEstimateRow,
  type TenderListRow,
} from './service/registers';

export { contractsModule } from './manifest';

export * as contractsSchema from './db/schema';
export { CONTRACTS_TENANT_TABLES, contracts } from './db/schema';
export { CONTRACTS_RLS, buildContractsGrants, buildContractsRls } from './db/security';

export {
  PaymentError,
  advanceRecoveredToDate,
  compareCertification,
  paymentDue,
  retentionHeld,
  retentionReleasable,
  valuePayment,
  type AdvancePaymentTerms,
  type CertificationComparison,
  type PaymentDue,
  type PaymentDueInput,
  type RetentionReleaseState,
  type RetentionReleaseTerms,
  type RetentionTerms,
  type Valuation,
  type ValuationInput,
} from './domain/payment';

export {
  APPROVED_STATUSES,
  INSTRUCTED_STATUSES,
  VariationError,
  noticeStatus,
  valueDayworks,
  valueVariation,
  variationPosition,
  type DayworksSheet,
  type DayworksValuation,
  type NoticeCheck,
  type NoticeStatus,
  type ValuationBasis,
  type VariationLine,
  type VariationPosition,
  type VariationRecord,
  type VariationStatus,
  type VariationValuation,
  type VariationValuationInput,
} from './domain/variation';

export {
  MODULE_KEY,
  ContractsError,
  activateContract,
  approveVariation,
  certifyApplication,
  createContract,
  createPaymentApplication,
  createVariation,
  getContractPosition,
  getNoticeExposure,
  getVariationPosition,
  listContracts,
  recalculateContractSum,
  recordPracticalCompletion,
  scheduleRetentionRelease,
  submitApplication,
  type ContractLineInput,
  type ContractListRow,
  type ContractPosition,
  type CreateApplicationInput,
  type CreateApplicationResult,
  type CreateContractInput,
  type CreateVariationInput,
} from './service/contracts';

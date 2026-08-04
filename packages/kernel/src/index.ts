/**
 * @aerolith/kernel — the platform every module depends on and none may bypass.
 *
 * See docs/02-architecture.md for the boundary rules this package exists to
 * enforce.
 */

// Tenancy
export {
  type ActorType,
  type TenantContext,
  MissingTenantContextError,
  getTenantContext,
  requireTenantContext,
  requireTenantId,
  runAsSystem,
  runWithTenantContext,
} from './tenancy/context';

// Database
export {
  type Database,
  type DatabaseOptions,
  type Transaction,
  closeDatabase,
  createDatabase,
  getDatabase,
  schema,
  withTenant,
  withTenantId,
  withoutTenantGuard,
} from './db';

export { KERNEL_MODULE_KEY, KERNEL_PERMISSIONS } from './rbac/permissions';

export {
  MemberError,
  addMember,
  createRole,
  listMembers,
  listRoles,
  setMemberRoles,
  setMemberStatus,
  setRolePermissions,
  type AddMemberInput,
  type AddMemberResult,
  type MemberRow,
  type RoleRow,
} from './rbac/members';

export {
  APPEND_ONLY_TABLES,
  APP_ROLE,
  TENANT_SCOPED_TABLES,
  type RlsOptions,
  buildGrantStatements,
  buildGrantStatementsFor,
  buildRlsStatements,
  buildRlsStatementsFor,
  clearTenantGuard,
  setTenantGuard,
} from './db/rls';

export {
  LIST_DEFAULT_PAGE_SIZE,
  LIST_MAX_PAGE_SIZE,
  listResult,
  parseListParams,
  searchPattern,
  type ListParams,
  type ListResult,
  type ParseListOptions,
  type RawListQuery,
  type SortDirection,
} from './db/list';

// Modules
export {
  type ModuleManifest,
  type NavItem,
  type PermissionDeclaration,
  type RuleDeclaration,
  defineModule,
  moduleManifestSchema,
} from './modules/manifest';
export { ModuleRegistry, type ResolvedModules } from './modules/registry';

// Events
export {
  type DispatcherOptions,
  type DomainEvent,
  type EmitInput,
  type EventHandler,
  EventBus,
  dispatchOutboxBatch,
  emit,
} from './events/bus';

// Localisation
export {
  type CountryPack,
  type RequirementPack,
  type TaxRegimePack,
  countryPackSchema,
  parseCountryPack,
} from './localisation/pack';
export { KERNEL_RULE_DEFINITIONS } from './localisation/definitions';
export {
  type PackValidationIssue,
  loadAllCountryPacks,
  loadCountryPack,
  validatePackAgainstDefinitions,
} from './localisation/loader';
export {
  type ResolvedRule,
  type RuleDefinitionRecord,
  type RuleLayer,
  type RuleRecord,
  type RuleSnapshot,
  UnknownRuleError,
  buildSnapshot,
  resolveDomain,
  resolveRule,
  ruleValue,
  validateRuleValue,
} from './localisation/rules';
export {
  type AdoptCountryOptions,
  type AdoptionResult,
  adoptCountry,
  setTenantRule,
} from './localisation/adopt';
export {
  loadRuleSnapshot,
  registerModuleRules,
  requirementsFor,
} from './localisation/snapshot';

// Numbering
export {
  type NumberTokens,
  fiscalYear,
  formatNumber,
  periodKey,
  validatePattern,
  validateResetConsistency,
} from './numbering/format';
export {
  type AllocateOptions,
  type AllocatedNumber,
  NoNumberSeriesError,
  allocateNumber,
  provisionSeries,
  voidNumber,
} from './numbering/service';
export {
  type NumberSeriesRow,
  type UpdateNumberSeriesInput,
  NumberSeriesError,
  listNumberSeries,
  updateNumberSeries,
} from './numbering/admin';

// Approvals
export type {
  WorkflowCondition,
  WorkflowDefinition,
  WorkflowStepDefinition,
} from './db/schema/approvals';
export {
  type ApprovalContext,
  type WorkflowCandidate,
  evaluateCondition,
  matchesConditions,
  planSteps,
  quorumMet,
  readPath,
  requiresReapproval,
  selectWorkflow,
} from './approvals/conditions';
export {
  type ApproverResolver,
  type DecideInput,
  type DecideResult,
  type RequestApprovalInput,
  type RequestApprovalResult,
  ApproverResolverRegistry,
  NoApproversError,
  NoMatchingWorkflowError,
  approverResolvers,
  decide,
  findOverdueTasks,
  recall,
  requestApproval,
} from './approvals/engine';

// Audit
export {
  type AuditAction,
  type AuditLogFilters,
  type AuditLogRow,
  type AuditLogSort,
  type FieldChange,
  type RecordAuditInput,
  AUDIT_LOG_SORTS,
  DEFAULT_REDACTED_FIELDS,
  actorActivity,
  diffRecords,
  entityHistory,
  listAuditActions,
  listAuditEntityTypes,
  listAuditEvents,
  recordAudit,
  redactChanges,
  tryRecordAudit,
} from './audit/service';

// Notifications
export {
  type NotificationRow,
  type NotificationSort,
  type NotifyInput,
  NOTIFICATION_SORTS,
  NotificationError,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notify,
  notifyMany,
  tryNotifyMany,
  unreadNotificationCount,
} from './notifications/service';

// Custom fields
export {
  type CreateCustomFieldDefinitionInput,
  type CustomFieldDefinitionRow,
  type CustomFieldOption,
  type CustomFieldType,
  type CustomFieldValidationError,
  type UpdateCustomFieldDefinitionInput,
  CustomFieldError,
  createCustomFieldDefinition,
  listCustomFieldDefinitions,
  updateCustomFieldDefinition,
  validateCustomFieldValues,
} from './customfields/service';

// Master data — parties
export {
  type AddPartyContactInput,
  type CreatePartyInput,
  type PartyContactRow,
  type PartyDetail,
  type PartyListRow,
  type PartyRole,
  type PartySort,
  type UpdatePartyInput,
  MasterDataError,
  PARTY_SORTS,
  addPartyContact,
  createParty,
  getPartyDetail,
  listParties,
  removePartyContact,
  setPartyCustomFields,
  updateParty,
} from './masterdata/service';

// Master data — cost codes and cost centres
export {
  type CostCentreRow,
  type CostCentreSort,
  type CostCodeRow,
  type CostCodeSort,
  type CostCodeType,
  type CreateCostCentreInput,
  type CreateCostCodeInput,
  type UpdateCostCentreInput,
  type UpdateCostCodeInput,
  COST_CENTRE_SORTS,
  COST_CODE_SORTS,
  COST_CODE_TYPES,
  createCostCentre,
  createCostCode,
  listCostCentres,
  listCostCodes,
  updateCostCentre,
  updateCostCode,
} from './masterdata/service';

// Documents
export {
  StorageNotConfiguredError,
  deleteObject,
  presignDownloadUrl,
  presignUploadUrl,
} from './documents/storage';
export {
  type AddDocumentVersionInput,
  type ConfirmDocumentUploadInput,
  type CreateFolderInput,
  type DocumentRow,
  type DocumentSort,
  type DocumentVersionRow,
  type FolderRow,
  type FolderSort,
  type GetDocumentDownloadUrlInput,
  type InitiateDocumentUploadInput,
  type InitiateDocumentUploadResult,
  type LinkDocumentInput,
  type LockDocumentInput,
  DOCUMENT_SORTS,
  DocumentError,
  FOLDER_SORTS,
  addDocumentVersion,
  confirmDocumentUpload,
  createFolder,
  deleteDocumentObject,
  getDocumentDownloadUrl,
  initiateDocumentUpload,
  linkDocument,
  listDocumentVersions,
  listDocuments,
  listFolders,
  lockDocument,
  unlinkDocument,
  unlockDocument,
} from './documents/service';

// Authentication
export {
  type ParsedHash,
  type ScryptParams,
  DEFAULT_PARAMS,
  MIN_PASSWORD_LENGTH,
  PasswordError,
  assertPasswordAcceptable,
  hashPassword,
  needsRehash,
  parseHash,
  verifyPassword,
} from './auth/password';
export {
  type LoginInput,
  type LoginResult,
  AuthError,
  LOCKOUT_MINUTES,
  MAX_FAILED_ATTEMPTS,
  SESSION_DAYS,
  login,
  logout,
  pruneSessions,
  safeEqual,
  setPassword,
  switchTenant,
} from './auth/service';

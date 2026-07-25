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
  APPEND_ONLY_TABLES,
  APP_ROLE,
  TENANT_SCOPED_TABLES,
  buildGrantStatements,
  buildRlsStatements,
  clearTenantGuard,
  setTenantGuard,
} from './db/rls';

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

// Approvals
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
  type FieldChange,
  type RecordAuditInput,
  DEFAULT_REDACTED_FIELDS,
  actorActivity,
  diffRecords,
  entityHistory,
  recordAudit,
  redactChanges,
  tryRecordAudit,
} from './audit/service';

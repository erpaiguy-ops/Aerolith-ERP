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
  withoutTenantGuard,
} from './db';

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

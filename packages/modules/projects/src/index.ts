export { projectsModule } from './manifest';

export * as projectsSchema from './db/schema';
export { PROJECTS_TENANT_TABLES, projects } from './db/schema';
export { PROJECTS_RLS, buildProjectsGrants, buildProjectsRls } from './db/security';

export {
  MANUAL_PROGRESS_CEILING,
  ProgressError,
  nodeProgressPercent,
  projectProgress,
  rollUpProgress,
  type ProgressInput,
  type ProgressMilestone,
  type RolledUpNode,
  type RuleOfCredit,
  type WbsNode,
} from './domain/progress';

export {
  earnedValueMetrics,
  forecast,
  marginPosition,
  type EarnedValueInput,
  type EarnedValueMetrics,
  type Forecast,
  type ForecastMethod,
  type MarginPosition,
  type MarginPositionInput,
} from './domain/earnedValue';

export {
  MODULE_KEY,
  ProjectsError,
  approveBudget,
  createBudgetVersion,
  createWbs,
  getCostEntries,
  getCostSummary,
  getProjectPosition,
  getWbsRollUp,
  postCost,
  recordCommitment,
  recordProgress,
  relieveCommitment,
  reverseCost,
  type BudgetLineInput,
  type CostSummary,
  type CreateBudgetInput,
  type PostCostInput,
  type ProjectPosition,
  type RecordCommitmentInput,
  type RecordProgressInput,
  type RecordProgressResult,
  type WbsNodeInput,
} from './service/projects';

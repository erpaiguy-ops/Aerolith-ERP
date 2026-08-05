/**
 * Projects — running the job after it is won.
 *
 * `integratesWith` everywhere, `dependsOn` only the kernel. That is possible
 * because `kernel.project` is kernel-owned: this module adds budgets, a WBS, a
 * cost ledger and progress measurement to a project it did not have to invent.
 *
 * The consequence is that Projects is genuinely sellable alone — job costing and
 * progress reporting for a firm that estimates in a spreadsheet and has no
 * factory. The estimate-to-budget and work-order-to-WBS links light up when
 * those modules are present, and are composed in the application layer.
 */
import { defineModule } from '@aerolith/kernel';

export const projectsModule = defineModule({
  key: 'projects',
  name: 'Aerolith Projects',
  description:
    'Project delivery and job costing: work breakdown, versioned budgets, ' +
    'value-weighted progress, an append-only cost ledger, earned value and snagging.',
  version: '0.1.0',
  category: 'operations',
  dbSchema: 'projects',

  dependsOn: ['kernel'],
  integratesWith: ['estimation', 'production', 'inventory', 'contracts'],

  standalone: true,
  sellable: true,

  permissions: [
    { key: 'projects.project.read', resource: 'project', action: 'read', label: 'View projects' },
    { key: 'projects.project.write', resource: 'project', action: 'write', label: 'Manage projects' },
    { key: 'projects.wbs.manage', resource: 'wbs', action: 'manage', label: 'Manage the work breakdown' },
    { key: 'projects.budget.read', resource: 'budget', action: 'read', label: 'View budgets' },
    {
      key: 'projects.budget.approve',
      resource: 'budget',
      action: 'approve',
      label: 'Approve a project budget',
      description: 'Sets what the job is allowed to cost. Restricted.',
      isDangerous: true,
    },
    { key: 'projects.progress.record', resource: 'progress', action: 'record', label: 'Record progress' },
    {
      key: 'projects.progress.override',
      resource: 'progress',
      action: 'override',
      label: 'Claim progress manually',
      description:
        'Bypasses the rule of credit with a typed percentage. This is how a job ' +
        'reports 90% complete for four months.',
      isDangerous: true,
    },
    { key: 'projects.cost.read', resource: 'cost', action: 'read', label: 'View job costs' },
    {
      key: 'projects.cost.post',
      resource: 'cost',
      action: 'post',
      label: 'Post to the job cost ledger',
      description: 'Normally held by service accounts, not people.',
    },
    {
      key: 'projects.margin.view',
      resource: 'margin',
      action: 'view',
      label: 'View forecast margin',
      description:
        'Separate from viewing costs. A site engineer needs the cost report; the ' +
        'forecast margin is a different conversation.',
    },
    { key: 'projects.snag.read', resource: 'snag', action: 'read', label: 'View snags' },
    { key: 'projects.snag.write', resource: 'snag', action: 'write', label: 'Raise and close snags' },
  ],

  nav: [
    {
      key: 'projects',
      label: 'Projects',
      icon: 'clipboard',
      order: 25,
      children: [
        { key: 'projects.list', label: 'Projects', path: '/projects', permission: 'projects.project.read', order: 10 },
        { key: 'projects.progress', label: 'Progress', path: '/projects/progress', permission: 'projects.progress.record', order: 20 },
        { key: 'projects.costs', label: 'Job Costing', path: '/projects/costs', permission: 'projects.cost.read', order: 30 },
        { key: 'projects.snags', label: 'Snags', path: '/projects/snags', permission: 'projects.snag.read', order: 40 },
      ],
    },
  ],

  events: {
    emits: [
      {
        type: 'projects.budget.approved',
        description: 'A budget version became the baseline. Job costing measures against it.',
      },
      {
        type: 'projects.progress.recorded',
        description:
          'Progress was measured for a period. Contract Administration values a ' +
          'payment application from it.',
      },
      {
        type: 'projects.cost.overrun_detected',
        description:
          'Forecast cost passed the approved budget. Raised once per crossing, not ' +
          'per posting — an alert that fires every hour is an alert nobody reads.',
      },
      {
        type: 'projects.practical_completion.recorded',
        description:
          'Practical completion was certified. Starts the defects period and the ' +
          'first retention release.',
      },
    ],
    consumes: [
      // estimation.tender.won   → opens the project, seeds budget version 1.
      // contracts.variation.approved → revises the budget, never overwrites it.
      'estimation.tender.won',
      'contracts.variation.approved',
    ],
  },

  rules: [
    {
      key: 'projects.budget.contingency_percent',
      domain: 'contract',
      label: 'Default contingency',
      description: 'Held centrally on the budget, not spread across lines.',
      valueType: 'percent',
      defaultValue: 5,
      tenantOverridable: true,
    },
    {
      key: 'projects.progress.default_rule_of_credit',
      domain: 'contract',
      label: 'Default rule of credit',
      description:
        'How a new WBS node measures progress. `manual` is permitted and is the ' +
        'weakest option — a countable rule is always better where one exists.',
      valueType: 'string',
      defaultValue: 'manual',
      tenantOverridable: true,
    },
    {
      key: 'projects.forecast.default_method',
      domain: 'contract',
      label: 'Default cost forecasting method',
      description:
        'budget_rate | performance_rate | cost_and_schedule. `performance_rate` ' +
        'assumes today\'s productivity continues, which is usually the safe bet.',
      valueType: 'string',
      defaultValue: 'performance_rate',
      tenantOverridable: true,
    },
    {
      key: 'projects.cost.overrun_alert_percent',
      domain: 'contract',
      label: 'Overrun warning threshold',
      description: 'Forecast cost above this share of budget raises the alert.',
      valueType: 'percent',
      defaultValue: 100,
      tenantOverridable: true,
    },
    {
      key: 'projects.snag.critical_blocks_handover',
      domain: 'contract',
      label: 'Critical snags block handover',
      description: 'Prevents practical completion while a critical snag is open.',
      valueType: 'boolean',
      defaultValue: true,
      tenantOverridable: true,
    },
  ],

  approvableEntities: ['projects.budget', 'projects.progress_claim'],

  numberSeries: [{ entityType: 'projects.snag', code: 'SNG', pattern: 'SNG-{YYYY}-{SEQ}' }],
});

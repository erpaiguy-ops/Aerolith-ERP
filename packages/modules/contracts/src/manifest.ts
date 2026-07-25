/**
 * Contract Administration — variations, payment applications and the final account.
 *
 * This is the module a joinery subcontractor would buy first if they could only
 * buy one, because it is where the money is lost: unapproved variations, missed
 * notice periods, retention nobody chased, and a certificate that quietly
 * certified less than was applied for.
 *
 * It depends on the kernel alone. Progress-driven valuation is composed with
 * Projects at the application layer, and where Projects is absent a quantity
 * surveyor enters measured quantities directly — which is exactly how it is done
 * today, so the module is complete without it.
 */
import { defineModule } from '@aerolith/kernel';

export const contractsModule = defineModule({
  key: 'contracts',
  name: 'Aerolith Contract Administration',
  description:
    'Contracts, variations, interim payment applications and certificates, ' +
    'retention, back charges and the notice register.',
  version: '0.1.0',
  category: 'commercial',
  dbSchema: 'contracts',

  dependsOn: ['kernel'],
  integratesWith: ['projects', 'estimation'],

  standalone: true,
  sellable: true,

  permissions: [
    { key: 'contracts.contract.read', resource: 'contract', action: 'read', label: 'View contracts' },
    { key: 'contracts.contract.write', resource: 'contract', action: 'write', label: 'Manage contracts' },
    {
      key: 'contracts.contract.execute',
      resource: 'contract',
      action: 'execute',
      label: 'Activate a contract',
      description: 'Freezes the commercial terms and the contract sum. Restricted.',
      isDangerous: true,
    },
    { key: 'contracts.variation.read', resource: 'variation', action: 'read', label: 'View variations' },
    { key: 'contracts.variation.write', resource: 'variation', action: 'write', label: 'Raise and price variations' },
    {
      key: 'contracts.variation.approve',
      resource: 'variation',
      action: 'approve',
      label: 'Record a variation as approved',
      description: 'Changes the contract sum. Nothing else does.',
      isDangerous: true,
    },
    { key: 'contracts.application.read', resource: 'application', action: 'read', label: 'View payment applications' },
    { key: 'contracts.application.write', resource: 'application', action: 'write', label: 'Prepare payment applications' },
    {
      key: 'contracts.application.submit',
      resource: 'application',
      action: 'submit',
      label: 'Submit a payment application',
      description: 'Sends a valuation to the client. Restricted.',
      isDangerous: true,
    },
    {
      key: 'contracts.application.certify',
      resource: 'application',
      action: 'certify',
      label: 'Record the client certificate',
    },
    {
      key: 'contracts.retention.release',
      resource: 'retention',
      action: 'release',
      label: 'Release retention',
      description: 'Gives up the leverage that gets snags fixed. Restricted.',
      isDangerous: true,
    },
    { key: 'contracts.back_charge.manage', resource: 'back_charge', action: 'manage', label: 'Manage back charges' },
    { key: 'contracts.correspondence.manage', resource: 'correspondence', action: 'manage', label: 'Manage the notice register' },
  ],

  nav: [
    {
      key: 'contracts',
      label: 'Contracts',
      icon: 'file-signature',
      order: 30,
      children: [
        { key: 'contracts.list', label: 'Contracts', path: '/contracts', permission: 'contracts.contract.read', order: 10 },
        { key: 'contracts.variations', label: 'Variations', path: '/contracts/variations', permission: 'contracts.variation.read', order: 20 },
        { key: 'contracts.applications', label: 'Payment Applications', path: '/contracts/applications', permission: 'contracts.application.read', order: 30 },
        { key: 'contracts.retention', label: 'Retention', path: '/contracts/retention', permission: 'contracts.contract.read', order: 40 },
        { key: 'contracts.register', label: 'Notice Register', path: '/contracts/correspondence', permission: 'contracts.correspondence.manage', order: 50 },
      ],
    },
  ],

  events: {
    emits: [
      {
        type: 'contracts.variation.approved',
        description:
          'A variation was approved. The contract sum moves and Projects revises ' +
          'the budget. The only event that changes what the job is worth.',
      },
      {
        type: 'contracts.variation.time_barred',
        description:
          'A variation passed its notice deadline without notice being given. ' +
          'Raised loudly: this is entitlement being extinguished.',
      },
      {
        type: 'contracts.application.submitted',
        description: 'A valuation went to the client. Starts the certification clock.',
      },
      {
        type: 'contracts.application.certified',
        description:
          'The client certified. Carries the disallowance, if any — the difference ' +
          'between applied and certified is the fact worth publishing.',
      },
      {
        type: 'contracts.payment.overdue',
        description: 'A certified amount passed its due date unpaid.',
      },
      {
        type: 'contracts.retention.due',
        description: 'A retention tranche became releasable. Otherwise it is forgotten.',
      },
    ],
    consumes: [
      // estimation.tender.won → creates the contract, snapshots the priced BOQ.
      // projects.progress.recorded → values the next payment application.
      // projects.practical_completion.recorded → schedules the first release.
      'estimation.tender.won',
      'projects.progress.recorded',
      'projects.practical_completion.recorded',
    ],
  },

  /**
   * Note what is NOT declared here: retention percentage, release schedule,
   * defects liability period and payment terms. Those are `contract.*` rules
   * already owned by the kernel and populated per country by the packs, so a UAE
   * tenant gets 10% retention and 60-day terms without anyone configuring them.
   * Re-declaring them here would create a second source of truth for the same
   * fact, which is the failure mode the localisation design exists to prevent.
   */
  rules: [
    {
      key: 'contracts.variation.notice_period_days',
      domain: 'contract',
      label: 'Notice period for variations and claims',
      description:
        'Days from the event to a written notice. Miss it and entitlement can be ' +
        'lost entirely, so this drives a warning rather than a report.',
      valueType: 'number',
      defaultValue: 28,
      unit: 'days',
      tenantOverridable: true,
    },
    {
      key: 'contracts.application.materials_on_site_percent',
      domain: 'contract',
      label: 'Valuation percentage for materials on site',
      description: 'Share of the value of delivered but uninstalled material that may be claimed.',
      valueType: 'percent',
      defaultValue: 80,
      tenantOverridable: true,
    },
    {
      key: 'contracts.advance.recovery_start_percent',
      domain: 'contract',
      label: 'Progress at which advance recovery starts',
      valueType: 'percent',
      defaultValue: 10,
      tenantOverridable: true,
    },
    {
      key: 'contracts.advance.recovery_end_percent',
      domain: 'contract',
      label: 'Progress by which the advance is fully recovered',
      valueType: 'percent',
      defaultValue: 90,
      tenantOverridable: true,
    },
    {
      key: 'contracts.application.tax_on_gross',
      domain: 'tax',
      label: 'Charge tax on the gross valuation',
      description:
        'Off for standard GCC VAT, where tax follows the net amount payable. On for ' +
        'the withholding regimes that require the gross basis.',
      valueType: 'boolean',
      defaultValue: false,
      tenantOverridable: false,
    },
  ],

  approvableEntities: ['contracts.variation', 'contracts.payment_application'],

  numberSeries: [
    { entityType: 'contracts.contract', code: 'CON', pattern: 'CON-{YYYY}-{SEQ}' },
    { entityType: 'contracts.variation', code: 'VO', pattern: 'VO-{YYYY}-{SEQ}' },
    { entityType: 'contracts.payment_application', code: 'IPC', pattern: 'IPC-{YYYY}-{SEQ}' },
  ],
});

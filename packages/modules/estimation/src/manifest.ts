/**
 * Estimation & Tendering — the front half of the joinery wedge.
 *
 * `integratesWith` rather than `dependsOn` throughout: a won tender becoming a
 * project and work orders is composed at the application layer. Estimation
 * prices tenders perfectly well on its own, which is how it stays sellable
 * standalone to a firm that does not want the rest of the ERP.
 */
import { defineModule } from '@aerolith/kernel';

export const estimationModule = defineModule({
  key: 'estimation',
  name: 'Aerolith Estimation',
  description:
    'Tendering and estimating for joinery: BOQ pricing, rate build-ups, a versioned ' +
    'rate library fed by job actuals, and margin scenarios.',
  version: '0.1.0',
  category: 'commercial',
  dbSchema: 'estimation',

  dependsOn: ['kernel'],
  integratesWith: ['production', 'inventory'],

  standalone: true,
  sellable: true,

  permissions: [
    { key: 'estimation.tender.read', resource: 'tender', action: 'read', label: 'View tenders' },
    { key: 'estimation.tender.write', resource: 'tender', action: 'write', label: 'Manage tenders' },
    {
      key: 'estimation.tender.decide',
      resource: 'tender',
      action: 'decide',
      label: 'Record bid/no-bid and outcome',
      isDangerous: false,
    },
    { key: 'estimation.estimate.read', resource: 'estimate', action: 'read', label: 'View estimates' },
    { key: 'estimation.estimate.write', resource: 'estimate', action: 'write', label: 'Price estimates' },
    {
      key: 'estimation.estimate.submit',
      resource: 'estimate',
      action: 'submit',
      label: 'Submit a tender price',
      description: 'Commits the company to a price. Restricted.',
      isDangerous: true,
    },
    { key: 'estimation.rate_library.read', resource: 'rate_library', action: 'read', label: 'View rates' },
    {
      key: 'estimation.rate_library.manage',
      resource: 'rate_library',
      action: 'manage',
      label: 'Manage the rate library',
      description: 'Changes the basis of every future tender.',
      isDangerous: true,
    },
    {
      key: 'estimation.margin.view',
      resource: 'margin',
      action: 'view',
      label: 'View cost and margin',
      description: 'Separate from viewing an estimate — not everyone should see the margin.',
    },
  ],

  nav: [
    {
      key: 'estimation',
      label: 'Estimating',
      icon: 'calculator',
      order: 15,
      children: [
        { key: 'estimation.tenders', label: 'Tenders', path: '/estimating/tenders', permission: 'estimation.tender.read', order: 10 },
        { key: 'estimation.estimates', label: 'Estimates', path: '/estimating/estimates', permission: 'estimation.estimate.read', order: 20 },
        { key: 'estimation.rates', label: 'Rate Library', path: '/estimating/rates', permission: 'estimation.rate_library.read', order: 30 },
      ],
    },
  ],

  events: {
    emits: [
      {
        type: 'estimation.tender.won',
        description:
          'A tender was won. Projects opens the job; Production can raise work orders ' +
          'from the priced build-ups.',
      },
      {
        type: 'estimation.tender.lost',
        description: 'A tender was lost. Feeds win-rate and pricing analysis.',
      },
      {
        type: 'estimation.estimate.submitted',
        description: 'A price was submitted to a client. The commercial commitment.',
      },
      {
        type: 'estimation.rate.variance_detected',
        description:
          'Job actuals diverged materially from the library rate. The estimator is ' +
          'asked to review, never overruled automatically.',
      },
    ],
    consumes: [],
  },

  rules: [
    {
      key: 'estimation.pricing.default_margin_percent',
      domain: 'contract',
      label: 'Default margin',
      description: 'Margin is a share of the SELLING price, not of cost.',
      valueType: 'percent',
      defaultValue: 18,
      tenantOverridable: true,
    },
    {
      key: 'estimation.pricing.default_overhead_percent',
      domain: 'contract',
      label: 'Default overhead recovery',
      valueType: 'percent',
      defaultValue: 8,
      tenantOverridable: true,
    },
    {
      key: 'estimation.pricing.round_rates_to',
      domain: 'contract',
      label: 'Round unit rates to',
      description: 'Tenders are rarely priced to four decimals. Zero disables rounding.',
      valueType: 'number',
      defaultValue: 0.05,
      tenantOverridable: true,
    },
    {
      key: 'estimation.rate_library.variance_alert_percent',
      domain: 'contract',
      label: 'Rate variance that triggers a review',
      description: 'How far actuals may drift from the library before an estimator is asked.',
      valueType: 'percent',
      defaultValue: 10,
      tenantOverridable: true,
    },
    {
      key: 'estimation.rate_library.actual_half_life_days',
      domain: 'contract',
      label: 'Half-life for weighting job actuals',
      description: 'A job this old counts half as much as one completed today.',
      valueType: 'number',
      defaultValue: 365,
      unit: 'days',
      tenantOverridable: true,
    },
  ],

  approvableEntities: ['estimation.estimate', 'estimation.tender'],

  numberSeries: [
    { entityType: 'estimation.tender', code: 'TND', pattern: 'TND-{YYYY}-{SEQ}' },
  ],
});

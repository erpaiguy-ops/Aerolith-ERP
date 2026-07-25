/**
 * Production — the joinery factory module.
 *
 * Note `integratesWith: ['inventory']` rather than `dependsOn`. Production
 * genuinely needs stock to cut, but the dependency is SOFT: without Inventory it
 * still plans work orders, routes them through work centres and records
 * shop-floor scans. Material issue and cutlist planning against the offcut
 * register light up when Inventory is present, and the composition happens in
 * the application layer, which may depend on both.
 *
 * That is what keeps both modules sellable on their own.
 */
import { defineModule } from '@aerolith/kernel';

export const productionModule = defineModule({
  key: 'production',
  name: 'Aerolith Production',
  description:
    'Joinery factory control: work orders, cutlist planning, routing through work ' +
    'centres, batch finishing with cure time, and barcode shop-floor tracking.',
  version: '0.1.0',
  category: 'operations',
  dbSchema: 'production',

  dependsOn: ['kernel'],
  integratesWith: ['inventory'],

  standalone: true,
  sellable: true,

  permissions: [
    { key: 'production.work_order.read', resource: 'work_order', action: 'read', label: 'View work orders' },
    { key: 'production.work_order.write', resource: 'work_order', action: 'write', label: 'Create and edit work orders' },
    {
      key: 'production.work_order.release',
      resource: 'work_order',
      action: 'release',
      label: 'Release work orders to the floor',
      description: 'Commits material and starts the job. Restricted.',
      isDangerous: true,
    },
    { key: 'production.routing.manage', resource: 'routing', action: 'manage', label: 'Manage routings and work centres' },
    { key: 'production.scan.create', resource: 'scan', action: 'create', label: 'Record shop-floor scans' },
    {
      key: 'production.scan.override',
      resource: 'scan',
      action: 'override',
      label: 'Override operation sequence',
      description: 'Lets a part skip an operation. This is how the edgebander gets missed.',
      isDangerous: true,
    },
    { key: 'production.cutlist.generate', resource: 'cutlist', action: 'generate', label: 'Generate cutting plans' },
    { key: 'production.finishing.manage', resource: 'finishing', action: 'manage', label: 'Manage spray batches' },
  ],

  nav: [
    {
      key: 'production',
      label: 'Production',
      icon: 'factory',
      order: 30,
      children: [
        { key: 'production.orders', label: 'Work Orders', path: '/production/orders', permission: 'production.work_order.read', order: 10 },
        { key: 'production.board', label: 'Shop Floor', path: '/production/board', permission: 'production.work_order.read', order: 20 },
        { key: 'production.cutlist', label: 'Cutting Plans', path: '/production/cutlist', permission: 'production.cutlist.generate', order: 30 },
        { key: 'production.finishing', label: 'Finishing', path: '/production/finishing', permission: 'production.finishing.manage', order: 40 },
        { key: 'production.routings', label: 'Routings', path: '/production/routings', permission: 'production.routing.manage', order: 50 },
      ],
    },
  ],

  events: {
    emits: [
      {
        type: 'production.work_order.released',
        description:
          'A job was released to the floor. Inventory issues the material; Projects ' +
          'updates the programme.',
      },
      {
        type: 'production.work_order.completed',
        description: 'A job finished. Inventory receives the output; Accounts closes WIP.',
      },
      {
        type: 'production.cutting_plan.generated',
        description:
          'A cutting plan was produced. Inventory commits the offcuts it consumed and ' +
          'registers the remnants it creates.',
      },
      {
        type: 'production.operation.completed',
        description: 'A station finished its part of a job. Drives the shop-floor board.',
      },
      {
        type: 'production.part.rejected',
        description: 'A part failed at a station. Quality raises an NCR if installed.',
      },
    ],
    consumes: [],
  },

  rules: [
    {
      key: 'production.scan.enforce_sequence',
      domain: 'production',
      label: 'Enforce operation sequence on scans',
      description:
        'Stops a part being scanned at assembly before it has been through the ' +
        'edgebander. Turn off only if the floor genuinely works out of order.',
      valueType: 'boolean',
      defaultValue: true,
      tenantOverridable: true,
    },
    {
      key: 'production.finishing.default_cure_minutes',
      domain: 'production',
      label: 'Default cure time between coats',
      valueType: 'number',
      defaultValue: 240,
      unit: 'minutes',
      tenantOverridable: true,
    },
    {
      key: 'production.scheduling.cure_runs_overnight',
      domain: 'production',
      label: 'Cure time continues outside working hours',
      description: 'Paint does not stop drying at five o\'clock. Machining time does stop.',
      valueType: 'boolean',
      defaultValue: true,
      tenantOverridable: true,
    },
    {
      key: 'production.work_order.allow_partial_completion',
      domain: 'production',
      label: 'Allow a work order to complete with parts outstanding',
      valueType: 'boolean',
      defaultValue: false,
      tenantOverridable: true,
    },
  ],

  approvableEntities: ['production.work_order', 'production.cutting_plan'],

  // Must match what the service allocates against — see the test in manifest.test.ts.
  numberSeries: [
    { entityType: 'production.work_order', code: 'WO', pattern: 'WO-{YYYY}-{SEQ}' },
    { entityType: 'production.finishing_batch', code: 'FIN', pattern: 'FIN-{YYYY}-{SEQ}' },
  ],
});

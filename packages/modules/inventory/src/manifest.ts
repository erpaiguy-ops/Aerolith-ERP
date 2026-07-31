/**
 * Inventory / Stores — the reference module.
 *
 * Note what it demonstrates:
 *
 *  - `standalone: true` — this is sellable as "Aerolith Inventory" on its own.
 *  - `dependsOn: ['kernel']` only — it works with nothing else installed.
 *  - `integratesWith` — Procurement and Accounts light up if the tenant holds
 *    them, and nothing breaks if they do not. That is what makes one binary
 *    serve both the standalone product and the full ERP.
 *  - It emits events and consumes none. A module that consumed another module's
 *    tables directly would fail CI; consuming its EVENTS is how they talk.
 */
import { defineModule } from '@aerolith/kernel';

export const inventoryModule = defineModule({
  key: 'inventory',
  name: 'Aerolith Inventory',
  description:
    'Multi-warehouse stock control with barcode-driven movements, batch and offcut ' +
    'tracking for sheet goods.',
  version: '0.1.0',
  category: 'operations',
  dbSchema: 'inventory',

  dependsOn: ['kernel'],
  integratesWith: [],

  standalone: true,
  sellable: true,

  permissions: [
    { key: 'inventory.item.read', resource: 'item', action: 'read', label: 'View items' },
    { key: 'inventory.item.write', resource: 'item', action: 'write', label: 'Manage items' },
    { key: 'inventory.stock.read', resource: 'stock', action: 'read', label: 'View stock' },
    {
      key: 'inventory.stock_movement.create',
      resource: 'stock_movement',
      action: 'create',
      label: 'Record stock movements',
    },
    {
      key: 'inventory.stock_movement.approve',
      resource: 'stock_movement',
      action: 'approve',
      label: 'Approve stock movements',
    },
    {
      key: 'inventory.stock_count.reconcile',
      resource: 'stock_count',
      action: 'reconcile',
      label: 'Reconcile stock counts',
      description: 'Writes off variances. Restricted — this is how stock loss gets hidden.',
      isDangerous: true,
    },
  ],

  nav: [
    {
      key: 'inventory',
      label: 'Inventory',
      icon: 'package',
      order: 10,
      children: [
        { key: 'inventory.items', label: 'Items', path: '/inventory/items', permission: 'inventory.item.read', order: 10 },
        { key: 'inventory.stock', label: 'Stock on Hand', path: '/inventory/stock', permission: 'inventory.stock.read', order: 20 },
        { key: 'inventory.offcuts', label: 'Offcut Register', path: '/inventory/offcuts', permission: 'inventory.stock.read', order: 30 },
        { key: 'inventory.counts', label: 'Stock Counts', path: '/inventory/counts', permission: 'inventory.stock.read', order: 40 },
        // The ledger. Gated on READ, not on create: seeing what moved is not the
        // same authority as moving it, and the screen hides its own form from
        // anybody without `stock_movement.create`.
        { key: 'inventory.movements', label: 'Stock Movements', path: '/inventory/movements', permission: 'inventory.stock.read', order: 50 },
      ],
    },
  ],

  events: {
    emits: [
      {
        type: 'inventory.stock_movement.posted',
        description:
          'Stock moved. Accounts posts the GL entry; Production releases any waiting job.',
      },
      {
        type: 'inventory.stock_level.below_reorder',
        description: 'An item fell below its reorder level. Procurement may raise a requisition.',
      },
      {
        type: 'inventory.offcut.created',
        description: 'A usable offcut was produced. The cutlist optimiser may consume it.',
      },
      {
        type: 'inventory.stock_count.reconciled',
        description: 'A count was reconciled and a variance written off.',
      },
    ],
    consumes: [],
  },

  rules: [
    {
      key: 'inventory.costing.method',
      domain: 'inventory',
      label: 'Stock costing method',
      valueType: 'enum',
      defaultValue: 'moving_average',
      tenantOverridable: true,
    },
    {
      key: 'inventory.offcut.minimum_usable_area_sqm',
      domain: 'inventory',
      label: 'Minimum offcut area worth registering',
      description: 'Below this, an offcut is scrapped rather than returned to stock.',
      valueType: 'number',
      defaultValue: 0.25,
      unit: 'm2',
      tenantOverridable: true,
    },
    {
      key: 'inventory.offcut.minimum_usable_dimension_mm',
      domain: 'inventory',
      label: 'Minimum offcut dimension worth registering',
      description:
        'Below this on either side a remnant cannot be handled safely on a panel saw.',
      valueType: 'number',
      defaultValue: 150,
      unit: 'mm',
      tenantOverridable: true,
    },
    {
      key: 'inventory.cutting.kerf_mm',
      domain: 'inventory',
      label: 'Saw kerf',
      description: 'Blade width removed on every cut. Feeds offcut matching and the cutlist.',
      valueType: 'number',
      defaultValue: 3.2,
      unit: 'mm',
      tenantOverridable: true,
    },
    {
      key: 'inventory.stock.allow_negative',
      domain: 'inventory',
      label: 'Allow stock to go negative',
      description:
        'Lets issues run ahead of paperwork. Convenient on site, and a reliable way to ' +
        'end up with stock that does not reconcile.',
      valueType: 'boolean',
      defaultValue: false,
      tenantOverridable: true,
    },
  ],

  approvableEntities: ['inventory.stock_transfer', 'inventory.stock_write_off'],

  // These entity types must match what postMovement() allocates against —
  // `inventory.${movementType}`. A mismatch means the series is silently never
  // found and every posting fails.
  numberSeries: [
    { entityType: 'inventory.receipt', code: 'GRN', pattern: 'GRN-{YYYY}-{SEQ}' },
    { entityType: 'inventory.issue', code: 'ISS', pattern: 'ISS-{YYYY}-{SEQ}' },
    { entityType: 'inventory.transfer', code: 'STR', pattern: 'STR-{YYYY}-{SEQ}' },
    { entityType: 'inventory.adjustment', code: 'ADJ', pattern: 'ADJ-{YYYY}-{SEQ}' },
    { entityType: 'inventory.return', code: 'RTN', pattern: 'RTN-{YYYY}-{SEQ}' },
    { entityType: 'inventory.scrap', code: 'SCR', pattern: 'SCR-{YYYY}-{SEQ}' },
    { entityType: 'inventory.production_output', code: 'PRO', pattern: 'PRO-{YYYY}-{SEQ}' },
    { entityType: 'inventory.stock_count', code: 'CNT', pattern: 'CNT-{YYYY}-{SEQ}' },
  ],
});

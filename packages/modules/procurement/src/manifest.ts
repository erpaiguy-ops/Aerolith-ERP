/**
 * Procurement — requisitions, quote comparison, purchase orders, goods receipt
 * and three-way matching.
 *
 * The module that pays for itself fastest, because the failures it prevents are
 * ordinary rather than exotic: the same invoice paid twice, an invoice paid for
 * goods that never arrived, a price that crept up between quote and invoice, and
 * an award made on unit price to a supplier who was never the cheapest once
 * freight and duty were counted.
 *
 * It depends on the kernel alone. Stock movement on receipt and commitment
 * accounting against a project budget are composed at the application layer when
 * Inventory and Projects are entitled — so a firm that buys only this gets a
 * complete purchasing system, and a firm that buys all three gets the chain.
 */
import { defineModule } from '@aerolith/kernel';

export const procurementModule = defineModule({
  key: 'procurement',
  name: 'Aerolith Procurement',
  description:
    'Requisitions and approvals, RFQs and landed-cost quote comparison, purchase ' +
    'orders, goods receipt, and three-way invoice matching.',
  version: '0.1.0',
  category: 'operations',
  dbSchema: 'procurement',

  dependsOn: ['kernel'],
  // No 'accounts' here, however natural it reads: the registry rejects a soft
  // integration naming a module that does not exist, and it is right to. A
  // manifest that advertises an integration nobody built is a lie the boot
  // sequence should catch.
  integratesWith: ['inventory', 'projects', 'estimation'],

  standalone: true,
  sellable: true,

  permissions: [
    { key: 'procurement.requisition.read', resource: 'requisition', action: 'read', label: 'View requisitions' },
    { key: 'procurement.requisition.write', resource: 'requisition', action: 'write', label: 'Raise requisitions' },
    {
      key: 'procurement.requisition.approve',
      resource: 'requisition',
      action: 'approve',
      label: 'Approve requisitions',
      description: 'Authorises the spend, before anyone is committed to it.',
      isDangerous: true,
    },
    { key: 'procurement.rfq.read', resource: 'rfq', action: 'read', label: 'View RFQs and quotes' },
    { key: 'procurement.rfq.write', resource: 'rfq', action: 'write', label: 'Issue RFQs and record quotes' },
    {
      key: 'procurement.rfq.award',
      resource: 'rfq',
      action: 'award',
      label: 'Award an RFQ',
      description: 'Picks the supplier. Awarding off-lowest requires a recorded reason.',
      isDangerous: true,
    },
    { key: 'procurement.order.read', resource: 'purchase_order', action: 'read', label: 'View purchase orders' },
    { key: 'procurement.order.write', resource: 'purchase_order', action: 'write', label: 'Prepare purchase orders' },
    {
      key: 'procurement.order.issue',
      resource: 'purchase_order',
      action: 'issue',
      label: 'Issue a purchase order',
      description: 'Commits the company to spend. Restricted.',
      isDangerous: true,
    },
    { key: 'procurement.receipt.read', resource: 'goods_receipt', action: 'read', label: 'View goods receipts' },
    { key: 'procurement.receipt.write', resource: 'goods_receipt', action: 'write', label: 'Receive goods' },
    { key: 'procurement.invoice.read', resource: 'supplier_invoice', action: 'read', label: 'View supplier invoices' },
    { key: 'procurement.invoice.write', resource: 'supplier_invoice', action: 'write', label: 'Register supplier invoices' },
    {
      key: 'procurement.invoice.release',
      resource: 'supplier_invoice',
      action: 'release',
      label: 'Release a held invoice',
      description:
        'Overrides a matching exception and lets the invoice be paid. The single ' +
        'most abusable permission in the module — it defeats the control that ' +
        'stops the company paying for goods it never received.',
      isDangerous: true,
    },
    {
      key: 'procurement.supplier.manage',
      resource: 'supplier',
      action: 'manage',
      label: 'Manage the approved supplier list',
    },
  ],

  nav: [
    {
      key: 'procurement',
      label: 'Procurement',
      icon: 'shopping-cart',
      // 12, not 20: Production already claims 20, and two modules on the same
      // order made the sidebar depend on registration order rather than intent.
      // Sits beside Inventory (10) — buying and holding are one flow to a user.
      order: 12,
      children: [
        { key: 'procurement.requisitions', label: 'Requisitions', path: '/procurement/requisitions', permission: 'procurement.requisition.read', order: 10 },
        { key: 'procurement.rfqs', label: 'RFQs & Quotes', path: '/procurement/rfqs', permission: 'procurement.rfq.read', order: 20 },
        { key: 'procurement.orders', label: 'Purchase Orders', path: '/procurement/orders', permission: 'procurement.order.read', order: 30 },
        { key: 'procurement.receipts', label: 'Goods Receipts', path: '/procurement/receipts', permission: 'procurement.receipt.read', order: 40 },
        { key: 'procurement.invoices', label: 'Supplier Invoices', path: '/procurement/invoices', permission: 'procurement.invoice.read', order: 50 },
        { key: 'procurement.exceptions', label: 'Match Exceptions', path: '/procurement/exceptions', permission: 'procurement.invoice.read', order: 60 },
      ],
    },
  ],

  events: {
    emits: [
      {
        type: 'procurement.requisition.approved',
        description: 'Spend was authorised. Sourcing may start.',
      },
      {
        type: 'procurement.order.issued',
        description:
          'A purchase order went to a supplier. Projects registers the commitment ' +
          'against the budget — the event that makes a forecast honest, because ' +
          'ordered-not-yet-invoiced money is spent in every sense that matters.',
      },
      {
        type: 'procurement.goods.received',
        description:
          'Material arrived. Inventory takes it into stock and Projects accrues ' +
          'the cost, so a job is charged when the goods land rather than whenever ' +
          'the supplier gets round to invoicing.',
      },
      {
        type: 'procurement.receipt.over_delivered',
        description:
          'More was delivered than ordered, beyond tolerance. Raised at the gate ' +
          'while the lorry is still there and the decision is still cheap.',
      },
      {
        type: 'procurement.invoice.matched',
        description:
          'An invoice passed three-way matching. The accrual reverses, the ' +
          'commitment is relieved, and the payable is real.',
      },
      {
        type: 'procurement.invoice.held',
        description:
          'An invoice failed matching. Carries the exceptions and what each is ' +
          'worth, because "on hold" without the amount is a queue nobody triages.',
      },
      {
        type: 'procurement.invoice.released',
        description:
          'A held invoice was released over its exceptions. Emitted loudly and ' +
          'separately: this is the control being overridden, and it should be as ' +
          'visible as the hold was.',
      },
    ],
    consumes: [
      // estimation.tender.won → the BOM becomes material demand to requisition.
      // production.work_order.released → shortages become requisitions.
      // inventory.stock.below_reorder_point → replenishment.
      'estimation.tender.won',
      'production.work_order.released',
      'inventory.stock.below_reorder_point',
    ],
  },

  /**
   * As in Contracts, note what is NOT here: payment terms and tax codes are
   * `contract.*` and `tax.*` kernel rules already populated per country by the
   * packs. A UAE tenant gets 5% VAT and 60-day terms on a purchase order without
   * anyone configuring them, and there is one source of truth for the fact.
   */
  rules: [
    {
      key: 'procurement.match.price_tolerance_percent',
      domain: 'procurement',
      label: 'Price variance tolerance',
      description:
        'Proportional difference between the ordered and invoiced line total that ' +
        'passes without a hold.',
      valueType: 'percent',
      defaultValue: 2,
      tenantOverridable: true,
    },
    {
      key: 'procurement.match.minor_amount',
      domain: 'procurement',
      label: 'Variance always accepted',
      description:
        'Differences at or below this pass whatever the percentage. Without it, a ' +
        'rounding difference on a cheap line generates an exception that costs more ' +
        'to read than it is worth.',
      valueType: 'money',
      defaultValue: 5,
      tenantOverridable: true,
    },
    {
      key: 'procurement.match.max_amount',
      domain: 'procurement',
      label: 'Ceiling on what the percentage may forgive',
      description:
        'Above this, a variance is held however small the percentage. 1% of a ' +
        '200,000 line is 2,000 nobody looked at.',
      valueType: 'money',
      defaultValue: 500,
      tenantOverridable: true,
    },
    {
      key: 'procurement.receipt.over_delivery_percent',
      domain: 'procurement',
      label: 'Over-delivery tolerance',
      description: 'Proportional over-delivery accepted at the gate without a query.',
      valueType: 'percent',
      defaultValue: 5,
      tenantOverridable: true,
    },
    {
      key: 'procurement.rfq.minimum_quotes',
      domain: 'procurement',
      label: 'Quotes required before award',
      description:
        'Below this an award needs a recorded reason. The cheapest governance ' +
        'control there is, and the first one abandoned under deadline pressure.',
      valueType: 'number',
      defaultValue: 3,
      tenantOverridable: true,
    },
    {
      key: 'procurement.cost_of_capital_percent',
      domain: 'procurement',
      label: 'Annual cost of capital',
      description:
        'Prices supplier payment terms in the landed-cost comparison. A business ' +
        'on an overdraft values ninety days far more than one sitting on cash, so ' +
        'this is a number rather than a built-in assumption.',
      valueType: 'percent',
      defaultValue: 8,
      tenantOverridable: true,
    },
  ],

  approvableEntities: ['procurement.requisition', 'procurement.purchase_order'],

  numberSeries: [
    { entityType: 'procurement.requisition', code: 'PR', pattern: 'PR-{YYYY}-{SEQ}' },
    { entityType: 'procurement.rfq', code: 'RFQ', pattern: 'RFQ-{YYYY}-{SEQ}' },
    { entityType: 'procurement.purchase_order', code: 'PO', pattern: 'PO-{YYYY}-{SEQ}' },
    { entityType: 'procurement.goods_receipt', code: 'GRN', pattern: 'GRN-{YYYY}-{SEQ}' },
    { entityType: 'procurement.supplier_invoice', code: 'SINV', pattern: 'SINV-{YYYY}-{SEQ}' },
  ],
});

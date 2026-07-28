export { procurementModule } from './manifest';

export * as procurementSchema from './db/schema';
export {
  PROCUREMENT_APPEND_ONLY_TABLES,
  PROCUREMENT_TENANT_TABLES,
  procurement,
} from './db/schema';
export {
  PROCUREMENT_RLS,
  buildProcurementGrants,
  buildProcurementRls,
} from './db/security';

export {
  DEFAULT_TOLERANCE,
  MatchError,
  checkReceipt,
  matchInvoice,
  withinTolerance,
  type ExceptionCode,
  type InvoiceLine,
  type MatchException,
  type MatchResult,
  type MatchTolerance,
  type PurchaseOrderLine,
} from './domain/matching';

export {
  ComparisonError,
  compareQuotes,
  orderQuantityFor,
  paymentTermsValue,
  type ComparisonOptions,
  type QuoteComparison,
  type QuoteInput,
} from './domain/comparison';

export {
  MODULE_KEY,
  ProcurementError,
  approveRequisition,
  awardRfq,
  compareRfqLine,
  createPurchaseOrder,
  createRequisition,
  createRfq,
  getOrderPosition,
  issuePurchaseOrder,
  linkCommitment,
  linkReceiptPostings,
  listGoodsReceipts,
  listMatchExceptions,
  listPurchaseOrders,
  listRequisitions,
  listSupplierInvoices,
  receiveGoods,
  recordQuote,
  registerInvoice,
  releaseInvoice,
  resolveTolerance,
  type CreatePurchaseOrderInput,
  type CreatePurchaseOrderResult,
  type CreateRequisitionInput,
  type CreateRfqInput,
  type IssuedOrder,
  type GoodsReceiptListRow,
  type MatchExceptionListRow,
  type OrderPosition,
  type PurchaseOrderListRow,
  type PurchaseOrderLineInput,
  type ReceiptPosting,
  type ReceiveGoodsInput,
  type ReceiveGoodsResult,
  type RecordQuoteInput,
  type RegisterInvoiceInput,
  type RegisterInvoiceResult,
  type RequisitionListRow,
  type RequisitionLineInput,
  type SupplierInvoiceListRow,
  type RfqComparison,
} from './service/purchasing';

export { RFQ_SORTS, listRfqs, type RfqListRow } from './service/rfq-register';

/**
 * Three-way matching — purchase order, goods receipt, supplier invoice.
 *
 * This is the control that stops a company paying for things it did not order,
 * did not receive, or already paid for. It is the accounts-payable equivalent of
 * the cumulative discipline in payment applications, and it fails in the same
 * ways when it is done casually:
 *
 *  1. **Everything is cumulative.** An invoice is matched against the quantity
 *     RECEIVED AND NOT YET BILLED, not against the order. Partial deliveries and
 *     partial invoices are the norm in joinery — a board order arrives over three
 *     weeks — and a per-invoice comparison against the PO quantity lets a
 *     supplier bill the full order three times without a single line looking
 *     wrong on its own.
 *
 *  2. **Under-charging is not an exception worth blocking.** A favourable
 *     variance is reported, never held: refusing to pay a supplier who charged
 *     less than agreed generates a phone call and no benefit. Unfavourable
 *     variance holds the line. That asymmetry is deliberate.
 *
 *  3. **Tolerance needs both a percentage and an absolute floor.** A 5% tolerance
 *     on a 2 AED item creates exceptions nobody can afford to read; a 5% tolerance
 *     on a 200,000 AED line forgives 10,000 AED. So a small absolute difference
 *     always passes, a proportional difference passes up to a cap, and above the
 *     cap it is an exception however small the percentage.
 */

export class MatchError extends Error {
  override readonly name = 'MatchError';
}

export interface MatchTolerance {
  /** Proportional variance allowed on unit price, e.g. 2 for 2%. */
  pricePercent: number;
  /**
   * Differences at or below this are always accepted, whatever the percentage.
   * Absorbs rounding on cheap lines rather than generating unreadable noise.
   */
  minorAmount: number;
  /**
   * Ceiling on what the percentage may forgive. Without it, a small percentage
   * of a large line is a large amount nobody looked at.
   */
  maxAmount: number;
  /** Proportional over-delivery allowed against the ordered quantity. */
  quantityPercent: number;
}

export const DEFAULT_TOLERANCE: MatchTolerance = {
  pricePercent: 2,
  minorAmount: 5,
  maxAmount: 500,
  quantityPercent: 5,
};

/**
 * Whether a variance is within tolerance.
 *
 * Exported because the same three-part rule applies to freight and duty on a
 * landed-cost line, and re-deriving it per caller is how the parts drift apart.
 */
export function withinTolerance(
  expected: number,
  actual: number,
  tolerance: MatchTolerance,
): { pass: boolean; difference: number; percent: number } {
  const difference = actual - expected;
  const magnitude = Math.abs(difference);
  const percent = expected === 0 ? (actual === 0 ? 0 : 100) : (difference / Math.abs(expected)) * 100;

  // Favourable to us: charged less than agreed. Reported by the caller, never
  // held — see the note at the top.
  if (difference < 0) return { pass: true, difference, percent };

  if (magnitude <= tolerance.minorAmount) return { pass: true, difference, percent };
  if (magnitude > tolerance.maxAmount) return { pass: false, difference, percent };

  return { pass: Math.abs(percent) <= tolerance.pricePercent, difference, percent };
}

// ---------------------------------------------------------------------------

export type ExceptionCode =
  /** Billed for more than has been received. The one that costs real money. */
  | 'over_invoiced_quantity'
  /** Billed for something with no goods receipt at all. */
  | 'no_receipt'
  /** Unit price above the ordered price, outside tolerance. */
  | 'price_variance'
  /** The line is not on the purchase order. */
  | 'unmatched_line'
  /** Received materially more than was ordered. Raised on receipt, not invoice. */
  | 'over_receipt';

export interface MatchException {
  code: ExceptionCode;
  lineReference: string;
  message: string;
  /** Money at stake. Lets a buyer triage a hundred exceptions by size. */
  amount: number;
}

export interface PurchaseOrderLine {
  /** Stable identity — the PO line id in practice. */
  reference: string;
  itemId?: string | null;
  description: string;
  quantityOrdered: number;
  unitPrice: number;
  /** Cumulative quantity received against this line, across all receipts. */
  quantityReceived: number;
  /** Cumulative quantity already invoiced, across all previously matched invoices. */
  quantityInvoiced: number;
}

export interface InvoiceLine {
  /** Which PO line this bills. Null when the supplier billed something unordered. */
  purchaseOrderLineReference: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface MatchResult {
  status: 'matched' | 'exception';
  exceptions: MatchException[];
  /** Favourable variances — reported, never blocking. */
  favourable: MatchException[];
  /** Total the invoice claims. */
  invoiceTotal: number;
  /** Total the same quantities would cost at ordered prices. */
  expectedTotal: number;
  /** invoiceTotal − expectedTotal. Positive is an overcharge. */
  variance: number;
  /** Per-line detail, so an exception can be explained rather than just flagged. */
  lines: {
    reference: string;
    quantityBilled: number;
    quantityAvailableToBill: number;
    unitPriceBilled: number;
    unitPriceOrdered: number;
    lineTotal: number;
    expectedTotal: number;
  }[];
}

/**
 * Matches one supplier invoice against a purchase order and its receipts.
 *
 * `quantityAvailableToBill` is received minus already-invoiced — the cumulative
 * figure that makes partial deliveries safe. A supplier who has delivered 40 of
 * 100 boards and already billed 40 can bill nothing more until more arrive, no
 * matter what the purchase order says.
 */
export function matchInvoice(input: {
  orderLines: PurchaseOrderLine[];
  invoiceLines: InvoiceLine[];
  tolerance?: MatchTolerance;
}): MatchResult {
  const tolerance = input.tolerance ?? DEFAULT_TOLERANCE;
  const byReference = new Map(input.orderLines.map((line) => [line.reference, line]));

  const exceptions: MatchException[] = [];
  const favourable: MatchException[] = [];
  const lines: MatchResult['lines'] = [];

  let invoiceTotal = 0;
  let expectedTotal = 0;

  for (const invoiceLine of input.invoiceLines) {
    const lineTotal = invoiceLine.quantity * invoiceLine.unitPrice;
    invoiceTotal += lineTotal;

    const orderLine = invoiceLine.purchaseOrderLineReference
      ? byReference.get(invoiceLine.purchaseOrderLineReference)
      : undefined;

    if (!orderLine) {
      exceptions.push({
        code: 'unmatched_line',
        lineReference: invoiceLine.purchaseOrderLineReference ?? invoiceLine.description,
        message: `"${invoiceLine.description}" is not on the purchase order.`,
        amount: lineTotal,
      });
      lines.push({
        reference: invoiceLine.purchaseOrderLineReference ?? invoiceLine.description,
        quantityBilled: invoiceLine.quantity,
        quantityAvailableToBill: 0,
        unitPriceBilled: invoiceLine.unitPrice,
        unitPriceOrdered: 0,
        lineTotal,
        expectedTotal: 0,
      });
      continue;
    }

    const availableToBill = orderLine.quantityReceived - orderLine.quantityInvoiced;
    const lineExpected = invoiceLine.quantity * orderLine.unitPrice;
    expectedTotal += lineExpected;

    lines.push({
      reference: orderLine.reference,
      quantityBilled: invoiceLine.quantity,
      quantityAvailableToBill: availableToBill,
      unitPriceBilled: invoiceLine.unitPrice,
      unitPriceOrdered: orderLine.unitPrice,
      lineTotal,
      expectedTotal: lineExpected,
    });

    if (orderLine.quantityReceived <= 0) {
      exceptions.push({
        code: 'no_receipt',
        lineReference: orderLine.reference,
        message: `Nothing has been received against "${orderLine.description}".`,
        amount: lineTotal,
      });
    } else if (invoiceLine.quantity > availableToBill) {
      const excess = invoiceLine.quantity - availableToBill;
      exceptions.push({
        code: 'over_invoiced_quantity',
        lineReference: orderLine.reference,
        message:
          `Billed ${invoiceLine.quantity} but only ${availableToBill} received and not yet ` +
          `billed (${orderLine.quantityReceived} received, ${orderLine.quantityInvoiced} already invoiced).`,
        amount: excess * invoiceLine.unitPrice,
      });
    }

    // Compared on LINE TOTALS, not unit prices. The percentage is identical
    // either way, but the absolute thresholds only mean anything against the
    // money actually at stake: a 5 AED floor on a unit price forgives 5 AED
    // per unit, which on a 500-unit line is 2,500 AED nobody ever sees, and the
    // hole grows with volume.
    const price = withinTolerance(lineExpected, lineTotal, tolerance);
    if (!price.pass) {
      exceptions.push({
        code: 'price_variance',
        lineReference: orderLine.reference,
        message:
          `Billed at ${invoiceLine.unitPrice} against an ordered price of ${orderLine.unitPrice} ` +
          `— ${price.difference.toFixed(2)} on the line (${price.percent.toFixed(2)}%).`,
        amount: price.difference,
      });
    } else if (price.difference < 0) {
      favourable.push({
        code: 'price_variance',
        lineReference: orderLine.reference,
        message: `Billed ${Math.abs(price.difference).toFixed(2)} below the ordered price.`,
        amount: price.difference,
      });
    }
  }

  return {
    status: exceptions.length === 0 ? 'matched' : 'exception',
    exceptions,
    favourable,
    invoiceTotal,
    expectedTotal,
    variance: invoiceTotal - expectedTotal,
    lines,
  };
}

// ---------------------------------------------------------------------------

/**
 * Checks a delivery against what was ordered.
 *
 * Separate from invoice matching because it happens at a different moment, by a
 * different person, and the response is different: an over-delivery is refused
 * at the gate or accepted as a variation, whereas an over-invoice is a query to
 * accounts. Conflating them means the storeman is asked a commercial question
 * while a lorry is waiting.
 */
export function checkReceipt(input: {
  orderLines: Pick<PurchaseOrderLine, 'reference' | 'description' | 'quantityOrdered' | 'quantityReceived' | 'unitPrice'>[];
  receiptLines: { purchaseOrderLineReference: string; quantity: number }[];
  tolerance?: MatchTolerance;
}): { exceptions: MatchException[]; overDelivered: boolean } {
  const tolerance = input.tolerance ?? DEFAULT_TOLERANCE;
  const byReference = new Map(input.orderLines.map((line) => [line.reference, line]));
  const exceptions: MatchException[] = [];

  for (const receiptLine of input.receiptLines) {
    const orderLine = byReference.get(receiptLine.purchaseOrderLineReference);
    if (!orderLine) {
      exceptions.push({
        code: 'unmatched_line',
        lineReference: receiptLine.purchaseOrderLineReference,
        message: 'Delivered item is not on the purchase order.',
        amount: 0,
      });
      continue;
    }

    const cumulative = orderLine.quantityReceived + receiptLine.quantity;
    const allowed = orderLine.quantityOrdered * (1 + tolerance.quantityPercent / 100);

    if (cumulative > allowed) {
      const excess = cumulative - orderLine.quantityOrdered;
      exceptions.push({
        code: 'over_receipt',
        lineReference: orderLine.reference,
        message:
          `Delivering ${receiptLine.quantity} takes the total to ${cumulative} against an ` +
          `order of ${orderLine.quantityOrdered}.`,
        amount: excess * orderLine.unitPrice,
      });
    }
  }

  return { exceptions, overDelivered: exceptions.some((e) => e.code === 'over_receipt') };
}

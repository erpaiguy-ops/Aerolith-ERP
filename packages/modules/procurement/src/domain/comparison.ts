/**
 * Quote comparison.
 *
 * The one thing this file exists to prevent: awarding on unit price. The
 * cheapest quote routinely is not the cheapest purchase, and the reasons are
 * mundane and consistent —
 *
 *  - **Freight and duty** are quoted separately, or not at all. Ex-works from
 *    Italy at 82 EUR/sheet is not cheaper than delivered-Dubai at 96.
 *  - **Minimum order quantities** force buying 200 sheets to get 140, and the
 *    surplus is either a real asset or a real write-off — which one depends on
 *    whether it is a stock item, so the caller says.
 *  - **Payment terms** are money. Ninety days from a supplier who charges 3%
 *    more can be cheaper than cash-on-delivery, and pretending otherwise is how
 *    a business with no working capital buys on the wrong terms.
 *  - **Lead time** is money only sometimes, so it is NOT folded into the total.
 *    It is reported beside it, because the cost of two extra weeks depends on
 *    whether the job is waiting — which this module cannot know and should not
 *    guess.
 *
 * The output ranks by landed cost and shows every component, so a buyer can
 * override with a reason rather than being told an answer.
 */

export class ComparisonError extends Error {
  override readonly name = 'ComparisonError';
}

export interface QuoteInput {
  supplierId: string;
  supplierName: string;
  currencyCode: string;
  /**
   * Rate to the tenant's base currency. 1 when already in base.
   * Passed in rather than looked up: the rate that matters is the one used for
   * the decision, and it must be recorded with the comparison to explain it later.
   */
  exchangeRate: number;

  unitPrice: number;
  /** The supplier will not sell fewer than this. */
  minimumOrderQuantity?: number;
  /** Quantity step above the minimum, e.g. full pallets of 25. */
  orderIncrement?: number;

  /** Delivery charge for the whole order, in the quote currency. */
  freight?: number;
  /** Duty as a percentage of goods value. */
  dutyPercent?: number;
  /** Anything else per order: handling, certification, packing. */
  otherCharges?: number;

  /** Days of credit offered. Zero for payment on delivery. */
  paymentTermDays?: number;
  /** Discount for paying early, e.g. 2 for "2/10 net 60". */
  earlyPaymentDiscountPercent?: number;
  earlyPaymentDays?: number;

  leadTimeDays?: number;
  /** Free text the buyer should see — warranty, origin, certification. */
  notes?: string;
}

export interface ComparisonOptions {
  /** What is actually needed. Surplus above this is bought only to meet an MOQ. */
  quantityRequired: number;
  /**
   * Whether surplus retains value.
   *
   * True for a stock item that will be used on the next job; false for a
   * one-off colour nobody will order again, where the surplus is a write-off
   * and belongs in the cost of this purchase.
   */
  surplusIsStock: boolean;
  /**
   * Annual cost of capital, used to price payment terms. Default 8%.
   *
   * A number rather than a switch because the honest answer differs by company:
   * a business on an overdraft values ninety days far more than one sitting on
   * cash, and encoding one assumption for everybody would be wrong for most.
   */
  costOfCapitalPercent?: number;
}

export interface QuoteComparison {
  supplierId: string;
  supplierName: string;

  /** What must be bought — required, or the MOQ if that is higher. */
  quantityToOrder: number;
  surplusQuantity: number;

  /** In base currency, all of these. */
  goodsValue: number;
  freight: number;
  duty: number;
  otherCharges: number;
  /**
   * What the surplus costs at the quoted price, landed. Disclosure only — it is
   * already inside `goodsValue`, because the surplus is bought and paid for
   * whether or not it is ever used. Shown so a buyer can see the size of what an
   * MOQ is forcing on them.
   */
  surplusValue: number;
  /**
   * Negative when the surplus is stock: the part of `surplusValue` that is an
   * asset rather than a cost of this purchase. Zero when the surplus is a
   * write-off, in which case the full outlay stays charged here.
   */
  surplusCredit: number;
  /** Negative — the value of the credit period. */
  paymentTermsBenefit: number;

  /**
   * The number to rank on. Exactly the sum of the components above, so a buyer
   * who adds up the column gets this figure and not one a cent away from it.
   */
  landedCost: number;
  /** Landed cost divided by the quantity actually NEEDED, not ordered. */
  effectiveUnitCost: number;

  leadTimeDays: number | null;
  /** How much dearer than the cheapest, in base currency. Zero for the winner. */
  premiumOverBest: number;
  notes?: string;
}

/**
 * Two decimals, and never negative zero.
 *
 * The `+ 0` is not decoration: most of the figures here are negative costs, and
 * a zero-day credit period produces `-0`, which `toFixed(2)` renders as
 * "-0.00" in a comparison column. Adding zero collapses it to a plain zero.
 */
const round = (value: number): number => Math.round(value * 100) / 100 + 0;

/**
 * Compares quotes on total landed cost for the quantity actually needed.
 *
 * Returned cheapest first. Ties keep input order, so a deliberate preference
 * expressed by listing an incumbent first survives an exact tie.
 */
export function compareQuotes(
  quotes: QuoteInput[],
  options: ComparisonOptions,
): QuoteComparison[] {
  if (quotes.length === 0) return [];
  if (options.quantityRequired <= 0) {
    throw new ComparisonError('Quantity required must be greater than zero.');
  }

  const costOfCapital = (options.costOfCapitalPercent ?? 8) / 100;

  const compared = quotes.map((quote): QuoteComparison => {
    if (quote.exchangeRate <= 0) {
      throw new ComparisonError(`Exchange rate for ${quote.supplierName} must be positive.`);
    }

    const quantityToOrder = orderQuantityFor(options.quantityRequired, quote);
    const surplus = quantityToOrder - options.quantityRequired;

    // `goods` is the WHOLE order, surplus included. That is what leaves the bank
    // account, and starting anywhere else means the comparison does not match
    // the invoice the supplier will send.
    const goods = quantityToOrder * quote.unitPrice;
    const dutyRate = (quote.dutyPercent ?? 0) / 100;
    const duty = goods * dutyRate;
    const freight = quote.freight ?? 0;
    const other = quote.otherCharges ?? 0;

    const beforeTerms = goods + duty + freight + other;

    // The early-payment discount is taken only when it beats the cost of the
    // capital it consumes — the arithmetic nobody does by hand, and the reason
    // "2/10 net 60" is usually worth taking and occasionally is not.
    const termsBenefit = paymentTermsValue(beforeTerms, quote, costOfCapital);

    // Surplus is only a cost when it will not be used again, so it is handled as
    // a CREDIT against the full outlay rather than a charge on top of it. Adding
    // it would bill the surplus twice — once inside `goods` and once again as a
    // write-off — and make every MOQ look roughly twice as bad as it is.
    //
    // Credited at the landed rate that scales with quantity: unit price plus
    // duty. Freight and handling are per-order and would still have been paid on
    // a smaller order, so they are not credited back.
    const surplusValue = surplus > 0 ? surplus * quote.unitPrice * (1 + dutyRate) : 0;
    const surplusCredit = options.surplusIsStock ? -surplusValue : 0;

    const rate = quote.exchangeRate;
    const toBase = (value: number): number => round(value * rate);

    // Rounded first, then summed. Rounding the total independently leaves a
    // column that does not add up to its own footer, which is the first thing a
    // buyer checks and the fastest way to lose their trust in the number.
    const components = {
      goodsValue: toBase(goods),
      freight: toBase(freight),
      duty: toBase(duty),
      otherCharges: toBase(other),
      paymentTermsBenefit: toBase(termsBenefit),
      surplusCredit: toBase(surplusCredit),
    };
    const landedCost = round(Object.values(components).reduce((total, part) => total + part, 0));

    return {
      supplierId: quote.supplierId,
      supplierName: quote.supplierName,
      quantityToOrder,
      surplusQuantity: surplus,
      ...components,
      surplusValue: toBase(surplusValue),
      landedCost,
      // Divided by what is NEEDED, not what must be ordered. Dividing by the
      // ordered quantity would make a supplier with a punitive MOQ look cheap
      // per unit on units nobody asked for.
      effectiveUnitCost: round(landedCost / options.quantityRequired),
      leadTimeDays: quote.leadTimeDays ?? null,
      premiumOverBest: 0,
      notes: quote.notes,
    };
  });

  const ranked = [...compared].sort((a, b) => a.landedCost - b.landedCost);
  const best = ranked[0]!.landedCost;

  return ranked.map((quote) => ({
    ...quote,
    premiumOverBest: round(quote.landedCost - best),
  }));
}

/**
 * How much must actually be bought.
 *
 * The minimum first, then rounded up to the next increment. Doing it the other
 * way round can land below the minimum on a supplier whose increment does not
 * divide it.
 */
export function orderQuantityFor(
  required: number,
  quote: Pick<QuoteInput, 'minimumOrderQuantity' | 'orderIncrement'>,
): number {
  let quantity = Math.max(required, quote.minimumOrderQuantity ?? 0);

  const increment = quote.orderIncrement ?? 0;
  if (increment > 0) {
    quantity = Math.ceil(quantity / increment) * increment;
  }

  return quantity;
}

/**
 * The value of a supplier's payment terms, as a negative cost.
 *
 * Credit is worth the cost of the capital it displaces. An early-payment
 * discount is worth taking only when the discount beats the interest on paying
 * sooner — a comparison that is trivial arithmetic and almost never done, which
 * is why suppliers keep offering terms that are bad for them.
 */
export function paymentTermsValue(
  amount: number,
  quote: Pick<QuoteInput, 'paymentTermDays' | 'earlyPaymentDiscountPercent' | 'earlyPaymentDays'>,
  costOfCapital: number,
): number {
  const days = quote.paymentTermDays ?? 0;

  // Two whole options, each priced from the same starting point — paying today.
  // The temptation is to price the discount RELATIVE to the credit option and
  // then subtract the credit as well, which counts the same days twice and, on
  // ordinary terms like "2/10 net 60", produces the wrong recommendation.
  const payLate = -amount * costOfCapital * (days / 365) + 0;

  const discountPercent = quote.earlyPaymentDiscountPercent ?? 0;
  if (discountPercent <= 0) return payLate;

  const earlyDays = quote.earlyPaymentDays ?? 0;
  const payEarly =
    -amount * (discountPercent / 100) - amount * costOfCapital * (earlyDays / 365);

  // Whichever the buyer would rationally choose — both are negative costs, so
  // the better one is the smaller.
  return Math.min(payLate, payEarly);
}

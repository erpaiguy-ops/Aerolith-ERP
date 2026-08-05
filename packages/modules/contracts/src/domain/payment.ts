/**
 * Interim payment application and certificate arithmetic.
 *
 * This is the module's reason to exist, and it is the calculation joinery firms
 * most often get wrong in a spreadsheet. Two properties matter above all others:
 *
 *  1. **Everything is cumulative-to-date, and the certificate is the
 *     difference.** Never "this month's work" — always "work done to date, less
 *     what was previously certified". A monthly-increment model loses money the
 *     first time a valuation is corrected downwards, because the correction has
 *     nowhere to live. Getting this wrong pays twice or not at all, and it is
 *     the single most common spreadsheet error in the trade.
 *
 *  2. **Deductions are calculated on cumulative bases, then netted the same
 *     way.** Retention is a percentage of the gross valuation to date subject to
 *     a cap on the contract sum. Computing it monthly and adding up drifts as
 *     soon as the cap bites or a valuation moves.
 *
 * The order of operations below follows FIDIC and the standard Gulf main-
 * contract forms: value the work, add materials on site, deduct retention,
 * recover advance payment, deduct contra charges, then apply tax to the net
 * amount payable. Order matters — retention is not charged on the advance
 * recovery, and tax is not charged on retention that has not been paid.
 */

export class PaymentError extends Error {
  override readonly name = 'PaymentError';
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export interface RetentionTerms {
  /** Percentage withheld from each valuation. Typically 5-10% in the Gulf. */
  percent: number;
  /**
   * Cap, as a percentage of the contract sum. Once cumulative retention reaches
   * it, no further retention is withheld — a limit that is routinely missed in
   * spreadsheets, and always in the contractor's favour to enforce.
   */
  capPercentOfContractSum?: number;
  /** Absolute cap, where the contract states an amount rather than a percentage. */
  capAmount?: number;
}

/**
 * Cumulative retention held against a gross valuation.
 *
 * `contractSum` here must include approved variations: retention caps move with
 * the contract sum, and computing the cap against the original sum under-holds
 * on a job that has grown.
 */
export function retentionHeld(
  grossValuationToDate: number,
  contractSum: number,
  terms: RetentionTerms,
): number {
  if (terms.percent < 0 || terms.percent > 100) {
    throw new PaymentError(`Retention percentage ${terms.percent} is not between 0 and 100.`);
  }

  const uncapped = grossValuationToDate * (terms.percent / 100);

  const caps: number[] = [];
  if (terms.capPercentOfContractSum !== undefined) {
    caps.push(contractSum * (terms.capPercentOfContractSum / 100));
  }
  if (terms.capAmount !== undefined) caps.push(terms.capAmount);

  return caps.length > 0 ? Math.min(uncapped, ...caps) : uncapped;
}

export interface RetentionReleaseTerms {
  /** Share released at practical completion. The Gulf norm is 50%. */
  practicalCompletionPercent: number;
  /** Share released at the end of the defects liability period. */
  endOfDlpPercent: number;
}

export interface RetentionReleaseState {
  practicalCompletionAchieved: boolean;
  defectsLiabilityExpired: boolean;
  /** Retention already released in earlier certificates. */
  previouslyReleased: number;
}

/**
 * How much retention is releasable now.
 *
 * The two halves are gated on real events, not on dates typed by an optimist:
 * practical completion has to have been certified, and the defects period has to
 * have actually expired. Releasing the second half early is giving away the only
 * leverage that gets snags fixed.
 */
export function retentionReleasable(
  totalHeld: number,
  terms: RetentionReleaseTerms,
  state: RetentionReleaseState,
): number {
  const total = terms.practicalCompletionPercent + terms.endOfDlpPercent;
  if (Math.abs(total - 100) > 0.01) {
    throw new PaymentError(
      `Retention release schedule must total 100%, got ${total.toFixed(2)}%.`,
    );
  }

  let earned = 0;
  if (state.practicalCompletionAchieved) {
    earned += totalHeld * (terms.practicalCompletionPercent / 100);
  }
  if (state.defectsLiabilityExpired) {
    earned += totalHeld * (terms.endOfDlpPercent / 100);
  }

  return Math.max(0, earned - state.previouslyReleased);
}

// ---------------------------------------------------------------------------
// Advance payment recovery
// ---------------------------------------------------------------------------

export interface AdvancePaymentTerms {
  /** Amount advanced, usually against a bank guarantee. */
  amount: number;
  /**
   * Recovery does not begin until the job has progressed this far. Gives the
   * contractor the working-capital breathing space the advance was for.
   */
  recoveryStartsAtProgressPercent?: number;
  /** Recovery completes by this point, so nothing is outstanding at the end. */
  recoveryCompleteAtProgressPercent?: number;
}

/**
 * Cumulative advance recovered by a given point of progress.
 *
 * Recovery is straight-line between the start and completion thresholds, which
 * is the common Gulf formulation ("recovered pro-rata between 10% and 90% of the
 * contract sum"). Some contracts instead recover a flat percentage of each
 * certificate; that is a different clause and would need its own function rather
 * than a flag here, because the two produce different numbers and pretending
 * otherwise inside one formula is how the wrong one gets used.
 */
export function advanceRecoveredToDate(
  grossValuationToDate: number,
  contractSum: number,
  terms: AdvancePaymentTerms,
): number {
  if (terms.amount <= 0) return 0;
  if (contractSum <= 0) return 0;

  const start = terms.recoveryStartsAtProgressPercent ?? 0;
  const finish = terms.recoveryCompleteAtProgressPercent ?? 100;

  if (finish <= start) {
    throw new PaymentError(
      'Advance recovery must complete after it starts; check the recovery thresholds.',
    );
  }

  const progress = (grossValuationToDate / contractSum) * 100;
  if (progress <= start) return 0;
  if (progress >= finish) return terms.amount;

  return terms.amount * ((progress - start) / (finish - start));
}

// ---------------------------------------------------------------------------
// The valuation
// ---------------------------------------------------------------------------

export interface ValuationInput {
  /** Contract sum INCLUDING approved variations. Drives caps and recovery. */
  contractSum: number;

  /** Cumulative value of measured work done, at contract rates. */
  workDoneToDate: number;
  /**
   * Cumulative value of approved variations executed to date. Separate from
   * `workDoneToDate` because a client's QS will always ask to see it separately,
   * and because unapproved variation work must never appear in either.
   */
  variationsToDate?: number;

  /**
   * Materials delivered but not yet installed, valued at the agreed percentage.
   * Carried at its own line because it is reversed as the material is fixed —
   * it becomes work done, and double-counting it is a classic overpayment.
   */
  materialsOnSite?: number;
  materialsOnSitePercent?: number;

  retention?: RetentionTerms;
  advance?: AdvancePaymentTerms;

  /** Retention released in this certificate, from `retentionReleasable`. */
  retentionReleased?: number;

  /**
   * Contra and back charges: the client's costs recharged to you, or in a
   * subcontract, yours recharged to the sub. Cumulative, like everything else.
   */
  backChargesToDate?: number;
  /** Liquidated damages levied to date. Cumulative. */
  liquidatedDamagesToDate?: number;

  /** What has already been certified, net of deductions, in earlier certificates. */
  previouslyCertifiedNet: number;
  /** Cumulative advance already recovered. Needed to net this period's recovery. */
  previouslyRecoveredAdvance?: number;

  /** Output VAT rate. From the country pack, not hardcoded. */
  taxPercent?: number;
  /**
   * Where the tax authority requires the contractor to account for tax on the
   * gross certified amount rather than the net paid — reverse-charge and some
   * withholding regimes. Defaults false; UAE and Qatar standard supply is tax on
   * the net amount payable.
   */
  taxOnGrossValuation?: boolean;
}

export interface Valuation {
  contractSum: number;

  workDoneToDate: number;
  variationsToDate: number;
  materialsOnSiteValued: number;
  /** Work + variations + materials. The base for retention. */
  grossValuationToDate: number;

  retentionHeldToDate: number;
  retentionReleasedThisCertificate: number;
  advanceRecoveredToDate: number;
  advanceRecoveredThisCertificate: number;
  backChargesToDate: number;
  liquidatedDamagesToDate: number;

  /** Gross less all cumulative deductions, plus retention released. */
  netValuationToDate: number;
  previouslyCertifiedNet: number;
  /** The number on the certificate, before tax. May be negative. */
  netThisCertificate: number;

  taxAmount: number;
  totalPayable: number;

  /** Percentage of the contract sum valued to date. */
  progressPercent: number;
  /** Set when the certificate is negative — a real event, worth flagging. */
  isNegativeCertificate: boolean;
}

/**
 * Values an interim payment application.
 *
 * Every figure in and out is cumulative except the two named "ThisCertificate",
 * which are always a cumulative figure minus its predecessor. That invariant is
 * what makes a downward re-measurement — a client's QS disallowing work claimed
 * last month — flow through correctly as a reduced certificate rather than
 * silently disappearing.
 */
export function valuePayment(input: ValuationInput): Valuation {
  const {
    contractSum,
    workDoneToDate,
    variationsToDate = 0,
    materialsOnSite = 0,
    materialsOnSitePercent = 100,
    backChargesToDate = 0,
    liquidatedDamagesToDate = 0,
    previouslyCertifiedNet,
    previouslyRecoveredAdvance = 0,
    retentionReleased = 0,
    taxPercent = 0,
  } = input;

  if (contractSum < 0) throw new PaymentError('Contract sum cannot be negative.');

  const materialsValued = materialsOnSite * (materialsOnSitePercent / 100);
  const gross = workDoneToDate + variationsToDate + materialsValued;

  const held = input.retention
    ? retentionHeld(gross, contractSum, input.retention)
    : 0;

  const advanceToDate = input.advance
    ? advanceRecoveredToDate(gross, contractSum, input.advance)
    : 0;

  // Recovery is monotonic: a downward re-measurement reduces progress, and
  // handing back advance the contractor already repaid would be a loan, not a
  // correction.
  const advanceThisCertificate = Math.max(0, advanceToDate - previouslyRecoveredAdvance);

  const net =
    gross -
    held +
    retentionReleased -
    advanceToDate -
    backChargesToDate -
    liquidatedDamagesToDate;

  const netThis = net - previouslyCertifiedNet;

  // Tax follows the net amount payable in the GCC VAT regimes this targets. The
  // gross basis is available because some withholding regimes require it, and
  // because getting it wrong is a penalty rather than an argument.
  const taxBase = input.taxOnGrossValuation ? gross - previouslyCertifiedNet : netThis;
  const tax = taxBase * (taxPercent / 100);

  return {
    contractSum,
    workDoneToDate,
    variationsToDate,
    materialsOnSiteValued: materialsValued,
    grossValuationToDate: gross,

    retentionHeldToDate: held,
    retentionReleasedThisCertificate: retentionReleased,
    advanceRecoveredToDate: advanceToDate,
    advanceRecoveredThisCertificate: advanceThisCertificate,
    backChargesToDate,
    liquidatedDamagesToDate,

    netValuationToDate: net,
    previouslyCertifiedNet,
    netThisCertificate: netThis,

    taxAmount: tax,
    totalPayable: netThis + tax,

    progressPercent: contractSum > 0 ? (gross / contractSum) * 100 : 0,
    isNegativeCertificate: netThis < 0,
  };
}

// ---------------------------------------------------------------------------
// Application versus certificate
// ---------------------------------------------------------------------------

export interface CertificationComparison {
  applied: number;
  certified: number;
  /** Certified minus applied. Negative is the amount disallowed. */
  difference: number;
  differencePercent: number;
  /** True when the client certified less than was applied for. */
  wasReduced: boolean;
}

/**
 * Compares what was applied for against what the client actually certified.
 *
 * This gap is the commercial heart of contract administration, and it is exactly
 * what a spreadsheet loses: once the certificate is typed over the application,
 * the disallowance is invisible and the pattern of a client who certifies 85% of
 * every application never becomes a fact anyone can act on.
 */
export function compareCertification(
  applied: number,
  certified: number,
): CertificationComparison {
  const difference = certified - applied;
  return {
    applied,
    certified,
    difference,
    differencePercent: applied !== 0 ? (difference / Math.abs(applied)) * 100 : 0,
    wasReduced: difference < 0,
  };
}

// ---------------------------------------------------------------------------
// Ageing
// ---------------------------------------------------------------------------

export interface PaymentDueInput {
  certifiedOn: Date;
  paymentTermDays: number;
  asAt?: Date;
  paidOn?: Date | null;
}

export interface PaymentDue {
  dueOn: Date;
  /** Days late. Zero when paid on time or not yet due. */
  daysOverdue: number;
  isOverdue: boolean;
  isPaid: boolean;
}

/** When a certificate falls due, and how late it is. */
export function paymentDue(input: PaymentDueInput): PaymentDue {
  const dueOn = new Date(input.certifiedOn);
  dueOn.setUTCDate(dueOn.getUTCDate() + input.paymentTermDays);

  const isPaid = input.paidOn != null;
  // A paid certificate is measured against the payment date, not today —
  // otherwise an invoice paid three days late keeps accruing overdue days
  // forever, and the ageing report becomes fiction.
  const reference = input.paidOn ?? input.asAt ?? new Date();

  const msPerDay = 24 * 60 * 60 * 1000;
  const overdueMs = reference.getTime() - dueOn.getTime();
  const daysOverdue = overdueMs > 0 ? Math.floor(overdueMs / msPerDay) : 0;

  return {
    dueOn,
    daysOverdue,
    isOverdue: daysOverdue > 0 && !isPaid,
    isPaid,
  };
}

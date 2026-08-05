/**
 * Variations — valuation, exposure, and the contract sum.
 *
 * A variation is not a status field on an order. It is a claim with a legal
 * basis, a valuation method that the contract dictates, and a life of its own
 * that routinely outlasts the work. Modelling it as a status is why joinery firms
 * build things for free.
 *
 * The number this file exists to produce is EXPOSURE: work that has been
 * instructed and executed but not yet approved for payment. Every contractor
 * knows the feeling of it; almost none can put a figure on it on any given
 * Tuesday. Making it a query is the point.
 */

export class VariationError extends Error {
  override readonly name = 'VariationError';
}

/** How the contract says a variation is to be valued. */
export type ValuationBasis =
  /** Measured at the rates already in the contract BOQ. The default. */
  | 'contract_rates'
  /** A contract rate adjusted for changed circumstances. Arguable, so evidenced. */
  | 'pro_rata'
  /** A new rate agreed because nothing comparable exists in the contract. */
  | 'star_rate'
  /** Recorded time, material and plant plus agreed percentages. */
  | 'dayworks'
  /** A quoted price for the whole change. */
  | 'lump_sum';

/**
 * The variation lifecycle.
 *
 * `instructed` before `quoted` is not an accident of ordering: on a live site the
 * instruction usually arrives first and the price is argued afterwards. A model
 * that requires a price before work can start does not describe the industry, so
 * this one records both the instruction date and the approval date and treats
 * the gap between them as the risk it is.
 */
export type VariationStatus =
  | 'identified'
  | 'instructed'
  | 'quoted'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'withdrawn';

/** Statuses in which the client has told you to proceed. */
export const INSTRUCTED_STATUSES: ReadonlySet<VariationStatus> = new Set([
  'instructed',
  'quoted',
  'submitted',
  'approved',
]);

/** Only these change the contract sum. Nothing else. Ever. */
export const APPROVED_STATUSES: ReadonlySet<VariationStatus> = new Set(['approved']);

// ---------------------------------------------------------------------------
// Dayworks
// ---------------------------------------------------------------------------

export interface DayworksSheet {
  labour: { hours: number; rate: number }[];
  materials: { quantity: number; rate: number }[];
  plant: { hours: number; rate: number }[];
  /** Uplifts the contract allows on each category. Rarely the same number. */
  labourUpliftPercent?: number;
  materialUpliftPercent?: number;
  plantUpliftPercent?: number;
}

export interface DayworksValuation {
  labourCost: number;
  materialCost: number;
  plantCost: number;
  labourUplift: number;
  materialUplift: number;
  plantUplift: number;
  total: number;
}

/**
 * Values a dayworks sheet.
 *
 * The uplifts are applied per category rather than once at the end because
 * standard forms set them separately — typically the highest on labour and the
 * lowest on materials. A single blended percentage is simpler and wrong, and the
 * error runs in the client's favour on exactly the sheets that are largest.
 */
export function valueDayworks(sheet: DayworksSheet): DayworksValuation {
  const labourCost = sheet.labour.reduce((sum, l) => sum + l.hours * l.rate, 0);
  const materialCost = sheet.materials.reduce((sum, m) => sum + m.quantity * m.rate, 0);
  const plantCost = sheet.plant.reduce((sum, p) => sum + p.hours * p.rate, 0);

  const labourUplift = labourCost * ((sheet.labourUpliftPercent ?? 0) / 100);
  const materialUplift = materialCost * ((sheet.materialUpliftPercent ?? 0) / 100);
  const plantUplift = plantCost * ((sheet.plantUpliftPercent ?? 0) / 100);

  return {
    labourCost,
    materialCost,
    plantCost,
    labourUplift,
    materialUplift,
    plantUplift,
    total:
      labourCost + materialCost + plantCost + labourUplift + materialUplift + plantUplift,
  };
}

// ---------------------------------------------------------------------------
// Variation valuation
// ---------------------------------------------------------------------------

export interface VariationLine {
  description: string;
  quantity: number;
  /** Negative for omitted work. Omissions are variations too. */
  unitRate: number;
  /** Cost side, so the margin on the change is knowable before agreeing it. */
  unitCost?: number;
}

export interface VariationValuationInput {
  basis: ValuationBasis;
  lines?: VariationLine[];
  dayworks?: DayworksSheet;
  /** For `lump_sum`, and for the cost side of a dayworks or star-rate claim. */
  lumpSumValue?: number;
  lumpSumCost?: number;
  /**
   * Overhead and profit added to a variation's cost, where the contract allows
   * it as a percentage rather than through the rates.
   */
  ohpPercent?: number;
}

export interface VariationValuation {
  basis: ValuationBasis;
  /** What is being claimed from the client. */
  value: number;
  /** What it is expected to cost. Null when the cost side is not known. */
  cost: number | null;
  ohpAmount: number;
  /** Margin on the change itself, as a share of its value. Null without a cost. */
  marginPercent: number | null;
  /** True when the net effect reduces the contract sum. */
  isOmission: boolean;
}

export function valueVariation(input: VariationValuationInput): VariationValuation {
  let value: number;
  let cost: number | null;

  switch (input.basis) {
    case 'contract_rates':
    case 'pro_rata':
    case 'star_rate': {
      const lines = input.lines ?? [];
      if (lines.length === 0) {
        throw new VariationError(`A ${input.basis} variation needs measured lines.`);
      }
      value = lines.reduce((sum, l) => sum + l.quantity * l.unitRate, 0);
      // Only meaningful if every line carries a cost — a partial cost roll-up
      // understates and would show a flattering margin on the change.
      cost = lines.every((l) => l.unitCost !== undefined)
        ? lines.reduce((sum, l) => sum + l.quantity * (l.unitCost ?? 0), 0)
        : null;
      break;
    }

    case 'dayworks': {
      if (!input.dayworks) throw new VariationError('A dayworks variation needs a sheet.');
      const sheet = valueDayworks(input.dayworks);
      value = sheet.total;
      // On dayworks the cost IS the recorded resource, before the uplifts —
      // the uplifts are the recovery, not an expense.
      cost = sheet.labourCost + sheet.materialCost + sheet.plantCost;
      break;
    }

    case 'lump_sum': {
      if (input.lumpSumValue === undefined) {
        throw new VariationError('A lump sum variation needs a value.');
      }
      value = input.lumpSumValue;
      cost = input.lumpSumCost ?? null;
      break;
    }
  }

  const ohpAmount = cost !== null ? cost * ((input.ohpPercent ?? 0) / 100) : 0;
  if (input.ohpPercent) value += ohpAmount;

  return {
    basis: input.basis,
    value,
    cost,
    ohpAmount,
    marginPercent: cost !== null && value !== 0 ? ((value - cost) / value) * 100 : null,
    isOmission: value < 0,
  };
}

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

export interface VariationRecord {
  id: string;
  reference: string;
  status: VariationStatus;
  /** Claimed value. For an approved variation, the agreed value. */
  value: number;
  cost?: number | null;
  /** How much of this variation's work has actually been done, 0-100. */
  percentExecuted?: number;
  instructedOn?: Date | null;
  approvedOn?: Date | null;
}

export interface VariationPosition {
  originalContractSum: number;
  /** Approved additions and omissions. The only thing that moves the sum. */
  approvedValue: number;
  /** Original plus approved. What the client is contractually committed to. */
  currentContractSum: number;

  /** Instructed, executed, and not yet approved — the money genuinely at risk. */
  exposureValue: number;
  /** Cost of that exposed work, where known. What has already been spent on it. */
  exposureCost: number;
  /** Claimed but not instructed. Weaker: no instruction, no obligation. */
  pendingValue: number;
  rejectedValue: number;

  counts: Record<VariationStatus, number>;
  /** Approved plus exposure. The realistic final account, not the safe one. */
  anticipatedFinalValue: number;
  /** Oldest unapproved instruction, in days. The ageing that gets ignored. */
  oldestUnapprovedDays: number | null;
}

/**
 * The whole variation position on a contract.
 *
 * Two figures are reported that most systems do not separate:
 *
 *  - `exposureValue` — instructed, executed, unapproved. You have spent the
 *    money and have an instruction to point at. Recoverable, usually, eventually.
 *  - `pendingValue` — claimed but never instructed. Much weaker.
 *
 * Reporting these as one number ("variations pending") flatters the position,
 * because the two have very different chances of ever being paid.
 *
 * Exposure is weighted by `percentExecuted`. An instruction for work not yet
 * started is a commitment, not an exposure — nothing has been spent on it — and
 * counting it as exposure inflates the figure until nobody looks at it.
 */
export function variationPosition(
  originalContractSum: number,
  variations: VariationRecord[],
  asAt: Date = new Date(),
): VariationPosition {
  const counts = {
    identified: 0,
    instructed: 0,
    quoted: 0,
    submitted: 0,
    approved: 0,
    rejected: 0,
    withdrawn: 0,
  } as Record<VariationStatus, number>;

  let approvedValue = 0;
  let exposureValue = 0;
  let exposureCost = 0;
  let pendingValue = 0;
  let rejectedValue = 0;
  let oldestUnapproved: Date | null = null;

  for (const v of variations) {
    counts[v.status] += 1;

    if (APPROVED_STATUSES.has(v.status)) {
      approvedValue += v.value;
      continue;
    }

    if (v.status === 'rejected') {
      rejectedValue += v.value;
      continue;
    }
    if (v.status === 'withdrawn') continue;

    if (INSTRUCTED_STATUSES.has(v.status)) {
      const executed = (v.percentExecuted ?? 0) / 100;
      exposureValue += v.value * executed;
      exposureCost += (v.cost ?? 0) * executed;

      if (v.instructedOn && (!oldestUnapproved || v.instructedOn < oldestUnapproved)) {
        oldestUnapproved = v.instructedOn;
      }
    } else {
      pendingValue += v.value;
    }
  }

  const msPerDay = 24 * 60 * 60 * 1000;

  return {
    originalContractSum,
    approvedValue,
    currentContractSum: originalContractSum + approvedValue,
    exposureValue,
    exposureCost,
    pendingValue,
    rejectedValue,
    counts,
    anticipatedFinalValue: originalContractSum + approvedValue + exposureValue,
    oldestUnapprovedDays: oldestUnapproved
      ? Math.max(0, Math.floor((asAt.getTime() - oldestUnapproved.getTime()) / msPerDay))
      : null,
  };
}

// ---------------------------------------------------------------------------
// Notice periods
// ---------------------------------------------------------------------------

export interface NoticeCheck {
  /** Days the contract allows between the event and a written notice. */
  noticePeriodDays: number;
  eventOn: Date;
  noticeGivenOn?: Date | null;
  asAt?: Date;
}

export interface NoticeStatus {
  deadlineOn: Date;
  daysRemaining: number;
  isGiven: boolean;
  /** Notice was required, is not given, and the deadline has passed. */
  isTimeBarred: boolean;
  /** Given, but after the deadline. Still worth claiming; weaker. */
  wasLate: boolean;
}

/**
 * Whether a variation or claim is still within its notice period.
 *
 * Time bars are the most expensive clause in construction contracts and the
 * easiest to miss: entitlement that is real and provable is extinguished because
 * nobody wrote a letter within 28 days. A system that knows the instruction date
 * can simply say so, which is worth more than most of the rest of this module.
 */
export function noticeStatus(check: NoticeCheck): NoticeStatus {
  const msPerDay = 24 * 60 * 60 * 1000;
  const deadlineOn = new Date(check.eventOn.getTime() + check.noticePeriodDays * msPerDay);
  const asAt = check.asAt ?? new Date();

  const isGiven = check.noticeGivenOn != null;
  const daysRemaining = Math.ceil((deadlineOn.getTime() - asAt.getTime()) / msPerDay);

  return {
    deadlineOn,
    daysRemaining,
    isGiven,
    isTimeBarred: !isGiven && asAt > deadlineOn,
    wasLate: isGiven && check.noticeGivenOn! > deadlineOn,
  };
}

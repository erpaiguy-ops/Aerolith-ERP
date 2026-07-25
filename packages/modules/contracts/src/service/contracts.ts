/**
 * Contract, variation and payment application lifecycle.
 *
 * The commercial terms of a contract are read from the resolved rule snapshot
 * (tenant → country → default) at creation and then SNAPSHOTTED onto the row. A
 * UAE tenant gets 10% retention, a 50/50 release, a 12-month defects period and
 * 60-day terms without configuring anything, because the country pack already
 * says so — and an admin who later changes the tenant default does not silently
 * restate a contract that has been signed and part-certified.
 */
import {
  allocateNumber,
  emit,
  loadRuleSnapshot,
  recordAudit,
  requireTenantContext,
  ruleValue,
  type Transaction,
} from '@aerolith/kernel';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import {
  backCharge,
  contract,
  contractLine,
  paymentApplication,
  paymentApplicationLine,
  retentionRelease,
  variation,
  variationLine,
} from '../db/schema';
import {
  compareCertification,
  paymentDue,
  retentionReleasable,
  valuePayment,
  type RetentionReleaseTerms,
  type ValuationInput,
  type Valuation,
} from '../domain/payment';
import {
  noticeStatus,
  valueVariation,
  variationPosition,
  type ValuationBasis,
  type VariationPosition,
  type VariationStatus,
} from '../domain/variation';

export const MODULE_KEY = 'contracts';

export class ContractsError extends Error {
  override readonly name = 'ContractsError';
}

const num = (value: string | null | undefined): number => (value == null ? 0 : Number(value));

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface CreateContractInput {
  name: string;
  side?: 'receivable' | 'payable';
  projectId?: string | null;
  counterpartyId?: string | null;
  externalReference?: string | null;
  form?: string | null;
  currencyCode?: string | null;
  /** ISO country for rule resolution. The project's country, not the tenant's. */
  countryCode: string;
  originalSum: number;
  lines?: ContractLineInput[];
  advanceAmount?: number;
  ldPerDay?: number | null;
  ldCapPercent?: number | null;
  awardedOn?: string | null;
  contractCompletionDate?: string | null;
  sourceTenderId?: string | null;
  sourceEstimateId?: string | null;
  /** Explicit overrides where the contract genuinely differs from the norm. */
  overrides?: {
    retentionPercent?: number;
    retentionCapPercent?: number;
    paymentTermDays?: number;
    defectsLiabilityMonths?: number;
    noticePeriodDays?: number;
    taxPercent?: number;
  };
}

export interface ContractLineInput {
  reference?: string | null;
  sectionName?: string | null;
  description: string;
  quantity: number;
  uomCode?: string | null;
  unitRate: number;
  kind?: string;
  sourceEstimateLineId?: string | null;
  wbsNodeId?: string | null;
}

export async function createContract(
  tx: Transaction,
  input: CreateContractInput,
): Promise<{ contractId: string; number: string; terms: Record<string, unknown> }> {
  const { tenantId, userId } = requireTenantContext();

  const snapshot = await loadRuleSnapshot(tx, { tenantId, countryCode: input.countryCode });
  const o = input.overrides ?? {};

  const retentionPercent =
    o.retentionPercent ?? ruleValue<number>(snapshot, 'contract.retention.default_percent');
  const releaseSchedule = ruleValue<{ practicalCompletion: number; endOfDlp: number }>(
    snapshot,
    'contract.retention.release_schedule',
  );
  const paymentTermDays =
    o.paymentTermDays ?? ruleValue<number>(snapshot, 'contract.payment_terms.default_days');
  const defectsLiabilityMonths =
    o.defectsLiabilityMonths ?? ruleValue<number>(snapshot, 'contract.dlp.default_months');
  const noticePeriodDays =
    o.noticePeriodDays ?? ruleValue<number>(snapshot, 'contracts.variation.notice_period_days');
  const advanceStart = ruleValue<number>(snapshot, 'contracts.advance.recovery_start_percent');
  const advanceEnd = ruleValue<number>(snapshot, 'contracts.advance.recovery_end_percent');

  const allocated = await allocateNumber(tx, { entityType: 'contracts.contract' });

  const [created] = await tx
    .insert(contract)
    .values({
      tenantId,
      number: allocated.formatted,
      numberPeriod: allocated.period,
      numberValue: allocated.value,
      projectId: input.projectId,
      counterpartyId: input.counterpartyId,
      side: input.side ?? 'receivable',
      name: input.name,
      externalReference: input.externalReference,
      form: input.form,
      currencyCode: input.currencyCode,
      originalSum: input.originalSum.toFixed(2),
      // No variations yet, so the current sum starts equal to the original.
      currentSum: input.originalSum.toFixed(2),

      retentionPercent: String(retentionPercent),
      // The retention cap defaults to the retention percentage itself, which is
      // the common Gulf formulation ("10% retention limited to 10% of the
      // contract sum") and never over-holds when the contract is silent.
      retentionCapPercent: String(o.retentionCapPercent ?? retentionPercent),
      retentionReleaseSchedule: releaseSchedule,
      paymentTermDays,
      defectsLiabilityMonths,
      noticePeriodDays,
      taxPercent: o.taxPercent == null ? null : String(o.taxPercent),

      advanceAmount: (input.advanceAmount ?? 0).toFixed(2),
      advanceRecoveryStartPercent: String(advanceStart),
      advanceRecoveryEndPercent: String(advanceEnd),
      ldPerDay: input.ldPerDay == null ? null : input.ldPerDay.toFixed(2),
      ldCapPercent: input.ldCapPercent == null ? null : String(input.ldCapPercent),

      awardedOn: input.awardedOn,
      contractCompletionDate: input.contractCompletionDate,
      sourceTenderId: input.sourceTenderId,
      sourceEstimateId: input.sourceEstimateId,
      createdBy: userId,
    })
    .returning({ id: contract.id });

  const contractId = created!.id;

  for (const [index, line] of (input.lines ?? []).entries()) {
    await tx.insert(contractLine).values({
      tenantId,
      contractId,
      lineNumber: index + 1,
      reference: line.reference,
      sectionName: line.sectionName,
      description: line.description,
      quantity: line.quantity.toFixed(4),
      uomCode: line.uomCode,
      unitRate: line.unitRate.toFixed(4),
      lineValue: (line.quantity * line.unitRate).toFixed(2),
      kind: line.kind ?? 'measured',
      sourceEstimateLineId: line.sourceEstimateLineId,
      wbsNodeId: line.wbsNodeId,
    });
  }

  const terms = {
    retentionPercent,
    retentionCapPercent: o.retentionCapPercent ?? retentionPercent,
    retentionReleaseSchedule: releaseSchedule,
    paymentTermDays,
    defectsLiabilityMonths,
    noticePeriodDays,
    advanceRecoveryStartPercent: advanceStart,
    advanceRecoveryEndPercent: advanceEnd,
  };

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'contracts.contract',
    entityId: contractId,
    entityLabel: allocated.formatted,
    action: 'create',
    metadata: { originalSum: input.originalSum, countryCode: input.countryCode, terms },
  });

  return { contractId, number: allocated.formatted, terms };
}

// ---------------------------------------------------------------------------
// Variations
// ---------------------------------------------------------------------------

export interface CreateVariationInput {
  contractId: string;
  title: string;
  description?: string | null;
  basis?: ValuationBasis;
  lines?: {
    description: string;
    quantity: number;
    uomCode?: string | null;
    unitRate: number;
    unitCost?: number | null;
    sourceContractLineId?: string | null;
    wbsNodeId?: string | null;
  }[];
  dayworks?: Record<string, unknown>;
  lumpSumValue?: number;
  lumpSumCost?: number;
  ohpPercent?: number;
  instructionReference?: string | null;
  instructedOn?: string | null;
  instructedBy?: string | null;
  instructionDocumentId?: string | null;
  eotClaimedDays?: number | null;
  /**
   * How much of the instructed work is actually built. Weights the exposure
   * figure — an instruction for work not yet started is a commitment, not money
   * already spent, and counting it as exposure inflates the number until nobody
   * looks at it.
   */
  percentExecuted?: number;
}

/**
 * Raises a variation and prices it.
 *
 * A variation with an instruction date starts life `instructed`, not
 * `identified`: the client has said proceed, so the work is exposure from that
 * moment. Recording it as merely identified until someone gets round to pricing
 * it is precisely how exposure becomes invisible.
 */
export async function createVariation(
  tx: Transaction,
  input: CreateVariationInput,
): Promise<{ variationId: string; number: string; value: number; cost: number | null }> {
  const { tenantId, userId } = requireTenantContext();

  const basis = input.basis ?? 'contract_rates';
  const valuation = valueVariation({
    basis,
    lines: input.lines?.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitRate: l.unitRate,
      unitCost: l.unitCost ?? undefined,
    })),
    dayworks: input.dayworks as never,
    lumpSumValue: input.lumpSumValue,
    lumpSumCost: input.lumpSumCost,
    ohpPercent: input.ohpPercent,
  });

  const allocated = await allocateNumber(tx, { entityType: 'contracts.variation' });

  const [created] = await tx
    .insert(variation)
    .values({
      tenantId,
      contractId: input.contractId,
      number: allocated.formatted,
      numberPeriod: allocated.period,
      numberValue: allocated.value,
      title: input.title,
      description: input.description,
      status: input.instructedOn ? 'instructed' : 'identified',
      basis,
      instructionReference: input.instructionReference,
      instructedOn: input.instructedOn,
      instructedBy: input.instructedBy,
      instructionDocumentId: input.instructionDocumentId,
      quotedValue: valuation.value.toFixed(2),
      quotedCost: valuation.cost == null ? null : valuation.cost.toFixed(2),
      eotClaimedDays: input.eotClaimedDays,
      percentExecuted: (input.percentExecuted ?? 0).toFixed(3),
      dayworks: input.dayworks ?? {},
      ohpPercent: input.ohpPercent == null ? null : String(input.ohpPercent),
      createdBy: userId,
    })
    .returning({ id: variation.id });

  const variationId = created!.id;

  for (const [index, line] of (input.lines ?? []).entries()) {
    await tx.insert(variationLine).values({
      tenantId,
      variationId,
      lineNumber: index + 1,
      description: line.description,
      quantity: line.quantity.toFixed(4),
      uomCode: line.uomCode,
      unitRate: line.unitRate.toFixed(4),
      unitCost: line.unitCost == null ? null : line.unitCost.toFixed(4),
      lineValue: (line.quantity * line.unitRate).toFixed(2),
      sourceContractLineId: line.sourceContractLineId,
      wbsNodeId: line.wbsNodeId,
    });
  }

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'contracts.variation',
    entityId: variationId,
    entityLabel: allocated.formatted,
    action: 'create',
    metadata: { basis, value: valuation.value, instructed: Boolean(input.instructedOn) },
  });

  return {
    variationId,
    number: allocated.formatted,
    value: valuation.value,
    cost: valuation.cost,
  };
}

/**
 * Records the client's approval of a variation and moves the contract sum.
 *
 * `approvedValue` is what the client agreed, which is usually not what was
 * quoted. Both are kept: a client who settles every variation at 70% of the
 * quote is a pattern that should change how the next one is priced, and it only
 * becomes visible if the quote survives the approval.
 */
export async function approveVariation(
  tx: Transaction,
  input: { variationId: string; approvedValue: number; approvedOn: string; reference?: string | null; eotGrantedDays?: number | null },
): Promise<{ contractId: string; currentSum: number; variance: number }> {
  const { tenantId } = requireTenantContext();

  const [row] = await tx
    .select()
    .from(variation)
    .where(and(eq(variation.tenantId, tenantId), eq(variation.id, input.variationId)));

  if (!row) throw new ContractsError('Variation not found.');
  if (row.status === 'approved') throw new ContractsError('Variation is already approved.');
  if (row.status === 'withdrawn' || row.status === 'rejected') {
    throw new ContractsError(`A ${row.status} variation cannot be approved.`);
  }

  await tx
    .update(variation)
    .set({
      status: 'approved',
      approvedValue: input.approvedValue.toFixed(2),
      approvedOn: input.approvedOn,
      approvedReference: input.reference,
      eotGrantedDays: input.eotGrantedDays,
      updatedAt: new Date(),
    })
    .where(and(eq(variation.tenantId, tenantId), eq(variation.id, input.variationId)));

  const currentSum = await recalculateContractSum(tx, row.contractId);

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'contracts.variation',
    entityId: input.variationId,
    entityLabel: row.number,
    action: 'approve',
    metadata: {
      quotedValue: num(row.quotedValue),
      approvedValue: input.approvedValue,
      currentSum,
    },
  });

  await emit(tx, {
    type: 'contracts.variation.approved',
    sourceModule: MODULE_KEY,
    aggregateType: 'contracts.variation',
    aggregateId: input.variationId,
    payload: {
      contractId: row.contractId,
      approvedValue: input.approvedValue,
      currentSum,
      eotGrantedDays: input.eotGrantedDays ?? 0,
    },
  });

  return {
    contractId: row.contractId,
    currentSum,
    variance: input.approvedValue - num(row.quotedValue),
  };
}

/**
 * Recomputes and stores the contract sum from approved variations only.
 *
 * Recomputed from the register rather than incremented on each approval. An
 * incremented total drifts the first time an approval is corrected, and a
 * contract sum that disagrees with the variation register is an argument nobody
 * can win.
 */
export async function recalculateContractSum(
  tx: Transaction,
  contractId: string,
): Promise<number> {
  const { tenantId } = requireTenantContext();

  const [head] = await tx
    .select({ originalSum: contract.originalSum })
    .from(contract)
    .where(and(eq(contract.tenantId, tenantId), eq(contract.id, contractId)));

  if (!head) throw new ContractsError('Contract not found.');

  const [approved] = await tx
    .select({ total: sql<string>`coalesce(sum(${variation.approvedValue}), 0)` })
    .from(variation)
    .where(
      and(
        eq(variation.tenantId, tenantId),
        eq(variation.contractId, contractId),
        eq(variation.status, 'approved'),
      ),
    );

  const currentSum = num(head.originalSum) + num(approved?.total);

  await tx
    .update(contract)
    .set({ currentSum: currentSum.toFixed(2), updatedAt: new Date() })
    .where(and(eq(contract.tenantId, tenantId), eq(contract.id, contractId)));

  return currentSum;
}

/** The variation register, with exposure separated from approved value. */
export async function getVariationPosition(
  tx: Transaction,
  input: { contractId: string; asAt?: Date },
): Promise<VariationPosition> {
  const { tenantId } = requireTenantContext();

  const [head] = await tx
    .select({ originalSum: contract.originalSum })
    .from(contract)
    .where(and(eq(contract.tenantId, tenantId), eq(contract.id, input.contractId)));

  if (!head) throw new ContractsError('Contract not found.');

  const rows = await tx
    .select()
    .from(variation)
    .where(and(eq(variation.tenantId, tenantId), eq(variation.contractId, input.contractId)))
    .orderBy(asc(variation.numberValue));

  return variationPosition(
    num(head.originalSum),
    rows.map((v) => ({
      id: v.id,
      reference: v.number ?? v.id,
      status: v.status as VariationStatus,
      // An approved variation is worth what was agreed; an unapproved one is
      // worth what is claimed. Using the quote for both would report an
      // approved variation at a price the client never accepted.
      value: v.status === 'approved' ? num(v.approvedValue) : num(v.quotedValue),
      cost: v.quotedCost == null ? null : num(v.quotedCost),
      percentExecuted: num(v.percentExecuted),
      instructedOn: v.instructedOn ? new Date(v.instructedOn) : null,
      approvedOn: v.approvedOn ? new Date(v.approvedOn) : null,
    })),
    input.asAt,
  );
}

/**
 * Variations whose notice period is running out or has run out.
 *
 * The one report in this module that pays for the module. Entitlement lost to a
 * missed 28-day notice is entitlement lost permanently, and the system already
 * knows every instruction date.
 */
export async function getNoticeExposure(
  tx: Transaction,
  input: { contractId: string; asAt?: Date; warnWithinDays?: number },
): Promise<
  { variationId: string; number: string | null; title: string; value: number; status: ReturnType<typeof noticeStatus> }[]
> {
  const { tenantId } = requireTenantContext();

  const [head] = await tx
    .select({ noticePeriodDays: contract.noticePeriodDays })
    .from(contract)
    .where(and(eq(contract.tenantId, tenantId), eq(contract.id, input.contractId)));

  if (!head) throw new ContractsError('Contract not found.');
  const noticePeriodDays = head.noticePeriodDays ?? 28;
  const warnWithin = input.warnWithinDays ?? 7;

  const rows = await tx
    .select()
    .from(variation)
    .where(
      and(
        eq(variation.tenantId, tenantId),
        eq(variation.contractId, input.contractId),
        inArray(variation.status, ['identified', 'instructed', 'quoted', 'submitted']),
      ),
    );

  return rows
    .filter((v) => v.instructedOn != null)
    .map((v) => ({
      variationId: v.id,
      number: v.number,
      title: v.title,
      value: num(v.quotedValue),
      status: noticeStatus({
        noticePeriodDays,
        eventOn: new Date(v.instructedOn!),
        noticeGivenOn: v.noticeGivenOn ? new Date(v.noticeGivenOn) : null,
        asAt: input.asAt,
      }),
    }))
    .filter((r) => r.status.isTimeBarred || (!r.status.isGiven && r.status.daysRemaining <= warnWithin))
    .sort((a, b) => a.status.daysRemaining - b.status.daysRemaining);
}

// ---------------------------------------------------------------------------
// Payment applications
// ---------------------------------------------------------------------------

export interface CreateApplicationInput {
  contractId: string;
  periodTo: string;
  periodFrom?: string | null;
  /** Cumulative value of measured contract work. Not this month's. */
  workDoneToDate: number;
  /** Cumulative value of approved variation work executed. */
  variationsToDate?: number;
  materialsOnSite?: number;
  materialsOnSitePercent?: number;
  backChargesToDate?: number;
  liquidatedDamagesToDate?: number;
  retentionReleased?: number;
  taxPercent?: number;
  countryCode?: string;
  lines?: {
    contractLineId?: string | null;
    variationId?: string | null;
    description: string;
    uomCode?: string | null;
    unitRate: number;
    quantityContract?: number | null;
    quantityToDate: number;
  }[];
  notes?: string | null;
}

export interface CreateApplicationResult {
  applicationId: string;
  number: string;
  sequence: number;
  valuation: Valuation;
}

/**
 * Prepares the next interim payment application.
 *
 * The previous application supplies `previouslyCertifiedNet` and
 * `previouslyRecoveredAdvance`. Critically it uses what was CERTIFIED, not what
 * was applied for: if the client cut last month's application, this month's
 * difference must be measured against the certificate they actually issued, or
 * the disallowance silently disappears and is never re-claimed.
 */
export async function createPaymentApplication(
  tx: Transaction,
  input: CreateApplicationInput,
): Promise<CreateApplicationResult> {
  const { tenantId, userId } = requireTenantContext();

  const [head] = await tx
    .select()
    .from(contract)
    .where(and(eq(contract.tenantId, tenantId), eq(contract.id, input.contractId)));

  if (!head) throw new ContractsError('Contract not found.');
  if (head.status === 'draft') {
    throw new ContractsError('Activate the contract before applying for payment against it.');
  }

  const previous = await tx
    .select()
    .from(paymentApplication)
    .where(
      and(
        eq(paymentApplication.tenantId, tenantId),
        eq(paymentApplication.contractId, input.contractId),
      ),
    )
    .orderBy(desc(paymentApplication.sequence))
    .limit(1);

  const last = previous[0];
  if (last && ['draft', 'pending_approval', 'submitted'].includes(last.status)) {
    throw new ContractsError(
      `Application ${last.number ?? last.sequence} is still ${last.status}. Certify or ` +
        'cancel it before raising the next one — two open applications produce two ' +
        'different cumulative positions.',
    );
  }

  const sequence = (last?.sequence ?? 0) + 1;

  // Certified where the client has certified, applied where they have not yet.
  // Falling back to the applied figure keeps a not-yet-certified application
  // from resetting the cumulative position to zero.
  const previouslyCertifiedNet = last
    ? last.certifiedNet != null
      ? num(last.certifiedNet)
      : num(last.netValuationToDate)
    : 0;

  const materialsPercent =
    input.materialsOnSitePercent ??
    (input.countryCode
      ? ruleValue<number>(
          await loadRuleSnapshot(tx, { tenantId, countryCode: input.countryCode }),
          'contracts.application.materials_on_site_percent',
        )
      : 100);

  const valuationInput: ValuationInput = {
    contractSum: num(head.currentSum),
    workDoneToDate: input.workDoneToDate,
    variationsToDate: input.variationsToDate,
    materialsOnSite: input.materialsOnSite,
    materialsOnSitePercent: materialsPercent,
    retention: head.retentionPercent
      ? {
          percent: num(head.retentionPercent),
          capPercentOfContractSum: head.retentionCapPercent
            ? num(head.retentionCapPercent)
            : undefined,
        }
      : undefined,
    advance:
      num(head.advanceAmount) > 0
        ? {
            amount: num(head.advanceAmount),
            recoveryStartsAtProgressPercent: head.advanceRecoveryStartPercent
              ? num(head.advanceRecoveryStartPercent)
              : undefined,
            recoveryCompleteAtProgressPercent: head.advanceRecoveryEndPercent
              ? num(head.advanceRecoveryEndPercent)
              : undefined,
          }
        : undefined,
    retentionReleased: input.retentionReleased,
    backChargesToDate: input.backChargesToDate,
    liquidatedDamagesToDate: input.liquidatedDamagesToDate,
    previouslyCertifiedNet,
    previouslyRecoveredAdvance: last ? num(last.advanceRecoveredToDate) : 0,
    taxPercent: input.taxPercent ?? (head.taxPercent ? num(head.taxPercent) : 0),
  };

  const valuation = valuePayment(valuationInput);
  const allocated = await allocateNumber(tx, { entityType: 'contracts.payment_application' });

  const [created] = await tx
    .insert(paymentApplication)
    .values({
      tenantId,
      contractId: input.contractId,
      number: allocated.formatted,
      numberPeriod: allocated.period,
      numberValue: allocated.value,
      sequence,
      status: 'draft',
      periodFrom: input.periodFrom,
      periodTo: input.periodTo,
      contractSumAtValuation: valuation.contractSum.toFixed(2),

      workDoneToDate: valuation.workDoneToDate.toFixed(2),
      variationsToDate: valuation.variationsToDate.toFixed(2),
      materialsOnSite: (input.materialsOnSite ?? 0).toFixed(2),
      materialsOnSitePercent: String(materialsPercent),
      grossValuationToDate: valuation.grossValuationToDate.toFixed(2),

      retentionHeldToDate: valuation.retentionHeldToDate.toFixed(2),
      retentionReleased: valuation.retentionReleasedThisCertificate.toFixed(2),
      advanceRecoveredToDate: valuation.advanceRecoveredToDate.toFixed(2),
      backChargesToDate: valuation.backChargesToDate.toFixed(2),
      liquidatedDamagesToDate: valuation.liquidatedDamagesToDate.toFixed(2),

      netValuationToDate: valuation.netValuationToDate.toFixed(2),
      previouslyCertifiedNet: valuation.previouslyCertifiedNet.toFixed(2),
      netThisApplication: valuation.netThisCertificate.toFixed(2),
      taxAmount: valuation.taxAmount.toFixed(2),
      totalApplied: valuation.totalPayable.toFixed(2),

      notes: input.notes,
      createdBy: userId,
    })
    .returning({ id: paymentApplication.id });

  const applicationId = created!.id;

  for (const line of input.lines ?? []) {
    const previousQuantity = line.contractLineId
      ? await previousCertifiedQuantity(tx, input.contractId, line.contractLineId, sequence)
      : 0;

    const valueToDate = line.quantityToDate * line.unitRate;

    await tx.insert(paymentApplicationLine).values({
      tenantId,
      applicationId,
      contractLineId: line.contractLineId,
      variationId: line.variationId,
      description: line.description,
      uomCode: line.uomCode,
      unitRate: line.unitRate.toFixed(4),
      quantityContract: line.quantityContract == null ? null : line.quantityContract.toFixed(4),
      quantityToDate: line.quantityToDate.toFixed(4),
      quantityPrevious: previousQuantity.toFixed(4),
      valueToDate: valueToDate.toFixed(2),
      valueThisPeriod: ((line.quantityToDate - previousQuantity) * line.unitRate).toFixed(2),
    });
  }

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'contracts.payment_application',
    entityId: applicationId,
    entityLabel: allocated.formatted,
    action: 'create',
    metadata: {
      sequence,
      grossValuationToDate: valuation.grossValuationToDate,
      netThisApplication: valuation.netThisCertificate,
    },
  });

  return { applicationId, number: allocated.formatted, sequence, valuation };
}

async function previousCertifiedQuantity(
  tx: Transaction,
  contractId: string,
  contractLineId: string,
  currentSequence: number,
): Promise<number> {
  const { tenantId } = requireTenantContext();

  const rows = await tx
    .select({
      quantityToDate: paymentApplicationLine.quantityToDate,
      quantityCertified: paymentApplicationLine.quantityCertified,
      sequence: paymentApplication.sequence,
    })
    .from(paymentApplicationLine)
    .innerJoin(
      paymentApplication,
      eq(paymentApplicationLine.applicationId, paymentApplication.id),
    )
    .where(
      and(
        eq(paymentApplicationLine.tenantId, tenantId),
        eq(paymentApplicationLine.contractLineId, contractLineId),
        eq(paymentApplication.contractId, contractId),
      ),
    )
    .orderBy(desc(paymentApplication.sequence));

  const previous = rows.find((r) => r.sequence < currentSequence);
  if (!previous) return 0;

  // Certified quantity where the client measured the line, applied quantity
  // otherwise — the same precedence as the header figures, for the same reason.
  return previous.quantityCertified != null
    ? num(previous.quantityCertified)
    : num(previous.quantityToDate);
}

/** Submits an application to the client and sets the due date from the terms. */
export async function submitApplication(
  tx: Transaction,
  input: { applicationId: string; submittedOn: string },
): Promise<{ number: string | null; dueOn: string }> {
  const { tenantId } = requireTenantContext();

  const [row] = await tx
    .select({
      id: paymentApplication.id,
      number: paymentApplication.number,
      status: paymentApplication.status,
      contractId: paymentApplication.contractId,
      totalApplied: paymentApplication.totalApplied,
    })
    .from(paymentApplication)
    .where(
      and(eq(paymentApplication.tenantId, tenantId), eq(paymentApplication.id, input.applicationId)),
    );

  if (!row) throw new ContractsError('Payment application not found.');
  if (row.status !== 'draft' && row.status !== 'pending_approval') {
    throw new ContractsError(`A ${row.status} application cannot be submitted.`);
  }

  const [head] = await tx
    .select({ paymentTermDays: contract.paymentTermDays })
    .from(contract)
    .where(and(eq(contract.tenantId, tenantId), eq(contract.id, row.contractId)));

  const due = new Date(input.submittedOn);
  due.setUTCDate(due.getUTCDate() + (head?.paymentTermDays ?? 30));
  const dueOn = due.toISOString().slice(0, 10);

  await tx
    .update(paymentApplication)
    .set({ status: 'submitted', submittedOn: input.submittedOn, dueOn, updatedAt: new Date() })
    .where(
      and(eq(paymentApplication.tenantId, tenantId), eq(paymentApplication.id, input.applicationId)),
    );

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'contracts.payment_application',
    entityId: input.applicationId,
    entityLabel: row.number,
    action: 'submit',
    metadata: { totalApplied: num(row.totalApplied), dueOn },
  });

  await emit(tx, {
    type: 'contracts.application.submitted',
    sourceModule: MODULE_KEY,
    aggregateType: 'contracts.payment_application',
    aggregateId: input.applicationId,
    payload: { contractId: row.contractId, totalApplied: num(row.totalApplied), dueOn },
  });

  return { number: row.number, dueOn };
}

/**
 * Records what the client actually certified.
 *
 * Kept beside the application rather than over it, so the disallowance survives.
 * The comparison is returned and emitted, because "they certified 82% of what we
 * applied for" is a fact worth acting on and it is invisible in every
 * spreadsheet-based process.
 */
export async function certifyApplication(
  tx: Transaction,
  input: {
    applicationId: string;
    certifiedNet: number;
    certifiedTax?: number;
    certifiedOn: string;
    certificateReference?: string | null;
    disallowedReason?: string | null;
  },
): Promise<{ comparison: ReturnType<typeof compareCertification>; dueOn: string | null }> {
  const { tenantId } = requireTenantContext();

  const [row] = await tx
    .select()
    .from(paymentApplication)
    .where(
      and(eq(paymentApplication.tenantId, tenantId), eq(paymentApplication.id, input.applicationId)),
    );

  if (!row) throw new ContractsError('Payment application not found.');
  if (row.status === 'paid') throw new ContractsError('A paid application cannot be re-certified.');

  const comparison = compareCertification(
    num(row.netThisApplication),
    input.certifiedNet,
  );

  if (comparison.wasReduced && !input.disallowedReason) {
    throw new ContractsError(
      'The client certified less than was applied for. Record why — an unexplained ' +
        'disallowance is one nobody re-claims.',
    );
  }

  const [head] = await tx
    .select({ paymentTermDays: contract.paymentTermDays })
    .from(contract)
    .where(and(eq(contract.tenantId, tenantId), eq(contract.id, row.contractId)));

  const due = paymentDue({
    certifiedOn: new Date(input.certifiedOn),
    paymentTermDays: head?.paymentTermDays ?? 30,
  });
  const dueOn = due.dueOn.toISOString().slice(0, 10);

  const certifiedTax = input.certifiedTax ?? 0;

  await tx
    .update(paymentApplication)
    .set({
      status: 'certified',
      certifiedNet: input.certifiedNet.toFixed(2),
      certifiedTax: certifiedTax.toFixed(2),
      certifiedTotal: (input.certifiedNet + certifiedTax).toFixed(2),
      certifiedOn: input.certifiedOn,
      certificateReference: input.certificateReference,
      disallowedReason: input.disallowedReason,
      dueOn,
      updatedAt: new Date(),
    })
    .where(
      and(eq(paymentApplication.tenantId, tenantId), eq(paymentApplication.id, input.applicationId)),
    );

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'contracts.payment_application',
    entityId: input.applicationId,
    entityLabel: row.number,
    action: 'approve',
    metadata: {
      applied: comparison.applied,
      certified: comparison.certified,
      disallowed: comparison.difference,
    },
  });

  await emit(tx, {
    type: 'contracts.application.certified',
    sourceModule: MODULE_KEY,
    aggregateType: 'contracts.payment_application',
    aggregateId: input.applicationId,
    payload: {
      contractId: row.contractId,
      applied: comparison.applied,
      certified: comparison.certified,
      difference: comparison.difference,
      dueOn,
    },
  });

  return { comparison, dueOn };
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * Schedules the retention releasable now, given the contract's state.
 *
 * Gated on real events — practical completion certified, defects period actually
 * expired — never on an optimistic date. The second half of retention is the
 * only leverage that gets a snag list finished; releasing it early is giving
 * that away for nothing.
 */
export async function scheduleRetentionRelease(
  tx: Transaction,
  input: { contractId: string; asAt?: Date },
): Promise<{ releasable: number; totalHeld: number; previouslyReleased: number; created: boolean }> {
  const { tenantId } = requireTenantContext();

  const [head] = await tx
    .select()
    .from(contract)
    .where(and(eq(contract.tenantId, tenantId), eq(contract.id, input.contractId)));

  if (!head) throw new ContractsError('Contract not found.');

  const [latest] = await tx
    .select({ retentionHeldToDate: paymentApplication.retentionHeldToDate })
    .from(paymentApplication)
    .where(
      and(
        eq(paymentApplication.tenantId, tenantId),
        eq(paymentApplication.contractId, input.contractId),
      ),
    )
    .orderBy(desc(paymentApplication.sequence))
    .limit(1);

  const totalHeld = num(latest?.retentionHeldToDate);

  const [released] = await tx
    .select({ total: sql<string>`coalesce(sum(${retentionRelease.amount}), 0)` })
    .from(retentionRelease)
    .where(
      and(
        eq(retentionRelease.tenantId, tenantId),
        eq(retentionRelease.contractId, input.contractId),
      ),
    );

  const previouslyReleased = num(released?.total);
  const asAt = input.asAt ?? new Date();
  const terms: RetentionReleaseTerms = {
    practicalCompletionPercent: head.retentionReleaseSchedule.practicalCompletion,
    endOfDlpPercent: head.retentionReleaseSchedule.endOfDlp,
  };

  const releasable = retentionReleasable(totalHeld, terms, {
    practicalCompletionAchieved: head.practicalCompletionOn != null,
    defectsLiabilityExpired:
      head.defectsLiabilityEndsOn != null && new Date(head.defectsLiabilityEndsOn) <= asAt,
    previouslyReleased,
  });

  let created = false;
  if (releasable > 0.005) {
    const trigger =
      head.defectsLiabilityEndsOn != null && new Date(head.defectsLiabilityEndsOn) <= asAt
        ? 'end_of_dlp'
        : 'practical_completion';

    await tx.insert(retentionRelease).values({
      tenantId,
      contractId: input.contractId,
      trigger,
      amount: releasable.toFixed(2),
      dueOn: asAt.toISOString().slice(0, 10),
    });
    created = true;

    await emit(tx, {
      type: 'contracts.retention.due',
      sourceModule: MODULE_KEY,
      aggregateType: 'contracts.contract',
      aggregateId: input.contractId,
      payload: { amount: releasable, trigger, totalHeld },
    });
  }

  return { releasable, totalHeld, previouslyReleased, created };
}

// ---------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------

export interface ContractPosition {
  contractId: string;
  number: string | null;
  originalSum: number;
  currentSum: number;
  variations: VariationPosition;
  grossValuedToDate: number;
  certifiedToDate: number;
  /** Applied for but not yet certified. */
  uncertified: number;
  retentionHeld: number;
  retentionReleased: number;
  advanceOutstanding: number;
  backChargesOutstanding: number;
  /** Certified, past due, unpaid. */
  overdueAmount: number;
  /** Current sum plus unapproved exposure. The realistic final account. */
  anticipatedFinalValue: number;
}

/**
 * Everything a commercial manager needs on one contract, in one call.
 *
 * `anticipatedFinalValue` is deliberately the optimistic-but-honest number:
 * approved variations plus executed-and-instructed exposure. Reporting only the
 * approved sum understates the job; reporting every claim overstates it. The
 * middle figure, with the components visible beside it, is the one that survives
 * a conversation with a client's QS.
 */
export async function getContractPosition(
  tx: Transaction,
  input: { contractId: string; asAt?: Date },
): Promise<ContractPosition> {
  const { tenantId } = requireTenantContext();
  const asAt = input.asAt ?? new Date();

  const [head] = await tx
    .select()
    .from(contract)
    .where(and(eq(contract.tenantId, tenantId), eq(contract.id, input.contractId)));

  if (!head) throw new ContractsError('Contract not found.');

  const variations = await getVariationPosition(tx, { contractId: input.contractId, asAt });

  const applications = await tx
    .select()
    .from(paymentApplication)
    .where(
      and(
        eq(paymentApplication.tenantId, tenantId),
        eq(paymentApplication.contractId, input.contractId),
      ),
    )
    .orderBy(desc(paymentApplication.sequence));

  const latest = applications[0];

  const certifiedToDate = applications
    .filter((a) => a.certifiedNet != null)
    .reduce((sum, a) => sum + num(a.certifiedNet), 0);

  const overdueAmount = applications
    .filter(
      (a) =>
        a.status === 'certified' &&
        a.paidOn == null &&
        a.dueOn != null &&
        new Date(a.dueOn) < asAt,
    )
    .reduce((sum, a) => sum + num(a.certifiedTotal), 0);

  const [released] = await tx
    .select({ total: sql<string>`coalesce(sum(${retentionRelease.amount}), 0)` })
    .from(retentionRelease)
    .where(
      and(
        eq(retentionRelease.tenantId, tenantId),
        eq(retentionRelease.contractId, input.contractId),
      ),
    );

  const [charges] = await tx
    .select({
      total: sql<string>`coalesce(sum(coalesce(${backCharge.agreedAmount}, ${backCharge.amount})), 0)`,
    })
    .from(backCharge)
    .where(
      and(
        eq(backCharge.tenantId, tenantId),
        eq(backCharge.contractId, input.contractId),
        inArray(backCharge.status, ['raised', 'notified', 'agreed', 'disputed']),
      ),
    );

  const grossValued = num(latest?.grossValuationToDate);
  const netValued = num(latest?.netValuationToDate);

  return {
    contractId: input.contractId,
    number: head.number,
    originalSum: num(head.originalSum),
    currentSum: num(head.currentSum),
    variations,
    grossValuedToDate: grossValued,
    certifiedToDate,
    uncertified: netValued - certifiedToDate,
    retentionHeld: num(latest?.retentionHeldToDate),
    retentionReleased: num(released?.total),
    advanceOutstanding: Math.max(
      0,
      num(head.advanceAmount) - num(latest?.advanceRecoveredToDate),
    ),
    backChargesOutstanding: num(charges?.total),
    overdueAmount,
    anticipatedFinalValue: variations.anticipatedFinalValue,
  };
}

/** Activates a contract, freezing its terms. Nothing may be valued before this. */
export async function activateContract(
  tx: Transaction,
  input: { contractId: string; commencedOn?: string | null },
): Promise<void> {
  const { tenantId } = requireTenantContext();

  const [row] = await tx
    .select({ status: contract.status, number: contract.number })
    .from(contract)
    .where(and(eq(contract.tenantId, tenantId), eq(contract.id, input.contractId)));

  if (!row) throw new ContractsError('Contract not found.');
  if (row.status !== 'draft') throw new ContractsError(`Contract is already ${row.status}.`);

  await tx
    .update(contract)
    .set({ status: 'active', commencedOn: input.commencedOn, updatedAt: new Date() })
    .where(and(eq(contract.tenantId, tenantId), eq(contract.id, input.contractId)));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'contracts.contract',
    entityId: input.contractId,
    entityLabel: row.number,
    action: 'update',
    metadata: { status: 'active' },
  });
}

/**
 * Records practical completion, which starts the defects period.
 *
 * The DLP end date is computed from the months snapshotted on the contract, not
 * from today's rule — the defects period a contract carries was agreed when it
 * was signed.
 */
export async function recordPracticalCompletion(
  tx: Transaction,
  input: { contractId: string; practicalCompletionOn: string },
): Promise<{ defectsLiabilityEndsOn: string }> {
  const { tenantId } = requireTenantContext();

  const [head] = await tx
    .select({ defectsLiabilityMonths: contract.defectsLiabilityMonths, number: contract.number })
    .from(contract)
    .where(and(eq(contract.tenantId, tenantId), eq(contract.id, input.contractId)));

  if (!head) throw new ContractsError('Contract not found.');

  const pc = new Date(input.practicalCompletionOn);
  const dlpEnd = new Date(pc);
  dlpEnd.setUTCMonth(dlpEnd.getUTCMonth() + (head.defectsLiabilityMonths ?? 12));
  const defectsLiabilityEndsOn = dlpEnd.toISOString().slice(0, 10);

  await tx
    .update(contract)
    .set({
      status: 'defects_liability',
      practicalCompletionOn: input.practicalCompletionOn,
      defectsLiabilityEndsOn,
      updatedAt: new Date(),
    })
    .where(and(eq(contract.tenantId, tenantId), eq(contract.id, input.contractId)));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'contracts.contract',
    entityId: input.contractId,
    entityLabel: head.number,
    action: 'update',
    metadata: { practicalCompletionOn: input.practicalCompletionOn, defectsLiabilityEndsOn },
  });

  return { defectsLiabilityEndsOn };
}

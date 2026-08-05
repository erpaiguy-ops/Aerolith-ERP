/**
 * Tender and estimate lifecycle.
 *
 * No import of Production or Projects. Winning a tender emits
 * `estimation.tender.won`; turning that into a project and work orders is
 * composed at the application layer.
 */
import {
  allocateNumber,
  emit,
  recordAudit,
  requireTenantContext,
  type Transaction,
} from '@aerolith/kernel';
import { and, asc, eq } from 'drizzle-orm';

import {
  estimate,
  estimateLine,
  estimateLineComponent,
  estimateSection,
  rateComponent,
  rateItem,
  tender,
} from '../db/schema';
import {
  calculateBuildUp,
  rollUp,
  type BuildUpComponent,
  type ComponentType,
  type EstimateLine as DomainLine,
} from '../domain/buildUp';

export const MODULE_KEY = 'estimation';

export class EstimationError extends Error {
  override readonly name = 'EstimationError';
}

// ---------------------------------------------------------------------------

export interface CreateTenderInput {
  name: string;
  clientPartyId?: string | null;
  consultantPartyId?: string | null;
  mainContractorPartyId?: string | null;
  currencyCode?: string | null;
  submissionDueAt?: string | null;
  validityDays?: number | null;
  siteAddress?: Record<string, string>;
  ownerId?: string | null;
  notes?: string | null;
}

export async function createTender(
  tx: Transaction,
  input: CreateTenderInput,
): Promise<{ tenderId: string; number: string }> {
  const { tenantId, userId } = requireTenantContext();

  const allocated = await allocateNumber(tx, { entityType: 'estimation.tender' });

  const [created] = await tx
    .insert(tender)
    .values({
      tenantId,
      number: allocated.formatted,
      numberPeriod: allocated.period,
      numberValue: allocated.value,
      name: input.name,
      clientPartyId: input.clientPartyId,
      consultantPartyId: input.consultantPartyId,
      mainContractorPartyId: input.mainContractorPartyId,
      currencyCode: input.currencyCode,
      submissionDueAt: input.submissionDueAt ? new Date(input.submissionDueAt) : null,
      validityDays: input.validityDays,
      siteAddress: input.siteAddress ?? {},
      ownerId: input.ownerId ?? userId,
      notes: input.notes,
      createdBy: userId,
    })
    .returning({ id: tender.id });

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'estimation.tender',
    entityId: created!.id,
    entityLabel: allocated.formatted,
    action: 'create',
  });

  return { tenderId: created!.id, number: allocated.formatted };
}

/**
 * Records the bid/no-bid decision.
 *
 * A decision with a reason and an author, not a status flip. Six months later
 * "why did we not bid the Marina job?" needs an answer.
 */
export async function recordBidDecision(
  tx: Transaction,
  input: { tenderId: string; decision: 'bid' | 'no_bid'; reason: string },
): Promise<void> {
  const { tenantId, userId } = requireTenantContext();

  if (!input.reason.trim()) {
    throw new EstimationError('A bid/no-bid decision needs a reason.');
  }

  const [row] = await tx
    .update(tender)
    .set({
      bidDecision: input.decision,
      bidDecisionReason: input.reason,
      bidDecidedBy: userId,
      bidDecidedAt: new Date(),
      status: input.decision === 'bid' ? 'estimating' : 'abandoned',
      updatedAt: new Date(),
    })
    .where(and(eq(tender.tenantId, tenantId), eq(tender.id, input.tenderId)))
    .returning({ id: tender.id, number: tender.number });

  if (!row) throw new EstimationError('Tender not found.');

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'estimation.tender',
    entityId: row.id,
    entityLabel: row.number,
    action: 'submit',
    reason: `${input.decision}: ${input.reason}`,
  });
}

// ---------------------------------------------------------------------------

/**
 * A build-up component as the service handles it.
 *
 * Extends the pure domain type with `itemId`. The domain arithmetic has no
 * business knowing about stock items, but the SNAPSHOT must carry it — without
 * it the estimate cannot explode into a production BOM, which is the whole
 * reason for pricing from linked build-ups rather than flat rates.
 */
export interface LineComponentInput extends BuildUpComponent {
  itemId?: string | null;
}

export interface EstimateLineInput {
  reference?: string | null;
  description: string;
  quantity: number;
  uomCode?: string | null;
  kind?: 'measured' | 'provisional_sum' | 'prime_cost' | 'dayworks' | 'preliminaries' | 'optional';
  sectionRef?: string | null;
  /** Price from the library... */
  rateItemCode?: string | null;
  /** ...or supply the build-up directly. */
  components?: LineComponentInput[];
  /** ...or just state a rate, for a provisional sum. */
  unitRate?: number;
  marginPercent?: number | null;
  notes?: string | null;
}

export interface CreateEstimateInput {
  tenderId: string;
  label: string;
  rateLibraryId?: string | null;
  overheadPercent?: number;
  marginPercent?: number;
  roundRatesTo?: number;
  sections?: { reference: string; name: string }[];
  lines: EstimateLineInput[];
}

export interface CreateEstimateResult {
  estimateId: string;
  version: number;
  linesPriced: number;
  totalValue: number;
  totalCost: number;
  marginPercent: number;
}

/**
 * Prices a BOQ into an estimate.
 *
 * Every rate and build-up is SNAPSHOTTED onto the estimate rather than
 * referenced. The library will move on; the submitted price must not. This is
 * the same reasoning as approval workflow version pinning and routing rate
 * snapshots — a pattern worth being consistent about.
 */
export async function createEstimate(
  tx: Transaction,
  input: CreateEstimateInput,
): Promise<CreateEstimateResult> {
  const { tenantId, userId } = requireTenantContext();

  const [parent] = await tx
    .select()
    .from(tender)
    .where(and(eq(tender.tenantId, tenantId), eq(tender.id, input.tenderId)))
    .limit(1);

  if (!parent) throw new EstimationError('Tender not found.');
  if (input.lines.length === 0) throw new EstimationError('An estimate needs at least one line.');

  const existing = await tx
    .select({ version: estimate.version })
    .from(estimate)
    .where(eq(estimate.tenderId, input.tenderId));
  const version = existing.reduce((max, row) => Math.max(max, row.version), 0) + 1;

  const [created] = await tx
    .insert(estimate)
    .values({
      tenantId,
      tenderId: input.tenderId,
      version,
      label: input.label,
      rateLibraryId: input.rateLibraryId,
      overheadPercent: input.overheadPercent == null ? null : String(input.overheadPercent),
      marginPercent: input.marginPercent == null ? null : String(input.marginPercent),
      createdBy: userId,
    })
    .returning({ id: estimate.id });

  const estimateId = created!.id;

  // --- Sections -----------------------------------------------------------
  const sectionIds = new Map<string, string>();
  for (const [index, section] of (input.sections ?? []).entries()) {
    const [row] = await tx
      .insert(estimateSection)
      .values({
        tenantId,
        estimateId,
        reference: section.reference,
        name: section.name,
        sortOrder: index,
      })
      .returning({ id: estimateSection.id });
    sectionIds.set(section.reference, row!.id);
  }

  // --- Lines --------------------------------------------------------------
  const domainLines: DomainLine[] = [];

  for (const [index, line] of input.lines.entries()) {
    const at = `Line ${index + 1}`;
    if (line.quantity < 0) throw new EstimationError(`${at}: quantity cannot be negative.`);

    let components: LineComponentInput[] = line.components ?? [];
    let rateItemId: string | null = null;

    // Pull the build-up from the library when a code is given.
    if (line.rateItemCode) {
      const [libraryItem] = await tx
        .select()
        .from(rateItem)
        .where(
          and(
            eq(rateItem.tenantId, tenantId),
            eq(rateItem.code, line.rateItemCode),
            input.rateLibraryId ? eq(rateItem.libraryId, input.rateLibraryId) : undefined,
          ),
        )
        .limit(1);

      if (!libraryItem) {
        throw new EstimationError(`${at}: rate "${line.rateItemCode}" is not in the library.`);
      }
      rateItemId = libraryItem.id;

      const libraryComponents = await tx
        .select()
        .from(rateComponent)
        .where(eq(rateComponent.rateItemId, libraryItem.id))
        .orderBy(asc(rateComponent.sequence));

      components = libraryComponents.map((c) => ({
        type: c.type,
        description: c.description ?? undefined,
        // Carried through deliberately — this is what makes BOM explosion work.
        itemId: c.itemId,
        quantityPerUnit: Number(c.quantityPerUnit),
        unitRate: Number(c.unitRate),
        wastagePercent: c.wastagePercent == null ? undefined : Number(c.wastagePercent),
      }));
    }

    const marginPercent = line.marginPercent ?? input.marginPercent;

    // A provisional sum with a stated rate has no build-up and no margin —
    // it is the client's money passing through.
    const isPassThrough = line.kind === 'provisional_sum' || line.kind === 'prime_cost';

    const built =
      components.length > 0
        ? calculateBuildUp(components, {
            overheadPercent: isPassThrough ? 0 : input.overheadPercent,
            ...(isPassThrough || marginPercent == null ? {} : { marginPercent }),
            ...(input.roundRatesTo ? { roundTo: input.roundRatesTo } : {}),
          })
        : null;

    const unitRate = built?.unitRate ?? line.unitRate ?? 0;
    const unitCost = built?.totalCost ?? line.unitRate ?? 0;

    const [lineRow] = await tx
      .insert(estimateLine)
      .values({
        tenantId,
        estimateId,
        sectionId: line.sectionRef ? (sectionIds.get(line.sectionRef) ?? null) : null,
        lineNumber: index + 1,
        reference: line.reference,
        description: line.description,
        quantity: String(line.quantity),
        uomCode: line.uomCode,
        kind: line.kind ?? 'measured',
        rateItemId,
        unitCost: String(unitCost),
        unitRate: String(unitRate),
        lineCost: String(round(unitCost * line.quantity, 2)),
        lineValue: String(round(unitRate * line.quantity, 2)),
        marginPercent: line.marginPercent == null ? null : String(line.marginPercent),
        notes: line.notes,
      })
      .returning({ id: estimateLine.id });

    // Snapshot the build-up so the bid can be explained years later.
    for (const [seq, component] of components.entries()) {
      await tx.insert(estimateLineComponent).values({
        tenantId,
        lineId: lineRow!.id,
        sequence: seq + 1,
        type: component.type,
        description: component.description,
        itemId: component.itemId ?? null,
        quantityPerUnit: String(component.quantityPerUnit),
        unitRate: String(component.unitRate),
        wastagePercent: component.wastagePercent == null ? null : String(component.wastagePercent),
      });
    }

    domainLines.push({
      id: lineRow!.id,
      sectionId: line.sectionRef ?? null,
      quantity: line.quantity,
      unitRate,
      totalCost: unitCost,
      isProvisional: isPassThrough,
      isOptional: line.kind === 'optional',
    });
  }

  const totals = rollUp(domainLines);

  await tx
    .update(estimate)
    .set({
      totalCost: String(totals.cost),
      totalValue: String(totals.total),
      provisionalTotal: String(totals.provisionalTotal),
      optionalTotal: String(totals.optionalTotal),
      updatedAt: new Date(),
    })
    .where(eq(estimate.id, estimateId));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'estimation.estimate',
    entityId: estimateId,
    entityLabel: `${parent.number} v${version}`,
    action: 'create',
  });

  return {
    estimateId,
    version,
    linesPriced: input.lines.length,
    totalValue: totals.total,
    totalCost: totals.cost,
    marginPercent: totals.marginPercent,
  };
}

// ---------------------------------------------------------------------------

/** Marks the scenario actually submitted to the client. */
export async function submitEstimate(
  tx: Transaction,
  input: { estimateId: string },
): Promise<{ tenderNumber: string; totalValue: number }> {
  const { tenantId } = requireTenantContext();

  const [row] = await tx
    .select({ estimate, tender })
    .from(estimate)
    .innerJoin(tender, eq(tender.id, estimate.tenderId))
    .where(and(eq(estimate.tenantId, tenantId), eq(estimate.id, input.estimateId)))
    .limit(1);

  if (!row) throw new EstimationError('Estimate not found.');
  if (row.estimate.status === 'superseded') {
    throw new EstimationError('This estimate has been superseded.');
  }

  const now = new Date();

  // Only one scenario is the submitted price; the rest become history.
  await tx
    .update(estimate)
    .set({ isSubmitted: false, status: 'superseded', updatedAt: now })
    .where(and(eq(estimate.tenderId, row.tender.id), eq(estimate.isSubmitted, true)));

  await tx
    .update(estimate)
    .set({ isSubmitted: true, status: 'approved', updatedAt: now })
    .where(eq(estimate.id, input.estimateId));

  await tx
    .update(tender)
    .set({ status: 'submitted', submittedAt: now, updatedAt: now })
    .where(eq(tender.id, row.tender.id));

  await emit(tx, {
    type: 'estimation.estimate.submitted',
    sourceModule: MODULE_KEY,
    aggregateType: 'estimation.estimate',
    aggregateId: input.estimateId,
    payload: {
      tenderId: row.tender.id,
      tenderNumber: row.tender.number,
      totalValue: Number(row.estimate.totalValue),
      version: row.estimate.version,
    },
  });

  return {
    tenderNumber: row.tender.number!,
    totalValue: Number(row.estimate.totalValue),
  };
}

/** Records the outcome. Winning emits the event that starts the job. */
export async function recordOutcome(
  tx: Transaction,
  input: {
    tenderId: string;
    outcome: 'won' | 'lost';
    outcomeValue?: number | null;
    lostToPartyId?: string | null;
    lostReason?: string | null;
    winningValue?: number | null;
  },
): Promise<{ number: string; submittedEstimateId: string | null }> {
  const { tenantId } = requireTenantContext();

  const [row] = await tx
    .select()
    .from(tender)
    .where(and(eq(tender.tenantId, tenantId), eq(tender.id, input.tenderId)))
    .limit(1);

  if (!row) throw new EstimationError('Tender not found.');
  if (row.status === 'won' || row.status === 'lost') {
    throw new EstimationError(`This tender is already recorded as ${row.status}.`);
  }

  const [submitted] = await tx
    .select({ id: estimate.id, totalValue: estimate.totalValue })
    .from(estimate)
    .where(and(eq(estimate.tenderId, row.id), eq(estimate.isSubmitted, true)))
    .limit(1);

  await tx
    .update(tender)
    .set({
      status: input.outcome,
      outcomeValue:
        input.outcomeValue == null
          ? (submitted?.totalValue ?? null)
          : String(input.outcomeValue),
      lostToPartyId: input.lostToPartyId,
      lostReason: input.lostReason,
      winningValue: input.winningValue == null ? null : String(input.winningValue),
      updatedAt: new Date(),
    })
    .where(eq(tender.id, row.id));

  await emit(tx, {
    type: input.outcome === 'won' ? 'estimation.tender.won' : 'estimation.tender.lost',
    sourceModule: MODULE_KEY,
    aggregateType: 'estimation.tender',
    aggregateId: row.id,
    payload: {
      number: row.number,
      name: row.name,
      clientPartyId: row.clientPartyId,
      currencyCode: row.currencyCode,
      estimateId: submitted?.id ?? null,
      value: input.outcomeValue ?? (submitted ? Number(submitted.totalValue) : null),
      lostReason: input.lostReason ?? null,
      winningValue: input.winningValue ?? null,
    },
  });

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'estimation.tender',
    entityId: row.id,
    entityLabel: row.number,
    action: input.outcome === 'won' ? 'approve' : 'reject',
    reason: input.lostReason ?? undefined,
  });

  return { number: row.number!, submittedEstimateId: submitted?.id ?? null };
}

/**
 * The priced build-ups of a won estimate, ready to become a production BOM.
 *
 * Returns data rather than creating work orders: Production is a soft
 * integration, and the application layer decides whether it is installed.
 */
export async function getEstimateBillOfMaterials(tx: Transaction, estimateId: string) {
  const { tenantId } = requireTenantContext();

  const rows = await tx
    .select({ line: estimateLine, component: estimateLineComponent })
    .from(estimateLine)
    .leftJoin(estimateLineComponent, eq(estimateLineComponent.lineId, estimateLine.id))
    .where(and(eq(estimateLine.tenantId, tenantId), eq(estimateLine.estimateId, estimateId)))
    .orderBy(asc(estimateLine.lineNumber), asc(estimateLineComponent.sequence));

  const byLine = new Map<
    string,
    { line: typeof estimateLine.$inferSelect; components: (typeof estimateLineComponent.$inferSelect)[] }
  >();

  for (const row of rows) {
    const entry = byLine.get(row.line.id) ?? { line: row.line, components: [] };
    if (row.component) entry.components.push(row.component);
    byLine.set(row.line.id, entry);
  }

  // Material demand across the whole estimate, for procurement and planning.
  const materialDemand = new Map<string, number>();
  for (const { line, components } of byLine.values()) {
    for (const component of components) {
      if (!component.itemId || component.type !== 'material') continue;
      const wastage = 1 + Number(component.wastagePercent ?? 0) / 100;
      const quantity = Number(component.quantityPerUnit) * Number(line.quantity) * wastage;
      materialDemand.set(component.itemId, (materialDemand.get(component.itemId) ?? 0) + quantity);
    }
  }

  return {
    lines: [...byLine.values()],
    materialDemand: [...materialDemand.entries()].map(([itemId, quantity]) => ({
      itemId,
      quantity: round(quantity, 4),
    })),
  };
}

// ---------------------------------------------------------------------------
// Rate library
// ---------------------------------------------------------------------------

/** Recomputes the cached `directCost`/`unitRate` from a rate's live components. */
async function refreshRateItemCache(
  tx: Transaction,
  input: { rateItemId: string; overheadPercent: number | null; marginPercent: number | null },
): Promise<void> {
  const components = await tx
    .select()
    .from(rateComponent)
    .where(eq(rateComponent.rateItemId, input.rateItemId))
    .orderBy(asc(rateComponent.sequence));

  const built = calculateBuildUp(
    components.map((c) => ({
      type: c.type,
      description: c.description ?? undefined,
      quantityPerUnit: Number(c.quantityPerUnit),
      unitRate: Number(c.unitRate),
      wastagePercent: c.wastagePercent == null ? undefined : Number(c.wastagePercent),
    })),
    {
      overheadPercent: input.overheadPercent ?? undefined,
      marginPercent: input.marginPercent ?? undefined,
    },
  );

  // Not load-bearing — `getRateDetail` and `createEstimate` both recompute from
  // the live components rather than trust this column. Kept in sync anyway,
  // because it is the one place a rate with zero components still needs a
  // number to fall back on.
  await tx
    .update(rateItem)
    .set({
      directCost: String(built.directCost),
      unitRate: String(built.unitRate),
      updatedAt: new Date(),
    })
    .where(eq(rateItem.id, input.rateItemId));
}

export interface UpdateRateItemInput {
  description?: string;
  uomCode?: string | null;
  category?: string | null;
  overheadPercent?: number | null;
  marginPercent?: number | null;
}

/**
 * Edits a rate's header — description, unit, category, overhead and margin.
 *
 * Does not touch anything already priced from this rate: `createEstimate`
 * snapshots cost and rate onto the estimate line the moment it is created, so
 * an edit here changes the basis of the NEXT tender priced from this rate, and
 * nothing about the last one.
 */
export async function updateRateItem(
  tx: Transaction,
  input: { rateItemId: string } & UpdateRateItemInput,
): Promise<void> {
  const { tenantId } = requireTenantContext();

  const [existing] = await tx
    .select()
    .from(rateItem)
    .where(and(eq(rateItem.tenantId, tenantId), eq(rateItem.id, input.rateItemId)));
  if (!existing) throw new EstimationError('Rate not found.');

  const overheadPercent =
    input.overheadPercent !== undefined ? input.overheadPercent : numOrNull(existing.overheadPercent);
  const marginPercent =
    input.marginPercent !== undefined ? input.marginPercent : numOrNull(existing.marginPercent);

  await tx
    .update(rateItem)
    .set({
      description: input.description ?? existing.description,
      uomCode: input.uomCode !== undefined ? input.uomCode : existing.uomCode,
      category: input.category !== undefined ? input.category : existing.category,
      overheadPercent: overheadPercent == null ? null : String(overheadPercent),
      marginPercent: marginPercent == null ? null : String(marginPercent),
      updatedAt: new Date(),
    })
    .where(eq(rateItem.id, input.rateItemId));

  await refreshRateItemCache(tx, { rateItemId: input.rateItemId, overheadPercent, marginPercent });

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'estimation.rate_item',
    entityId: input.rateItemId,
    entityLabel: existing.code,
    action: 'update',
  });
}

export interface RateComponentInput {
  type: ComponentType;
  description?: string | null;
  itemId?: string | null;
  quantityPerUnit: number;
  unitRate: number;
  wastagePercent?: number | null;
}

/**
 * Replaces a rate's entire build-up in one transaction — the save behind a
 * spreadsheet-style grid, where the client holds every row and submits the
 * whole sheet rather than one cell at a time.
 *
 * Sequence is assigned from array order, so reordering rows in the grid and
 * saving is how a component's position changes; there is no separate "move"
 * operation.
 */
export async function replaceRateComponents(
  tx: Transaction,
  input: { rateItemId: string; components: RateComponentInput[] },
): Promise<void> {
  const { tenantId } = requireTenantContext();

  const [existing] = await tx
    .select()
    .from(rateItem)
    .where(and(eq(rateItem.tenantId, tenantId), eq(rateItem.id, input.rateItemId)));
  if (!existing) throw new EstimationError('Rate not found.');

  if (input.components.length === 0) {
    throw new EstimationError(
      'A rate needs at least one component — an empty build-up prices nothing.',
    );
  }

  await tx
    .delete(rateComponent)
    .where(and(eq(rateComponent.tenantId, tenantId), eq(rateComponent.rateItemId, input.rateItemId)));

  await tx.insert(rateComponent).values(
    input.components.map((c, index) => ({
      tenantId,
      rateItemId: input.rateItemId,
      sequence: index + 1,
      type: c.type,
      description: c.description ?? null,
      itemId: c.itemId ?? null,
      quantityPerUnit: String(c.quantityPerUnit),
      unitRate: String(c.unitRate),
      wastagePercent: c.wastagePercent == null ? null : String(c.wastagePercent),
    })),
  );

  await refreshRateItemCache(tx, {
    rateItemId: input.rateItemId,
    overheadPercent: numOrNull(existing.overheadPercent),
    marginPercent: numOrNull(existing.marginPercent),
  });

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'estimation.rate_item',
    entityId: input.rateItemId,
    entityLabel: existing.code,
    action: 'update',
  });
}

function numOrNull(value: string | null): number | null {
  return value == null ? null : Number(value);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

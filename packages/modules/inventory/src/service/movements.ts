/**
 * Posting stock movements.
 *
 * Posting is the only way stock changes. It is atomic: quantities, costs,
 * offcuts, the document number and the outbox event all commit together or none
 * of them do. That is the property that keeps the stock ledger reconcilable.
 *
 * Note what this module does NOT do: it never calls Procurement or Accounts. It
 * emits events and lets them listen, so Inventory works standalone.
 */
import {
  allocateNumber,
  emit,
  recordAudit,
  requireTenantContext,
  type Transaction,
} from '@aerolith/kernel';
import { and, eq, isNull, sql } from 'drizzle-orm';

import {
  applyAdjustment,
  applyIssue,
  applyReceipt,
  toNumber,
  toNumeric,
  type StockPosition,
} from '../domain/costing';
import { areaSqm, isUsableOffcut, offcutCost, type UsabilityRule } from '../domain/offcuts';
import {
  batch as batchTable,
  offcut,
  reorderRule,
  stockLevel,
  stockMovement,
  stockMovementLine,
  warehouse,
} from '../db/schema';

export const MODULE_KEY = 'inventory';

export interface MovementLineInput {
  itemId: string;
  quantity: number;
  stockQuantity?: number;
  uomId?: string | null;
  batchId?: string | null;
  fromWarehouseId?: string | null;
  fromBinId?: string | null;
  toWarehouseId?: string | null;
  toBinId?: string | null;
  unitCost?: number | null;
  offcutId?: string | null;
  notes?: string | null;
  /**
   * Usable remnants produced by this line. Registered as offcuts, costed from
   * the parent sheet by area.
   */
  offcutsProduced?: {
    lengthMm: number;
    widthMm: number;
    thicknessMm?: number | null;
    grainDirection?: 'length' | 'width' | null;
    grainCode?: string | null;
    colourCode?: string | null;
    finishedEdges?: number;
    barcode?: string;
  }[];
  /** Parent sheet dimensions, needed to cost the remnants above. */
  parentSheet?: { lengthMm: number; widthMm: number };
}

export interface CreateMovementInput {
  type: 'receipt' | 'issue' | 'transfer' | 'adjustment' | 'return' | 'scrap' | 'production_output';
  movementDate?: string;
  projectId?: string | null;
  partyId?: string | null;
  costCodeId?: string | null;
  sourceModule?: string | null;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
  reference?: string | null;
  notes?: string | null;
  lines: MovementLineInput[];
}

export interface PostMovementResult {
  movementId: string;
  number: string;
  linesPosted: number;
  offcutsCreated: number;
  reorderTriggered: { itemId: string; warehouseId: string; available: number; minimum: number }[];
}

export class InvalidMovementError extends Error {
  override readonly name = 'InvalidMovementError';
}

/**
 * Which direction each movement type moves stock. Keeping this as data rather
 * than a switch scattered through the code means a new movement type is one
 * line, not an audit of every branch.
 */
const DIRECTION: Record<
  CreateMovementInput['type'],
  { takesFrom: boolean; putsTo: boolean; isCostSource: boolean }
> = {
  receipt: { takesFrom: false, putsTo: true, isCostSource: true },
  issue: { takesFrom: true, putsTo: false, isCostSource: false },
  transfer: { takesFrom: true, putsTo: true, isCostSource: false },
  adjustment: { takesFrom: false, putsTo: false, isCostSource: false },
  return: { takesFrom: false, putsTo: true, isCostSource: false },
  scrap: { takesFrom: true, putsTo: false, isCostSource: false },
  production_output: { takesFrom: false, putsTo: true, isCostSource: true },
};

export async function postMovement(
  tx: Transaction,
  input: CreateMovementInput,
  options: { allowNegative?: boolean; offcutRule?: UsabilityRule } = {},
): Promise<PostMovementResult> {
  const { tenantId, userId } = requireTenantContext();
  const direction = DIRECTION[input.type];

  if (input.lines.length === 0) {
    throw new InvalidMovementError('A movement must have at least one line.');
  }

  validateLines(input, direction);
  await assertWarehousesUsable(tx, tenantId, input, direction);

  const movementDate = input.movementDate ?? new Date().toISOString().slice(0, 10);

  const allocated = await allocateNumber(tx, {
    entityType: `inventory.${input.type}`,
    documentDate: new Date(movementDate),
  });

  const [movement] = await tx
    .insert(stockMovement)
    .values({
      tenantId,
      number: allocated.formatted,
      numberPeriod: allocated.period,
      numberValue: allocated.value,
      type: input.type,
      status: 'posted',
      movementDate,
      projectId: input.projectId,
      partyId: input.partyId,
      costCodeId: input.costCodeId,
      sourceModule: input.sourceModule,
      sourceEntityType: input.sourceEntityType,
      sourceEntityId: input.sourceEntityId,
      reference: input.reference,
      notes: input.notes,
      postedAt: new Date(),
      postedBy: userId,
      createdBy: userId,
    })
    .returning({ id: stockMovement.id });

  const movementId = movement!.id;
  let offcutsCreated = 0;
  const touched: { itemId: string; warehouseId: string }[] = [];

  for (const [index, line] of input.lines.entries()) {
    const stockQuantity = line.stockQuantity ?? line.quantity;
    // An adjustment SETS an absolute quantity rather than moving one, and zero
    // is a real shelf, not a meaningless line — a count that finds nothing
    // left must be able to write the book down to zero. Every other type
    // moves a positive amount by definition; there is no such thing as
    // issuing zero units.
    const zeroIsValid = input.type === 'adjustment' && stockQuantity === 0;
    if (stockQuantity < 0 || (stockQuantity === 0 && !zeroIsValid)) {
      throw new InvalidMovementError(`Line ${index + 1}: quantity must be positive.`);
    }

    let unitCost = line.unitCost ?? null;

    // --- Take stock out -------------------------------------------------
    if (direction.takesFrom) {
      const from = await lockLevel(tx, {
        tenantId,
        itemId: line.itemId,
        warehouseId: line.fromWarehouseId!,
        binId: line.fromBinId ?? null,
        batchId: line.batchId ?? null,
      });

      const result = applyIssue(from.position, stockQuantity, {
        allowNegative: options.allowNegative,
      });

      // An issue is valued at the cost it leaves at, not at a cost the caller
      // supplies — otherwise a job could be charged whatever it liked.
      unitCost = from.position.averageCost;

      await writeLevel(tx, from.id, result.position);
      touched.push({ itemId: line.itemId, warehouseId: line.fromWarehouseId! });
    }

    // --- Put stock in ---------------------------------------------------
    if (direction.putsTo) {
      const to = await lockLevel(tx, {
        tenantId,
        itemId: line.itemId,
        warehouseId: line.toWarehouseId!,
        binId: line.toBinId ?? null,
        batchId: line.batchId ?? null,
      });

      const cost = direction.isCostSource ? (line.unitCost ?? 0) : (unitCost ?? 0);
      const result = applyReceipt(to.position, { quantity: stockQuantity, unitCost: cost });

      unitCost = direction.isCostSource ? cost : unitCost;
      await writeLevel(tx, to.id, result);
      touched.push({ itemId: line.itemId, warehouseId: line.toWarehouseId! });
    }

    // --- Adjustment sets an absolute quantity ---------------------------
    if (input.type === 'adjustment') {
      const level = await lockLevel(tx, {
        tenantId,
        itemId: line.itemId,
        warehouseId: line.toWarehouseId ?? line.fromWarehouseId!,
        binId: line.toBinId ?? line.fromBinId ?? null,
        batchId: line.batchId ?? null,
      });

      const result = applyAdjustment(level.position, stockQuantity);
      unitCost = level.position.averageCost;
      await writeLevel(tx, level.id, result.position);
      touched.push({
        itemId: line.itemId,
        warehouseId: line.toWarehouseId ?? line.fromWarehouseId!,
      });
    }

    await tx.insert(stockMovementLine).values({
      tenantId,
      movementId,
      lineNumber: index + 1,
      itemId: line.itemId,
      batchId: line.batchId,
      fromWarehouseId: line.fromWarehouseId,
      fromBinId: line.fromBinId,
      toWarehouseId: line.toWarehouseId,
      toBinId: line.toBinId,
      quantity: toNumeric(line.quantity),
      uomId: line.uomId,
      stockQuantity: toNumeric(stockQuantity),
      unitCost: unitCost === null ? null : toNumeric(unitCost, 6),
      totalCost: unitCost === null ? null : toNumeric(unitCost * stockQuantity),
      offcutId: line.offcutId,
      notes: line.notes,
    });

    // --- Offcuts produced by this line ----------------------------------
    if (line.offcutsProduced?.length) {
      offcutsCreated += await registerOffcuts(tx, {
        tenantId,
        movementId,
        line,
        parentUnitCost: unitCost ?? 0,
        warehouseId: line.fromWarehouseId ?? line.toWarehouseId!,
        binId: line.fromBinId ?? line.toBinId ?? null,
        projectId: input.projectId ?? null,
        rule: options.offcutRule,
      });
    }

    // Consuming an offcut retires it.
    if (line.offcutId) {
      await tx
        .update(offcut)
        .set({
          status: 'consumed',
          consumedByMovementId: movementId,
          consumedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(offcut.tenantId, tenantId), eq(offcut.id, line.offcutId)));
    }
  }

  const reorderTriggered = await checkReorderLevels(tx, tenantId, touched);

  await emit(tx, {
    type: 'inventory.stock_movement.posted',
    sourceModule: MODULE_KEY,
    aggregateType: 'inventory.stock_movement',
    aggregateId: movementId,
    payload: {
      movementType: input.type,
      number: allocated.formatted,
      movementDate,
      projectId: input.projectId ?? null,
      costCodeId: input.costCodeId ?? null,
      lineCount: input.lines.length,
      sourceModule: input.sourceModule ?? null,
      sourceEntityId: input.sourceEntityId ?? null,
    },
  });

  for (const trigger of reorderTriggered) {
    await emit(tx, {
      type: 'inventory.stock_level.below_reorder',
      sourceModule: MODULE_KEY,
      aggregateType: 'inventory.stock_level',
      aggregateId: movementId,
      payload: trigger,
    });
  }

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'inventory.stock_movement',
    entityId: movementId,
    entityLabel: allocated.formatted,
    action: 'post',
  });

  return {
    movementId,
    number: allocated.formatted,
    linesPosted: input.lines.length,
    offcutsCreated,
    reorderTriggered,
  };
}

// ---------------------------------------------------------------------------

function validateLines(
  input: CreateMovementInput,
  direction: (typeof DIRECTION)[keyof typeof DIRECTION],
): void {
  input.lines.forEach((line, index) => {
    const at = `Line ${index + 1}`;
    if (direction.takesFrom && !line.fromWarehouseId) {
      throw new InvalidMovementError(`${at}: a ${input.type} needs a source warehouse.`);
    }
    if (direction.putsTo && !line.toWarehouseId) {
      throw new InvalidMovementError(`${at}: a ${input.type} needs a destination warehouse.`);
    }
    if (
      input.type === 'transfer' &&
      line.fromWarehouseId === line.toWarehouseId &&
      (line.fromBinId ?? null) === (line.toBinId ?? null)
    ) {
      throw new InvalidMovementError(`${at}: source and destination are the same.`);
    }
    if (input.type === 'adjustment' && !line.toWarehouseId && !line.fromWarehouseId) {
      throw new InvalidMovementError(`${at}: an adjustment needs a warehouse.`);
    }
    if (direction.isCostSource && (line.unitCost === null || line.unitCost === undefined)) {
      throw new InvalidMovementError(`${at}: a ${input.type} needs a unit cost.`);
    }
  });
}

/**
 * Rejects issues from a warehouse that has been closed for issuing.
 *
 * Checked before anything is written, so a demobilised site cannot have material
 * booked out of it by a stale mobile client.
 */
async function assertWarehousesUsable(
  tx: Transaction,
  tenantId: string,
  input: CreateMovementInput,
  direction: (typeof DIRECTION)[keyof typeof DIRECTION],
): Promise<void> {
  if (!direction.takesFrom) return;

  const sources = [...new Set(input.lines.map((l) => l.fromWarehouseId).filter(Boolean))];

  for (const warehouseId of sources) {
    const [row] = await tx
      .select({ code: warehouse.code, blocked: warehouse.isIssueBlocked, active: warehouse.isActive })
      .from(warehouse)
      .where(and(eq(warehouse.tenantId, tenantId), eq(warehouse.id, warehouseId!)))
      .limit(1);

    if (!row) throw new InvalidMovementError('Source warehouse does not exist.');
    if (!row.active) throw new InvalidMovementError(`Warehouse ${row.code} is inactive.`);
    if (row.blocked) throw new InvalidMovementError(`Warehouse ${row.code} is closed for issues.`);
  }
}

/**
 * Finds or creates the stock level row and locks it.
 *
 * The lock is what makes concurrent movements on the same item safe: two issues
 * racing without it both read the same quantity and both succeed, taking the
 * stock negative.
 */
async function lockLevel(
  tx: Transaction,
  key: {
    tenantId: string;
    itemId: string;
    warehouseId: string;
    binId: string | null;
    batchId: string | null;
  },
): Promise<{ id: string; position: StockPosition }> {
  const where = and(
    eq(stockLevel.tenantId, key.tenantId),
    eq(stockLevel.itemId, key.itemId),
    eq(stockLevel.warehouseId, key.warehouseId),
    key.binId ? eq(stockLevel.binId, key.binId) : isNull(stockLevel.binId),
    key.batchId ? eq(stockLevel.batchId, key.batchId) : isNull(stockLevel.batchId),
  );

  const [existing] = await tx.select().from(stockLevel).where(where).limit(1).for('update');

  if (existing) {
    return {
      id: existing.id,
      position: {
        quantity: toNumber(existing.quantity),
        averageCost: toNumber(existing.averageCost),
      },
    };
  }

  // No row yet. onConflictDoNothing plus a re-read handles the race where two
  // transactions create the same slot at once.
  const inserted = await tx
    .insert(stockLevel)
    .values({
      tenantId: key.tenantId,
      itemId: key.itemId,
      warehouseId: key.warehouseId,
      binId: key.binId,
      batchId: key.batchId,
    })
    .onConflictDoNothing()
    .returning({ id: stockLevel.id });

  if (inserted[0]) {
    return { id: inserted[0].id, position: { quantity: 0, averageCost: 0 } };
  }

  const [raced] = await tx.select().from(stockLevel).where(where).limit(1).for('update');
  if (!raced) throw new Error('Failed to create or find the stock level row.');

  return {
    id: raced.id,
    position: { quantity: toNumber(raced.quantity), averageCost: toNumber(raced.averageCost) },
  };
}

async function writeLevel(
  tx: Transaction,
  id: string,
  position: StockPosition,
): Promise<void> {
  await tx
    .update(stockLevel)
    .set({
      quantity: toNumeric(position.quantity),
      averageCost: toNumeric(position.averageCost, 6),
      lastMovementAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(stockLevel.id, id));
}

/**
 * Registers the usable remnants a cut produced.
 *
 * Remnants below the usability threshold are silently dropped rather than
 * stored: filling the rack with slivers nobody will cut is worse than throwing
 * them away, and the threshold is tenant-configurable.
 */
async function registerOffcuts(
  tx: Transaction,
  args: {
    tenantId: string;
    movementId: string;
    line: MovementLineInput;
    parentUnitCost: number;
    warehouseId: string;
    binId: string | null;
    projectId: string | null;
    rule?: UsabilityRule;
  },
): Promise<number> {
  const parentSheet = args.line.parentSheet;
  let created = 0;

  for (const remnant of args.line.offcutsProduced ?? []) {
    if (!isUsableOffcut(remnant, args.rule)) continue;

    const unitCost = parentSheet
      ? offcutCost(parentSheet, args.parentUnitCost, remnant)
      : args.parentUnitCost * areaSqm(remnant);

    await tx.insert(offcut).values({
      tenantId: args.tenantId,
      itemId: args.line.itemId,
      batchId: args.line.batchId ?? null,
      barcode: remnant.barcode ?? `OC-${crypto.randomUUID().slice(0, 12).toUpperCase()}`,
      lengthMm: toNumeric(remnant.lengthMm, 2),
      widthMm: toNumeric(remnant.widthMm, 2),
      thicknessMm: remnant.thicknessMm == null ? null : toNumeric(remnant.thicknessMm, 2),
      grainDirection: remnant.grainDirection ?? null,
      grainCode: remnant.grainCode ?? null,
      colourCode: remnant.colourCode ?? null,
      finishedEdges: remnant.finishedEdges ?? 0,
      warehouseId: args.warehouseId,
      binId: args.binId,
      status: 'available',
      unitCost: toNumeric(unitCost, 6),
      sourceMovementId: args.movementId,
      sourceProjectId: args.projectId,
    });
    created += 1;
  }

  return created;
}

/**
 * Reports items that have fallen below their reorder level.
 *
 * Only reports — raising a requisition is Procurement's job, and Inventory must
 * work when Procurement is not installed.
 */
async function checkReorderLevels(
  tx: Transaction,
  tenantId: string,
  touched: { itemId: string; warehouseId: string }[],
): Promise<{ itemId: string; warehouseId: string; available: number; minimum: number }[]> {
  const triggered: {
    itemId: string;
    warehouseId: string;
    available: number;
    minimum: number;
  }[] = [];

  const unique = new Map(touched.map((t) => [`${t.itemId}:${t.warehouseId}`, t]));

  for (const { itemId, warehouseId } of unique.values()) {
    const [rule] = await tx
      .select()
      .from(reorderRule)
      .where(
        and(
          eq(reorderRule.tenantId, tenantId),
          eq(reorderRule.itemId, itemId),
          eq(reorderRule.warehouseId, warehouseId),
          eq(reorderRule.isActive, true),
        ),
      )
      .limit(1);

    if (!rule) continue;

    // Sum across every bin and batch in the warehouse — the reorder decision is
    // about the warehouse, not one shelf.
    const [total] = await tx
      .select({ available: sql<string>`coalesce(sum(${stockLevel.availableQuantity}), 0)` })
      .from(stockLevel)
      .where(
        and(
          eq(stockLevel.tenantId, tenantId),
          eq(stockLevel.itemId, itemId),
          eq(stockLevel.warehouseId, warehouseId),
        ),
      );

    const available = toNumber(total?.available, 0);
    const minimum = toNumber(rule.minimumQuantity);

    if (available <= minimum) {
      triggered.push({ itemId, warehouseId, available, minimum });
      await tx
        .update(reorderRule)
        .set({ lastTriggeredAt: new Date(), updatedAt: new Date() })
        .where(eq(reorderRule.id, rule.id));
    }
  }

  return triggered;
}

/** Current position for one item across a warehouse. */
export async function stockOnHand(
  tx: Transaction,
  input: { tenantId: string; itemId: string; warehouseId?: string },
): Promise<{ quantity: number; available: number; value: number }> {
  const [row] = await tx
    .select({
      quantity: sql<string>`coalesce(sum(${stockLevel.quantity}), 0)`,
      available: sql<string>`coalesce(sum(${stockLevel.availableQuantity}), 0)`,
      value: sql<string>`coalesce(sum(${stockLevel.quantity} * ${stockLevel.averageCost}), 0)`,
    })
    .from(stockLevel)
    .where(
      and(
        eq(stockLevel.tenantId, input.tenantId),
        eq(stockLevel.itemId, input.itemId),
        input.warehouseId ? eq(stockLevel.warehouseId, input.warehouseId) : undefined,
      ),
    );

  return {
    quantity: toNumber(row?.quantity, 0),
    available: toNumber(row?.available, 0),
    value: toNumber(row?.value, 0),
  };
}

export { batchTable };

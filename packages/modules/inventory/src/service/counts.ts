/**
 * Stock counts: freeze the book, count the shelf, and reconcile the
 * difference into the ledger the only way it is ever changed — a posted
 * movement.
 *
 * `inventory.stock_count.reconcile` gated the "Stock Counts" nav entry and
 * nothing underneath it: a list route existed, and no way to raise a count,
 * enter what was actually found, or turn the variance into an adjustment.
 * The schema was already built for the whole lifecycle — `draft` →
 * `counting` → `pending_approval` → `posted`, `adjustmentMovementId`
 * waiting to be set — none of it wired.
 *
 * One permission gates the whole surface, the same shape as
 * `contracts.back_charge.manage` and `contracts.correspondence.manage`:
 * there is no lesser permission declared for raising a count or entering a
 * quantity, so all of it sits behind the one the manifest calls
 * "Restricted — this is how stock loss gets hidden."
 */
import {
  allocateNumber,
  recordAudit,
  requireTenantContext,
  schema,
  type Transaction,
} from '@aerolith/kernel';
import { and, eq, isNull, ne } from 'drizzle-orm';

import { postMovement, type MovementLineInput } from './movements';
import { stockCount, stockCountLine, stockLevel, warehouse } from '../db/schema';

export const MODULE_KEY = 'inventory';

export class StockCountError extends Error {
  override readonly name = 'StockCountError';
}

export interface CreateStockCountInput {
  warehouseId: string;
  countDate?: string;
  itemCategoryId?: string | null;
  notes?: string | null;
}

/** The header only — nothing is frozen yet. See `generateCountSheet`. */
export async function createStockCount(
  tx: Transaction,
  input: CreateStockCountInput,
): Promise<{ id: string; number: string }> {
  const { tenantId } = requireTenantContext();

  const [wh] = await tx
    .select({ id: warehouse.id })
    .from(warehouse)
    .where(and(eq(warehouse.tenantId, tenantId), eq(warehouse.id, input.warehouseId)));
  if (!wh) throw new StockCountError('Warehouse not found.');

  const countDate = input.countDate ?? new Date().toISOString().slice(0, 10);
  const allocated = await allocateNumber(tx, {
    entityType: 'inventory.stock_count',
    documentDate: new Date(countDate),
  });

  const [row] = await tx
    .insert(stockCount)
    .values({
      tenantId,
      number: allocated.formatted,
      warehouseId: input.warehouseId,
      countDate,
      itemCategoryId: input.itemCategoryId,
      notes: input.notes,
    })
    .returning({ id: stockCount.id });

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'inventory.stock_count',
    entityId: row!.id,
    entityLabel: allocated.formatted,
    action: 'create',
  });

  return { id: row!.id, number: allocated.formatted };
}

/**
 * Freezes the book quantity for every item held in this warehouse (narrowed
 * to one category, if the count is a cycle count rather than a full one)
 * into one line per item/bin/batch — the moment `systemQuantity` stops
 * moving and a counted figure becomes a variance rather than a race.
 */
export async function generateCountSheet(
  tx: Transaction,
  input: { countId: string },
): Promise<{ lineCount: number }> {
  const { tenantId } = requireTenantContext();

  const [count] = await tx
    .select()
    .from(stockCount)
    .where(and(eq(stockCount.tenantId, tenantId), eq(stockCount.id, input.countId)));
  if (!count) throw new StockCountError('Stock count not found.');
  if (count.status !== 'draft') {
    throw new StockCountError('The count sheet has already been generated.');
  }

  const conditions = [
    eq(stockLevel.tenantId, tenantId),
    eq(stockLevel.warehouseId, count.warehouseId),
  ];

  const levels = count.itemCategoryId
    ? await tx
        .select({
          itemId: stockLevel.itemId,
          binId: stockLevel.binId,
          batchId: stockLevel.batchId,
          quantity: stockLevel.quantity,
        })
        .from(stockLevel)
        .innerJoin(
          schema.item,
          and(eq(schema.item.id, stockLevel.itemId), eq(schema.item.tenantId, tenantId)),
        )
        .where(and(...conditions, eq(schema.item.categoryId, count.itemCategoryId)))
    : await tx
        .select({
          itemId: stockLevel.itemId,
          binId: stockLevel.binId,
          batchId: stockLevel.batchId,
          quantity: stockLevel.quantity,
        })
        .from(stockLevel)
        .where(and(...conditions));

  if (levels.length === 0) {
    throw new StockCountError('Nothing is stocked at this warehouse to count.');
  }

  await tx.insert(stockCountLine).values(
    levels.map((level) => ({
      tenantId,
      countId: input.countId,
      itemId: level.itemId,
      binId: level.binId,
      batchId: level.batchId,
      systemQuantity: level.quantity,
    })),
  );

  await tx
    .update(stockCount)
    .set({ status: 'counting', updatedAt: new Date() })
    .where(eq(stockCount.id, input.countId));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'inventory.stock_count',
    entityId: input.countId,
    entityLabel: count.number ?? input.countId,
    action: 'update',
    metadata: { lineCount: levels.length },
  });

  return { lineCount: levels.length };
}

export interface RecordCountLineInput {
  countLineId: string;
  countedQuantity: number;
  varianceReason?: string | null;
}

/**
 * Records what was actually found on one line. Once every line in the count
 * carries a counted quantity, the count itself moves to `pending_approval`
 * — computed from the data rather than a separate button, so a count cannot
 * sit "ready to reconcile" while one shelf was never actually counted.
 */
export async function recordCountLine(
  tx: Transaction,
  input: RecordCountLineInput,
): Promise<void> {
  const { tenantId, userId } = requireTenantContext();

  const [line] = await tx
    .select()
    .from(stockCountLine)
    .where(and(eq(stockCountLine.tenantId, tenantId), eq(stockCountLine.id, input.countLineId)));
  if (!line) throw new StockCountError('Count line not found.');

  const [count] = await tx
    .select()
    .from(stockCount)
    .where(and(eq(stockCount.tenantId, tenantId), eq(stockCount.id, line.countId)));
  if (!count || !['counting', 'pending_approval'].includes(count.status)) {
    throw new StockCountError('This count is not open for counting.');
  }

  if (input.countedQuantity < 0) {
    throw new StockCountError('A counted quantity cannot be negative.');
  }

  await tx
    .update(stockCountLine)
    .set({
      countedQuantity: String(input.countedQuantity),
      varianceReason: input.varianceReason,
      countedAt: new Date(),
      countedBy: userId,
      updatedAt: new Date(),
    })
    .where(eq(stockCountLine.id, input.countLineId));

  const [remaining] = await tx
    .select({ id: stockCountLine.id })
    .from(stockCountLine)
    .where(and(eq(stockCountLine.countId, line.countId), isNull(stockCountLine.countedQuantity)))
    .limit(1);

  if (!remaining && count.status === 'counting') {
    await tx
      .update(stockCount)
      .set({ status: 'pending_approval', updatedAt: new Date() })
      .where(eq(stockCount.id, line.countId));
  }

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'inventory.stock_count_line',
    entityId: input.countLineId,
    entityLabel: count.number ?? line.countId,
    action: 'update',
  });
}

export interface ReconcileStockCountInput {
  countId: string;
  notes?: string | null;
}

/**
 * Turns every line's variance into one adjustment movement and closes the
 * count. Lines that counted exactly what the book said are left out of the
 * movement — nothing changed there, and a zero-quantity adjustment line
 * would just be noise in the movement's own audit trail.
 *
 * Requires every line to be counted (`pending_approval`, not `counting`) —
 * reconciling a count that skipped a shelf would post the book as right for
 * a line nobody actually looked at.
 */
export async function reconcileStockCount(
  tx: Transaction,
  input: ReconcileStockCountInput,
): Promise<{ adjustmentMovementId: string | null }> {
  const { tenantId } = requireTenantContext();

  const [count] = await tx
    .select()
    .from(stockCount)
    .where(and(eq(stockCount.tenantId, tenantId), eq(stockCount.id, input.countId)));
  if (!count) throw new StockCountError('Stock count not found.');
  if (count.status !== 'pending_approval') {
    throw new StockCountError('Every line must be counted before a count can be reconciled.');
  }

  const lines = await tx
    .select()
    .from(stockCountLine)
    .where(
      and(
        eq(stockCountLine.tenantId, tenantId),
        eq(stockCountLine.countId, input.countId),
        ne(stockCountLine.variance, '0'),
      ),
    );

  let adjustmentMovementId: string | null = null;

  if (lines.length > 0) {
    const movementLines: MovementLineInput[] = lines.map((line) => ({
      itemId: line.itemId,
      quantity: Number(line.countedQuantity),
      toWarehouseId: count.warehouseId,
      toBinId: line.binId,
      batchId: line.batchId,
      notes: line.varianceReason,
    }));

    const posted = await postMovement(tx, {
      type: 'adjustment',
      movementDate: count.countDate,
      sourceModule: MODULE_KEY,
      sourceEntityType: 'inventory.stock_count',
      sourceEntityId: input.countId,
      reference: count.number ?? undefined,
      notes: input.notes,
      lines: movementLines,
    });

    adjustmentMovementId = posted.movementId;
  }

  await tx
    .update(stockCount)
    .set({
      status: 'posted',
      adjustmentMovementId,
      postedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(stockCount.id, input.countId));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'inventory.stock_count',
    entityId: input.countId,
    entityLabel: count.number ?? input.countId,
    action: 'post',
    metadata: { variantLines: lines.length, adjustmentMovementId },
  });

  return { adjustmentMovementId };
}

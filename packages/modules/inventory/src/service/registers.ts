/**
 * The read side of Inventory — the four registers the module's navigation
 * promises.
 *
 * Everything here is a list: no writes, no side effects, no events. They are
 * separated from `movements.ts` because posting is the module's dangerous
 * surface and reading is not, and mixing the two makes it harder to see which
 * functions can change stock.
 *
 * The item master lives in `kernel.item`, not in this schema, and that is
 * deliberate rather than an oversight: a sheet of 18mm MDF is bought by
 * Procurement, estimated by Estimating, cut by Production and stocked here, so
 * it belongs to the platform. Inventory owns the *stock* of an item, which is
 * why `stock_level` is here and `item` is not. Reading a kernel table from a
 * module is allowed — reading another MODULE's tables is what the boundary
 * check forbids.
 */
import {
  listResult,
  requireTenantContext,
  schema,
  searchPattern,
  type ListParams,
  type ListResult,
  type Transaction,
} from '@aerolith/kernel';
import { and, asc, desc, eq, gt, ilike, inArray, isNull, or, sql } from 'drizzle-orm';

import {
  batch as batchTable,
  offcut,
  reorderRule,
  stockCount,
  stockCountLine,
  stockLevel,
  storageBin,
  warehouse,
} from '../db/schema';

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export interface ItemListRow {
  id: string;
  code: string;
  name: string;
  type: string;
  categoryName: string | null;
  uomCode: string | null;
  lengthMm: string | null;
  widthMm: string | null;
  thicknessMm: string | null;
  hasGrainDirection: boolean;
  isStocked: boolean;
  isBatchTracked: boolean;
  isActive: boolean;
  standardCost: string | null;
  /** Summed across every warehouse. Null when the item has no stock rows at all. */
  onHand: string | null;
}

export const ITEM_SORTS = ['code', 'name', 'type', 'standardCost', 'onHand', 'createdAt'] as const;

export async function listItems(
  tx: Transaction,
  params: ListParams,
  filters: { type?: string; stockedOnly?: boolean; includeInactive?: boolean } = {},
): Promise<ListResult<ItemListRow>> {
  const { tenantId } = requireTenantContext();

  // One grouped scan of stock_level joined back per item, rather than a
  // correlated subquery evaluated per row.
  const onHand = tx
    .select({
      itemId: stockLevel.itemId,
      quantity: sql<string>`sum(${stockLevel.quantity})`.as('on_hand_quantity'),
    })
    .from(stockLevel)
    .where(eq(stockLevel.tenantId, tenantId))
    .groupBy(stockLevel.itemId)
    .as('on_hand');

  const conditions = [eq(schema.item.tenantId, tenantId), isNull(schema.item.deletedAt)];
  if (filters.type) conditions.push(eq(schema.item.type, filters.type as never));
  if (filters.stockedOnly) conditions.push(eq(schema.item.isStocked, true));
  // Inactive items are hidden by default. They are not deleted — an item that
  // has ever moved must stay for the ledger to reconcile — but a discontinued
  // board should not sit in the list somebody picks from.
  if (!filters.includeInactive) conditions.push(eq(schema.item.isActive, true));

  if (params.search) {
    const pattern = searchPattern(params.search);
    conditions.push(
      or(
        ilike(schema.item.code, pattern),
        ilike(schema.item.name, pattern),
        ilike(schema.item.barcode, pattern),
      )!,
    );
  }

  const where = and(...conditions);

  const sortColumn =
    {
      code: schema.item.code,
      name: schema.item.name,
      type: schema.item.type,
      standardCost: schema.item.standardCost,
      onHand: onHand.quantity,
      createdAt: schema.item.createdAt,
    }[params.sort as string] ?? schema.item.code;

  const rows = await tx
    .select({
      id: schema.item.id,
      code: schema.item.code,
      name: schema.item.name,
      type: schema.item.type,
      categoryName: schema.itemCategory.name,
      uomCode: schema.unitOfMeasure.code,
      lengthMm: schema.item.lengthMm,
      widthMm: schema.item.widthMm,
      thicknessMm: schema.item.thicknessMm,
      hasGrainDirection: schema.item.hasGrainDirection,
      isStocked: schema.item.isStocked,
      isBatchTracked: schema.item.isBatchTracked,
      isActive: schema.item.isActive,
      standardCost: schema.item.standardCost,
      onHand: onHand.quantity,
    })
    .from(schema.item)
    .leftJoin(
      schema.itemCategory,
      and(
        eq(schema.itemCategory.id, schema.item.categoryId),
        eq(schema.itemCategory.tenantId, tenantId),
      ),
    )
    .leftJoin(
      schema.unitOfMeasure,
      and(
        eq(schema.unitOfMeasure.id, schema.item.stockUomId),
        eq(schema.unitOfMeasure.tenantId, tenantId),
      ),
    )
    .leftJoin(onHand, eq(onHand.itemId, schema.item.id))
    .where(where)
    .orderBy(params.direction === 'asc' ? asc(sortColumn) : desc(sortColumn), asc(schema.item.id))
    .limit(params.pageSize)
    .offset(params.offset);

  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(schema.item)
    .where(where);

  return listResult(rows, counted?.total ?? 0, params);
}

// ---------------------------------------------------------------------------
// Stock on hand
// ---------------------------------------------------------------------------

export interface StockListRow {
  id: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  uomCode: string | null;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  binCode: string | null;
  batchCode: string | null;
  quantity: string;
  reservedQuantity: string;
  availableQuantity: string | null;
  averageCost: string;
  /** quantity × averageCost, computed in the database so the column adds up. */
  value: string;
  lastMovementAt: string | null;
  /** Null when no reorder rule covers this item and warehouse. */
  minimumQuantity: string | null;
  belowReorder: boolean;
}

export const STOCK_SORTS = [
  'itemCode',
  'warehouseCode',
  'quantity',
  'availableQuantity',
  'value',
  'lastMovementAt',
] as const;

export async function listStockOnHand(
  tx: Transaction,
  params: ListParams,
  filters: {
    warehouseId?: string;
    itemId?: string;
    /** 'in_stock' hides zero rows; 'zero' shows only them; absent shows all. */
    holding?: 'in_stock' | 'zero';
    belowReorderOnly?: boolean;
  } = {},
): Promise<ListResult<StockListRow>> {
  const { tenantId } = requireTenantContext();

  const value = sql<string>`(${stockLevel.quantity} * ${stockLevel.averageCost})`;
  const belowReorder = sql<boolean>`(
    ${reorderRule.minimumQuantity} is not null
    and ${reorderRule.isActive}
    and ${stockLevel.quantity} < ${reorderRule.minimumQuantity}
  )`;

  const conditions = [eq(stockLevel.tenantId, tenantId)];
  if (filters.warehouseId) conditions.push(eq(stockLevel.warehouseId, filters.warehouseId));
  if (filters.itemId) conditions.push(eq(stockLevel.itemId, filters.itemId));
  // A zero row is not the same as no row: it says this item HAS been stocked
  // here and currently is not, which is why zero rows are shown by default and
  // filtering them is an explicit choice.
  if (filters.holding === 'in_stock') conditions.push(gt(stockLevel.quantity, '0'));
  if (filters.holding === 'zero') conditions.push(eq(stockLevel.quantity, '0'));
  // The same predicate the `belowReorder` flag reports, so the filter and the
  // badge can never disagree about which rows are short.
  if (filters.belowReorderOnly) conditions.push(belowReorder);

  if (params.search) {
    const pattern = searchPattern(params.search);
    conditions.push(
      or(
        ilike(schema.item.code, pattern),
        ilike(schema.item.name, pattern),
        ilike(batchTable.code, pattern),
      )!,
    );
  }

  const where = and(...conditions);

  const sortColumn =
    {
      itemCode: schema.item.code,
      warehouseCode: warehouse.code,
      quantity: stockLevel.quantity,
      availableQuantity: stockLevel.availableQuantity,
      value,
      lastMovementAt: stockLevel.lastMovementAt,
    }[params.sort as string] ?? schema.item.code;

  const rows = await tx
    .select({
      id: stockLevel.id,
      itemId: stockLevel.itemId,
      itemCode: schema.item.code,
      itemName: schema.item.name,
      uomCode: schema.unitOfMeasure.code,
      warehouseId: stockLevel.warehouseId,
      warehouseCode: warehouse.code,
      warehouseName: warehouse.name,
      binCode: storageBin.code,
      batchCode: batchTable.code,
      quantity: stockLevel.quantity,
      reservedQuantity: stockLevel.reservedQuantity,
      availableQuantity: stockLevel.availableQuantity,
      averageCost: stockLevel.averageCost,
      value,
      lastMovementAt: sql<string | null>`${stockLevel.lastMovementAt}`,
      minimumQuantity: reorderRule.minimumQuantity,
      belowReorder,
    })
    .from(stockLevel)
    .innerJoin(
      schema.item,
      and(eq(schema.item.id, stockLevel.itemId), eq(schema.item.tenantId, tenantId)),
    )
    .innerJoin(
      warehouse,
      and(eq(warehouse.id, stockLevel.warehouseId), eq(warehouse.tenantId, tenantId)),
    )
    .leftJoin(storageBin, eq(storageBin.id, stockLevel.binId))
    .leftJoin(batchTable, eq(batchTable.id, stockLevel.batchId))
    .leftJoin(
      schema.unitOfMeasure,
      and(
        eq(schema.unitOfMeasure.id, schema.item.stockUomId),
        eq(schema.unitOfMeasure.tenantId, tenantId),
      ),
    )
    .leftJoin(
      reorderRule,
      and(
        eq(reorderRule.itemId, stockLevel.itemId),
        eq(reorderRule.warehouseId, stockLevel.warehouseId),
        eq(reorderRule.tenantId, tenantId),
      ),
    )
    .where(where)
    .orderBy(params.direction === 'asc' ? asc(sortColumn) : desc(sortColumn), asc(stockLevel.id))
    .limit(params.pageSize)
    .offset(params.offset);

  // The count repeats every join the filter can reference, or it counts a
  // different set from the one on screen.
  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(stockLevel)
    .innerJoin(
      schema.item,
      and(eq(schema.item.id, stockLevel.itemId), eq(schema.item.tenantId, tenantId)),
    )
    .innerJoin(
      warehouse,
      and(eq(warehouse.id, stockLevel.warehouseId), eq(warehouse.tenantId, tenantId)),
    )
    .leftJoin(batchTable, eq(batchTable.id, stockLevel.batchId))
    .leftJoin(
      reorderRule,
      and(
        eq(reorderRule.itemId, stockLevel.itemId),
        eq(reorderRule.warehouseId, stockLevel.warehouseId),
        eq(reorderRule.tenantId, tenantId),
      ),
    )
    .where(where);

  return listResult(rows, counted?.total ?? 0, params);
}

// ---------------------------------------------------------------------------
// Offcut register
// ---------------------------------------------------------------------------

export interface OffcutListRow {
  id: string;
  barcode: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  batchCode: string | null;
  lengthMm: string;
  widthMm: string;
  thicknessMm: string | null;
  areaSqm: string | null;
  grainDirection: string | null;
  grainCode: string | null;
  colourCode: string | null;
  finishedEdges: number;
  warehouseCode: string;
  binCode: string | null;
  status: string;
  unitCost: string | null;
  consumedAt: string | null;
  scrappedReason: string | null;
}

export const OFFCUT_SORTS = ['barcode', 'areaSqm', 'status', 'itemCode', 'createdAt'] as const;

export async function listOffcuts(
  tx: Transaction,
  params: ListParams,
  filters: { status?: string; warehouseId?: string; itemId?: string } = {},
): Promise<ListResult<OffcutListRow>> {
  const { tenantId } = requireTenantContext();

  const conditions = [eq(offcut.tenantId, tenantId)];
  if (filters.status) conditions.push(eq(offcut.status, filters.status as never));
  if (filters.warehouseId) conditions.push(eq(offcut.warehouseId, filters.warehouseId));
  if (filters.itemId) conditions.push(eq(offcut.itemId, filters.itemId));

  if (params.search) {
    const pattern = searchPattern(params.search);
    conditions.push(
      or(
        ilike(offcut.barcode, pattern),
        ilike(schema.item.code, pattern),
        ilike(schema.item.name, pattern),
      )!,
    );
  }

  const where = and(...conditions);

  const sortColumn =
    {
      barcode: offcut.barcode,
      areaSqm: offcut.areaSqm,
      status: offcut.status,
      itemCode: schema.item.code,
      createdAt: offcut.createdAt,
    }[params.sort as string] ?? offcut.areaSqm;

  const rows = await tx
    .select({
      id: offcut.id,
      barcode: offcut.barcode,
      itemId: offcut.itemId,
      itemCode: schema.item.code,
      itemName: schema.item.name,
      batchCode: batchTable.code,
      lengthMm: offcut.lengthMm,
      widthMm: offcut.widthMm,
      thicknessMm: offcut.thicknessMm,
      areaSqm: offcut.areaSqm,
      grainDirection: offcut.grainDirection,
      grainCode: offcut.grainCode,
      colourCode: offcut.colourCode,
      finishedEdges: offcut.finishedEdges,
      warehouseCode: warehouse.code,
      binCode: storageBin.code,
      status: offcut.status,
      unitCost: offcut.unitCost,
      consumedAt: sql<string | null>`${offcut.consumedAt}`,
      scrappedReason: offcut.scrappedReason,
    })
    .from(offcut)
    .innerJoin(
      schema.item,
      and(eq(schema.item.id, offcut.itemId), eq(schema.item.tenantId, tenantId)),
    )
    .innerJoin(
      warehouse,
      and(eq(warehouse.id, offcut.warehouseId), eq(warehouse.tenantId, tenantId)),
    )
    .leftJoin(storageBin, eq(storageBin.id, offcut.binId))
    .leftJoin(batchTable, eq(batchTable.id, offcut.batchId))
    .where(where)
    .orderBy(params.direction === 'asc' ? asc(sortColumn) : desc(sortColumn), asc(offcut.id))
    .limit(params.pageSize)
    .offset(params.offset);

  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(offcut)
    .innerJoin(
      schema.item,
      and(eq(schema.item.id, offcut.itemId), eq(schema.item.tenantId, tenantId)),
    )
    .where(where);

  return listResult(rows, counted?.total ?? 0, params);
}

/**
 * What the register is worth, split by status.
 *
 * The reason the offcut register exists is that remnants are money sitting on a
 * rack, and the number nobody can produce without this is "how much". Scrapped
 * value is kept beside available value on purpose: it is the cost of the
 * minimum-usable-size rule, and a tenant tuning that rule needs to see what it
 * threw away.
 */
export interface OffcutSummary {
  status: string;
  pieces: number;
  areaSqm: number;
  value: number;
}

export async function summariseOffcuts(
  tx: Transaction,
  filters: { warehouseId?: string; itemId?: string } = {},
): Promise<OffcutSummary[]> {
  const { tenantId } = requireTenantContext();

  const conditions = [eq(offcut.tenantId, tenantId)];
  if (filters.warehouseId) conditions.push(eq(offcut.warehouseId, filters.warehouseId));
  if (filters.itemId) conditions.push(eq(offcut.itemId, filters.itemId));

  const rows = await tx
    .select({
      status: offcut.status,
      pieces: sql<number>`count(*)::int`,
      areaSqm: sql<string>`coalesce(sum(${offcut.areaSqm}), 0)`,
      // `unitCost` is misnamed: it holds the piece's ABSOLUTE cost, not a rate
      // per square metre. Both branches that write it produce an absolute figure
      // — `offcutCost()` returns the remnant's share of the parent sheet, and
      // the fallback multiplies a per-m² rate by the remnant's own area. So the
      // register's value is a plain sum. Multiplying by area here would square
      // it, and the result would still look like a plausible number.
      value: sql<string>`coalesce(sum(coalesce(${offcut.unitCost}, 0)), 0)`,
    })
    .from(offcut)
    .where(and(...conditions))
    .groupBy(offcut.status);

  return rows.map((row) => ({
    status: row.status,
    pieces: row.pieces,
    areaSqm: Number(row.areaSqm),
    value: Number(row.value),
  }));
}

// ---------------------------------------------------------------------------
// Stock counts
// ---------------------------------------------------------------------------

export interface StockCountListRow {
  id: string;
  number: string | null;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  status: string;
  countDate: string;
  postedAt: string | null;
  lineCount: number;
  countedLines: number;
  /** Net of overs and shorts — see the note on the query. */
  netVariance: string;
  /** Sum of absolute variances: what was actually miscounted. */
  grossVariance: string;
}

export const COUNT_SORTS = ['countDate', 'number', 'status', 'warehouseCode'] as const;

export async function listStockCounts(
  tx: Transaction,
  params: ListParams,
  filters: { status?: string; warehouseId?: string; openOnly?: boolean } = {},
): Promise<ListResult<StockCountListRow>> {
  const { tenantId } = requireTenantContext();

  const openStatuses = ['draft', 'counting', 'pending_approval'] as const;

  // Aggregated once and joined, so a count with 4,000 lines costs one grouped
  // scan rather than four subqueries per row.
  const lines = tx
    .select({
      countId: stockCountLine.countId,
      lineCount: sql<number>`count(*)::int`.as('line_count'),
      countedLines: sql<number>`count(${stockCountLine.countedQuantity})::int`.as('counted_lines'),
      // Net answers "is the book value right"; gross answers "is the counting
      // right". A count where one bin is 50 over and another 50 short nets to
      // zero and is not a clean count, so both are reported.
      netVariance: sql<string>`coalesce(sum(${stockCountLine.variance}), 0)`.as('net_variance'),
      grossVariance: sql<string>`coalesce(sum(abs(${stockCountLine.variance})), 0)`.as(
        'gross_variance',
      ),
    })
    .from(stockCountLine)
    .where(eq(stockCountLine.tenantId, tenantId))
    .groupBy(stockCountLine.countId)
    .as('count_lines');

  const conditions = [eq(stockCount.tenantId, tenantId)];
  if (filters.status) conditions.push(eq(stockCount.status, filters.status as never));
  if (filters.warehouseId) conditions.push(eq(stockCount.warehouseId, filters.warehouseId));
  if (filters.openOnly) conditions.push(inArray(stockCount.status, [...openStatuses]));

  if (params.search) {
    const pattern = searchPattern(params.search);
    conditions.push(or(ilike(stockCount.number, pattern), ilike(warehouse.name, pattern))!);
  }

  const where = and(...conditions);

  const sortColumn =
    {
      countDate: stockCount.countDate,
      number: stockCount.number,
      status: stockCount.status,
      warehouseCode: warehouse.code,
    }[params.sort as string] ?? stockCount.countDate;

  const rows = await tx
    .select({
      id: stockCount.id,
      number: stockCount.number,
      warehouseId: stockCount.warehouseId,
      warehouseCode: warehouse.code,
      warehouseName: warehouse.name,
      status: stockCount.status,
      countDate: stockCount.countDate,
      postedAt: sql<string | null>`${stockCount.postedAt}`,
      lineCount: sql<number>`coalesce(${lines.lineCount}, 0)`,
      countedLines: sql<number>`coalesce(${lines.countedLines}, 0)`,
      netVariance: sql<string>`coalesce(${lines.netVariance}, 0)`,
      grossVariance: sql<string>`coalesce(${lines.grossVariance}, 0)`,
    })
    .from(stockCount)
    .innerJoin(
      warehouse,
      and(eq(warehouse.id, stockCount.warehouseId), eq(warehouse.tenantId, tenantId)),
    )
    .leftJoin(lines, eq(lines.countId, stockCount.id))
    .where(where)
    .orderBy(params.direction === 'asc' ? asc(sortColumn) : desc(sortColumn), asc(stockCount.id))
    .limit(params.pageSize)
    .offset(params.offset);

  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(stockCount)
    .innerJoin(
      warehouse,
      and(eq(warehouse.id, stockCount.warehouseId), eq(warehouse.tenantId, tenantId)),
    )
    .where(where);

  return listResult(rows, counted?.total ?? 0, params);
}

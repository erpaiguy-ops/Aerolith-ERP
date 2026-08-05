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
import { and, asc, desc, eq, gt, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import {
  batch as batchTable,
  offcut,
  stockMovement,
  stockMovementLine,
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

export interface ItemDetail {
  item: typeof schema.item.$inferSelect;
  categoryName: string | null;
  stockUomCode: string | null;
  purchaseUomCode: string | null;
  /** Summed across every warehouse. Null when the item has no stock rows at all. */
  onHand: string | null;
}

/**
 * One item, with what it is measured and stocked in resolved to codes.
 *
 * Had no endpoint at all before this — only the list, same gap the project
 * and party registers had. `stockUomId`/`purchaseUomId` both point at
 * `kernel.unit_of_measure`, so this aliases it twice the same way
 * `getProjectDetail` aliases `kernel.app_user` for the PM and QS.
 */
export async function getItemDetail(tx: Transaction, itemId: string): Promise<ItemDetail | null> {
  const { tenantId } = requireTenantContext();

  const stockUom = alias(schema.unitOfMeasure, 'stock_uom');
  const purchaseUom = alias(schema.unitOfMeasure, 'purchase_uom');

  const [row] = await tx
    .select({
      item: schema.item,
      categoryName: schema.itemCategory.name,
      stockUomCode: stockUom.code,
      purchaseUomCode: purchaseUom.code,
    })
    .from(schema.item)
    .leftJoin(
      schema.itemCategory,
      and(eq(schema.itemCategory.id, schema.item.categoryId), eq(schema.itemCategory.tenantId, tenantId)),
    )
    .leftJoin(stockUom, eq(stockUom.id, schema.item.stockUomId))
    .leftJoin(purchaseUom, eq(purchaseUom.id, schema.item.purchaseUomId))
    .where(
      and(
        eq(schema.item.tenantId, tenantId),
        eq(schema.item.id, itemId),
        isNull(schema.item.deletedAt),
      ),
    )
    .limit(1);

  if (!row) return null;

  // Plain `sum`, not `coalesce(sum, 0)`: an aggregate over zero matching rows
  // still returns one row here (there is no GROUP BY to collapse), so
  // coalescing would turn "never stocked" into a false zero — the same trap
  // `listItems`' onHand subquery avoids by grouping instead.
  const [onHandRow] = await tx
    .select({ quantity: sql<string | null>`sum(${stockLevel.quantity})` })
    .from(stockLevel)
    .where(and(eq(stockLevel.tenantId, tenantId), eq(stockLevel.itemId, itemId)));

  return { ...row, onHand: onHandRow?.quantity ?? null };
}

// ---------------------------------------------------------------------------
// Stock on hand
// ---------------------------------------------------------------------------

export interface StockListRow {
  /**
   * The stock level's id, or `item:<id>` for an item that has never been
   * stocked anywhere and therefore has no stock level to be identified by.
   */
  id: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  uomCode: string | null;
  /**
   * Null for an item that has never been stocked. There is no warehouse to
   * name because the item has never been anywhere — which is a different fact
   * from holding zero of it in a named warehouse, and the two must stay
   * distinguishable on screen.
   */
  warehouseId: string | null;
  warehouseCode: string | null;
  warehouseName: string | null;
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
  /** True when this row is a catalogue entry with no stock level behind it. */
  neverStocked: boolean;
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

  /*
   * Anchored on `item`, not `stock_level`, with the stock level LEFT joined.
   *
   * Anchoring on the stock level meant an item that had never been stocked
   * anywhere had no row to be found by: adding something to the catalogue and
   * then looking for it here returned nothing, with no way to tell "I have none
   * of this" from "I typed the name wrong". An item now always has at least one
   * row, and several once it is stocked in several places.
   *
   * The distinction that anchoring preserved is kept in the data rather than in
   * the absence of data: `neverStocked` is true only for the synthetic row, and
   * its warehouse is null because there is genuinely no warehouse to name. A
   * zero row against a named warehouse still means "stocked here, none now",
   * which is a different fact and still reads differently on screen.
   */
  const stocked = isNotNull(stockLevel.id);
  const quantity = sql<string>`coalesce(${stockLevel.quantity}, 0)`;
  const reserved = sql<string>`coalesce(${stockLevel.reservedQuantity}, 0)`;
  const available = sql<string>`coalesce(${stockLevel.availableQuantity}, 0)`;
  const averageCost = sql<string>`coalesce(${stockLevel.averageCost}, 0)`;
  const value = sql<string>`coalesce(${stockLevel.quantity} * ${stockLevel.averageCost}, 0)`;
  const belowReorder = sql<boolean>`(
    ${reorderRule.minimumQuantity} is not null
    and ${reorderRule.isActive}
    and coalesce(${stockLevel.quantity}, 0) < ${reorderRule.minimumQuantity}
  )`;

  const conditions = [
    eq(schema.item.tenantId, tenantId),
    // A deleted item is gone from the catalogue; whatever it once held is the
    // movement ledger's business, not this register's.
    isNull(schema.item.deletedAt),
  ];

  if (filters.itemId) conditions.push(eq(schema.item.id, filters.itemId));

  if (filters.warehouseId) {
    // Asking "what is in THIS warehouse" excludes the never-stocked rows by
    // definition — they are in no warehouse, and answering with the whole
    // catalogue marked "not here" would be noise, not an answer.
    conditions.push(eq(stockLevel.warehouseId, filters.warehouseId), stocked);
  }

  // `in_stock` is about holdings, so it drops the synthetic rows along with the
  // real zeroes. `zero` reads as "none of this on hand", which is true of both
  // a stocked-then-emptied location and an item never stocked at all — so it
  // keeps them, and `neverStocked` still tells the two apart in the row.
  if (filters.holding === 'in_stock') conditions.push(gt(stockLevel.quantity, '0'), stocked);
  if (filters.holding === 'zero') conditions.push(sql`coalesce(${stockLevel.quantity}, 0) = 0`);

  // An inactive item with stock still has to be visible — the ledger refers to
  // it and somebody has to shift it — but a discontinued item that was never
  // stocked is pure clutter, so it does not get a synthetic row.
  conditions.push(or(stocked, eq(schema.item.isActive, true))!);

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

  // Sorting on the coalesced expressions, not the raw columns: a null quantity
  // would otherwise sort as null rather than as the zero it is displayed as,
  // and the never-stocked rows would clump at one end regardless of direction.
  const sortColumn =
    {
      itemCode: schema.item.code,
      warehouseCode: warehouse.code,
      quantity,
      availableQuantity: available,
      value,
      lastMovementAt: stockLevel.lastMovementAt,
    }[params.sort as string] ?? schema.item.code;

  // `stock_level.id` is null on a synthetic row, so it cannot be the tiebreaker
  // that makes paging deterministic. Item id is present on every row by
  // construction, and the stock level id separates the several rows one item
  // can have.
  // Written out rather than wrapped in `asc()`: that helper appends `asc` after
  // whatever it is given, so `asc(sql\`… nulls first\`)` emits
  // `… nulls first asc`, which is a syntax error rather than a sort order.
  const tiebreak = [asc(schema.item.id), sql`${stockLevel.id} asc nulls first`];

  const selection = {
    // A React key and a stable handle for a row that has no stock level to be
    // identified by. Prefixed rather than falling back to the item id alone, so
    // the two kinds of id can never be confused for one another.
    id: sql<string>`coalesce(${stockLevel.id}::text, 'item:' || ${schema.item.id}::text)`,
    itemId: schema.item.id,
    itemCode: schema.item.code,
    itemName: schema.item.name,
    uomCode: schema.unitOfMeasure.code,
    warehouseId: warehouse.id,
    warehouseCode: warehouse.code,
    warehouseName: warehouse.name,
    binCode: storageBin.code,
    batchCode: batchTable.code,
    quantity,
    reservedQuantity: reserved,
    availableQuantity: available,
    averageCost,
    value,
    lastMovementAt: sql<string | null>`${stockLevel.lastMovementAt}`,
    minimumQuantity: reorderRule.minimumQuantity,
    belowReorder,
    neverStocked: sql<boolean>`(${stockLevel.id} is null)`,
  };

  const rows = await tx
    .select(selection)
    .from(schema.item)
    .leftJoin(
      stockLevel,
      and(eq(stockLevel.itemId, schema.item.id), eq(stockLevel.tenantId, tenantId)),
    )
    // Left, not inner, and it has to be: an inner join here would discard every
    // row whose stock level is null and undo the whole point of the left join
    // above.
    .leftJoin(
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
        eq(reorderRule.itemId, schema.item.id),
        eq(reorderRule.warehouseId, stockLevel.warehouseId),
        eq(reorderRule.tenantId, tenantId),
      ),
    )
    .where(where)
    .orderBy(params.direction === 'asc' ? asc(sortColumn) : desc(sortColumn), ...tiebreak)
    .limit(params.pageSize)
    .offset(params.offset);

  // The count repeats every join the filter can reference, or it counts a
  // different set from the one on screen. `warehouse` is joined here too now:
  // it is no longer only a display join, because the never-stocked rows depend
  // on it staying a LEFT join and the row count would differ if it were not.
  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(schema.item)
    .leftJoin(
      stockLevel,
      and(eq(stockLevel.itemId, schema.item.id), eq(stockLevel.tenantId, tenantId)),
    )
    .leftJoin(
      warehouse,
      and(eq(warehouse.id, stockLevel.warehouseId), eq(warehouse.tenantId, tenantId)),
    )
    .leftJoin(batchTable, eq(batchTable.id, stockLevel.batchId))
    .leftJoin(
      reorderRule,
      and(
        eq(reorderRule.itemId, schema.item.id),
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

export interface StockCountLineRow {
  id: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  binCode: string | null;
  batchCode: string | null;
  systemQuantity: string;
  countedQuantity: string | null;
  variance: string | null;
  varianceReason: string | null;
  countedAt: string | null;
}

export interface StockCountDetail {
  id: string;
  number: string | null;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  status: string;
  countDate: string;
  itemCategoryId: string | null;
  adjustmentMovementId: string | null;
  postedAt: string | null;
  notes: string | null;
  lines: StockCountLineRow[];
}

/** One count, with every line resolved to something a human recognises. */
export async function getStockCountDetail(
  tx: Transaction,
  countId: string,
): Promise<StockCountDetail | null> {
  const { tenantId } = requireTenantContext();

  const [header] = await tx
    .select({
      id: stockCount.id,
      number: stockCount.number,
      warehouseId: stockCount.warehouseId,
      warehouseCode: warehouse.code,
      warehouseName: warehouse.name,
      status: stockCount.status,
      countDate: stockCount.countDate,
      itemCategoryId: stockCount.itemCategoryId,
      adjustmentMovementId: stockCount.adjustmentMovementId,
      postedAt: sql<string | null>`${stockCount.postedAt}`,
      notes: stockCount.notes,
    })
    .from(stockCount)
    .innerJoin(
      warehouse,
      and(eq(warehouse.id, stockCount.warehouseId), eq(warehouse.tenantId, tenantId)),
    )
    .where(and(eq(stockCount.tenantId, tenantId), eq(stockCount.id, countId)));

  if (!header) return null;

  const lines = await tx
    .select({
      id: stockCountLine.id,
      itemId: stockCountLine.itemId,
      itemCode: schema.item.code,
      itemName: schema.item.name,
      binCode: storageBin.code,
      batchCode: batchTable.code,
      systemQuantity: stockCountLine.systemQuantity,
      countedQuantity: stockCountLine.countedQuantity,
      variance: sql<string | null>`${stockCountLine.variance}`,
      varianceReason: stockCountLine.varianceReason,
      countedAt: sql<string | null>`${stockCountLine.countedAt}`,
    })
    .from(stockCountLine)
    .innerJoin(
      schema.item,
      and(eq(schema.item.id, stockCountLine.itemId), eq(schema.item.tenantId, tenantId)),
    )
    .leftJoin(storageBin, eq(storageBin.id, stockCountLine.binId))
    .leftJoin(batchTable, eq(batchTable.id, stockCountLine.batchId))
    .where(and(eq(stockCountLine.tenantId, tenantId), eq(stockCountLine.countId, countId)))
    .orderBy(asc(schema.item.code));

  return { ...header, lines };
}

// ---------------------------------------------------------------------------
// Movement ledger
// ---------------------------------------------------------------------------

export interface MovementListRow {
  id: string;
  number: string | null;
  type: string;
  status: string;
  movementDate: string;
  reference: string | null;
  projectCode: string | null;
  partyName: string | null;
  sourceModule: string | null;
  postedAt: string | null;
  postedByName: string | null;
  notes: string | null;
  lineCount: number;
  /**
   * Summed across the lines, unsigned. Line quantities are always positive and
   * the direction lives in the movement type, so this is "how much moved", not
   * "how much stock changed by" — an issue of 40 and a receipt of 40 both read
   * 40 here.
   */
  totalQuantity: string;
  totalCost: string;
  /** True when a later movement reverses this one. */
  isReversed: boolean;
  reversesMovementId: string | null;
}

export const MOVEMENT_SORTS = ['movementDate', 'number', 'type', 'postedAt'] as const;

export async function listMovements(
  tx: Transaction,
  params: ListParams,
  filters: { type?: string; projectId?: string; itemId?: string } = {},
): Promise<ListResult<MovementListRow>> {
  const { tenantId } = requireTenantContext();

  const lines = tx
    .select({
      movementId: stockMovementLine.movementId,
      lineCount: sql<number>`count(*)::int`.as('line_count'),
      totalQuantity: sql<string>`coalesce(sum(${stockMovementLine.quantity}), 0)`.as(
        'total_quantity',
      ),
      totalCost: sql<string>`coalesce(sum(${stockMovementLine.totalCost}), 0)`.as('total_cost'),
    })
    .from(stockMovementLine)
    .where(eq(stockMovementLine.tenantId, tenantId))
    .groupBy(stockMovementLine.movementId)
    .as('movement_lines');

  // A reversal points at what it reverses, so the reversed row is the one with a
  // pointer AT it. Both stay on the ledger: stock is corrected by a compensating
  // movement, never by deletion, which is what makes the ledger reconcilable.
  const isReversed = sql<boolean>`exists (
    select 1 from ${stockMovement} r
    where r.tenant_id = ${tenantId} and r.reverses_movement_id = ${stockMovement.id}
  )`;

  const conditions = [eq(stockMovement.tenantId, tenantId)];
  if (filters.type) conditions.push(eq(stockMovement.type, filters.type as never));
  if (filters.projectId) conditions.push(eq(stockMovement.projectId, filters.projectId));
  if (filters.itemId) {
    conditions.push(
      sql`exists (
        select 1 from ${stockMovementLine} l
        where l.movement_id = ${stockMovement.id} and l.item_id = ${filters.itemId}
      )`,
    );
  }

  if (params.search) {
    const pattern = searchPattern(params.search);
    conditions.push(
      or(ilike(stockMovement.number, pattern), ilike(stockMovement.reference, pattern))!,
    );
  }

  const where = and(...conditions);

  const sortColumn =
    {
      movementDate: stockMovement.movementDate,
      number: stockMovement.number,
      type: stockMovement.type,
      postedAt: stockMovement.postedAt,
    }[params.sort as string] ?? stockMovement.movementDate;

  const rows = await tx
    .select({
      id: stockMovement.id,
      number: stockMovement.number,
      type: stockMovement.type,
      status: stockMovement.status,
      movementDate: stockMovement.movementDate,
      reference: stockMovement.reference,
      projectCode: schema.project.code,
      partyName: schema.party.name,
      sourceModule: stockMovement.sourceModule,
      postedAt: sql<string | null>`${stockMovement.postedAt}`,
      postedByName: schema.appUser.name,
      notes: stockMovement.notes,
      lineCount: sql<number>`coalesce(${lines.lineCount}, 0)`,
      totalQuantity: sql<string>`coalesce(${lines.totalQuantity}, 0)`,
      totalCost: sql<string>`coalesce(${lines.totalCost}, 0)`,
      isReversed,
      reversesMovementId: stockMovement.reversesMovementId,
    })
    .from(stockMovement)
    .leftJoin(
      schema.project,
      and(eq(schema.project.id, stockMovement.projectId), eq(schema.project.tenantId, tenantId)),
    )
    .leftJoin(
      schema.party,
      and(eq(schema.party.id, stockMovement.partyId), eq(schema.party.tenantId, tenantId)),
    )
    // Who posted it. `postedBy` is a uuid and a stock ledger whose actor column
    // reads as a uuid is a ledger nobody can audit.
    .leftJoin(schema.appUser, eq(schema.appUser.id, stockMovement.postedBy))
    .leftJoin(lines, eq(lines.movementId, stockMovement.id))
    .where(where)
    .orderBy(params.direction === 'asc' ? asc(sortColumn) : desc(sortColumn), asc(stockMovement.id))
    .limit(params.pageSize)
    .offset(params.offset);

  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(stockMovement)
    .where(where);

  return listResult(rows, counted?.total ?? 0, params);
}

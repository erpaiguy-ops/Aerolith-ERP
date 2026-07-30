/**
 * The item catalogue.
 *
 * Separate from `movements.ts` for the same reason that file exists apart
 * from `registers.ts`: posting a stock movement is the module's dangerous
 * surface, and defining what an item IS is a different kind of write again —
 * master data, not a ledger entry. `kernel.item` is platform data (Procurement,
 * Estimating and Production all reference it), but nothing else registers a
 * permission for managing it, so `inventory.item.write` is where that lives.
 */
import {
  listCustomFieldDefinitions,
  recordAudit,
  requireTenantContext,
  schema,
  validateCustomFieldValues,
  type Transaction,
} from '@aerolith/kernel';
import { and, eq } from 'drizzle-orm';

const MODULE_KEY = 'inventory';

export class ItemError extends Error {
  override readonly name = 'ItemError';
}

export interface CreateItemInput {
  code: string;
  name: string;
  nativeName?: string | null;
  description?: string | null;
  type: string;
  categoryId?: string | null;
  stockUomId?: string | null;
  purchaseUomId?: string | null;
  lengthMm?: number | null;
  widthMm?: number | null;
  thicknessMm?: number | null;
  hasGrainDirection?: boolean;
  finishCode?: string | null;
  colourCode?: string | null;
  isStocked?: boolean;
  isBatchTracked?: boolean;
  isSerialTracked?: boolean;
  barcode?: string | null;
  standardCost?: number | null;
  wastagePercent?: number;
}

const numOrNull = (value: number | null | undefined): string | null =>
  value == null ? null : String(value);

export async function createItem(tx: Transaction, input: CreateItemInput): Promise<{ id: string }> {
  const { tenantId } = requireTenantContext();

  const [row] = await tx
    .insert(schema.item)
    .values({
      tenantId,
      code: input.code,
      name: input.name,
      nativeName: input.nativeName,
      description: input.description,
      type: input.type as never,
      categoryId: input.categoryId,
      stockUomId: input.stockUomId,
      purchaseUomId: input.purchaseUomId,
      lengthMm: numOrNull(input.lengthMm),
      widthMm: numOrNull(input.widthMm),
      thicknessMm: numOrNull(input.thicknessMm),
      hasGrainDirection: input.hasGrainDirection ?? false,
      finishCode: input.finishCode,
      colourCode: input.colourCode,
      isStocked: input.isStocked ?? true,
      isBatchTracked: input.isBatchTracked ?? false,
      isSerialTracked: input.isSerialTracked ?? false,
      barcode: input.barcode,
      standardCost: numOrNull(input.standardCost),
      wastagePercent: input.wastagePercent == null ? undefined : String(input.wastagePercent),
    })
    .onConflictDoNothing({ target: [schema.item.tenantId, schema.item.code] })
    .returning({ id: schema.item.id });

  if (!row) throw new ItemError(`"${input.code}" is already in use.`);

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'kernel.item',
    entityId: row.id,
    entityLabel: `${input.code} — ${input.name}`,
    action: 'create',
  });

  return { id: row.id };
}

export interface UpdateItemInput {
  name?: string;
  nativeName?: string | null;
  description?: string | null;
  categoryId?: string | null;
  stockUomId?: string | null;
  purchaseUomId?: string | null;
  lengthMm?: number | null;
  widthMm?: number | null;
  thicknessMm?: number | null;
  hasGrainDirection?: boolean;
  finishCode?: string | null;
  colourCode?: string | null;
  isStocked?: boolean;
  isBatchTracked?: boolean;
  isSerialTracked?: boolean;
  barcode?: string | null;
  standardCost?: number | null;
  wastagePercent?: number;
  isActive?: boolean;
}

export async function updateItem(
  tx: Transaction,
  input: { itemId: string } & UpdateItemInput,
): Promise<void> {
  const { tenantId } = requireTenantContext();

  const [existing] = await tx
    .select()
    .from(schema.item)
    .where(and(eq(schema.item.tenantId, tenantId), eq(schema.item.id, input.itemId)));
  if (!existing) throw new ItemError('Item not found.');

  await tx
    .update(schema.item)
    .set({
      name: input.name ?? existing.name,
      nativeName: input.nativeName !== undefined ? input.nativeName : existing.nativeName,
      description: input.description !== undefined ? input.description : existing.description,
      categoryId: input.categoryId !== undefined ? input.categoryId : existing.categoryId,
      stockUomId: input.stockUomId !== undefined ? input.stockUomId : existing.stockUomId,
      purchaseUomId: input.purchaseUomId !== undefined ? input.purchaseUomId : existing.purchaseUomId,
      lengthMm: input.lengthMm !== undefined ? numOrNull(input.lengthMm) : existing.lengthMm,
      widthMm: input.widthMm !== undefined ? numOrNull(input.widthMm) : existing.widthMm,
      thicknessMm: input.thicknessMm !== undefined ? numOrNull(input.thicknessMm) : existing.thicknessMm,
      hasGrainDirection: input.hasGrainDirection ?? existing.hasGrainDirection,
      finishCode: input.finishCode !== undefined ? input.finishCode : existing.finishCode,
      colourCode: input.colourCode !== undefined ? input.colourCode : existing.colourCode,
      isStocked: input.isStocked ?? existing.isStocked,
      isBatchTracked: input.isBatchTracked ?? existing.isBatchTracked,
      isSerialTracked: input.isSerialTracked ?? existing.isSerialTracked,
      barcode: input.barcode !== undefined ? input.barcode : existing.barcode,
      standardCost: input.standardCost !== undefined ? numOrNull(input.standardCost) : existing.standardCost,
      wastagePercent:
        input.wastagePercent == null ? existing.wastagePercent : String(input.wastagePercent),
      isActive: input.isActive ?? existing.isActive,
      updatedAt: new Date(),
    })
    .where(eq(schema.item.id, input.itemId));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'kernel.item',
    entityId: input.itemId,
    entityLabel: `${existing.code} — ${existing.name}`,
    action: 'update',
  });
}

/**
 * Sets an item's tenant-defined fields, replacing the whole object — the
 * same shape as `setProjectCustomFields` and the kernel's own
 * `setPartyCustomFields`, and the third and last of the original three
 * entities (`party`, `item`, `project`) to get one.
 */
export async function setItemCustomFields(
  tx: Transaction,
  input: { itemId: string; values: Record<string, unknown> },
): Promise<{ values: Record<string, unknown> }> {
  const { tenantId } = requireTenantContext();

  const [existing] = await tx
    .select({ id: schema.item.id })
    .from(schema.item)
    .where(and(eq(schema.item.tenantId, tenantId), eq(schema.item.id, input.itemId)));
  if (!existing) throw new ItemError('Item not found.');

  const definitions = await listCustomFieldDefinitions(tx, { entityType: 'item' });
  const { values, errors } = validateCustomFieldValues(definitions, input.values);

  if (errors.length > 0) {
    throw new ItemError(errors.map((e) => e.message).join(' '));
  }

  await tx
    .update(schema.item)
    .set({ customFields: values, updatedAt: new Date() })
    .where(eq(schema.item.id, input.itemId));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'kernel.item',
    entityId: input.itemId,
    action: 'update',
    reason: 'Custom fields updated.',
  });

  return { values };
}

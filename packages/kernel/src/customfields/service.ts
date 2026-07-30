/**
 * Tenant-defined fields — the catalogue side.
 *
 * Values live in a JSONB `custom_fields` column on the owning table (`party`,
 * `item`, `project`) rather than an EAV table, so they stay queryable with the
 * rest of the row. This file is the schema FOR those values: what fields exist
 * for an entity type, and the validation a write against them must pass. The
 * owning module is the one that actually reads and writes its `custom_fields`
 * column — this never touches `party`, `item` or `project` itself, the same
 * separation the audit trail keeps between recording a change and being the
 * table that changed.
 *
 * Relational field types (`user`, `party`, `item`, `project`, `document`) are
 * defined and stored as a plain id — there is no picker here, and no check
 * that the id actually resolves to something. A generic entity-search
 * component belongs in the web app, not the kernel, and building one before a
 * screen needs it would be designing blind.
 */
import { and, asc, eq } from 'drizzle-orm';

import { type Transaction } from '../db';
import { customFieldDefinition, type customFieldType } from '../db/schema';
import { recordAudit } from '../audit/service';
import { requireTenantContext } from '../tenancy/context';

export type CustomFieldType = (typeof customFieldType.enumValues)[number];

const MODULE_KEY = 'kernel';

export class CustomFieldError extends Error {
  override readonly name = 'CustomFieldError';
}

export interface CustomFieldOption {
  value: string;
  label: string;
  colour?: string;
}

export interface CustomFieldDefinitionRow {
  id: string;
  entityType: string;
  moduleKey: string | null;
  key: string;
  label: string;
  labelNative: string | null;
  helpText: string | null;
  type: CustomFieldType;
  isRequired: boolean;
  isSearchable: boolean;
  showInList: boolean;
  defaultValue: unknown;
  options: CustomFieldOption[];
  validation: Record<string, unknown>;
  section: string | null;
  sortOrder: number;
  isActive: boolean;
}

/** Every active field defined for one entity type, in display order. */
export async function listCustomFieldDefinitions(
  tx: Transaction,
  input: { entityType: string; includeInactive?: boolean },
): Promise<CustomFieldDefinitionRow[]> {
  const { tenantId } = requireTenantContext();

  const conditions = [
    eq(customFieldDefinition.tenantId, tenantId),
    eq(customFieldDefinition.entityType, input.entityType),
  ];
  if (!input.includeInactive) conditions.push(eq(customFieldDefinition.isActive, true));

  return tx
    .select()
    .from(customFieldDefinition)
    .where(and(...conditions))
    .orderBy(asc(customFieldDefinition.section), asc(customFieldDefinition.sortOrder));
}

export interface CreateCustomFieldDefinitionInput {
  entityType: string;
  moduleKey?: string | null;
  key: string;
  label: string;
  labelNative?: string | null;
  helpText?: string | null;
  type: CustomFieldType;
  isRequired?: boolean;
  isSearchable?: boolean;
  showInList?: boolean;
  defaultValue?: unknown;
  options?: CustomFieldOption[];
  validation?: Record<string, unknown>;
  section?: string | null;
  sortOrder?: number;
}

const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

export async function createCustomFieldDefinition(
  tx: Transaction,
  input: CreateCustomFieldDefinitionInput,
): Promise<{ id: string }> {
  const { tenantId } = requireTenantContext();

  if (!KEY_PATTERN.test(input.key)) {
    throw new CustomFieldError(
      'The field key must start with a letter and use only lowercase letters, numbers and underscores — it becomes a JSON key other code reads by name.',
    );
  }
  if ((input.type === 'select' || input.type === 'multiselect') && !input.options?.length) {
    throw new CustomFieldError('A select field needs at least one option.');
  }

  const [row] = await tx
    .insert(customFieldDefinition)
    .values({
      tenantId,
      entityType: input.entityType,
      moduleKey: input.moduleKey ?? null,
      key: input.key,
      label: input.label,
      labelNative: input.labelNative,
      helpText: input.helpText,
      type: input.type,
      isRequired: input.isRequired ?? false,
      isSearchable: input.isSearchable ?? false,
      showInList: input.showInList ?? false,
      defaultValue: input.defaultValue ?? null,
      options: input.options ?? [],
      validation: input.validation ?? {},
      section: input.section,
      sortOrder: input.sortOrder ?? 0,
    })
    .onConflictDoNothing({
      target: [customFieldDefinition.tenantId, customFieldDefinition.entityType, customFieldDefinition.key],
    })
    .returning({ id: customFieldDefinition.id });

  if (!row) {
    throw new CustomFieldError(`"${input.key}" is already defined for ${input.entityType}.`);
  }

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'kernel.custom_field_definition',
    entityId: row.id,
    entityLabel: `${input.entityType}.${input.key}`,
    action: 'create',
  });

  return { id: row.id };
}

export interface UpdateCustomFieldDefinitionInput {
  label?: string;
  labelNative?: string | null;
  helpText?: string | null;
  isRequired?: boolean;
  isSearchable?: boolean;
  showInList?: boolean;
  defaultValue?: unknown;
  options?: CustomFieldOption[];
  validation?: Record<string, unknown>;
  section?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}

/**
 * Edits everything about a field except what makes it the field it is.
 *
 * `key`, `type` and `entityType` are not in this input at all: the key is the
 * JSONB property name every existing row's value is stored under, and the
 * type is what every stored value was validated and coerced against. Neither
 * can change once there might be data behind it — a tenant that got the type
 * wrong retires the field and defines a new one, which is one honest field
 * with a gap in its history rather than a field that quietly reinterprets
 * old values under a new rule.
 */
export async function updateCustomFieldDefinition(
  tx: Transaction,
  input: { id: string } & UpdateCustomFieldDefinitionInput,
): Promise<void> {
  const { tenantId } = requireTenantContext();

  const [existing] = await tx
    .select()
    .from(customFieldDefinition)
    .where(and(eq(customFieldDefinition.tenantId, tenantId), eq(customFieldDefinition.id, input.id)));
  if (!existing) throw new CustomFieldError('Field not found.');

  const options = input.options ?? existing.options;
  if (
    (existing.type === 'select' || existing.type === 'multiselect') &&
    options.length === 0
  ) {
    throw new CustomFieldError('A select field needs at least one option.');
  }

  await tx
    .update(customFieldDefinition)
    .set({
      label: input.label ?? existing.label,
      labelNative: input.labelNative !== undefined ? input.labelNative : existing.labelNative,
      helpText: input.helpText !== undefined ? input.helpText : existing.helpText,
      isRequired: input.isRequired ?? existing.isRequired,
      isSearchable: input.isSearchable ?? existing.isSearchable,
      showInList: input.showInList ?? existing.showInList,
      defaultValue: input.defaultValue !== undefined ? input.defaultValue : existing.defaultValue,
      options,
      validation: input.validation ?? existing.validation,
      section: input.section !== undefined ? input.section : existing.section,
      sortOrder: input.sortOrder ?? existing.sortOrder,
      isActive: input.isActive ?? existing.isActive,
      updatedAt: new Date(),
    })
    .where(eq(customFieldDefinition.id, input.id));

  await recordAudit(tx, {
    moduleKey: MODULE_KEY,
    entityType: 'kernel.custom_field_definition',
    entityId: input.id,
    entityLabel: `${existing.entityType}.${existing.key}`,
    action: 'update',
  });
}

export interface CustomFieldValidationError {
  key: string;
  message: string;
}

/**
 * Validates a submitted value set against a set of definitions, and returns
 * the values coerced to what the column should actually store.
 *
 * Unknown keys in `values` are dropped rather than rejected: a field
 * definition retired after data was entered under it must not turn every
 * future write to the record into a hard failure over a key nobody can fix
 * from the form in front of them.
 */
export function validateCustomFieldValues(
  definitions: CustomFieldDefinitionRow[],
  values: Record<string, unknown>,
): { values: Record<string, unknown>; errors: CustomFieldValidationError[] } {
  const errors: CustomFieldValidationError[] = [];
  const result: Record<string, unknown> = {};

  for (const def of definitions) {
    const raw = values[def.key];
    const isEmpty = raw === undefined || raw === null || raw === '';

    if (isEmpty) {
      if (def.isRequired) errors.push({ key: def.key, message: `${def.label} is required.` });
      continue;
    }

    const coerced = coerceValue(def, raw, errors);
    if (coerced !== undefined) result[def.key] = coerced;
  }

  return { values: result, errors };
}

function coerceValue(
  def: CustomFieldDefinitionRow,
  raw: unknown,
  errors: CustomFieldValidationError[],
): unknown {
  const fail = (message: string) => {
    errors.push({ key: def.key, message: `${def.label}: ${message}` });
    return undefined;
  };

  switch (def.type) {
    case 'number':
    case 'decimal': {
      const num = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(num)) return fail('must be a number.');
      const { min, max } = def.validation as { min?: number; max?: number };
      if (typeof min === 'number' && num < min) return fail(`must be at least ${min}.`);
      if (typeof max === 'number' && num > max) return fail(`must be at most ${max}.`);
      return num;
    }
    case 'boolean':
      return raw === true || raw === 'true';
    case 'date':
    case 'datetime': {
      const date = new Date(String(raw));
      if (Number.isNaN(date.getTime())) return fail('is not a valid date.');
      return String(raw);
    }
    case 'select': {
      const allowed = new Set(def.options.map((o) => o.value));
      if (!allowed.has(String(raw))) return fail('is not one of the allowed options.');
      return String(raw);
    }
    case 'multiselect': {
      const list = Array.isArray(raw) ? raw : String(raw).split(',').map((v) => v.trim());
      const allowed = new Set(def.options.map((o) => o.value));
      const invalid = list.filter((v) => !allowed.has(v));
      if (invalid.length > 0) return fail(`has an option not on the list: ${invalid.join(', ')}.`);
      return list;
    }
    case 'text':
    case 'textarea':
    case 'url':
    case 'user':
    case 'party':
    case 'item':
    case 'project':
    case 'document':
      return String(raw);
    default:
      return raw;
  }
}

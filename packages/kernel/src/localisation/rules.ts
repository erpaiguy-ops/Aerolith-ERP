/**
 * Rule resolution: tenant -> country -> global default.
 *
 * This is the function that replaces every `if (country === 'AE')` the system
 * would otherwise grow. A module asks for `payroll.overtime.weekday_multiplier`
 * and gets the right number for whoever is logged in, with a record of which
 * layer answered — which matters when a payroll run has to be explained to an
 * auditor two years later.
 *
 * Effectivity is respected at every layer: asking for a rule "as at" a past date
 * returns the value that was in force then, so recalculating an old payroll or
 * reprinting an old invoice reproduces the original numbers.
 */
import { z } from 'zod';

export type RuleLayer = 'tenant' | 'country' | 'default';

export interface RuleRecord {
  key: string;
  value: unknown;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  sourceReference?: string | null;
}

export interface RuleDefinitionRecord {
  key: string;
  valueType: string;
  defaultValue: unknown;
  tenantOverridable: boolean;
}

export interface ResolvedRule<T = unknown> {
  key: string;
  value: T;
  layer: RuleLayer;
  /** Statute or policy the value came from, when recorded. */
  source?: string | null;
}

export interface RuleSnapshot {
  definitions: ReadonlyMap<string, RuleDefinitionRecord>;
  countryValues: ReadonlyMap<string, RuleRecord[]>;
  tenantValues: ReadonlyMap<string, RuleRecord[]>;
}

export class UnknownRuleError extends Error {
  override readonly name = 'UnknownRuleError';
  constructor(key: string) {
    super(
      `Rule "${key}" is not declared. Declare it in a module manifest's \`rules\` array ` +
        'so it appears in the admin UI and can be given a country value.',
    );
  }
}

/**
 * Resolves one rule. Kept pure and synchronous over a pre-loaded snapshot: rules
 * are read constantly (every payroll line, every invoice line) and must never
 * become a per-call database round trip.
 */
export function resolveRule<T = unknown>(
  snapshot: RuleSnapshot,
  key: string,
  asAt: Date = new Date(),
): ResolvedRule<T> {
  const definition = snapshot.definitions.get(key);
  if (!definition) throw new UnknownRuleError(key);

  if (definition.tenantOverridable) {
    const tenantValue = pickEffective(snapshot.tenantValues.get(key), asAt);
    if (tenantValue) {
      return { key, value: tenantValue.value as T, layer: 'tenant' };
    }
  }

  const countryValue = pickEffective(snapshot.countryValues.get(key), asAt);
  if (countryValue) {
    return {
      key,
      value: countryValue.value as T,
      layer: 'country',
      source: countryValue.sourceReference,
    };
  }

  return { key, value: definition.defaultValue as T, layer: 'default' };
}

/** Convenience for the common case where only the value matters. */
export function ruleValue<T = unknown>(
  snapshot: RuleSnapshot,
  key: string,
  asAt?: Date,
): T {
  return resolveRule<T>(snapshot, key, asAt).value;
}

/** Every rule in a domain — for the admin screen and for payroll setup. */
export function resolveDomain(
  snapshot: RuleSnapshot,
  prefix: string,
  asAt: Date = new Date(),
): ResolvedRule[] {
  return [...snapshot.definitions.keys()]
    .filter((key) => key === prefix || key.startsWith(`${prefix}.`))
    .sort()
    .map((key) => resolveRule(snapshot, key, asAt));
}

/**
 * Picks the record in force at `asAt`. Where several overlap — which happens
 * when a correction is backdated — the one that started most recently wins.
 */
function pickEffective(records: RuleRecord[] | undefined, asAt: Date): RuleRecord | undefined {
  if (!records || records.length === 0) return undefined;

  let best: RuleRecord | undefined;
  for (const record of records) {
    if (record.effectiveFrom.getTime() > asAt.getTime()) continue;
    if (record.effectiveTo && record.effectiveTo.getTime() <= asAt.getTime()) continue;
    if (!best || record.effectiveFrom.getTime() > best.effectiveFrom.getTime()) {
      best = record;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const validators: Record<string, z.ZodTypeAny> = {
  boolean: z.boolean(),
  number: z.number(),
  percent: z.number().min(0).max(100),
  money: z.number(),
  string: z.string(),
  enum: z.string(),
  date: z.string(),
  duration: z.number().nonnegative(),
  json: z.unknown(),
};

/**
 * Validates a value before it is written. Called by the admin API, so a country
 * or tenant cannot store a string where payroll expects a multiplier — a class
 * of bug that otherwise surfaces on payday.
 */
export function validateRuleValue(
  definition: RuleDefinitionRecord,
  value: unknown,
): { ok: true } | { ok: false; error: string } {
  const validator = validators[definition.valueType];
  if (!validator) {
    return { ok: false, error: `Unknown rule value type "${definition.valueType}".` };
  }
  const result = validator.safeParse(value);
  return result.success
    ? { ok: true }
    : { ok: false, error: result.error.issues.map((i) => i.message).join('; ') };
}

/** Builds a snapshot from query rows. */
export function buildSnapshot(input: {
  definitions: RuleDefinitionRecord[];
  countryValues: RuleRecord[];
  tenantValues: RuleRecord[];
}): RuleSnapshot {
  return {
    definitions: new Map(input.definitions.map((d) => [d.key, d])),
    countryValues: groupByKey(input.countryValues),
    tenantValues: groupByKey(input.tenantValues),
  };
}

function groupByKey(records: RuleRecord[]): Map<string, RuleRecord[]> {
  const grouped = new Map<string, RuleRecord[]>();
  for (const record of records) {
    const existing = grouped.get(record.key);
    if (existing) existing.push(record);
    else grouped.set(record.key, [record]);
  }
  return grouped;
}

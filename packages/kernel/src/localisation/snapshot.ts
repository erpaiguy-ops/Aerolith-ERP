/**
 * Loads a RuleSnapshot from the database.
 *
 * Rules are read constantly — every payroll line, every invoice line, every
 * expiry check — so they are loaded once per request and resolved in memory.
 * Making `resolveRule` hit the database would put a query inside every loop in
 * the system.
 */
import { and, eq } from 'drizzle-orm';

import { type Transaction } from '../db';
import {
  countryRuleValue,
  ruleDefinition,
  tenantRequirement,
  tenantRuleValue,
} from '../db/schema';
import { buildSnapshot, type RuleSnapshot } from './rules';

export async function loadRuleSnapshot(
  tx: Transaction,
  input: { tenantId: string; countryCode: string },
): Promise<RuleSnapshot> {
  // Sequential, not Promise.all: these share one transaction, and therefore one
  // connection. Issuing them concurrently interleaves queries on a single pg
  // client, which pg deprecates and which has no benefit — the connection
  // serialises them anyway.
  const definitions = await tx
    .select({
      key: ruleDefinition.key,
      valueType: ruleDefinition.valueType,
      defaultValue: ruleDefinition.defaultValue,
      tenantOverridable: ruleDefinition.tenantOverridable,
    })
    .from(ruleDefinition);

  const countryValues = await tx
    .select({
      key: countryRuleValue.key,
      value: countryRuleValue.value,
      effectiveFrom: countryRuleValue.effectiveFrom,
      effectiveTo: countryRuleValue.effectiveTo,
      sourceReference: countryRuleValue.sourceReference,
    })
    .from(countryRuleValue)
    .where(eq(countryRuleValue.countryCode, input.countryCode));

  const tenantValues = await tx
    .select({
      key: tenantRuleValue.key,
      value: tenantRuleValue.value,
      effectiveFrom: tenantRuleValue.effectiveFrom,
      effectiveTo: tenantRuleValue.effectiveTo,
    })
    .from(tenantRuleValue)
    .where(eq(tenantRuleValue.tenantId, input.tenantId));

  return buildSnapshot({
    definitions,
    countryValues,
    tenantValues: tenantValues.map((v) => ({ ...v, sourceReference: null })),
  });
}

/**
 * Registers the rules a module declares in its manifest.
 *
 * Called when the module is loaded. Without this a pack that sets the module's
 * rule would fail validation, so registration must happen before any seed.
 */
export async function registerModuleRules(
  tx: Transaction,
  input: {
    moduleKey: string;
    rules: {
      key: string;
      domain: string;
      label: string;
      description?: string;
      valueType: string;
      defaultValue?: unknown;
      unit?: string;
      tenantOverridable: boolean;
    }[];
  },
): Promise<number> {
  let count = 0;

  for (const rule of input.rules) {
    if (!rule.key.startsWith(`${input.moduleKey}.`)) {
      throw new Error(
        `Rule "${rule.key}" must be namespaced under "${input.moduleKey}." so its owner ` +
          'is unambiguous.',
      );
    }

    await tx
      .insert(ruleDefinition)
      .values({
        key: rule.key,
        domain: rule.domain as never,
        label: rule.label,
        description: rule.description,
        valueType: rule.valueType as never,
        defaultValue: rule.defaultValue ?? null,
        unit: rule.unit,
        tenantOverridable: rule.tenantOverridable,
        ownerModule: input.moduleKey,
      })
      .onConflictDoUpdate({
        target: ruleDefinition.key,
        set: {
          label: rule.label,
          description: rule.description,
          defaultValue: rule.defaultValue ?? null,
          ownerModule: input.moduleKey,
          updatedAt: new Date(),
        },
      });
    count += 1;
  }

  return count;
}

/**
 * The requirements a tenant must track for a given subject — the query the HR,
 * Fleet and Accommodation modules all make.
 */
export async function requirementsFor(
  tx: Transaction,
  input: { tenantId: string; subject: string; countryCode?: string },
) {
  return tx
    .select()
    .from(tenantRequirement)
    .where(
      and(
        eq(tenantRequirement.tenantId, input.tenantId),
        eq(tenantRequirement.subject, input.subject as never),
        eq(tenantRequirement.isActive, true),
        input.countryCode ? eq(tenantRequirement.countryCode, input.countryCode) : undefined,
      ),
    )
    .orderBy(tenantRequirement.sortOrder);
}

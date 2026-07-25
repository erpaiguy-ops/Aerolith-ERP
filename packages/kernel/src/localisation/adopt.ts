/**
 * Country adoption.
 *
 * When a tenant selects a country, the country's definitions are COPIED into
 * tenant-owned tables. The tenant then edits their copy — adding a requirement
 * their trade needs, correcting a rate, disabling one that does not apply — with
 * no risk to any other tenant and no risk from a later pack update.
 *
 * This is the flow behind "the selected country will have its own requirements
 * filled by the user": the tenant starts with a complete, correct-by-default set
 * rather than an empty screen, and edits from there.
 */
import { and, eq } from 'drizzle-orm';

import { type Transaction } from '../db';
import { jsonValue } from '../db/json';
import {
  countryRuleValue,
  holidayDefinition,
  requirementDefinition,
  taxCodeDefinition,
  taxRegime,
  tenantHoliday,
  tenantLocalisation,
  tenantRequirement,
  tenantRuleValue,
  tenantTaxCode,
  country as countryTable,
} from '../db/schema';

export interface AdoptCountryOptions {
  tenantId: string;
  countryCode: string;
  isPrimary?: boolean;
  /** Tenant may deviate from country defaults at adoption time. */
  overrides?: {
    locale?: string;
    currencyCode?: string;
    timezone?: string;
    weekendDays?: number[];
    fiscalYearStartMonth?: number;
    taxRegimeCode?: string;
    taxRegistrationNumber?: string;
  };
  /**
   * Re-copy definitions that already exist for this tenant. Customised rows are
   * never overwritten regardless — a tenant's edits always win.
   */
  refresh?: boolean;
}

export interface AdoptionResult {
  countryCode: string;
  packVersion: string | null;
  requirementsCopied: number;
  taxCodesCopied: number;
  holidaysCopied: number;
  rulesCopied: number;
  skippedCustomised: string[];
}

export async function adoptCountry(
  tx: Transaction,
  options: AdoptCountryOptions,
): Promise<AdoptionResult> {
  const { tenantId, countryCode } = options;

  const [countryRow] = await tx
    .select()
    .from(countryTable)
    .where(eq(countryTable.code, countryCode))
    .limit(1);

  if (!countryRow) {
    throw new Error(
      `Country "${countryCode}" is not present. Seed its pack, or create it from the ` +
        'country admin screen before adopting it.',
    );
  }

  const overrides = options.overrides ?? {};
  const result: AdoptionResult = {
    countryCode,
    packVersion: countryRow.packVersion,
    requirementsCopied: 0,
    taxCodesCopied: 0,
    holidaysCopied: 0,
    rulesCopied: 0,
    skippedCustomised: [],
  };

  // --- 1. The tenant's localisation record --------------------------------
  await tx
    .insert(tenantLocalisation)
    .values({
      tenantId,
      countryCode,
      isPrimary: options.isPrimary ?? false,
      locale: overrides.locale ?? countryRow.defaultLocale,
      currencyCode: overrides.currencyCode ?? countryRow.currencyCode,
      timezone: overrides.timezone ?? countryRow.defaultTimezone,
      weekendDays: overrides.weekendDays ?? countryRow.weekendDays,
      fiscalYearStartMonth:
        overrides.fiscalYearStartMonth ?? countryRow.fiscalYearStartMonth,
      taxRegimeCode: overrides.taxRegimeCode ?? null,
      taxRegistrationNumber: overrides.taxRegistrationNumber ?? null,
      adoptedPackVersion: countryRow.packVersion,
    })
    .onConflictDoUpdate({
      target: [tenantLocalisation.tenantId, tenantLocalisation.countryCode],
      set: { adoptedPackVersion: countryRow.packVersion, updatedAt: new Date() },
    });

  // --- 2. Statutory requirements ------------------------------------------
  const requirements = await tx
    .select()
    .from(requirementDefinition)
    .where(
      and(
        eq(requirementDefinition.countryCode, countryCode),
        eq(requirementDefinition.isActive, true),
      ),
    );

  const existingRequirements = await tx
    .select({
      code: tenantRequirement.code,
      isCustomised: tenantRequirement.isCustomised,
    })
    .from(tenantRequirement)
    .where(
      and(
        eq(tenantRequirement.tenantId, tenantId),
        eq(tenantRequirement.countryCode, countryCode),
      ),
    );

  const customised = new Set(
    existingRequirements.filter((r) => r.isCustomised).map((r) => r.code),
  );
  const present = new Set(existingRequirements.map((r) => r.code));

  for (const definition of requirements) {
    if (customised.has(definition.code)) {
      result.skippedCustomised.push(`requirement:${definition.code}`);
      continue;
    }
    if (present.has(definition.code) && !options.refresh) continue;

    await tx
      .insert(tenantRequirement)
      .values({
        tenantId,
        sourceDefinitionId: definition.id,
        countryCode,
        code: definition.code,
        name: definition.name,
        nativeName: definition.nativeName,
        subject: definition.subject,
        category: definition.category,
        isMandatory: definition.isMandatory,
        appliesTo: definition.appliesTo,
        hasExpiry: definition.hasExpiry,
        expiryNoticeDays: definition.expiryNoticeDays,
        renewalLeadDays: definition.renewalLeadDays,
        typicalValidityMonths: definition.typicalValidityMonths,
        numberFormatRegex: definition.numberFormatRegex,
        numberFormatHint: definition.numberFormatHint,
        issuingAuthority: definition.issuingAuthority,
        blocksOnboarding: definition.blocksOnboarding,
        blocksSiteAccess: definition.blocksSiteAccess,
        requiresDocumentCopy: definition.requiresDocumentCopy,
        additionalFields: definition.additionalFields,
        sortOrder: definition.sortOrder,
      })
      .onConflictDoUpdate({
        target: [
          tenantRequirement.tenantId,
          tenantRequirement.countryCode,
          tenantRequirement.code,
        ],
        set: {
          name: definition.name,
          expiryNoticeDays: definition.expiryNoticeDays,
          renewalLeadDays: definition.renewalLeadDays,
          numberFormatRegex: definition.numberFormatRegex,
          updatedAt: new Date(),
        },
      });
    result.requirementsCopied += 1;
  }

  // --- 3. Tax codes --------------------------------------------------------
  const regimes = await tx
    .select()
    .from(taxRegime)
    .where(and(eq(taxRegime.countryCode, countryCode), eq(taxRegime.isActive, true)));

  for (const regime of regimes) {
    // Only copy the regime the tenant actually operates under, when they named
    // one. A country may carry several across effective dates.
    if (overrides.taxRegimeCode && regime.code !== overrides.taxRegimeCode) continue;

    const codes = await tx
      .select()
      .from(taxCodeDefinition)
      .where(eq(taxCodeDefinition.regimeId, regime.id));

    for (const code of codes) {
      await tx
        .insert(tenantTaxCode)
        .values({
          tenantId,
          sourceDefinitionId: code.id,
          countryCode,
          regimeCode: regime.code,
          code: code.code,
          name: code.name,
          rate: code.rate,
          applicability: code.applicability,
          isRecoverable: code.isRecoverable,
          isReverseCharge: code.isReverseCharge,
          isDefault: code.isDefault,
          returnBox: code.returnBox,
          sortOrder: code.sortOrder,
          effectiveFrom: code.effectiveFrom,
          effectiveTo: code.effectiveTo,
        })
        .onConflictDoNothing({
          target: [tenantTaxCode.tenantId, tenantTaxCode.regimeCode, tenantTaxCode.code],
        });
      result.taxCodesCopied += 1;
    }
  }

  // --- 4. Rule values ------------------------------------------------------
  // Country rule values are NOT copied to the tenant. They are read live through
  // the tenant -> country -> default chain, so a tenant automatically picks up a
  // country correction unless they have explicitly overridden that rule. Only
  // the count is reported here, for the onboarding summary.
  const countryRules = await tx
    .select({ key: countryRuleValue.key })
    .from(countryRuleValue)
    .where(eq(countryRuleValue.countryCode, countryCode));
  result.rulesCopied = countryRules.length;

  // --- 5. Holidays ---------------------------------------------------------
  // Definitions are copied only as far as the CURRENT year, because Hijri and
  // announced dates are not knowable in advance. A yearly job materialises the
  // next year once the government confirms.
  const holidays = await tx
    .select()
    .from(holidayDefinition)
    .where(
      and(
        eq(holidayDefinition.countryCode, countryCode),
        eq(holidayDefinition.isActive, true),
      ),
    );

  const year = new Date().getUTCFullYear();
  for (const holiday of holidays) {
    const dates = materialiseHoliday(holiday.calculation, holiday.rule, year);
    if (!dates) continue;

    const durationDays = Math.max(1, Math.round(Number(holiday.defaultDurationDays)));
    const end = new Date(dates.start);
    end.setUTCDate(end.getUTCDate() + durationDays - 1);

    await tx.insert(tenantHoliday).values({
      tenantId,
      sourceDefinitionId: holiday.id,
      countryCode,
      name: holiday.name,
      startDate: toDateString(dates.start),
      endDate: toDateString(end),
      isPaid: holiday.isPaid,
      isConfirmed: dates.confirmed,
      appliesToDivisions: holiday.appliesToDivisions,
    });
    result.holidaysCopied += 1;
  }

  return result;
}

/** Applies a tenant's override for one rule. */
export async function setTenantRule(
  tx: Transaction,
  input: {
    tenantId: string;
    key: string;
    value: unknown;
    reason?: string;
    effectiveFrom?: Date;
  },
): Promise<void> {
  await tx
    .insert(tenantRuleValue)
    .values({
      tenantId: input.tenantId,
      key: input.key,
      value: jsonValue(input.value),
      reason: input.reason,
      effectiveFrom: input.effectiveFrom ?? new Date(),
    })
    .onConflictDoUpdate({
      target: [tenantRuleValue.tenantId, tenantRuleValue.key, tenantRuleValue.effectiveFrom],
      set: { value: jsonValue(input.value), reason: input.reason, updatedAt: new Date() },
    });
}

/**
 * Resolves a holiday definition to a date.
 *
 * Only the Gregorian case is computed here. Hijri dates depend on lunar
 * observation and vary by country, and `announced` dates are a government
 * decision — both are deliberately left for a tenant or a yearly job to confirm
 * rather than guessed at, because a wrong public holiday is a wrong payroll.
 */
function materialiseHoliday(
  calculation: string,
  rule: Record<string, unknown>,
  year: number,
): { start: Date; confirmed: boolean } | null {
  if (calculation === 'fixed_gregorian') {
    const month = Number(rule.month);
    const day = Number(rule.day);
    if (!Number.isFinite(month) || !Number.isFinite(day)) return null;
    return { start: new Date(Date.UTC(year, month - 1, day)), confirmed: true };
  }
  return null;
}

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

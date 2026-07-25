/**
 * Seeds the global (non-tenant) reference data: the rule catalogue and every
 * country pack.
 *
 * Idempotent — safe to re-run after editing a pack. Country-level rows are
 * upserted; tenant-level rows are never touched, because a tenant's copy is
 * theirs. Pack updates reach tenants through the adoption diff, not through
 * this script.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, and } from 'drizzle-orm';
import pg from 'pg';

import * as schema from '../src/db/schema';
import { KERNEL_RULE_DEFINITIONS } from '../src/localisation/definitions';
import { loadAllCountryPacks, validatePackAgainstDefinitions } from '../src/localisation/loader';
import { jsonValue } from '../src/db/json';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const CURRENCIES = [
  { code: 'AED', name: 'UAE Dirham', symbol: 'د.إ', decimalPlaces: 2 },
  { code: 'QAR', name: 'Qatari Riyal', symbol: 'ر.ق', decimalPlaces: 2 },
  { code: 'SAR', name: 'Saudi Riyal', symbol: 'ر.س', decimalPlaces: 2 },
  { code: 'OMR', name: 'Omani Rial', symbol: 'ر.ع.', decimalPlaces: 3 },
  { code: 'BHD', name: 'Bahraini Dinar', symbol: 'د.ب', decimalPlaces: 3 },
  { code: 'KWD', name: 'Kuwaiti Dinar', symbol: 'د.ك', decimalPlaces: 3 },
  { code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2 },
  { code: 'EUR', name: 'Euro', symbol: '€', decimalPlaces: 2 },
  { code: 'GBP', name: 'Pound Sterling', symbol: '£', decimalPlaces: 2 },
  { code: 'INR', name: 'Indian Rupee', symbol: '₹', decimalPlaces: 2 },
];

async function main() {
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool, { schema });

  try {
    // --- Currencies -------------------------------------------------------
    for (const currency of CURRENCIES) {
      await db.insert(schema.currency).values(currency).onConflictDoUpdate({
        target: schema.currency.code,
        set: { name: currency.name, symbol: currency.symbol },
      });
    }
    console.log(`✓ ${CURRENCIES.length} currencies`);

    // --- Rule catalogue ---------------------------------------------------
    for (const definition of KERNEL_RULE_DEFINITIONS) {
      await db
        .insert(schema.ruleDefinition)
        .values({
          key: definition.key,
          domain: definition.domain as typeof schema.ruleDomain.enumValues[number],
          label: definition.label,
          description: definition.description,
          valueType: definition.valueType,
          defaultValue: definition.defaultValue ?? null,
          unit: definition.unit,
          tenantOverridable: definition.tenantOverridable,
          ownerModule: null,
        })
        .onConflictDoUpdate({
          target: schema.ruleDefinition.key,
          set: {
            label: definition.label,
            description: definition.description,
            valueType: definition.valueType,
            defaultValue: definition.defaultValue ?? null,
            tenantOverridable: definition.tenantOverridable,
            updatedAt: new Date(),
          },
        });
    }
    console.log(`✓ ${KERNEL_RULE_DEFINITIONS.length} rule definitions`);

    // --- Country packs ----------------------------------------------------
    const packs = await loadAllCountryPacks();
    const knownKeys = new Set(KERNEL_RULE_DEFINITIONS.map((d) => d.key));
    let errors = 0;

    for (const pack of packs) {
      const issues = validatePackAgainstDefinitions(pack, knownKeys);
      for (const issue of issues.filter((i) => i.severity === 'error')) {
        console.error(`  ✗ [${issue.pack}] ${issue.message}`);
        errors += 1;
      }
    }
    if (errors > 0) {
      throw new Error(`${errors} pack error(s). Fix the packs before seeding.`);
    }

    for (const pack of packs) {
      await db
        .insert(schema.country)
        .values({
          code: pack.code,
          code3: pack.code3,
          numericCode: pack.numericCode,
          name: pack.name,
          nativeName: pack.nativeName,
          currencyCode: pack.currencyCode,
          defaultLocale: pack.defaultLocale,
          supportedLocales: pack.supportedLocales,
          isRtlDefault: pack.isRtlDefault,
          defaultTimezone: pack.defaultTimezone,
          dateFormat: pack.dateFormat,
          weekendDays: pack.weekendDays,
          fiscalYearStartMonth: pack.fiscalYearStartMonth,
          adminDivisionLabel: pack.adminDivisionLabel,
          addressFormat: pack.addressFormat,
          phoneCode: pack.phoneCode,
          phoneFormat: pack.phoneFormat,
          packVersion: pack.packVersion,
        })
        .onConflictDoUpdate({
          target: schema.country.code,
          set: {
            name: pack.name,
            addressFormat: pack.addressFormat,
            weekendDays: pack.weekendDays,
            packVersion: pack.packVersion,
            updatedAt: new Date(),
          },
        });

      for (const division of pack.adminDivisions) {
        await db
          .insert(schema.countryAdminDivision)
          .values({
            countryCode: pack.code,
            code: division.code,
            name: division.name,
            nativeName: division.nativeName,
            sortOrder: division.sortOrder,
          })
          .onConflictDoNothing();
      }

      for (const requirement of pack.requirements) {
        await db
          .insert(schema.requirementDefinition)
          .values({
            countryCode: pack.code,
            code: requirement.code,
            name: requirement.name,
            nativeName: requirement.nativeName,
            description: requirement.description,
            subject: requirement.subject,
            category: requirement.category,
            isMandatory: requirement.isMandatory,
            appliesTo: requirement.appliesTo,
            hasExpiry: requirement.hasExpiry,
            expiryNoticeDays: requirement.expiryNoticeDays,
            renewalLeadDays: requirement.renewalLeadDays,
            typicalValidityMonths: requirement.typicalValidityMonths,
            numberFormatRegex: requirement.numberFormatRegex,
            numberFormatHint: requirement.numberFormatHint,
            issuingAuthority: requirement.issuingAuthority,
            blocksOnboarding: requirement.blocksOnboarding,
            blocksSiteAccess: requirement.blocksSiteAccess,
            requiresDocumentCopy: requirement.requiresDocumentCopy,
            additionalFields: requirement.additionalFields,
            sortOrder: requirement.sortOrder,
          })
          .onConflictDoUpdate({
            target: [schema.requirementDefinition.countryCode, schema.requirementDefinition.code],
            set: {
              name: requirement.name,
              expiryNoticeDays: requirement.expiryNoticeDays,
              numberFormatRegex: requirement.numberFormatRegex,
              blocksOnboarding: requirement.blocksOnboarding,
              updatedAt: new Date(),
            },
          });
      }

      for (const regime of pack.taxRegimes) {
        const [regimeRow] = await db
          .insert(schema.taxRegime)
          .values({
            countryCode: pack.code,
            code: regime.code,
            name: regime.name,
            type: regime.type,
            registrationLabel: regime.registrationLabel,
            registrationRegex: regime.registrationRegex,
            registrationHint: regime.registrationHint,
            filingFrequency: regime.filingFrequency,
            supportsReverseCharge: regime.supportsReverseCharge,
            supportsDesignatedZones: regime.supportsDesignatedZones,
            registrationThreshold: regime.registrationThreshold?.toString(),
            einvoicingScheme: regime.einvoicingScheme,
            einvoicingMandatoryFrom: regime.einvoicingMandatoryFrom,
            einvoicingConfig: regime.einvoicingConfig,
            ...(regime.effectiveFrom ? { effectiveFrom: new Date(regime.effectiveFrom) } : {}),
          })
          .onConflictDoUpdate({
            target: [schema.taxRegime.countryCode, schema.taxRegime.code],
            set: { name: regime.name, einvoicingConfig: regime.einvoicingConfig, updatedAt: new Date() },
          })
          .returning({ id: schema.taxRegime.id });

        const regimeId =
          regimeRow?.id ??
          (
            await db
              .select({ id: schema.taxRegime.id })
              .from(schema.taxRegime)
              .where(
                and(
                  eq(schema.taxRegime.countryCode, pack.code),
                  eq(schema.taxRegime.code, regime.code),
                ),
              )
              .limit(1)
          )[0]?.id;

        if (!regimeId) continue;

        for (const taxCode of regime.taxCodes) {
          await db
            .insert(schema.taxCodeDefinition)
            .values({
              regimeId,
              code: taxCode.code,
              name: taxCode.name,
              rate: taxCode.rate.toString(),
              applicability: taxCode.applicability,
              isRecoverable: taxCode.isRecoverable,
              isReverseCharge: taxCode.isReverseCharge,
              isDefault: taxCode.isDefault,
              returnBox: taxCode.returnBox,
              sortOrder: taxCode.sortOrder,
            })
            .onConflictDoUpdate({
              target: [schema.taxCodeDefinition.regimeId, schema.taxCodeDefinition.code],
              set: { name: taxCode.name, rate: taxCode.rate.toString(), updatedAt: new Date() },
            });
        }
      }

      for (const holiday of pack.holidays) {
        await db
          .insert(schema.holidayDefinition)
          .values({
            countryCode: pack.code,
            code: holiday.code,
            name: holiday.name,
            nativeName: holiday.nativeName,
            calculation: holiday.calculation,
            rule: holiday.rule,
            defaultDurationDays: holiday.defaultDurationDays.toString(),
            isPaid: holiday.isPaid,
            appliesToDivisions: holiday.appliesToDivisions,
          })
          .onConflictDoUpdate({
            target: [schema.holidayDefinition.countryCode, schema.holidayDefinition.code],
            set: { name: holiday.name, rule: holiday.rule, updatedAt: new Date() },
          });
      }

      for (const [key, value] of Object.entries(pack.rules)) {
        await db
          .insert(schema.countryRuleValue)
          .values({
            countryCode: pack.code,
            key,
            value: jsonValue(value),
            sourceReference: pack.ruleSources[key],
            effectiveFrom: new Date('2000-01-01'),
          })
          .onConflictDoUpdate({
            target: [
              schema.countryRuleValue.countryCode,
              schema.countryRuleValue.key,
              schema.countryRuleValue.effectiveFrom,
            ],
            set: {
              value: jsonValue(value),
              sourceReference: pack.ruleSources[key],
              updatedAt: new Date(),
            },
          });
      }

      console.log(
        `✓ ${pack.code} ${pack.name} — ${pack.requirements.length} requirements, ` +
          `${pack.taxRegimes.length} tax regimes, ${pack.holidays.length} holidays, ` +
          `${Object.keys(pack.rules).length} rules`,
      );
    }

    console.log('✓ seed complete');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('✗ seed failed:', error);
  process.exit(1);
});

/**
 * Country master — data-driven localisation.
 *
 * The rule: country differences are DATA, never code branches. There is no
 * `if (country === 'AE')` anywhere in this system. Adding Oman, Kuwait or Egypt
 * is a seed file (a "country pack"), and a tenant admin can define a country
 * that ships with no pack at all by filling the same tables from the UI.
 *
 * Three layers, resolved tenant -> country -> global default:
 *
 *   1. GLOBAL   `ruleDefinition`     the catalogue of knobs that exist at all
 *   2. COUNTRY  `countryRuleValue`   what this country says the knob should be
 *   3. TENANT   `tenantRuleValue`    what this tenant overrode it to
 *
 * Country-level definitions (requirements, tax codes, holidays) are COPIED into
 * tenant-owned tables when a tenant adopts a country, never referenced. That is
 * deliberate: a tenant must be able to edit them, and a later correction to the
 * global pack must never silently change a live tenant's payroll or tax
 * behaviour. `adoptedPackVersion` records what they started from so the UI can
 * offer a reviewable diff when the pack updates.
 */
import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { effectivity, kernel, tenantColumn, timestamps } from '../columns';

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/** What a statutory requirement attaches to. Extend as modules land. */
export const requirementSubject = kernel.enum('requirement_subject', [
  'employee',
  'dependent',
  'company',
  'establishment',
  'vehicle',
  'asset',
  'project',
  'accommodation',
  'subcontractor',
  'supplier',
]);

export const requirementCategory = kernel.enum('requirement_category', [
  'identity',
  'immigration',
  'licence',
  'insurance',
  'permit',
  'registration',
  'certification',
  'tax',
  'health',
  'other',
]);

export const taxRegimeType = kernel.enum('tax_regime_type', [
  'vat',
  'gst',
  'sales_tax',
  'none',
]);

export const taxApplicability = kernel.enum('tax_applicability', [
  'sales',
  'purchase',
  'both',
]);

export const ruleValueType = kernel.enum('rule_value_type', [
  'boolean',
  'number',
  'percent',
  'money',
  'string',
  'enum',
  'date',
  'duration',
  'json',
]);

/**
 * Which part of the system a configurable rule belongs to. Adding a domain here
 * costs nothing — it is how future modules register their own country knobs.
 */
export const ruleDomain = kernel.enum('rule_domain', [
  'payroll',
  'hr',
  'tax',
  'accounting',
  'contract',
  'procurement',
  'inventory',
  'production',
  'logistics',
  'accommodation',
  'compliance',
  'document',
  'general',
]);

export const holidayCalculation = kernel.enum('holiday_calculation', [
  'fixed_gregorian', // 1 January, National Day
  'hijri', // Eid — computed, then confirmed
  'announced', // government announces each year
  'observed_weekday', // "first Monday of..."
]);

// ---------------------------------------------------------------------------
// Country master
// ---------------------------------------------------------------------------

export const country = kernel.table(
  'country',
  {
    code: char('code', { length: 2 }).primaryKey(), // ISO 3166-1 alpha-2
    code3: char('code3', { length: 3 }).notNull(),
    numericCode: char('numeric_code', { length: 3 }),
    name: text('name').notNull(),
    nativeName: text('native_name'),

    currencyCode: char('currency_code', { length: 3 }).notNull(), // ISO 4217
    defaultLocale: varchar('default_locale', { length: 10 }).notNull().default('en'),
    /** Locales a tenant in this country will typically need (e.g. en + ar). */
    supportedLocales: text('supported_locales').array().notNull().default(sql`'{}'::text[]`),
    isRtlDefault: boolean('is_rtl_default').notNull().default(false),

    defaultTimezone: text('default_timezone').notNull(),
    dateFormat: varchar('date_format', { length: 32 }).notNull().default('dd/MM/yyyy'),
    /** ISO weekday numbers, 1 = Monday .. 7 = Sunday. GCC is typically {6,7}. */
    weekendDays: smallint('weekend_days').array().notNull().default(sql`'{6,7}'::smallint[]`),
    fiscalYearStartMonth: smallint('fiscal_year_start_month').notNull().default(1),

    /** Label for the top administrative division: Emirate, Municipality, Province. */
    adminDivisionLabel: text('admin_division_label').notNull().default('Region'),
    /**
     * Ordered address field descriptors, so the address form renders correctly
     * per country without a per-country component. The UAE has no postcode and
     * uses PO Box + Emirate; Qatar uses Zone/Street/Building.
     */
    addressFormat: jsonb('address_format')
      .$type<AddressFieldSpec[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    phoneCode: varchar('phone_code', { length: 8 }),
    phoneFormat: varchar('phone_format', { length: 32 }),

    /** Version of the seeded country pack this row came from. */
    packVersion: varchar('pack_version', { length: 32 }),
    isActive: boolean('is_active').notNull().default(true),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [index('country_active_idx').on(t.isActive)],
);

export type AddressFieldSpec = {
  key: string;
  label: string;
  labelNative?: string;
  required: boolean;
  order: number;
  /** Renders as a dropdown sourced from `countryAdminDivision`. */
  source?: 'admin_division';
  maxLength?: number;
};

/** Emirates, municipalities, provinces. */
export const countryAdminDivision = kernel.table(
  'country_admin_division',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    countryCode: char('country_code', { length: 2 })
      .notNull()
      .references(() => country.code, { onDelete: 'cascade' }),
    code: varchar('code', { length: 16 }).notNull(),
    name: text('name').notNull(),
    nativeName: text('native_name'),
    parentId: uuid('parent_id'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [unique('country_admin_division_uq').on(t.countryCode, t.code)],
);

// ---------------------------------------------------------------------------
// Statutory requirements
// ---------------------------------------------------------------------------

/**
 * The generic "document or registration the law requires you to hold and renew".
 *
 * One table covers Emirates ID, UAE residence visa, labour card, Qatar ID,
 * Saudi Iqama, trade licence, establishment card, vehicle registration
 * (Mulkiya / Istimara), third-party insurance, municipality accommodation
 * permits and anything a future country invents. The application never names
 * any of them — it renders whatever rows exist for the tenant's country.
 */
export const requirementDefinition = kernel.table(
  'requirement_definition',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    countryCode: char('country_code', { length: 2 })
      .notNull()
      .references(() => country.code, { onDelete: 'cascade' }),
    code: varchar('code', { length: 64 }).notNull(), // EMIRATES_ID, RESIDENCE_VISA
    name: text('name').notNull(),
    nativeName: text('native_name'),
    description: text('description'),

    subject: requirementSubject('subject').notNull(),
    category: requirementCategory('category').notNull(),

    isMandatory: boolean('is_mandatory').notNull().default(true),
    /** Applies only to nationals / only to expatriates / everyone. */
    appliesTo: jsonb('applies_to')
      .$type<{ nationality?: 'national' | 'gcc' | 'expatriate' | 'any'; [k: string]: unknown }>()
      .notNull()
      .default({}),

    hasExpiry: boolean('has_expiry').notNull().default(true),
    /** Escalating reminders, in days before expiry. e.g. {90,60,30,14,7,1} */
    expiryNoticeDays: integer('expiry_notice_days')
      .array()
      .notNull()
      .default(sql`'{90,60,30,7}'::integer[]`),
    /** Working days typically needed to renew — drives "start renewal now" alerts. */
    renewalLeadDays: integer('renewal_lead_days').notNull().default(30),
    typicalValidityMonths: integer('typical_validity_months'),

    /** Validation for the identifier itself, so bad data never enters. */
    numberFormatRegex: text('number_format_regex'),
    numberFormatHint: text('number_format_hint'),
    issuingAuthority: text('issuing_authority'),

    /** An employee cannot be marked active while this is missing or expired. */
    blocksOnboarding: boolean('blocks_onboarding').notNull().default(false),
    /** Expiry blocks site access — drives the gate/attendance check. */
    blocksSiteAccess: boolean('blocks_site_access').notNull().default(false),
    requiresDocumentCopy: boolean('requires_document_copy').notNull().default(true),

    /** Extra fields to capture for this requirement, rendered dynamically. */
    additionalFields: jsonb('additional_fields')
      .$type<RequirementFieldSpec[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('requirement_definition_uq').on(t.countryCode, t.code),
    index('requirement_definition_subject_idx').on(t.countryCode, t.subject),
  ],
);

export type RequirementFieldSpec = {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'boolean' | 'select';
  required?: boolean;
  options?: { value: string; label: string }[];
};

/**
 * A tenant's editable copy, created on country adoption. This is the table the
 * HR module actually reads. `sourceDefinitionId` is a provenance pointer only —
 * it is intentionally NOT a foreign key with cascade, because deleting a global
 * definition must never delete a tenant's live compliance record.
 */
export const tenantRequirement = kernel.table(
  'tenant_requirement',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    sourceDefinitionId: uuid('source_definition_id'),
    countryCode: char('country_code', { length: 2 }).notNull(),

    code: varchar('code', { length: 64 }).notNull(),
    name: text('name').notNull(),
    nativeName: text('native_name'),
    subject: requirementSubject('subject').notNull(),
    category: requirementCategory('category').notNull(),

    isMandatory: boolean('is_mandatory').notNull().default(true),
    appliesTo: jsonb('applies_to').$type<Record<string, unknown>>().notNull().default({}),
    hasExpiry: boolean('has_expiry').notNull().default(true),
    expiryNoticeDays: integer('expiry_notice_days')
      .array()
      .notNull()
      .default(sql`'{90,60,30,7}'::integer[]`),
    renewalLeadDays: integer('renewal_lead_days').notNull().default(30),
    typicalValidityMonths: integer('typical_validity_months'),
    numberFormatRegex: text('number_format_regex'),
    numberFormatHint: text('number_format_hint'),
    issuingAuthority: text('issuing_authority'),
    blocksOnboarding: boolean('blocks_onboarding').notNull().default(false),
    blocksSiteAccess: boolean('blocks_site_access').notNull().default(false),
    requiresDocumentCopy: boolean('requires_document_copy').notNull().default(true),
    additionalFields: jsonb('additional_fields')
      .$type<RequirementFieldSpec[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    /** True once a tenant edits it, so pack updates can skip customised rows. */
    isCustomised: boolean('is_customised').notNull().default(false),
    /** True when the tenant created it themselves rather than adopting a pack. */
    isUserDefined: boolean('is_user_defined').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('tenant_requirement_uq').on(t.tenantId, t.countryCode, t.code),
    index('tenant_requirement_subject_idx').on(t.tenantId, t.subject, t.isActive),
  ],
);

// ---------------------------------------------------------------------------
// Tax
// ---------------------------------------------------------------------------

export const taxRegime = kernel.table(
  'tax_regime',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    countryCode: char('country_code', { length: 2 })
      .notNull()
      .references(() => country.code, { onDelete: 'cascade' }),
    code: varchar('code', { length: 32 }).notNull(), // AE_VAT, QA_VAT, SA_VAT
    name: text('name').notNull(),
    type: taxRegimeType('type').notNull(),

    /** "TRN" in the UAE, "TIN" in Qatar, "VAT Number" elsewhere. */
    registrationLabel: varchar('registration_label', { length: 32 }).notNull().default('Tax No.'),
    registrationRegex: text('registration_regex'),
    registrationHint: text('registration_hint'),

    filingFrequency: varchar('filing_frequency', { length: 16 }).notNull().default('quarterly'),
    supportsReverseCharge: boolean('supports_reverse_charge').notNull().default(false),
    supportsDesignatedZones: boolean('supports_designated_zones').notNull().default(false),
    /** Threshold above which registration is mandatory, in country currency. */
    registrationThreshold: numeric('registration_threshold', { precision: 18, scale: 2 }),

    /**
     * E-invoicing. The UAE is moving to a Peppol-based five-corner model; Saudi
     * runs ZATCA Fatoora. Both are just values here, and `einvoicingConfig`
     * carries scheme-specific settings so no code changes per country.
     */
    einvoicingScheme: varchar('einvoicing_scheme', { length: 32 }),
    einvoicingMandatoryFrom: date('einvoicing_mandatory_from'),
    einvoicingConfig: jsonb('einvoicing_config')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    ...effectivity(),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [unique('tax_regime_uq').on(t.countryCode, t.code)],
);

export const taxCodeDefinition = kernel.table(
  'tax_code_definition',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    regimeId: uuid('regime_id')
      .notNull()
      .references(() => taxRegime.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 16 }).notNull(), // SR, ZR, EX, RC, OS
    name: text('name').notNull(),
    rate: numeric('rate', { precision: 7, scale: 4 }).notNull().default('0'),
    applicability: taxApplicability('applicability').notNull().default('both'),
    isRecoverable: boolean('is_recoverable').notNull().default(true),
    isReverseCharge: boolean('is_reverse_charge').notNull().default(false),
    isDefault: boolean('is_default').notNull().default(false),
    /** Box on the statutory return this code aggregates into. */
    returnBox: varchar('return_box', { length: 16 }),
    sortOrder: integer('sort_order').notNull().default(0),
    ...effectivity(),
    ...timestamps(),
  },
  (t) => [unique('tax_code_definition_uq').on(t.regimeId, t.code)],
);

/** Tenant's editable copy — same rationale as `tenantRequirement`. */
export const tenantTaxCode = kernel.table(
  'tenant_tax_code',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    sourceDefinitionId: uuid('source_definition_id'),
    countryCode: char('country_code', { length: 2 }).notNull(),
    regimeCode: varchar('regime_code', { length: 32 }).notNull(),
    code: varchar('code', { length: 16 }).notNull(),
    name: text('name').notNull(),
    rate: numeric('rate', { precision: 7, scale: 4 }).notNull().default('0'),
    applicability: taxApplicability('applicability').notNull().default('both'),
    isRecoverable: boolean('is_recoverable').notNull().default(true),
    isReverseCharge: boolean('is_reverse_charge').notNull().default(false),
    isDefault: boolean('is_default').notNull().default(false),
    returnBox: varchar('return_box', { length: 16 }),
    /** Set once the Accounts module exists; posting rules resolve through this. */
    outputAccountId: uuid('output_account_id'),
    inputAccountId: uuid('input_account_id'),
    isCustomised: boolean('is_customised').notNull().default(false),
    isUserDefined: boolean('is_user_defined').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    ...effectivity(),
    ...timestamps(),
  },
  (t) => [
    unique('tenant_tax_code_uq').on(t.tenantId, t.regimeCode, t.code),
    index('tenant_tax_code_lookup_idx').on(t.tenantId, t.isActive),
  ],
);

// ---------------------------------------------------------------------------
// Configurable rules — the generic knob mechanism
// ---------------------------------------------------------------------------

/**
 * The catalogue of every country-variable setting in the system. Modules
 * register their knobs here at migration time; the admin UI is generated from
 * this table, which is why adding a country never needs a new screen.
 */
export const ruleDefinition = kernel.table(
  'rule_definition',
  {
    key: varchar('key', { length: 128 }).primaryKey(), // payroll.overtime.weekday_multiplier
    domain: ruleDomain('domain').notNull(),
    label: text('label').notNull(),
    description: text('description'),
    valueType: ruleValueType('value_type').notNull(),
    /** JSON Schema fragment used to validate values at write time. */
    valueSchema: jsonb('value_schema').$type<Record<string, unknown>>().notNull().default({}),
    defaultValue: jsonb('default_value'),
    unit: varchar('unit', { length: 24 }),
    /** Tenants may override this rule. Some are statutory and must not be. */
    tenantOverridable: boolean('tenant_overridable').notNull().default(true),
    /** Which module owns this knob — null for kernel-owned. */
    ownerModule: varchar('owner_module', { length: 64 }),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps(),
  },
  (t) => [index('rule_definition_domain_idx').on(t.domain)],
);

export const countryRuleValue = kernel.table(
  'country_rule_value',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    countryCode: char('country_code', { length: 2 })
      .notNull()
      .references(() => country.code, { onDelete: 'cascade' }),
    key: varchar('key', { length: 128 })
      .notNull()
      .references(() => ruleDefinition.key, { onDelete: 'cascade' }),
    value: jsonb('value').notNull(),
    /** Cite the law, so the next person knows why the number is what it is. */
    sourceReference: text('source_reference'),
    ...effectivity(),
    ...timestamps(),
  },
  (t) => [
    unique('country_rule_value_uq').on(t.countryCode, t.key, t.effectiveFrom),
    index('country_rule_value_lookup_idx').on(t.countryCode, t.key),
  ],
);

export const tenantRuleValue = kernel.table(
  'tenant_rule_value',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    key: varchar('key', { length: 128 }).notNull(),
    value: jsonb('value').notNull(),
    reason: text('reason'),
    ...effectivity(),
    ...timestamps(),
  },
  (t) => [
    unique('tenant_rule_value_uq').on(t.tenantId, t.key, t.effectiveFrom),
    index('tenant_rule_value_lookup_idx').on(t.tenantId, t.key),
  ],
);

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export const holidayDefinition = kernel.table(
  'holiday_definition',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    countryCode: char('country_code', { length: 2 })
      .notNull()
      .references(() => country.code, { onDelete: 'cascade' }),
    code: varchar('code', { length: 64 }).notNull(),
    name: text('name').notNull(),
    nativeName: text('native_name'),
    calculation: holidayCalculation('calculation').notNull(),
    /**
     * Shape depends on `calculation`:
     *   fixed_gregorian  { month: 12, day: 2 }
     *   hijri            { hijriMonth: 10, hijriDay: 1 }
     *   announced        {}                       — needs a confirmed instance
     */
    rule: jsonb('rule').$type<Record<string, unknown>>().notNull().default({}),
    defaultDurationDays: numeric('default_duration_days', { precision: 4, scale: 1 })
      .notNull()
      .default('1'),
    isPaid: boolean('is_paid').notNull().default(true),
    appliesToDivisions: text('applies_to_divisions').array(),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [unique('holiday_definition_uq').on(t.countryCode, t.code)],
);

/**
 * The actual dates for a given year. Hijri holidays and anything `announced`
 * are only certain once the government confirms them, so payroll and site
 * planning read this table, never the rule.
 */
export const tenantHoliday = kernel.table(
  'tenant_holiday',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    sourceDefinitionId: uuid('source_definition_id'),
    countryCode: char('country_code', { length: 2 }).notNull(),
    name: text('name').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    isPaid: boolean('is_paid').notNull().default(true),
    /** False while the date is an estimate (unconfirmed Hijri or announced). */
    isConfirmed: boolean('is_confirmed').notNull().default(false),
    appliesToDivisions: text('applies_to_divisions').array(),
    isUserDefined: boolean('is_user_defined').notNull().default(false),
    notes: text('notes'),
    ...timestamps(),
  },
  (t) => [index('tenant_holiday_range_idx').on(t.tenantId, t.startDate, t.endDate)],
);

// ---------------------------------------------------------------------------
// Tenant adoption
// ---------------------------------------------------------------------------

/**
 * A tenant's localisation state. Multi-country by design: a contractor with a
 * Dubai factory and a Doha branch has two rows, one flagged primary, and every
 * operating entity points at one of them.
 */
export const tenantLocalisation = kernel.table(
  'tenant_localisation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    countryCode: char('country_code', { length: 2 }).notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),

    /** Country defaults, overridable per tenant at adoption time. */
    locale: varchar('locale', { length: 10 }).notNull().default('en'),
    currencyCode: char('currency_code', { length: 3 }).notNull(),
    timezone: text('timezone').notNull(),
    weekendDays: smallint('weekend_days').array().notNull(),
    fiscalYearStartMonth: smallint('fiscal_year_start_month').notNull().default(1),

    /** Statutory registration numbers held by this tenant in this country. */
    taxRegistrationNumber: varchar('tax_registration_number', { length: 64 }),
    taxRegimeCode: varchar('tax_regime_code', { length: 32 }),

    adoptedPackVersion: varchar('adopted_pack_version', { length: 32 }),
    adoptedAt: timestamp('adopted_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when a newer pack is available, so the UI can offer a diff. */
    packUpdateAvailable: varchar('pack_update_available', { length: 32 }),

    /** Tenant-supplied answers to the country's onboarding questionnaire. */
    setupAnswers: jsonb('setup_answers').$type<Record<string, unknown>>().notNull().default({}),
    setupCompletedAt: timestamp('setup_completed_at', { withTimezone: true }),

    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('tenant_localisation_uq').on(t.tenantId, t.countryCode),
    index('tenant_localisation_primary_idx').on(t.tenantId, t.isPrimary),
  ],
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const countryRelations = relations(country, ({ many }) => ({
  divisions: many(countryAdminDivision),
  requirements: many(requirementDefinition),
  taxRegimes: many(taxRegime),
  ruleValues: many(countryRuleValue),
  holidays: many(holidayDefinition),
}));

export const taxRegimeRelations = relations(taxRegime, ({ one, many }) => ({
  country: one(country, { fields: [taxRegime.countryCode], references: [country.code] }),
  taxCodes: many(taxCodeDefinition),
}));

export const taxCodeDefinitionRelations = relations(taxCodeDefinition, ({ one }) => ({
  regime: one(taxRegime, { fields: [taxCodeDefinition.regimeId], references: [taxRegime.id] }),
}));

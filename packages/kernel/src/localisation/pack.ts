/**
 * Country pack format.
 *
 * A country pack is DATA — a JSON file under `packs/`. Adding Oman, Kuwait,
 * Egypt or India is a new pack and zero lines of code. A tenant admin can also
 * build a country from scratch in the UI, because the UI writes the same tables
 * a pack seeds.
 *
 * Packs are versioned. Adopting one COPIES its definitions into tenant-owned
 * tables, so a later correction to a pack never silently rewrites a live
 * tenant's payroll or tax behaviour — it offers them a diff instead.
 */
import { z } from 'zod';

const requirementFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['text', 'number', 'date', 'boolean', 'select']),
  required: z.boolean().default(false),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
});

export const requirementPackSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'Requirement codes are SCREAMING_SNAKE_CASE.'),
  name: z.string(),
  nativeName: z.string().optional(),
  description: z.string().optional(),
  subject: z.enum([
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
  ]),
  category: z.enum([
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
  ]),
  isMandatory: z.boolean().default(true),
  appliesTo: z
    .object({ nationality: z.enum(['national', 'gcc', 'expatriate', 'any']).default('any') })
    .passthrough()
    .default({ nationality: 'any' }),
  hasExpiry: z.boolean().default(true),
  expiryNoticeDays: z.array(z.number().int().positive()).default([90, 60, 30, 7]),
  renewalLeadDays: z.number().int().nonnegative().default(30),
  typicalValidityMonths: z.number().int().positive().optional(),
  numberFormatRegex: z.string().optional(),
  numberFormatHint: z.string().optional(),
  issuingAuthority: z.string().optional(),
  blocksOnboarding: z.boolean().default(false),
  blocksSiteAccess: z.boolean().default(false),
  requiresDocumentCopy: z.boolean().default(true),
  additionalFields: z.array(requirementFieldSchema).default([]),
  sortOrder: z.number().int().default(0),
});

export const taxCodePackSchema = z.object({
  code: z.string(),
  name: z.string(),
  rate: z.number().min(0).max(100),
  applicability: z.enum(['sales', 'purchase', 'both']).default('both'),
  isRecoverable: z.boolean().default(true),
  isReverseCharge: z.boolean().default(false),
  isDefault: z.boolean().default(false),
  returnBox: z.string().optional(),
  sortOrder: z.number().int().default(0),
});

export const taxRegimePackSchema = z.object({
  code: z.string(),
  name: z.string(),
  type: z.enum(['vat', 'gst', 'sales_tax', 'none']),
  registrationLabel: z.string().default('Tax No.'),
  registrationRegex: z.string().optional(),
  registrationHint: z.string().optional(),
  filingFrequency: z.enum(['monthly', 'quarterly', 'annual']).default('quarterly'),
  supportsReverseCharge: z.boolean().default(false),
  supportsDesignatedZones: z.boolean().default(false),
  registrationThreshold: z.number().optional(),
  einvoicingScheme: z.string().optional(),
  einvoicingMandatoryFrom: z.string().optional(),
  einvoicingConfig: z.record(z.unknown()).default({}),
  effectiveFrom: z.string().optional(),
  taxCodes: z.array(taxCodePackSchema).default([]),
});

export const holidayPackSchema = z.object({
  code: z.string(),
  name: z.string(),
  nativeName: z.string().optional(),
  calculation: z.enum(['fixed_gregorian', 'hijri', 'announced', 'observed_weekday']),
  rule: z.record(z.unknown()).default({}),
  defaultDurationDays: z.number().positive().default(1),
  isPaid: z.boolean().default(true),
  appliesToDivisions: z.array(z.string()).optional(),
});

export const addressFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  labelNative: z.string().optional(),
  required: z.boolean().default(false),
  order: z.number().int(),
  source: z.literal('admin_division').optional(),
  maxLength: z.number().int().positive().optional(),
});

export const countryPackSchema = z.object({
  /** Bump when the pack's content changes; drives the tenant update prompt. */
  packVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  code: z.string().length(2),
  code3: z.string().length(3),
  numericCode: z.string().length(3).optional(),
  name: z.string(),
  nativeName: z.string().optional(),

  currencyCode: z.string().length(3),
  defaultLocale: z.string().default('en'),
  supportedLocales: z.array(z.string()).default(['en']),
  isRtlDefault: z.boolean().default(false),
  defaultTimezone: z.string(),
  dateFormat: z.string().default('dd/MM/yyyy'),
  /** ISO weekday numbers: 1 = Monday .. 7 = Sunday. */
  weekendDays: z.array(z.number().int().min(1).max(7)).default([6, 7]),
  fiscalYearStartMonth: z.number().int().min(1).max(12).default(1),

  adminDivisionLabel: z.string().default('Region'),
  adminDivisions: z
    .array(
      z.object({
        code: z.string(),
        name: z.string(),
        nativeName: z.string().optional(),
        sortOrder: z.number().int().default(0),
      }),
    )
    .default([]),
  addressFormat: z.array(addressFieldSchema).default([]),

  phoneCode: z.string().optional(),
  phoneFormat: z.string().optional(),

  requirements: z.array(requirementPackSchema).default([]),
  taxRegimes: z.array(taxRegimePackSchema).default([]),
  holidays: z.array(holidayPackSchema).default([]),
  /** Values for keys declared in `kernel.rule_definition`. */
  rules: z.record(z.unknown()).default({}),
  /** Why a rule is what it is — cite the law. */
  ruleSources: z.record(z.string()).default({}),

  notes: z.string().optional(),
});

export type CountryPack = z.infer<typeof countryPackSchema>;
export type RequirementPack = z.infer<typeof requirementPackSchema>;
export type TaxRegimePack = z.infer<typeof taxRegimePackSchema>;

export function parseCountryPack(input: unknown, source = '<inline>'): CountryPack {
  const parsed = countryPackSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      `Invalid country pack (${source}):\n` +
        parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n'),
    );
  }

  const codes = new Set<string>();
  for (const requirement of parsed.data.requirements) {
    if (codes.has(requirement.code)) {
      throw new Error(`Duplicate requirement code "${requirement.code}" in ${source}.`);
    }
    codes.add(requirement.code);
  }

  return parsed.data;
}

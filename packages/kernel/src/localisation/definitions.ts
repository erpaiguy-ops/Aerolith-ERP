/**
 * The kernel's own rule catalogue.
 *
 * Every knob that varies by country and is needed before the business modules
 * exist. Modules add their own via the `rules` array in their manifest — the
 * kernel never needs to know about them.
 *
 * A rule belongs here when the ANSWER differs by country but the QUESTION does
 * not. "How many days of annual leave?" is universal; the number is not. That
 * test is what keeps this list from becoming a dumping ground for settings.
 */
import { type RuleDeclaration } from '../modules/manifest';

export const KERNEL_RULE_DEFINITIONS: RuleDeclaration[] = [
  // --- Working time -------------------------------------------------------
  {
    key: 'hr.working_time.standard_daily_hours',
    domain: 'hr',
    label: 'Standard working hours per day',
    valueType: 'number',
    defaultValue: 8,
    unit: 'hours',
    tenantOverridable: true,
  },
  {
    key: 'hr.working_time.standard_weekly_hours',
    domain: 'hr',
    label: 'Standard working hours per week',
    valueType: 'number',
    defaultValue: 48,
    unit: 'hours',
    tenantOverridable: true,
  },
  {
    key: 'hr.working_time.ramadan_daily_hours',
    domain: 'hr',
    label: 'Working hours per day during Ramadan',
    description: 'Reduced statutory hours. Set equal to the standard where not applicable.',
    valueType: 'number',
    defaultValue: 8,
    unit: 'hours',
    tenantOverridable: false,
  },
  {
    key: 'hr.working_time.midday_break',
    domain: 'compliance',
    label: 'Summer midday outdoor work ban',
    description:
      'Outdoor work prohibited between these times in the given months. Drives site ' +
      'attendance validation and production scheduling.',
    valueType: 'json',
    defaultValue: null,
    tenantOverridable: false,
  },

  // --- Overtime -----------------------------------------------------------
  {
    key: 'payroll.overtime.weekday_multiplier',
    domain: 'payroll',
    label: 'Overtime multiplier — normal day',
    valueType: 'number',
    defaultValue: 1.25,
    tenantOverridable: false,
  },
  {
    key: 'payroll.overtime.night_multiplier',
    domain: 'payroll',
    label: 'Overtime multiplier — night hours',
    valueType: 'number',
    defaultValue: 1.5,
    tenantOverridable: false,
  },
  {
    key: 'payroll.overtime.rest_day_multiplier',
    domain: 'payroll',
    label: 'Overtime multiplier — weekly rest day',
    valueType: 'number',
    defaultValue: 1.5,
    tenantOverridable: false,
  },
  {
    key: 'payroll.overtime.holiday_multiplier',
    domain: 'payroll',
    label: 'Overtime multiplier — public holiday',
    valueType: 'number',
    defaultValue: 1.5,
    tenantOverridable: false,
  },

  // --- Leave --------------------------------------------------------------
  {
    key: 'hr.leave.annual_days',
    domain: 'hr',
    label: 'Annual leave entitlement',
    valueType: 'number',
    defaultValue: 30,
    unit: 'days',
    tenantOverridable: true,
  },
  {
    key: 'hr.leave.annual_accrual_basis',
    domain: 'hr',
    label: 'Annual leave counted in calendar or working days',
    valueType: 'enum',
    defaultValue: 'calendar',
    tenantOverridable: true,
  },
  {
    key: 'hr.leave.sick_leave_scale',
    domain: 'hr',
    label: 'Sick leave entitlement scale',
    description: 'Ordered bands of days and the percentage of pay for each.',
    valueType: 'json',
    defaultValue: [],
    tenantOverridable: false,
  },
  {
    key: 'hr.leave.maternity_days',
    domain: 'hr',
    label: 'Maternity leave',
    valueType: 'number',
    defaultValue: 45,
    unit: 'days',
    tenantOverridable: false,
  },
  {
    key: 'hr.probation.max_months',
    domain: 'hr',
    label: 'Maximum probation period',
    valueType: 'number',
    defaultValue: 6,
    unit: 'months',
    tenantOverridable: false,
  },
  {
    key: 'hr.notice.minimum_days',
    domain: 'hr',
    label: 'Minimum notice period',
    valueType: 'number',
    defaultValue: 30,
    unit: 'days',
    tenantOverridable: true,
  },

  // --- End of service -----------------------------------------------------
  {
    key: 'payroll.end_of_service.scheme',
    domain: 'payroll',
    label: 'End-of-service benefit scheme',
    description:
      'Bands of service years, days accrued per year, and the salary component the ' +
      'accrual is calculated on. Drives the monthly EOSB provision posted to the GL.',
    valueType: 'json',
    defaultValue: null,
    tenantOverridable: false,
  },
  {
    key: 'payroll.end_of_service.cap_years',
    domain: 'payroll',
    label: 'End-of-service benefit cap',
    description: 'Maximum total benefit expressed in years of salary. Null for no cap.',
    valueType: 'number',
    defaultValue: null,
    unit: 'years',
    tenantOverridable: false,
  },

  // --- Wage protection ----------------------------------------------------
  {
    key: 'payroll.wps.enabled',
    domain: 'payroll',
    label: 'Wage Protection System applies',
    valueType: 'boolean',
    defaultValue: false,
    tenantOverridable: false,
  },
  {
    key: 'payroll.wps.file_format',
    domain: 'payroll',
    label: 'Wage Protection System file format',
    description: 'Identifier of the export generator, e.g. "AE_SIF". Null where not applicable.',
    valueType: 'string',
    defaultValue: null,
    tenantOverridable: false,
  },
  {
    key: 'payroll.wps.deadline_days',
    domain: 'payroll',
    label: 'Days after period end by which wages must be paid',
    valueType: 'number',
    defaultValue: 15,
    unit: 'days',
    tenantOverridable: false,
  },
  {
    key: 'payroll.social_insurance',
    domain: 'payroll',
    label: 'Social insurance / pension contributions',
    description:
      'Employer and employee rates, and which nationalities they apply to. GCC schemes ' +
      'generally apply to nationals only.',
    valueType: 'json',
    defaultValue: null,
    tenantOverridable: false,
  },

  // --- Contract defaults --------------------------------------------------
  {
    key: 'contract.retention.default_percent',
    domain: 'contract',
    label: 'Default retention percentage',
    valueType: 'percent',
    defaultValue: 10,
    tenantOverridable: true,
  },
  {
    key: 'contract.retention.release_schedule',
    domain: 'contract',
    label: 'Retention release schedule',
    description: 'Proportion released at practical completion and at end of the defects period.',
    valueType: 'json',
    defaultValue: { practicalCompletion: 50, endOfDlp: 50 },
    tenantOverridable: true,
  },
  {
    key: 'contract.dlp.default_months',
    domain: 'contract',
    label: 'Default defects liability period',
    valueType: 'number',
    defaultValue: 12,
    unit: 'months',
    tenantOverridable: true,
  },
  {
    key: 'contract.payment_terms.default_days',
    domain: 'contract',
    label: 'Default payment terms',
    valueType: 'number',
    defaultValue: 60,
    unit: 'days',
    tenantOverridable: true,
  },

  // --- Documents and records ---------------------------------------------
  {
    key: 'document.retention.statutory_years',
    domain: 'compliance',
    label: 'Statutory record retention period',
    valueType: 'number',
    defaultValue: 5,
    unit: 'years',
    tenantOverridable: false,
  },
  {
    key: 'tax.invoice.required_fields',
    domain: 'tax',
    label: 'Mandatory tax invoice fields',
    description:
      'Field keys a compliant tax invoice must carry. Validated before an invoice can ' +
      'be issued, so non-compliant documents never reach a customer.',
    valueType: 'json',
    defaultValue: [],
    tenantOverridable: false,
  },
  {
    key: 'tax.invoice.language_requirement',
    domain: 'tax',
    label: 'Language a tax invoice must be issued in',
    valueType: 'json',
    defaultValue: ['en'],
    tenantOverridable: false,
  },

  // --- Accommodation ------------------------------------------------------
  {
    key: 'accommodation.max_occupants_per_room',
    domain: 'accommodation',
    label: 'Maximum occupants per room',
    description: 'Labour accommodation standard. Drives the occupancy compliance warning.',
    valueType: 'number',
    defaultValue: null,
    tenantOverridable: true,
  },
  {
    key: 'accommodation.min_area_per_occupant_sqm',
    domain: 'accommodation',
    label: 'Minimum floor area per occupant',
    valueType: 'number',
    defaultValue: null,
    unit: 'm2',
    tenantOverridable: true,
  },
];

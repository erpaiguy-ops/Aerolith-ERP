/**
 * Every shipped country pack must be valid. This runs in CI, so a malformed pack
 * fails the build rather than a customer's onboarding.
 */
import { describe, expect, it } from 'vitest';

import { KERNEL_RULE_DEFINITIONS } from './definitions';
import { loadAllCountryPacks, validatePackAgainstDefinitions } from './loader';
import { parseCountryPack } from './pack';

const knownKeys = new Set(KERNEL_RULE_DEFINITIONS.map((d) => d.key));
const packs = await loadAllCountryPacks();

describe('shipped country packs', () => {
  it('ships packs for the target markets', () => {
    const codes = packs.map((p) => p.code).sort();
    expect(codes).toEqual(['AE', 'BH', 'KW', 'OM', 'QA', 'SA']);
  });

  it.each(packs.map((p) => [p.code, p] as const))(
    '%s has no validation errors against the rule catalogue',
    (_code, pack) => {
      const errors = validatePackAgainstDefinitions(pack, knownKeys).filter(
        (i) => i.severity === 'error',
      );
      expect(errors).toEqual([]);
    },
  );

  it.each(packs.map((p) => [p.code, p] as const))(
    '%s declares a currency, timezone and weekend',
    (_code, pack) => {
      expect(pack.currencyCode).toHaveLength(3);
      expect(pack.defaultTimezone).toMatch(/^[A-Za-z]+\/[A-Za-z_]+$/);
      expect(pack.weekendDays.length).toBeGreaterThan(0);
    },
  );

  it.each(packs.map((p) => [p.code, p] as const))(
    '%s tracks the identity documents an expatriate workforce needs',
    (_code, pack) => {
      const employeeRequirements = pack.requirements.filter((r) => r.subject === 'employee');
      expect(employeeRequirements.length).toBeGreaterThan(0);
      expect(employeeRequirements.some((r) => r.code === 'PASSPORT')).toBe(true);
      // Something must gate onboarding, or the compliance module has no teeth.
      expect(employeeRequirements.some((r) => r.blocksOnboarding)).toBe(true);
    },
  );

  it.each(packs.map((p) => [p.code, p] as const))(
    '%s gives every expiry-tracked requirement a notice schedule',
    (_code, pack) => {
      for (const requirement of pack.requirements) {
        if (!requirement.hasExpiry) continue;
        expect(
          requirement.expiryNoticeDays.length,
          `${pack.code}/${requirement.code} has no expiry notices`,
        ).toBeGreaterThan(0);
      }
    },
  );

  it.each(packs.map((p) => [p.code, p] as const))(
    '%s declares exactly one tax regime with a usable default code',
    (_code, pack) => {
      expect(pack.taxRegimes.length).toBeGreaterThan(0);
      for (const regime of pack.taxRegimes) {
        expect(regime.taxCodes.filter((c) => c.isDefault)).toHaveLength(1);
      }
    },
  );

  it('models a country with no VAT without special-casing it', () => {
    // Qatar and Kuwait have no general consumption tax. That must be an ordinary
    // regime row, not a null the application has to branch on.
    const qatar = packs.find((p) => p.code === 'QA');
    expect(qatar?.taxRegimes[0]?.type).toBe('none');
    expect(qatar?.taxRegimes[0]?.taxCodes.length).toBeGreaterThan(0);
  });

  it('carries an address format that matches the country, not a generic one', () => {
    const uae = packs.find((p) => p.code === 'AE');
    const saudi = packs.find((p) => p.code === 'SA');

    // The UAE has no postcode; Saudi requires one plus a building number.
    expect(uae?.addressFormat.some((f) => f.key === 'postalCode')).toBe(false);
    expect(uae?.addressFormat.some((f) => f.key === 'poBox')).toBe(true);
    expect(saudi?.addressFormat.some((f) => f.key === 'postalCode' && f.required)).toBe(true);
  });

  it('sources every admin-division address field from real divisions', () => {
    for (const pack of packs) {
      const needsDivisions = pack.addressFormat.some((f) => f.source === 'admin_division');
      if (needsDivisions) {
        expect(pack.adminDivisions.length, `${pack.code} has no divisions`).toBeGreaterThan(0);
      }
    }
  });
});

describe('parseCountryPack', () => {
  const minimal = {
    packVersion: '1.0.0',
    code: 'XX',
    code3: 'XXX',
    name: 'Example',
    currencyCode: 'USD',
    defaultTimezone: 'UTC',
  };

  it('accepts a country defined with nothing but the essentials', () => {
    // A tenant admin adding an unsupported country starts here.
    const pack = parseCountryPack(minimal);
    expect(pack.requirements).toEqual([]);
    expect(pack.weekendDays).toEqual([6, 7]);
  });

  it('rejects a duplicate requirement code', () => {
    expect(() =>
      parseCountryPack({
        ...minimal,
        requirements: [
          { code: 'PASSPORT', name: 'Passport', subject: 'employee', category: 'identity' },
          { code: 'PASSPORT', name: 'Passport again', subject: 'employee', category: 'identity' },
        ],
      }),
    ).toThrow(/Duplicate requirement code/);
  });

  it('rejects a lowercase requirement code so codes stay stable identifiers', () => {
    expect(() =>
      parseCountryPack({
        ...minimal,
        requirements: [
          { code: 'passport', name: 'Passport', subject: 'employee', category: 'identity' },
        ],
      }),
    ).toThrow();
  });
});

describe('validatePackAgainstDefinitions', () => {
  it('errors on a rule key no module declares', () => {
    // Silently ignoring it would mean the setting looks configured but does
    // nothing — the worst failure mode for a payroll value.
    const pack = parseCountryPack({
      packVersion: '1.0.0',
      code: 'XX',
      code3: 'XXX',
      name: 'Example',
      currencyCode: 'USD',
      defaultTimezone: 'UTC',
      rules: { 'payroll.invented.setting': 5 },
    });

    const issues = validatePackAgainstDefinitions(pack, knownKeys);
    expect(issues.some((i) => i.severity === 'error' && i.message.includes('invented'))).toBe(true);
  });

  it('only warns when a country leaves a rule at the global default', () => {
    const pack = parseCountryPack({
      packVersion: '1.0.0',
      code: 'XX',
      code3: 'XXX',
      name: 'Example',
      currencyCode: 'USD',
      defaultTimezone: 'UTC',
    });

    const issues = validatePackAgainstDefinitions(pack, knownKeys);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(issues.filter((i) => i.severity === 'warning').length).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from 'vitest';

import {
  UnknownRuleError,
  buildSnapshot,
  resolveDomain,
  resolveRule,
  validateRuleValue,
  type RuleDefinitionRecord,
  type RuleRecord,
} from './rules';

const definitions: RuleDefinitionRecord[] = [
  {
    key: 'hr.leave.annual_days',
    valueType: 'number',
    defaultValue: 30,
    tenantOverridable: true,
  },
  {
    key: 'payroll.overtime.weekday_multiplier',
    valueType: 'number',
    defaultValue: 1.25,
    tenantOverridable: false,
  },
  {
    key: 'payroll.wps.enabled',
    valueType: 'boolean',
    defaultValue: false,
    tenantOverridable: false,
  },
  {
    key: 'contract.retention.default_percent',
    valueType: 'percent',
    defaultValue: 10,
    tenantOverridable: true,
  },
];

const rule = (
  key: string,
  value: unknown,
  from = '2000-01-01',
  to: string | null = null,
  source?: string,
): RuleRecord => ({
  key,
  value,
  effectiveFrom: new Date(from),
  effectiveTo: to ? new Date(to) : null,
  sourceReference: source ?? null,
});

describe('resolveRule', () => {
  it('falls back to the global default when nothing else is set', () => {
    const snapshot = buildSnapshot({ definitions, countryValues: [], tenantValues: [] });
    const resolved = resolveRule(snapshot, 'hr.leave.annual_days');

    expect(resolved.value).toBe(30);
    expect(resolved.layer).toBe('default');
  });

  it('prefers the country value over the default', () => {
    const snapshot = buildSnapshot({
      definitions,
      countryValues: [rule('hr.leave.annual_days', 21, '2000-01-01', null, 'Qatar Labour Law')],
      tenantValues: [],
    });
    const resolved = resolveRule(snapshot, 'hr.leave.annual_days');

    expect(resolved.value).toBe(21);
    expect(resolved.layer).toBe('country');
    expect(resolved.source).toBe('Qatar Labour Law');
  });

  it('prefers the tenant override over the country value', () => {
    const snapshot = buildSnapshot({
      definitions,
      countryValues: [rule('hr.leave.annual_days', 21)],
      tenantValues: [rule('hr.leave.annual_days', 25)],
    });
    const resolved = resolveRule(snapshot, 'hr.leave.annual_days');

    expect(resolved.value).toBe(25);
    expect(resolved.layer).toBe('tenant');
  });

  it('ignores a tenant override on a statutory rule', () => {
    // A tenant cannot contract out of the statutory overtime multiplier, so the
    // override must be inert even if a row somehow exists.
    const snapshot = buildSnapshot({
      definitions,
      countryValues: [rule('payroll.overtime.weekday_multiplier', 1.5)],
      tenantValues: [rule('payroll.overtime.weekday_multiplier', 1.0)],
    });
    const resolved = resolveRule(snapshot, 'payroll.overtime.weekday_multiplier');

    expect(resolved.value).toBe(1.5);
    expect(resolved.layer).toBe('country');
  });

  it('throws on an undeclared rule rather than returning undefined', () => {
    const snapshot = buildSnapshot({ definitions, countryValues: [], tenantValues: [] });
    expect(() => resolveRule(snapshot, 'payroll.made.up')).toThrow(UnknownRuleError);
  });

  it('preserves a JSON null value as the answer', () => {
    // "No end-of-service cap" is a real answer, not an absent one.
    const snapshot = buildSnapshot({
      definitions: [
        { key: 'payroll.eosb.cap', valueType: 'json', defaultValue: 2, tenantOverridable: false },
      ],
      countryValues: [rule('payroll.eosb.cap', null)],
      tenantValues: [],
    });
    const resolved = resolveRule(snapshot, 'payroll.eosb.cap');

    expect(resolved.value).toBeNull();
    expect(resolved.layer).toBe('country');
  });
});

describe('resolveRule effectivity', () => {
  it('returns the value in force at the given date, not the latest', () => {
    // Reprinting a 2023 invoice or recalculating a 2023 payroll must reproduce
    // the original numbers.
    const snapshot = buildSnapshot({
      definitions,
      countryValues: [
        rule('contract.retention.default_percent', 10, '2000-01-01', '2024-01-01'),
        rule('contract.retention.default_percent', 5, '2024-01-01'),
      ],
      tenantValues: [],
    });

    expect(resolveRule(snapshot, 'contract.retention.default_percent', new Date('2023-06-01')).value).toBe(10);
    expect(resolveRule(snapshot, 'contract.retention.default_percent', new Date('2025-06-01')).value).toBe(5);
  });

  it('ignores a value that has not taken effect yet', () => {
    const snapshot = buildSnapshot({
      definitions,
      countryValues: [rule('hr.leave.annual_days', 21, '2030-01-01')],
      tenantValues: [],
    });

    expect(resolveRule(snapshot, 'hr.leave.annual_days', new Date('2026-01-01')).layer).toBe(
      'default',
    );
  });

  it('takes the most recently started value when windows overlap', () => {
    // Backdated corrections overlap by nature; the later correction wins.
    const snapshot = buildSnapshot({
      definitions,
      countryValues: [
        rule('hr.leave.annual_days', 21, '2020-01-01'),
        rule('hr.leave.annual_days', 22, '2023-01-01'),
      ],
      tenantValues: [],
    });

    expect(resolveRule(snapshot, 'hr.leave.annual_days', new Date('2026-01-01')).value).toBe(22);
  });
});

describe('resolveDomain', () => {
  it('returns every rule under a prefix', () => {
    const snapshot = buildSnapshot({
      definitions,
      countryValues: [rule('payroll.wps.enabled', true)],
      tenantValues: [],
    });
    const resolved = resolveDomain(snapshot, 'payroll');

    expect(resolved.map((r) => r.key)).toEqual([
      'payroll.overtime.weekday_multiplier',
      'payroll.wps.enabled',
    ]);
    expect(resolved.find((r) => r.key === 'payroll.wps.enabled')?.value).toBe(true);
  });

  it('does not match a prefix that is only a string prefix', () => {
    const snapshot = buildSnapshot({
      definitions: [
        { key: 'hr.leave.annual_days', valueType: 'number', defaultValue: 30, tenantOverridable: true },
        { key: 'hrm.other', valueType: 'number', defaultValue: 1, tenantOverridable: true },
      ],
      countryValues: [],
      tenantValues: [],
    });

    expect(resolveDomain(snapshot, 'hr').map((r) => r.key)).toEqual(['hr.leave.annual_days']);
  });
});

describe('validateRuleValue', () => {
  it('rejects a string where a number is declared', () => {
    const result = validateRuleValue(
      { key: 'x', valueType: 'number', defaultValue: 1, tenantOverridable: true },
      'twenty-one',
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a percentage outside 0-100', () => {
    const result = validateRuleValue(
      { key: 'x', valueType: 'percent', defaultValue: 10, tenantOverridable: true },
      140,
    );
    expect(result.ok).toBe(false);
  });

  it('accepts a well-formed value', () => {
    const result = validateRuleValue(
      { key: 'x', valueType: 'percent', defaultValue: 10, tenantOverridable: true },
      12.5,
    );
    expect(result.ok).toBe(true);
  });
});

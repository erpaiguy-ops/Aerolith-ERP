import { describe, expect, it } from 'vitest';

import { diffRecords, redactChanges } from './service';

describe('diffRecords', () => {
  it('keeps only the fields that actually changed', () => {
    const changes = diffRecords(
      { name: 'Emaar', creditLimit: 100000, isBlocked: false },
      { name: 'Emaar Properties', creditLimit: 100000, isBlocked: false },
    );

    expect(Object.keys(changes)).toEqual(['name']);
    expect(changes.name).toEqual({ from: 'Emaar', to: 'Emaar Properties' });
  });

  it('ignores bookkeeping columns that change on every write', () => {
    const changes = diffRecords(
      { name: 'A', updatedAt: new Date('2026-01-01'), updatedBy: 'u1' },
      { name: 'A', updatedAt: new Date('2026-02-01'), updatedBy: 'u2' },
    );

    expect(changes).toEqual({});
  });

  it('compares dates by value, not identity', () => {
    const changes = diffRecords(
      { startDate: new Date('2026-01-01') },
      { startDate: new Date('2026-01-01') },
    );
    expect(changes).toEqual({});
  });

  it('detects added and removed fields', () => {
    const changes = diffRecords({ a: 1 }, { b: 2 });
    expect(changes.a).toEqual({ from: 1, to: undefined });
    expect(changes.b).toEqual({ from: undefined, to: 2 });
  });

  it('compares nested objects structurally', () => {
    expect(diffRecords({ address: { city: 'Dubai' } }, { address: { city: 'Dubai' } })).toEqual({});
    expect(
      Object.keys(diffRecords({ address: { city: 'Dubai' } }, { address: { city: 'Doha' } })),
    ).toEqual(['address']);
  });
});

describe('redactChanges', () => {
  it('records that a salary changed without recording the values', () => {
    // Otherwise the audit trail becomes the easiest way around field-level
    // permissions on payroll data.
    const { changes, redacted } = redactChanges({
      basicSalary: { from: 8000, to: 9500 },
      jobTitle: { from: 'Joiner', to: 'Senior Joiner' },
    });

    expect(changes!.basicSalary).toEqual({ from: '[redacted]', to: '[redacted]' });
    expect(changes!.jobTitle).toEqual({ from: 'Joiner', to: 'Senior Joiner' });
    expect(redacted).toEqual(['basicSalary']);
  });

  it('redacts regardless of naming convention', () => {
    const { redacted } = redactChanges({
      bank_account: { from: 'a', to: 'b' },
      'employee.passportNumber': { from: 'x', to: 'y' },
      IBAN: { from: '1', to: '2' },
    });

    expect(redacted.sort()).toEqual(['IBAN', 'bank_account', 'employee.passportNumber']);
  });

  it('accepts extra sensitive fields from the caller', () => {
    const { redacted } = redactChanges({ tenderMargin: { from: 12, to: 18 } }, ['tenderMargin']);
    expect(redacted).toEqual(['tenderMargin']);
  });

  it('returns null for an empty change set so no row records nothing', () => {
    expect(redactChanges({}).changes).toBeNull();
    expect(redactChanges(undefined).changes).toBeNull();
  });

  it('leaves ordinary fields untouched', () => {
    const { changes, redacted } = redactChanges({ name: { from: 'A', to: 'B' } });
    expect(changes!.name).toEqual({ from: 'A', to: 'B' });
    expect(redacted).toEqual([]);
  });
});

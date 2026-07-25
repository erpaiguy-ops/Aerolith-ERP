import { describe, expect, it } from 'vitest';

import { contractsModule } from './manifest';

describe('contracts manifest', () => {
  it('declares the number series the service allocates against', () => {
    const declared = new Set(contractsModule.numberSeries.map((s) => s.entityType));
    expect(declared).toContain('contracts.contract');
    expect(declared).toContain('contracts.variation');
    expect(declared).toContain('contracts.payment_application');
  });

  it('gives every series a sequence and a year token', () => {
    for (const series of contractsModule.numberSeries) {
      expect(series.pattern).toContain('{SEQ}');
      expect(series.pattern).toMatch(/\{(YYYY|YY|FY)\}/);
    }
  });

  it('depends on the kernel alone, so a subcontractor can buy just this', () => {
    // Progress-driven valuation is composed with Projects at the application
    // layer; without it a QS enters measured quantities directly, which is
    // exactly how it is done today.
    expect(contractsModule.dependsOn).toEqual(['kernel']);
    expect(contractsModule.integratesWith).toContain('projects');
    expect(contractsModule.standalone).toBe(true);
  });

  it('owns exactly one Postgres schema, named after itself', () => {
    expect(contractsModule.dbSchema).toBe('contracts');
  });

  it('namespaces every permission, event and rule under its own key', () => {
    for (const permission of contractsModule.permissions) {
      expect(permission.key.startsWith('contracts.')).toBe(true);
    }
    for (const event of contractsModule.events.emits) {
      expect(event.type.startsWith('contracts.')).toBe(true);
    }
    for (const rule of contractsModule.rules) {
      expect(rule.key.startsWith('contracts.')).toBe(true);
    }
  });

  it('gates every navigation leaf on a permission it declares', () => {
    const declared = new Set(contractsModule.permissions.map((p) => p.key));

    const walk = (items: typeof contractsModule.nav) => {
      for (const item of items) {
        if (item.permission) expect(declared).toContain(item.permission);
        if (item.children) walk(item.children);
      }
    };

    walk(contractsModule.nav);
  });

  it('does not redeclare the contract rules the country packs already own', () => {
    // retention percent, release schedule, DLP and payment terms are `contract.*`
    // kernel rules populated per country. Redeclaring them here would create a
    // second source of truth for the same fact — the exact failure the
    // localisation design exists to prevent.
    const keys = contractsModule.rules.map((r) => r.key);
    expect(keys).not.toContain('contract.retention.default_percent');
    expect(keys).not.toContain('contract.retention.release_schedule');
    expect(keys).not.toContain('contract.dlp.default_months');
    expect(keys).not.toContain('contract.payment_terms.default_days');
  });

  it('marks the actions that move money or give up leverage as dangerous', () => {
    const dangerous = contractsModule.permissions.filter((p) => p.isDangerous).map((p) => p.key);
    // Approving a variation is the only thing that changes the contract sum.
    expect(dangerous).toContain('contracts.variation.approve');
    // Releasing retention gives away what gets snags finished.
    expect(dangerous).toContain('contracts.retention.release');
    expect(dangerous).toContain('contracts.application.submit');
  });

  it('emits the time-bar warning that is the module’s reason to exist', () => {
    const emitted = contractsModule.events.emits.map((e) => e.type);
    expect(emitted).toContain('contracts.variation.time_barred');
    expect(emitted).toContain('contracts.application.certified');
  });
});

import { describe, expect, it } from 'vitest';

import { projectsModule } from './manifest';

describe('projects manifest', () => {
  it('declares the number series the service allocates against', () => {
    const declared = new Set(projectsModule.numberSeries.map((s) => s.entityType));
    expect(declared).toContain('projects.snag');
  });

  it('gives every series a sequence and a year token', () => {
    for (const series of projectsModule.numberSeries) {
      expect(series.pattern).toContain('{SEQ}');
      expect(series.pattern).toMatch(/\{(YYYY|YY|FY)\}/);
    }
  });

  it('depends on the kernel alone, which is what makes it sellable by itself', () => {
    // Possible only because `kernel.project` is kernel-owned: this module adds
    // budgets and a cost ledger to a project it did not have to invent.
    expect(projectsModule.dependsOn).toEqual(['kernel']);
    expect(projectsModule.integratesWith).toEqual(
      expect.arrayContaining(['estimation', 'production', 'contracts']),
    );
    expect(projectsModule.standalone).toBe(true);
  });

  it('owns exactly one Postgres schema, named after itself', () => {
    expect(projectsModule.dbSchema).toBe('projects');
  });

  it('namespaces every permission, event and rule under its own key', () => {
    for (const permission of projectsModule.permissions) {
      expect(permission.key.startsWith('projects.')).toBe(true);
    }
    for (const event of projectsModule.events.emits) {
      expect(event.type.startsWith('projects.')).toBe(true);
    }
    for (const rule of projectsModule.rules) {
      expect(rule.key.startsWith('projects.')).toBe(true);
    }
  });

  it('gates every navigation leaf on a permission it declares', () => {
    const declared = new Set(projectsModule.permissions.map((p) => p.key));

    const walk = (items: typeof projectsModule.nav) => {
      for (const item of items) {
        if (item.permission) expect(declared).toContain(item.permission);
        if (item.children) walk(item.children);
      }
    };

    walk(projectsModule.nav);
  });

  it('separates reading job costs from seeing the forecast margin', () => {
    // A site engineer needs the cost report. The forecast margin is a different
    // conversation, held by different people.
    const keys = projectsModule.permissions.map((p) => p.key);
    expect(keys).toContain('projects.cost.read');
    expect(keys).toContain('projects.margin.view');
  });

  it('marks manual progress claims and budget approval as dangerous', () => {
    const dangerous = projectsModule.permissions.filter((p) => p.isDangerous).map((p) => p.key);
    expect(dangerous).toContain('projects.progress.override');
    expect(dangerous).toContain('projects.budget.approve');
  });

  it('consumes the events that seed and revise a budget', () => {
    expect(projectsModule.events.consumes).toContain('estimation.tender.won');
    expect(projectsModule.events.consumes).toContain('contracts.variation.approved');
  });
});

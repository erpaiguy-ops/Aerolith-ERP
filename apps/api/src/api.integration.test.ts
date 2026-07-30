/**
 * End-to-end API tests: real HTTP, real database, real RLS.
 *
 * Skipped when TEST_DATABASE_URL is unset.
 *
 * The point of the module tests here is requirement 19 — the SAME running
 * server returns a focused single-module product to one tenant and the full
 * ERP to another, decided by entitlement rows alone.
 */
import { createHash, randomUUID } from 'node:crypto';

import { closeDatabase, createDatabase, getDatabase, schema } from '@aerolith/kernel';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { invalidateTenantModules, syncModules } from './bootstrap';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const TENANT_FULL = '44444444-4444-4444-8444-444444444444';
const TENANT_SOLO = '55555555-5555-4555-8555-555555555555';
const OWNER = 'bbbbbbbb-0000-4000-8000-000000000001';
const STAFF = 'bbbbbbbb-0000-4000-8000-000000000002';

const OWNER_TOKEN = 'owner-token-for-tests';
const STAFF_TOKEN = 'staff-token-for-tests';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

suite('API', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    createDatabase({ connectionString: url! });
    await syncModules();

    const db = getDatabase();

    await db.insert(schema.tenant).values([
      {
        id: TENANT_FULL,
        slug: 'full-erp',
        name: 'Full ERP Co',
        status: 'active',
        primaryCountryCode: 'AE',
        baseCurrencyCode: 'AED',
        timezone: 'Asia/Dubai',
      },
      {
        id: TENANT_SOLO,
        slug: 'solo-inventory',
        name: 'Inventory Only Co',
        status: 'active',
        primaryCountryCode: 'QA',
        baseCurrencyCode: 'QAR',
        timezone: 'Asia/Qatar',
      },
    ]);

    await db.insert(schema.appUser).values([
      { id: OWNER, email: 'owner@api.test', name: 'Owner', locale: 'en' },
      { id: STAFF, email: 'staff@api.test', name: 'Staff', locale: 'en' },
    ]);

    await db.insert(schema.membership).values([
      { tenantId: TENANT_FULL, userId: OWNER, status: 'active', isOwner: true },
      { tenantId: TENANT_FULL, userId: STAFF, status: 'active', isOwner: false },
      { tenantId: TENANT_SOLO, userId: OWNER, status: 'active', isOwner: true },
    ]);

    const expiresAt = new Date(Date.now() + 3_600_000);
    await db.insert(schema.session).values([
      { userId: OWNER, tenantId: TENANT_FULL, tokenHash: hash(OWNER_TOKEN), expiresAt },
      { userId: STAFF, tenantId: TENANT_FULL, tokenHash: hash(STAFF_TOKEN), expiresAt },
    ]);

    // Entitlements: this is the ONLY difference between the two tenants.
    await db.insert(schema.tenantModule).values([
      { tenantId: TENANT_FULL, moduleKey: 'inventory', status: 'enabled' },
      { tenantId: TENANT_SOLO, moduleKey: 'inventory', status: 'enabled' },
    ]);

    invalidateTenantModules();
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    const db = getDatabase();
    const tenants = [TENANT_FULL, TENANT_SOLO];
    await db.delete(schema.partyContact).where(inArray(schema.partyContact.tenantId, tenants));
    await db.delete(schema.party).where(inArray(schema.party.tenantId, tenants));
    await db.delete(schema.tenantRequirement).where(inArray(schema.tenantRequirement.tenantId, tenants));
    await db.delete(schema.tenantTaxCode).where(inArray(schema.tenantTaxCode.tenantId, tenants));
    await db.delete(schema.tenantHoliday).where(inArray(schema.tenantHoliday.tenantId, tenants));
    await db.delete(schema.tenantRuleValue).where(inArray(schema.tenantRuleValue.tenantId, tenants));
    await db
      .delete(schema.tenantLocalisation)
      .where(inArray(schema.tenantLocalisation.tenantId, tenants));
    await db.delete(schema.tenantModule).where(inArray(schema.tenantModule.tenantId, tenants));

    // Roles and their grants, and anybody the administration suite added. The
    // suite creates roles with fixed codes, so leaving them behind makes a
    // second run collide on `role_uq` — idempotent by accident of always being
    // run against a fresh database is not idempotent.
    const created = await db
      .select({ id: schema.appUser.id })
      .from(schema.appUser)
      .where(inArray(schema.appUser.email, ['newcomer@full.test']));
    const userIds = [OWNER, STAFF, ...created.map((u) => u.id)];

    await db.delete(schema.userRole).where(inArray(schema.userRole.tenantId, tenants));
    await db.delete(schema.rolePermission).where(inArray(schema.rolePermission.tenantId, tenants));
    await db.delete(schema.role).where(inArray(schema.role.tenantId, tenants));

    await db.delete(schema.session).where(inArray(schema.session.userId, userIds));
    await db.delete(schema.membership).where(inArray(schema.membership.tenantId, tenants));
    await db.delete(schema.appUser).where(inArray(schema.appUser.id, userIds));
    await db.delete(schema.tenant).where(inArray(schema.tenant.id, tenants));
    await app.close();
    await closeDatabase();
  });

  const auth = (token: string, tenantId?: string) => ({
    authorization: `Bearer ${token}`,
    ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
  });

  // -------------------------------------------------------------------------

  describe('health and auth', () => {
    it('serves health without a token', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('ok');
    });

    it('rejects a request with no token', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/me' });
      expect(response.statusCode).toBe(401);
    });

    it('rejects a bogus token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: auth('not-a-real-token'),
      });
      expect(response.statusCode).toBe(401);
    });

    it('refuses a tenant the user is not a member of, without confirming it exists', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: auth(STAFF_TOKEN, TENANT_SOLO),
      });

      expect(response.statusCode).toBe(401);
      // Same message as a bad token — no probing which tenants exist.
      expect(response.json().error).toBe('Session is invalid or expired.');
    });

    it('authenticates and resolves the tenant', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: auth(OWNER_TOKEN),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.user.id).toBe(OWNER);
      expect(body.tenant.countryCode).toBe('AE');
      expect(body.tenant.currencyCode).toBe('AED');
    });
  });

  describe('modules and entitlements', () => {
    it('lists what this deployment could serve', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/modules/catalogue' });
      expect(response.statusCode).toBe(200);
      expect(response.json().modules.map((m: { key: string }) => m.key)).toContain('inventory');
    });

    it('serves a tenant only its entitled modules, with navigation', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: auth(OWNER_TOKEN),
      });

      const body = response.json();
      expect(body.modules.map((m: { key: string }) => m.key)).toEqual(['inventory']);
      // The kernel approvals, notifications and master-data sections sit
      // above every module, so the first MODULE entry is the fourth item.
      expect(body.navigation[0].key).toBe('kernel.approvals');
      expect(body.navigation[1].key).toBe('kernel.notifications');
      expect(body.navigation[2].key).toBe('kernel.master_data.parties');
      expect(body.navigation[3].key).toBe('inventory');
      expect(body.unavailableModules).toEqual([]);
    });

    it('orders the menu by intent, not by module dependency order', async () => {
      const db = getDatabase();
      await db.insert(schema.tenantModule).values(
        ['estimation', 'production', 'projects', 'contracts'].map((moduleKey) => ({
          tenantId: TENANT_FULL,
          moduleKey,
          status: 'enabled' as const,
        })),
      );
      invalidateTenantModules(TENANT_FULL);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: auth(OWNER_TOKEN),
      });

      const keys = response.json().navigation.map((n: { key: string }) => n.key);

      // Dependency order is the right order to BOOT modules in and the wrong
      // order to show a menu in — it put Contracts above Estimating, reversing
      // the workflow the product is arranged around.
      expect(keys.indexOf('estimation')).toBeLessThan(keys.indexOf('production'));
      expect(keys.indexOf('production')).toBeLessThan(keys.indexOf('projects'));
      expect(keys.indexOf('projects')).toBeLessThan(keys.indexOf('contracts'));

      await db
        .delete(schema.tenantModule)
        .where(
          and(
            eq(schema.tenantModule.tenantId, TENANT_FULL),
            inArray(schema.tenantModule.moduleKey, [
              'estimation',
              'production',
              'projects',
              'contracts',
            ]),
          ),
        );
      invalidateTenantModules(TENANT_FULL);
    });

    it('gives an owner every permission', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: auth(OWNER_TOKEN),
      });

      const permissions: string[] = response.json().permissions;
      expect(permissions).toContain('kernel.localisation.manage');
      expect(permissions).toContain('inventory.stock_count.reconcile');
    });

    it('gives a non-owner with no roles nothing, and empty navigation', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: auth(STAFF_TOKEN),
      });

      const body = response.json();
      expect(body.permissions).toEqual([]);
      // Every MODULE nav item is permission-gated, so the menu carries no links
      // that would 403. What remains is the kernel approvals and notifications
      // sections, neither of which is permission-gated: an approver's authority
      // is the task assignment itself, and a notification is addressed to this
      // user specifically, so a user with no roles can still reach both.
      // Neither route 403s for anybody, so the principle this test protects is
      // intact.
      expect(body.navigation.map((item: { key: string }) => item.key)).toEqual([
        'kernel.approvals',
        'kernel.notifications',
      ]);
    });

    it('reports an entitlement this deployment cannot serve instead of hiding it', async () => {
      const db = getDatabase();
      await db
        .insert(schema.tenantModule)
        // A deliberately synthetic key rather than a module that is merely
        // unbuilt today: the assertion is about the registry failing to resolve
        // an entitlement, and pointing it at a real roadmap module means this
        // test breaks every time one of them ships.
        .values({ tenantId: TENANT_FULL, moduleKey: 'not_a_shipped_module', status: 'enabled' });
      invalidateTenantModules(TENANT_FULL);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: auth(OWNER_TOKEN),
      });

      expect(response.json().unavailableModules).toContainEqual({
        key: 'not_a_shipped_module',
        reason: 'Module is not present in this deployment.',
      });

      await db
        .delete(schema.tenantModule)
        .where(eq(schema.tenantModule.moduleKey, 'not_a_shipped_module'));
      invalidateTenantModules(TENANT_FULL);
    });
  });

  describe('workspace administration', () => {
    // Everything here was in the schema and unreachable until this suite: a
    // workspace had exactly the users a SQL script had inserted, and the three
    // kernel permissions that gate it had never been checked by anything.

    it('lists members with their roles, scoped by membership and not by user', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/members',
        headers: auth(OWNER_TOKEN),
      });

      expect(response.statusCode).toBe(200);
      const emails = response.json().members.map((m: { email: string }) => m.email);
      expect(emails).toContain('owner@api.test');
      expect(emails).toContain('staff@api.test');

      // `app_user` is global and carries no RLS, so the tenant boundary on this
      // list has to come from `membership`. The same owner is a member of both
      // tenants and the staff user of only one: asked as the other tenant, the
      // list must be the owner alone.
      const solo = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/members',
        headers: auth(OWNER_TOKEN, TENANT_SOLO),
      });
      const soloEmails = solo.json().members.map((m: { email: string }) => m.email);
      expect(soloEmails).toEqual(['owner@api.test']);
    });

    it('refuses to manage users without the permission', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/members',
        headers: auth(STAFF_TOKEN),
        payload: { email: 'nope@full.test', name: 'Nope', password: 'a-long-enough-password' },
      });

      expect(response.statusCode).toBe(403);
    });

    it('creates a role, grants it, and the grant reaches /me', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/roles',
        headers: auth(OWNER_TOKEN),
        payload: {
          code: 'test_storekeeper',
          name: 'Test Storekeeper',
          permissionKeys: ['inventory.stock.read', 'inventory.item.read'],
        },
      });

      expect(created.statusCode).toBe(200);
      const { roleId } = created.json();

      // The code is normalised: a role code is an identifier, and `test_storekeeper`
      // and `TEST_STOREKEEPER` are not two roles.
      const roles = (
        await app.inject({ method: 'GET', url: '/api/v1/admin/roles', headers: auth(OWNER_TOKEN) })
      ).json().roles;
      const role = roles.find((r: { id: string }) => r.id === roleId);
      expect(role.code).toBe('TEST_STOREKEEPER');
      expect(role.permissionKeys).toEqual(['inventory.item.read', 'inventory.stock.read']);

      await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/members/${STAFF}`,
        headers: auth(OWNER_TOKEN),
        payload: { roleIds: [roleId] },
      });

      // The whole point: a permission granted here is a permission the rest of
      // the application enforces on the next request.
      const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(STAFF_TOKEN) });
      expect(me.json().permissions).toContain('inventory.stock.read');

      // Handed back. `STAFF` is the suite's shared "non-owner with nothing", and
      // another test asserts they see an empty navigation — leaving this grant
      // in place makes that test pass or fail on execution order.
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/members/${STAFF}`,
        headers: auth(OWNER_TOKEN),
        payload: { roleIds: [] },
      });
    });

    it('replaces a role\'s permissions rather than adding to them', async () => {
      const { roleId } = (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/roles',
          headers: auth(OWNER_TOKEN),
          payload: { code: 'REPLACE_ME', name: 'Replace me', permissionKeys: ['inventory.stock.read'] },
        })
      ).json();

      await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/roles/${roleId}`,
        headers: auth(OWNER_TOKEN),
        payload: { permissionKeys: ['inventory.item.read'] },
      });

      const roles = (
        await app.inject({ method: 'GET', url: '/api/v1/admin/roles', headers: auth(OWNER_TOKEN) })
      ).json().roles;
      const role = roles.find((r: { id: string }) => r.id === roleId);

      // A tick box screen means "these are the permissions". Add-only behind it
      // would silently ignore every box the admin cleared.
      expect(role.permissionKeys).toEqual(['inventory.item.read']);
    });

    it('rejects a permission key no module declares', async () => {
      const { roleId } = (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/roles',
          headers: auth(OWNER_TOKEN),
          payload: { code: 'BAD_KEYS', name: 'Bad keys' },
        })
      ).json();

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/roles/${roleId}`,
        headers: auth(OWNER_TOKEN),
        payload: { permissionKeys: ['inventory.invented.superpower'] },
      });

      // A key nothing enforces grants nothing and looks like it grants
      // something, which is how a permissions screen lies.
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain('inventory.invented.superpower');
    });

    it('adds a member, refuses the same one twice, and revokes on suspension', async () => {
      const added = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/members',
        headers: auth(OWNER_TOKEN),
        payload: {
          email: 'newcomer@full.test',
          name: 'Newcomer',
          password: 'a-long-enough-password',
        },
      });

      expect(added.statusCode).toBe(200);
      expect(added.json().accountCreated).toBe(true);
      const { userId } = added.json();

      const again = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/members',
        headers: auth(OWNER_TOKEN),
        payload: {
          email: 'newcomer@full.test',
          name: 'Newcomer',
          password: 'a-long-enough-password',
        },
      });
      expect(again.statusCode).toBe(409);

      const db = getDatabase();
      const expiresAt = new Date(Date.now() + 3_600_000);
      await db.insert(schema.session).values({
        userId,
        tenantId: TENANT_FULL,
        tokenHash: hash('newcomer-token'),
        expiresAt,
      });

      await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/members/${userId}`,
        headers: auth(OWNER_TOKEN),
        payload: { status: 'suspended' },
      });

      // Suspension that leaves a live session is a statement of intent, not a
      // control.
      const after = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: auth('newcomer-token'),
      });
      expect(after.statusCode).toBe(401);
    });

    it('refuses to strip the last owner', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/members/${OWNER}`,
        headers: auth(OWNER_TOKEN),
        payload: { isOwner: false },
      });

      // A workspace with no owner is one nobody can administer: the only way
      // back is the permission matrix, and granting on it needs somebody who
      // already can.
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain('last owner');
    });

    it('gives every permission a category, so none lands in "Other"', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/permissions',
        headers: auth(OWNER_TOKEN),
      });

      const permissions = response.json().permissions;
      expect(permissions.length).toBeGreaterThan(50);
      // 63 of 76 had none, because no module declared one and the sync did not
      // default it. A permission matrix where five sixths of the rows group
      // under "Other" is not a matrix.
      expect(permissions.every((p: { category: string | null }) => p.category)).toBe(true);
    });
  });

  describe('localisation', () => {
    it('lists the seeded countries', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/localisation/countries',
        headers: auth(OWNER_TOKEN),
      });

      expect(response.statusCode).toBe(200);
      const codes = response.json().countries.map((c: { code: string }) => c.code);
      expect(codes).toEqual(expect.arrayContaining(['AE', 'QA', 'SA']));
    });

    it('returns a country with the address shape the UI needs', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/localisation/countries/AE',
        headers: auth(OWNER_TOKEN),
      });

      const body = response.json();
      expect(body.country.adminDivisionLabel).toBe('Emirate');
      expect(body.divisions.map((d: { code: string }) => d.code)).toContain('DU');
      expect(body.country.addressFormat.some((f: { key: string }) => f.key === 'poBox')).toBe(true);
    });

    it('404s an unknown country rather than returning an empty shell', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/localisation/countries/ZZ',
        headers: auth(OWNER_TOKEN),
      });
      expect(response.statusCode).toBe(404);
    });

    it('refuses adoption without the permission', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/localisation/adopt',
        headers: auth(STAFF_TOKEN),
        payload: { countryCode: 'AE' },
      });

      expect(response.statusCode).toBe(403);
    });

    it('adopts a country and pre-fills the tenant requirement set', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/localisation/adopt',
        headers: auth(OWNER_TOKEN),
        payload: { countryCode: 'AE', isPrimary: true },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().requirementsCopied).toBeGreaterThan(0);

      const requirements = await app.inject({
        method: 'GET',
        url: '/api/v1/localisation/requirements?subject=employee',
        headers: auth(OWNER_TOKEN),
      });

      const codes = requirements.json().requirements.map((r: { code: string }) => r.code);
      expect(codes).toContain('EMIRATES_ID');
      expect(codes).toContain('LABOUR_CARD');
    });

    it('serves the adopted tax codes', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/localisation/tax-codes',
        headers: auth(OWNER_TOKEN),
      });

      const standard = response
        .json()
        .taxCodes.find((c: { code: string }) => c.code === 'SR');
      expect(Number(standard.rate)).toBe(5);
    });

    it('resolves rules and reports which layer answered', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/localisation/rules?domain=payroll',
        headers: auth(OWNER_TOKEN),
      });

      expect(response.statusCode).toBe(200);
      const rules = response.json().rules;
      const wps = rules.find((r: { key: string }) => r.key === 'payroll.wps.enabled');
      expect(wps.value).toBe(true);
      expect(wps.layer).toBe('country');
    });

    it('filters by the declared domain, not by the key prefix', async () => {
      // Two different questions wearing the same word. 18 rules are declared in
      // the `contract` domain and only four have keys starting `contract.` —
      // the rest are `contracts.`, `estimation.` and `projects.`, because a
      // module declares which domain a knob BELONGS to independently of what it
      // called the knob. Prefix-matching showed four of eighteen under a filter
      // labelled "contract", which is worse than no filter: it looks complete.
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/localisation/rules?domain=contract',
        headers: auth(OWNER_TOKEN),
      });

      expect(response.statusCode).toBe(200);
      const rules = response.json().rules;

      expect(rules.every((r: { domain: string }) => r.domain === 'contract')).toBe(true);
      const keys = rules.map((r: { key: string }) => r.key);
      expect(keys).toContain('contract.retention.default_percent');
      // The ones a prefix filter drops.
      expect(keys).toContain('contracts.variation.notice_period_days');
      expect(keys).toContain('projects.budget.contingency_percent');
    });

    it('summarises the whole rule set whatever the filter, and names each knob', async () => {
      const all = await app.inject({
        method: 'GET',
        url: '/api/v1/localisation/rules',
        headers: auth(OWNER_TOKEN),
      });
      const filtered = await app.inject({
        method: 'GET',
        url: '/api/v1/localisation/rules?domain=tax',
        headers: auth(OWNER_TOKEN),
      });

      // "How much of this workspace's configuration is actually ours" is a
      // question about the workspace. A figure that silently rescopes when a
      // filter is set is a figure that gets quoted wrongly.
      expect(filtered.json().summary).toEqual(all.json().summary);
      expect(filtered.json().rules.length).toBeLessThan(all.json().rules.length);

      const summary = all.json().summary;
      expect(summary.total).toBe(all.json().rules.length);
      expect(summary.tenant + summary.country + summary.default).toBe(summary.total);

      // Every rule carries what an admin needs to edit it safely: what it is,
      // what shape a value takes, and whether it may be touched at all.
      const retention = all
        .json()
        .rules.find((r: { key: string }) => r.key === 'contract.retention.default_percent');
      expect(retention.label).toBeTruthy();
      expect(retention.valueType).toBe('percent');
      expect(retention.tenantOverridable).toBe(true);

      // The filter's own options come from the definitions, not from the
      // filtered rows — a filter that erases its own options cannot be undone.
      expect(filtered.json().domains).toEqual(all.json().domains);
      expect(filtered.json().domains).toContain('payroll');
    });

    it('lets a tenant override an overridable rule', async () => {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/v1/localisation/rules/contract.retention.default_percent',
        headers: auth(OWNER_TOKEN),
        payload: { value: 5, reason: 'Negotiated with our main client' },
      });

      expect(put.statusCode).toBe(200);

      const rules = await app.inject({
        method: 'GET',
        url: '/api/v1/localisation/rules?domain=contract',
        headers: auth(OWNER_TOKEN),
      });

      const retention = rules
        .json()
        .rules.find((r: { key: string }) => r.key === 'contract.retention.default_percent');
      expect(retention.value).toBe(5);
      expect(retention.layer).toBe('tenant');
    });

    it('refuses to override a statutory rule', async () => {
      // A tenant cannot contract out of the overtime multiplier.
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/localisation/rules/payroll.overtime.weekday_multiplier',
        headers: auth(OWNER_TOKEN),
        payload: { value: 1.0 },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error).toMatch(/statutory/);
    });

    it('rejects a value of the wrong type before it can reach payroll', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/localisation/rules/contract.retention.default_percent',
        headers: auth(OWNER_TOKEN),
        payload: { value: 'about ten percent' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects a percentage outside 0-100', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/localisation/rules/contract.retention.default_percent',
        headers: auth(OWNER_TOKEN),
        payload: { value: 250 },
      });

      expect(response.statusCode).toBe(400);
    });

    it('404s an unknown rule key', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/localisation/rules/payroll.invented.knob',
        headers: auth(OWNER_TOKEN),
        payload: { value: 1 },
      });

      expect(response.statusCode).toBe(404);
    });

    it('gives a Qatar tenant Qatar rules from the same endpoints', async () => {
      // Same server, same code path, different country — the whole point.
      const db = getDatabase();
      const soloToken = 'solo-token-for-tests';
      await db.insert(schema.session).values({
        userId: OWNER,
        tenantId: TENANT_SOLO,
        tokenHash: hash(soloToken),
        expiresAt: new Date(Date.now() + 3_600_000),
      });

      await app.inject({
        method: 'POST',
        url: '/api/v1/localisation/adopt',
        headers: auth(soloToken, TENANT_SOLO),
        payload: { countryCode: 'QA', isPrimary: true },
      });

      const requirements = await app.inject({
        method: 'GET',
        url: '/api/v1/localisation/requirements',
        headers: auth(soloToken, TENANT_SOLO),
      });

      const codes = requirements.json().requirements.map((r: { code: string }) => r.code);
      expect(codes).toContain('QATAR_ID');
      expect(codes).not.toContain('EMIRATES_ID');

      const rules = await app.inject({
        method: 'GET',
        url: '/api/v1/localisation/rules?domain=hr',
        headers: auth(soloToken, TENANT_SOLO),
      });

      const leave = rules
        .json()
        .rules.find((r: { key: string }) => r.key === 'hr.leave.annual_days');
      expect(leave.value).toBe(21); // Qatar, versus 30 in the UAE
    });
  });

  describe('approvals', () => {
    it('returns an empty inbox rather than erroring when nothing is pending', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/approvals/inbox',
        headers: auth(OWNER_TOKEN),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().tasks).toEqual([]);
    });

    it('404s history for an unknown request', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/approvals/${randomUUID()}/history`,
        headers: auth(OWNER_TOKEN),
      });

      expect(response.statusCode).toBe(404);
    });

    it('409s a decision on a task that does not exist', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/approvals/tasks/${randomUUID()}/decide`,
        headers: auth(OWNER_TOKEN),
        payload: { decision: 'approved' },
      });

      expect(response.statusCode).toBe(409);
    });

    it('400s an invalid decision value', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/approvals/tasks/${randomUUID()}/decide`,
        headers: auth(OWNER_TOKEN),
        payload: { decision: 'maybe' },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('parties', () => {
    let partyId: string;

    it('creates a party holding two roles at once', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/master-data/parties',
        headers: auth(OWNER_TOKEN),
        payload: {
          code: 'EMAAR',
          name: 'Emaar Properties PJSC',
          isCustomer: true,
          isConsultant: true,
          countryCode: 'AE',
          email: 'contracts@emaar.test',
        },
      });

      expect(response.statusCode).toBe(200);
      partyId = response.json().id;
    });

    it('refuses a code already in use', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/master-data/parties',
        headers: auth(OWNER_TOKEN),
        payload: { code: 'EMAAR', name: 'Duplicate', isCustomer: true },
      });

      expect(response.statusCode).toBe(409);
    });

    it('refuses a party with no role at all', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/master-data/parties',
        headers: auth(OWNER_TOKEN),
        payload: { code: 'NOBODY', name: 'Has no role' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/at least one role/);
    });

    it('lists parties, searchable and filterable by role', async () => {
      const all = await app.inject({
        method: 'GET',
        url: '/api/v1/master-data/parties',
        headers: auth(OWNER_TOKEN),
      });
      expect(all.json().rows.some((r: { code: string }) => r.code === 'EMAAR')).toBe(true);

      const searched = await app.inject({
        method: 'GET',
        url: '/api/v1/master-data/parties?q=emaar',
        headers: auth(OWNER_TOKEN),
      });
      expect(searched.json().total).toBe(1);

      const wrongRole = await app.inject({
        method: 'GET',
        url: '/api/v1/master-data/parties?role=supplier&q=emaar',
        headers: auth(OWNER_TOKEN),
      });
      expect(wrongRole.json().total).toBe(0);
    });

    it('reads one party back with its contacts', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/master-data/parties/${partyId}`,
        headers: auth(OWNER_TOKEN),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.party.code).toBe('EMAAR');
      expect(body.contacts).toEqual([]);
    });

    it('404s a party id that does not exist', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/master-data/parties/${randomUUID()}`,
        headers: auth(OWNER_TOKEN),
      });

      expect(response.statusCode).toBe(404);
    });

    it('adds a contact, and a second primary demotes the first', async () => {
      const first = await app.inject({
        method: 'POST',
        url: `/api/v1/master-data/parties/${partyId}/contacts`,
        headers: auth(OWNER_TOKEN),
        payload: { name: 'Fatima Al Suwaidi', jobTitle: 'Contracts Manager', isPrimary: true },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: 'POST',
        url: `/api/v1/master-data/parties/${partyId}/contacts`,
        headers: auth(OWNER_TOKEN),
        payload: { name: 'Omar Khalil', jobTitle: 'Quantity Surveyor', isPrimary: true },
      });
      expect(second.statusCode).toBe(200);

      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/master-data/parties/${partyId}`,
        headers: auth(OWNER_TOKEN),
      });
      const contacts = detail.json().contacts as { name: string; isPrimary: boolean }[];
      expect(contacts).toHaveLength(2);
      expect(contacts.find((c) => c.name === 'Omar Khalil')!.isPrimary).toBe(true);
      expect(contacts.find((c) => c.name === 'Fatima Al Suwaidi')!.isPrimary).toBe(false);
    });

    it('removes a contact', async () => {
      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/master-data/parties/${partyId}`,
        headers: auth(OWNER_TOKEN),
      });
      const contactId = detail.json().contacts[0].id;

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/master-data/parties/${partyId}/contacts/${contactId}/remove`,
        headers: auth(OWNER_TOKEN),
      });
      expect(response.statusCode).toBe(200);

      const after = await app.inject({
        method: 'GET',
        url: `/api/v1/master-data/parties/${partyId}`,
        headers: auth(OWNER_TOKEN),
      });
      expect(after.json().contacts).toHaveLength(1);
    });

    it('requires a reason to block a party — it stops every module trading with them', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/master-data/parties/${partyId}`,
        headers: auth(OWNER_TOKEN),
        payload: { isBlocked: true },
      });

      expect(response.statusCode).toBe(409);
    });

    it('blocks a party with a reason', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/master-data/parties/${partyId}`,
        headers: auth(OWNER_TOKEN),
        payload: { isBlocked: true, blockReason: 'Two overdue invoices, on hold pending finance review.' },
      });

      expect(response.statusCode).toBe(200);

      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/master-data/parties/${partyId}`,
        headers: auth(OWNER_TOKEN),
      });
      expect(detail.json().party.isBlocked).toBe(true);
    });

    it('refuses a non-owner with no master-data permission', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/master-data/parties',
        headers: auth(STAFF_TOKEN),
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('the approval inbox', () => {
    it('reports a pending count without fetching the inbox', async () => {
      // Its own endpoint because the shell needs the number on every page and
      // must not pay for the whole inbox to render a badge.
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/approvals/count',
        headers: auth(OWNER_TOKEN),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(typeof body.pending).toBe('number');
      expect(typeof body.overdue).toBe('number');
      expect(body.overdue).toBeLessThanOrEqual(body.pending);
    });

    it('names the requester rather than returning a uuid', async () => {
      // An inbox that says a write-off is waiting on you "from
      // 9f3c…-…-…" tells an approver nothing they can act on.
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/approvals/inbox',
        headers: auth(OWNER_TOKEN),
      });

      expect(response.statusCode).toBe(200);
      for (const task of response.json().tasks) {
        expect(task.request).toHaveProperty('requestedByName');
      }
    });

    it('names who a submitted request is waiting on', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/approvals/submitted',
        headers: auth(OWNER_TOKEN),
      });

      expect(response.statusCode).toBe(200);
      for (const request of response.json().requests) {
        for (const who of request.waitingOn) {
          // The only question this screen is asked is who to go and chase.
          expect(who).toHaveProperty('approverName');
          expect(who).toHaveProperty('isOverdue');
        }
      }
    });

    it('offers an approvals section in the navigation to every tenant', async () => {
      // Approvals is a KERNEL capability with no manifest to declare it, and
      // every tenant has an inbox whatever they bought — so it cannot come from
      // `navigationFor` and must not be filtered by a module entitlement.
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: auth(OWNER_TOKEN),
      });
      const nav = response.json().navigation;

      const approvals = nav.find((item: { key: string }) => item.key === 'kernel.approvals');
      expect(approvals).toBeDefined();
      expect(approvals.order).toBe(0);
      expect(approvals.children.map((c: { path: string }) => c.path)).toEqual([
        '/approvals',
        '/approvals/submitted',
      ]);
      // First, because an inbox that sorts below Stock Counts is one nobody opens.
      expect(nav[0].key).toBe('kernel.approvals');
    });
  });
});

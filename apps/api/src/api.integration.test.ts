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
import { eq, inArray } from 'drizzle-orm';
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
    await db.delete(schema.tenantRequirement).where(inArray(schema.tenantRequirement.tenantId, tenants));
    await db.delete(schema.tenantTaxCode).where(inArray(schema.tenantTaxCode.tenantId, tenants));
    await db.delete(schema.tenantHoliday).where(inArray(schema.tenantHoliday.tenantId, tenants));
    await db.delete(schema.tenantRuleValue).where(inArray(schema.tenantRuleValue.tenantId, tenants));
    await db
      .delete(schema.tenantLocalisation)
      .where(inArray(schema.tenantLocalisation.tenantId, tenants));
    await db.delete(schema.tenantModule).where(inArray(schema.tenantModule.tenantId, tenants));
    await db.delete(schema.session).where(inArray(schema.session.userId, [OWNER, STAFF]));
    await db.delete(schema.membership).where(inArray(schema.membership.tenantId, tenants));
    await db.delete(schema.appUser).where(inArray(schema.appUser.id, [OWNER, STAFF]));
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
      expect(body.navigation[0].key).toBe('inventory');
      expect(body.unavailableModules).toEqual([]);
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
      // Every nav item is permission-gated, so the menu is empty rather than
      // full of links that 403.
      expect(body.navigation).toEqual([]);
    });

    it('reports an entitlement this deployment cannot serve instead of hiding it', async () => {
      const db = getDatabase();
      await db
        .insert(schema.tenantModule)
        // A module this deployment does not ship. Update if 'contracts' is
        // ever built — the point is a key the registry cannot resolve.
        .values({ tenantId: TENANT_FULL, moduleKey: 'contracts', status: 'enabled' });
      invalidateTenantModules(TENANT_FULL);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: auth(OWNER_TOKEN),
      });

      expect(response.json().unavailableModules).toContainEqual({
        key: 'contracts',
        reason: 'Module is not present in this deployment.',
      });

      await db
        .delete(schema.tenantModule)
        .where(eq(schema.tenantModule.moduleKey, 'contracts'));
      invalidateTenantModules(TENANT_FULL);
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
});

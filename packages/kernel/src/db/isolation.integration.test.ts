/**
 * Proves the two things that would be catastrophic to get wrong: that Row Level
 * Security genuinely isolates tenants, and that country adoption gives a tenant
 * their own editable copy.
 *
 * Requires a migrated and seeded database. Skipped when TEST_DATABASE_URL is
 * unset so the unit suite still runs anywhere.
 *
 *   pnpm db:up && pnpm db:migrate && pnpm db:seed
 *   TEST_DATABASE_URL=postgres://aerolith:aerolith@localhost:5432/aerolith \
 *   TEST_APP_DATABASE_URL=postgres://aerolith_app:aerolith_app@localhost:5432/aerolith \
 *   pnpm test
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from './schema';
import { adoptCountry } from '../localisation/adopt';

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl =
  process.env.TEST_APP_DATABASE_URL ??
  ownerUrl?.replace('//aerolith:aerolith@', '//aerolith_app:aerolith_app@');

const suite = ownerUrl ? describe : describe.skip;

suite('tenant isolation and country adoption', () => {
  let ownerPool: pg.Pool;
  let appPool: pg.Pool;
  let owner: NodePgDatabase<typeof schema>;
  let app: NodePgDatabase<typeof schema>;

  const tenantA = '11111111-1111-4111-8111-111111111111';
  const tenantB = '22222222-2222-4222-8222-222222222222';

  beforeAll(async () => {
    ownerPool = new pg.Pool({ connectionString: ownerUrl });
    appPool = new pg.Pool({ connectionString: appUrl, max: 4 });
    owner = drizzle(ownerPool, { schema });
    app = drizzle(appPool, { schema });

    for (const [id, slug, name, country] of [
      [tenantA, 'joinery-dubai', 'Aerolith Joinery LLC', 'AE'],
      [tenantB, 'joinery-doha', 'Aerolith Qatar WLL', 'QA'],
    ] as const) {
      await owner
        .insert(schema.tenant)
        .values({
          id,
          slug,
          name,
          status: 'active',
          primaryCountryCode: country,
          baseCurrencyCode: country === 'AE' ? 'AED' : 'QAR',
        })
        .onConflictDoNothing();
    }
  });

  afterAll(async () => {
    for (const id of [tenantA, tenantB]) {
      await owner.delete(schema.tenantRequirement).where(eq(schema.tenantRequirement.tenantId, id));
      await owner.delete(schema.tenantTaxCode).where(eq(schema.tenantTaxCode.tenantId, id));
      await owner.delete(schema.tenantHoliday).where(eq(schema.tenantHoliday.tenantId, id));
      await owner
        .delete(schema.tenantLocalisation)
        .where(eq(schema.tenantLocalisation.tenantId, id));
      await owner.delete(schema.party).where(eq(schema.party.tenantId, id));
      await owner.delete(schema.auditLog).where(eq(schema.auditLog.tenantId, id));
      await owner.delete(schema.tenant).where(eq(schema.tenant.id, id));
    }
    await ownerPool.end();
    await appPool.end();
  });

  // -------------------------------------------------------------------------

  describe('country adoption', () => {
    it('gives a UAE tenant the UAE requirement set, pre-filled', async () => {
      const result = await owner.transaction((tx) =>
        adoptCountry(tx, { tenantId: tenantA, countryCode: 'AE', isPrimary: true }),
      );

      expect(result.requirementsCopied).toBeGreaterThan(0);
      expect(result.taxCodesCopied).toBeGreaterThan(0);

      const copied = await owner
        .select()
        .from(schema.tenantRequirement)
        .where(eq(schema.tenantRequirement.tenantId, tenantA));

      const codes = copied.map((r) => r.code);
      expect(codes).toContain('EMIRATES_ID');
      expect(codes).toContain('LABOUR_CARD');
      expect(codes).toContain('TRADE_LICENCE');

      // The pre-filled row carries the validation and alerting the tenant needs
      // without them configuring anything.
      const emiratesId = copied.find((r) => r.code === 'EMIRATES_ID');
      expect(emiratesId?.numberFormatRegex).toBe('^784-\\d{4}-\\d{7}-\\d$');
      expect(emiratesId?.blocksOnboarding).toBe(true);
      expect(emiratesId?.expiryNoticeDays).toContain(30);
    });

    it('gives a Qatar tenant a different set, from the same code path', async () => {
      await owner.transaction((tx) =>
        adoptCountry(tx, { tenantId: tenantB, countryCode: 'QA', isPrimary: true }),
      );

      const codes = (
        await owner
          .select({ code: schema.tenantRequirement.code })
          .from(schema.tenantRequirement)
          .where(eq(schema.tenantRequirement.tenantId, tenantB))
      ).map((r) => r.code);

      expect(codes).toContain('QATAR_ID');
      expect(codes).toContain('COMPUTER_CARD');
      expect(codes).not.toContain('EMIRATES_ID');
    });

    it('copies the right VAT rate per country', async () => {
      const aeStandard = await owner
        .select()
        .from(schema.tenantTaxCode)
        .where(and(eq(schema.tenantTaxCode.tenantId, tenantA), eq(schema.tenantTaxCode.code, 'SR')))
        .limit(1);

      expect(Number(aeStandard[0]?.rate)).toBe(5);

      // Qatar has no VAT — an ordinary regime row, not a special case.
      const qaCodes = await owner
        .select()
        .from(schema.tenantTaxCode)
        .where(eq(schema.tenantTaxCode.tenantId, tenantB));

      expect(qaCodes.length).toBeGreaterThan(0);
      expect(qaCodes.every((c) => Number(c.rate) === 0 || c.code === 'WHT5')).toBe(true);
    });

    it('does not overwrite a requirement the tenant has customised', async () => {
      await owner
        .update(schema.tenantRequirement)
        .set({ renewalLeadDays: 120, isCustomised: true })
        .where(
          and(
            eq(schema.tenantRequirement.tenantId, tenantA),
            eq(schema.tenantRequirement.code, 'RESIDENCE_VISA'),
          ),
        );

      const result = await owner.transaction((tx) =>
        adoptCountry(tx, { tenantId: tenantA, countryCode: 'AE', refresh: true }),
      );

      expect(result.skippedCustomised).toContain('requirement:RESIDENCE_VISA');

      const [visa] = await owner
        .select()
        .from(schema.tenantRequirement)
        .where(
          and(
            eq(schema.tenantRequirement.tenantId, tenantA),
            eq(schema.tenantRequirement.code, 'RESIDENCE_VISA'),
          ),
        );

      expect(visa?.renewalLeadDays).toBe(120);
    });

    it('lets a tenant add a requirement the pack never anticipated', async () => {
      // This is the whole point: the tenant fills in what their trade needs
      // rather than waiting for a code change.
      await owner.insert(schema.tenantRequirement).values({
        tenantId: tenantA,
        countryCode: 'AE',
        code: 'CNC_OPERATOR_CERT',
        name: 'CNC Operator Certification',
        subject: 'employee',
        category: 'certification',
        isMandatory: false,
        hasExpiry: true,
        expiryNoticeDays: [60, 30],
        isUserDefined: true,
      });

      const [custom] = await owner
        .select()
        .from(schema.tenantRequirement)
        .where(
          and(
            eq(schema.tenantRequirement.tenantId, tenantA),
            eq(schema.tenantRequirement.code, 'CNC_OPERATOR_CERT'),
          ),
        );

      expect(custom?.isUserDefined).toBe(true);
    });
  });

  // -------------------------------------------------------------------------

  describe('row level security', () => {
    /** Runs a callback with the RLS guard set, as the non-owner app role. */
    async function asTenant<T>(
      tenantId: string,
      fn: (tx: Parameters<Parameters<typeof app.transaction>[0]>[0]) => Promise<T>,
    ): Promise<T> {
      return app.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        return fn(tx);
      });
    }

    beforeAll(async () => {
      await owner.insert(schema.party).values([
        { tenantId: tenantA, code: 'C-001', name: 'Emaar Properties', isCustomer: true },
        { tenantId: tenantB, code: 'C-001', name: 'Qatari Diar', isCustomer: true },
      ]);
    });

    it('shows a tenant only its own rows', async () => {
      const seenByA = await asTenant(tenantA, (tx) => tx.select().from(schema.party));
      const seenByB = await asTenant(tenantB, (tx) => tx.select().from(schema.party));

      expect(seenByA.map((p) => p.name)).toEqual(['Emaar Properties']);
      expect(seenByB.map((p) => p.name)).toEqual(['Qatari Diar']);
    });

    it('shows nothing at all when no tenant guard is set', async () => {
      // The failure mode of a misconfigured connection must be "sees nothing",
      // never "sees everything".
      const rows = await app.select().from(schema.party);
      expect(rows).toEqual([]);
    });

    it('refuses to write a row belonging to another tenant', async () => {
      await expect(
        asTenant(tenantA, (tx) =>
          tx
            .insert(schema.party)
            .values({ tenantId: tenantB, code: 'SMUGGLED', name: 'Should not exist' }),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it('refuses to update another tenant’s row even by primary key', async () => {
      const [victim] = await owner
        .select()
        .from(schema.party)
        .where(and(eq(schema.party.tenantId, tenantB), eq(schema.party.code, 'C-001')));

      const result = await asTenant(tenantA, (tx) =>
        tx
          .update(schema.party)
          .set({ name: 'Hijacked' })
          .where(eq(schema.party.id, victim!.id))
          .returning({ id: schema.party.id }),
      );

      expect(result).toEqual([]);

      const [unchanged] = await owner
        .select()
        .from(schema.party)
        .where(eq(schema.party.id, victim!.id));
      expect(unchanged?.name).toBe('Qatari Diar');
    });

    it('scopes deletes to the acting tenant', async () => {
      const deleted = await asTenant(tenantA, (tx) =>
        tx
          .delete(schema.party)
          .where(eq(schema.party.code, 'C-001'))
          .returning({ id: schema.party.id }),
      );

      expect(deleted).toHaveLength(1);

      // Scoped to the two tenants this suite created. Selecting the whole table
      // asserts that the database contains nothing else, which is a fact about
      // the developer's machine rather than about tenant isolation — it passes
      // on a clean CI database and fails the moment anyone runs the suite
      // against a database that also holds the demo seed.
      const survivors = await owner
        .select()
        .from(schema.party)
        .where(inArray(schema.party.tenantId, [tenantA, tenantB]));
      expect(survivors.map((p) => p.name)).toEqual(['Qatari Diar']);
    });

    it('isolates a tenant’s adopted requirements from another tenant', async () => {
      const seenByB = await asTenant(tenantB, (tx) =>
        tx.select().from(schema.tenantRequirement),
      );

      expect(seenByB.every((r) => r.tenantId === tenantB)).toBe(true);
      expect(seenByB.some((r) => r.code === 'EMIRATES_ID')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------

  describe('append-only audit trail', () => {
    it('accepts an insert', async () => {
      await app.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.tenant_id', ${tenantA}, true)`);
        await tx.insert(schema.auditLog).values({
          tenantId: tenantA,
          entityType: 'kernel.party',
          action: 'create',
          actorType: 'system',
        });
      });

      const rows = await owner
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.tenantId, tenantA));
      expect(rows).toHaveLength(1);
    });

    it('refuses an update, in the database, not just in code', async () => {
      await expect(
        app.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.tenant_id', ${tenantA}, true)`);
          await tx
            .update(schema.auditLog)
            .set({ reason: 'covering my tracks' })
            .where(eq(schema.auditLog.tenantId, tenantA));
        }),
      ).rejects.toThrow(/permission denied/i);
    });

    it('refuses a delete', async () => {
      await expect(
        app.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.tenant_id', ${tenantA}, true)`);
          await tx.delete(schema.auditLog).where(eq(schema.auditLog.tenantId, tenantA));
        }),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  /**
   * The pre-tenant path.
   *
   * Authentication has to read `kernel.membership` to discover which tenants a
   * user belongs to, and it must do that BEFORE any tenant is known. These tests
   * run as the NON-OWNER role on purpose: the API connects that way in
   * production, every other suite connects as the owner, and that gap is exactly
   * why login was broken for every user without a single test failing.
   */
  describe('authentication before a tenant is known', () => {
    const alice = 'aaaaaaaa-0000-4000-8000-00000000a001';
    const bob = 'bbbbbbbb-0000-4000-8000-00000000b001';

    /** As the app role, identified as a user, with NO tenant guard — like login. */
    async function asUser<T>(
      userId: string,
      fn: (tx: Parameters<Parameters<typeof app.transaction>[0]>[0]) => Promise<T>,
    ): Promise<T> {
      return app.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
        return fn(tx);
      });
    }

    beforeAll(async () => {
      await owner
        .insert(schema.appUser)
        .values([
          { id: alice, email: 'alice@isolation.test', name: 'Alice', passwordHash: 'x' },
          { id: bob, email: 'bob@isolation.test', name: 'Bob', passwordHash: 'x' },
        ])
        .onConflictDoNothing();

      await owner
        .insert(schema.membership)
        .values([
          { tenantId: tenantA, userId: alice, status: 'active', isOwner: true },
          { tenantId: tenantB, userId: bob, status: 'active', isOwner: true },
        ])
        .onConflictDoNothing();
    });

    afterAll(async () => {
      await owner.delete(schema.membership).where(inArray(schema.membership.userId, [alice, bob]));
      await owner.delete(schema.appUser).where(inArray(schema.appUser.id, [alice, bob]));
    });

    it('lets a user read their own memberships with no tenant guard set', async () => {
      // The whole fix. Without it this returns nothing, `loadMemberships` finds
      // no workspace, and every login fails with "not a member of any active
      // workspace" — while the owner-connected test suite stays green.
      const rows = await asUser(alice, (tx) =>
        tx.select().from(schema.membership).where(eq(schema.membership.userId, alice)),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]!.tenantId).toBe(tenantA);
    });

    it('does not let a user read anybody else’s memberships', async () => {
      // The policy is keyed on the user id in the row, not on the id in the
      // query — so asking for Bob's rows while identified as Alice returns
      // nothing rather than Bob's tenant.
      const rows = await asUser(alice, (tx) =>
        tx.select().from(schema.membership).where(eq(schema.membership.userId, bob)),
      );

      expect(rows).toEqual([]);
    });

    it('still shows nothing when neither guard is set', async () => {
      const rows = await app.select().from(schema.membership);
      expect(rows).toEqual([]);
    });

    it('refuses to let a user grant themselves a membership', async () => {
      // The self-scope is SELECT only. If it were not, any authenticated user
      // could write themselves into any tenant — self-service escalation, and a
      // far worse bug than the one being fixed.
      await expect(
        asUser(alice, (tx) =>
          tx
            .insert(schema.membership)
            .values({ tenantId: tenantB, userId: alice, status: 'active' }),
        ),
      ).rejects.toThrow();
    });

    it('refuses to let a user promote their own membership to owner', async () => {
      await asUser(alice, async (tx) => {
        const result = await tx
          .update(schema.membership)
          .set({ isOwner: true })
          .where(eq(schema.membership.userId, alice));
        // The UPDATE policy is still tenant-scoped and no tenant guard is set,
        // so the statement matches nothing rather than being refused outright.
        expect(result.rowCount).toBe(0);
      });
    });

    it('hides module entitlements without a tenant guard', async () => {
      // Why `modulesForTenant` needs `withTenantId`. Read unguarded, this comes
      // back empty, and "no entitlements" is indistinguishable from "bought
      // nothing" — so every module answers 404 and the whole application looks
      // unentitled to a user who is correctly signed in.
      await owner
        .insert(schema.tenantModule)
        .values({ tenantId: tenantA, moduleKey: 'inventory', status: 'enabled' })
        .onConflictDoNothing();

      const unguarded = await app
        .select()
        .from(schema.tenantModule)
        .where(eq(schema.tenantModule.tenantId, tenantA));
      expect(unguarded).toEqual([]);

      const guarded = await asTenantModule(tenantA);
      expect(guarded.map((m) => m.moduleKey)).toContain('inventory');

      await owner
        .delete(schema.tenantModule)
        .where(eq(schema.tenantModule.tenantId, tenantA));
    });

    async function asTenantModule(tenantId: string) {
      return app.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        return tx
          .select()
          .from(schema.tenantModule)
          .where(eq(schema.tenantModule.tenantId, tenantId));
      });
    }
  });
});

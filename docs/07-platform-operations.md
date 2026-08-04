# 07 — Platform operations

The vendor's own view of the estate: who the customers are, what they are
entitled to, what they are paying for, and how a new one comes into existence.

This does not exist today. Nothing in the codebase creates a tenant — `grep`
for an insert into `kernel.tenant` outside the seed scripts returns nothing —
so onboarding a customer currently means writing SQL by hand. And nothing can
read across tenants, by design: every route resolves a tenant from the session
and RLS enforces it in Postgres. Those two facts are the whole of this
document. Phase 5 in the roadmap already names "tenant billing and self-serve
onboarding"; this is what that entails.

---

## The one decision everything else follows from

**A platform operator is not a user with an extra permission.** It is a
different kind of principal, in a different realm, reached through a different
door.

The tempting version is an `is_platform_owner` boolean on `kernel.app_user` and
a permission check on some new routes. Resist it. That design puts every tenant
user exactly one boolean away from reading every customer's commercial data,
and puts the check that stops them in application code — the layer this system
has consistently refused to trust alone. RLS exists precisely because "the
application will remember to filter" is not a security model.

So: separate identity table, separate session table, separate cookie, separate
authentication path, separate database role, separate deployed surface. The
cost is real duplication. The benefit is that a bug in the tenant application
cannot escalate into the estate, because the tenant application holds no
credential that can read it.

**Blast radius is the thing to keep in mind throughout.** A bug in the
Contracts module inconveniences one customer. A bug here exposes all of them to
each other, or to an attacker. Everything below is more conservative than it
would be for a tenant-facing feature, deliberately.

---

## Stage 1 — Read-only estate visibility

The smallest thing that answers the original question, and the right place to
prove the isolation model before anything can write.

### The database role

Cross-tenant reads need a role the RLS policies recognise. Two ways:

- `BYPASSRLS` on a new role. Simple, and on a managed Postgres you may not be
  able to grant it — it needs superuser, which Render's provisioned role is not
  (proved the hard way: `seed-demo.ts` connecting as the owner hit
  `new row violates row-level security policy`, so the owner is subject to RLS
  like anyone else).
- **Explicit policies naming the role.** Generate a second set alongside the
  existing ones in `packages/kernel/src/db/rls.ts` —
  `CREATE POLICY platform_read ON <table> FOR SELECT TO aerolith_platform USING (true)`.

Take the second. It needs no superuser, it is generated from the same list that
generates tenant isolation so a new table cannot be forgotten by one and
remembered by the other, and it is greppable: `SELECT` only, no `WITH CHECK`,
so the role provably cannot write. `buildRlsStatementsFor` already takes an
options object; this is another field on it.

The connection string (`DATABASE_PLATFORM_URL`) belongs only to the operator
service. It must not appear in the tenant API's environment — if it is not
there, no bug in that codebase can reach it.

### The reporting model

Everything needed is already in the schema:

| Question | Source |
|---|---|
| How many customers | `kernel.tenant`, `status`, `deleted_at` |
| Trials about to lapse | `kernel.tenant.trial_ends_at` |
| Which modules each has | `kernel.tenant_module.module_key`, `status` |
| Entitlement expiry | `kernel.tenant_module.expires_on` |
| Seat/usage caps | `kernel.tenant_module.limits` (jsonb) |
| How many users | `kernel.membership`, `status = 'active'` |
| Whether anyone is using it | `kernel.session`, `kernel.audit_log.occurred_at` |

Note what is *not* there: no plan, no price, no invoice, no subscription
period. "Plan" today is implicit — the set of enabled modules plus a jsonb of
limits. Stage 3 makes it explicit; Stage 1 should report what exists rather
than invent a vocabulary the data cannot back.

### Deliverable

A list of tenants with status, trial expiry, module count and user count; a
tenant detail view; and a module take-up summary across the estate. Read-only,
no mutations anywhere in the surface.

---

## Stage 2 — Provisioning

The gap that matters more than reporting: today a new customer cannot be
created through any code path.

Creating a tenant is not one insert. It is:

1. `kernel.tenant` — slug, name, country, currency, timezone, status.
2. `adoptCountry` — the tenant's own copies of tax codes, requirements,
   holidays and rule values. Without this, contract terms and tax resolve to
   nothing.
3. The owner `kernel.app_user` and their `kernel.membership` with
   `is_owner = true`.
4. `kernel.tenant_module` rows for what they have bought.
5. `provisionSeries` for each enabled module's declared number series.
6. An invitation email so the owner can set their own password — the operator
   must never choose a customer's credential.

All of it in one transaction. A half-provisioned tenant is worse than none: the
owner logs in and every screen fails on something absent, and diagnosing that
costs more than the signup was worth.

`enableModule` in `apps/api/src/entitlements.ts` already does steps 4 and 5
correctly, including pulling in module dependencies. It is written against a
tenant context, so the operator path either reuses it under a synthesised
context or the shared part moves into the kernel. Prefer the latter — the logic
is the same and duplicating it guarantees drift.

**Suspension and deletion** belong here too, and are the operations most worth
getting right, because they are the ones done in anger. Suspending sets
`tenant.status`; `loadMemberships` already refuses to log a user into a
non-active tenant, so suspension takes effect on the next request without any
new enforcement. Deletion should be a soft delete with a retention window and
an explicit, separately-authorised purge — a customer who leaves and comes back
in a month is a customer, and a purge that runs on the wrong id is unrecoverable.

---

## Stage 3 — Plans and subscriptions

Only now is there enough shape to make "plan" mean something.

```
platform.plan            code, name, module keys, default limits, is_public
platform.subscription    tenant, plan, period start/end, status, seats
```

The important design point: **`kernel.tenant_module` stays the runtime read
path.** `modulesForTenant` reads it on every request and it is already indexed
and correct; a subscription model that made the request path join through
billing tables would be a performance regression bought with nothing. Instead
the subscription is the source of truth and *writes* `tenant_module` when it
changes — so the runtime keeps its cheap read and the commercial state has one
authoritative home.

That also means an operator can still grant a module outside a plan (a
proof-of-concept, a goodwill extension) without the model fighting them. It
should be visible that they did — a `source` column distinguishing "from plan"
from "granted manually" is a small thing that answers a real question later.

**What this stage is not.** No payment processing, no invoicing, no dunning.
Those are a product decision and probably a third-party integration, not
schema. This stage answers "what did we agree to sell them", which is the part
that has to live in the data model regardless of who takes the money.

---

## Stage 4 — The surface

A separate Next application (`apps/operator`), not a route group in the tenant
app.

Reasons, in order of weight: the auth realm is different, so sharing a codebase
means two session mechanisms in one middleware and one mistake away from
crossing them; it can be deployed on a hostname that is not the customers', or
behind a VPN, or not deployed at all in environments that do not need it; and
the tenant application's bundle then provably contains no operator code.

Shared UI components can move to a package if the duplication becomes annoying.
Do not do that pre-emptively — the two surfaces will diverge more than expected,
and a shared component library that serves two masters gets worse at both.

### Authentication

Operator accounts should not use the tenant password flow. This is the surface
where a credential compromise is worst, so require a second factor from the
first version rather than retrofitting one. Sessions should be short and
absolute-expiry rather than sliding.

---

## Auditing, and why it is not optional here

`kernel.audit_log` is tenant-scoped and append-only, which is right for tenant
activity and useless for this: an operator action spans tenants, or targets one
without acting inside it.

`platform.operator_action` — append-only, same `REVOKE UPDATE, DELETE` treatment
the existing append-only tables get, recording who, when, what, which tenant,
and from where. **Reads are included, not just writes.** In a normal application
auditing reads is overkill; in one where an employee can read every customer's
commercial position, "who looked at what" is the entire point. It is also what
makes an honest answer possible when a customer asks whether anyone at the
vendor has been in their data.

---

## Sequencing, and what to build first

Stage 1 is worth building alone — it answers the immediate question, and it
forces the isolation model (separate role, separate policies, separate
credential) to be built and reviewed while the surface is read-only and the
consequences of getting it wrong are smallest.

Stage 2 has the highest practical value: it removes hand-written SQL from
customer onboarding, which is both a bottleneck and the single most likely
source of a corrupted tenant.

Stage 3 only pays off once there are enough customers on enough different terms
that the implicit model stops fitting. Before that it is a schema you maintain
for a spreadsheet's worth of information. Build it when the second or third
pricing conversation is awkward, not before.

Stage 4's separation should be established as soon as *anything* operator-facing
exists — retrofitting a realm split after routes are already living in the
tenant app is exactly the migration nobody wants to do.

## The risk worth naming

Every stage here increases the number of ways a vendor employee, or someone
holding their credential, can read customer data. That is inherent to the
feature — you cannot support customers you cannot see — but it should be a
deliberate exchange rather than a side effect. The controls that make it
defensible are the separate credential, the SELECT-only policy set, the second
factor, and the read audit. None of them is the sort of thing that gets added
later once the surface is useful and busy.

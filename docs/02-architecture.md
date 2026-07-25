# 02 — Architecture

This document answers requirement 19: **individual working apps that also run as
one ERP.**

## The short answer

A **modular monolith with enforced boundaries and per-tenant module entitlements.**

One codebase, one deployable, one database. Each module is an independently
developed, independently sellable package. What a customer sees — a single
standalone app, or a full ERP — is a *licensing and navigation* concern, not a
deployment concern.

## Why this, and not the alternatives

**Why not 17 separate apps with separate databases?**
Because the modules are not actually independent, and pretending otherwise
destroys the product. A goods receipt touches Procurement, Inventory *and* the
General Ledger in one atomic operation. A production job consumes stock, burns
labour hours, accrues WIP cost and updates a project schedule. Split those across
databases and you have replaced a `BEGIN…COMMIT` with a distributed saga, plus
reconciliation jobs, plus a permanent class of "my stock doesn't match my GL"
support tickets. On a free-tier box you would also be running 17 Node processes
and 17 Postgres instances, which does not fit.

**Why not one big app?**
Because you want to sell modules separately, and because a 17-module ERP without
internal walls becomes unmaintainable at roughly the point it becomes valuable.

**The modular monolith gets both**: transactional integrity and hard boundaries.
And because the boundaries are real, any module *can* later be extracted into its
own service without a rewrite — you get the microservices exit ramp without
paying for it upfront.

## How "standalone" actually works

Three mechanisms, all cheap:

### 1. Module manifest

Every module declares itself:

```ts
// packages/modules/inventory/manifest.ts
export default defineModule({
  key: 'inventory',
  name: 'Aerolith Inventory',
  version: '1.0.0',
  dbSchema: 'inventory',
  dependsOn: ['kernel'],                  // hard deps — must be present
  integratesWith: ['procurement', 'accounts'], // soft — light up if present
  nav: [...],
  permissions: [...],
  events: { emits: [...], consumes: [...] },
  standalone: true,                        // can be sold alone
});
```

### 2. Entitlements

A `tenant_modules` table decides which modules a tenant has. The app boots with
only those modules registered: routes, navigation, permissions, jobs and event
subscribers. A customer who bought only Inventory gets a focused product called
*Aerolith Inventory* with its own branding and landing page. A customer who bought
everything gets the unified ERP. **Same binary, same database, different row.**

This means: no separate builds, no separate deploys, no code duplication, and
upselling a module is one INSERT.

### 3. Graceful degradation

A module must work with its hard dependencies only. Everything else is
opportunistic:

- Inventory alone → stock, bins, transfers, counts, reorder levels.
- Inventory + Procurement → purchase requisitions auto-raise from reorder levels.
- Inventory + Accounts → stock movements post to the GL automatically.

This is enforced by the event bus (below): a module *emits* what happened and
never cares who listens. If nobody listens, nothing breaks.

## Repository layout

```
aerolith-erp/
├── apps/
│   ├── web/                 # Next.js — shell, renders whatever modules are enabled
│   ├── api/                 # NestJS — registers whatever modules are enabled
│   ├── worker/              # background jobs
│   └── docs/                # public docs site (free on GitHub Pages)
├── packages/
│   ├── kernel/              # ← build this first. Everything depends on it
│   │   ├── tenancy/         # tenant context, RLS session vars
│   │   ├── auth/            # identity, sessions, 2FA, org membership
│   │   ├── rbac/            # roles, permission matrix, CASL abilities
│   │   ├── audit/           # immutable who-changed-what-when
│   │   ├── numbering/       # per-tenant document series (INV-2026-0001)
│   │   ├── documents/       # attachments, versions, R2, OCR  [your module 12]
│   │   ├── approvals/       # the workflow engine             [your module 16]
│   │   ├── reporting/       # report registry, exports, BI views [your module 15]
│   │   ├── notifications/   # email / in-app / Telegram
│   │   ├── customfields/    # tenant-defined fields (JSONB)
│   │   ├── masterdata/      # party, item, project, UoM, currency, cost centre
│   │   ├── events/          # typed event bus + transactional outbox
│   │   └── i18n/            # en / ar, RTL, multi-currency
│   ├── modules/
│   │   ├── inventory/  procurement/  production/  projects/
│   │   ├── estimation/ contracts/    sales-crm/   hr/
│   │   ├── logistics/  accommodation/ assets/     accounts/
│   │   ├── it-service/ quality/      hse/         maintenance/
│   ├── cutlist/             # pure optimisation engine, no framework deps
│   ├── localisation/        # tax, payroll, statutory reports (per country)
│   └── ui/                  # shared design system
└── docs/
```

Each module folder has the same internal shape:

```
modules/inventory/
├── manifest.ts
├── db/schema.ts        # owns the `inventory.*` Postgres schema
├── domain/             # business logic, framework-free, unit-testable
├── api/                # NestJS controllers + ts-rest contracts
├── ui/                 # React screens exported to the shell
├── events.ts           # published event contracts (this is the public API)
└── jobs/
```

## Boundary rules (enforced in CI, not by convention)

1. A module may import from `kernel` and its own folder. **Never from another module.**
2. Cross-module communication is exclusively: **published events** (async) or
   **kernel-registered service contracts** (sync, interface only).
3. No cross-module foreign keys. FKs to `kernel.*` (tenant, user, party, item,
   project, gl_account) are allowed and expected — that is what shared master data
   is for.
4. Each module owns exactly one Postgres schema. Cross-schema reads happen only
   through read-only views the owning module publishes.
5. Rules 1–4 are checked by `dependency-cruiser` and an ESLint
   `no-restricted-imports` rule in CI. **A boundary that isn't mechanically
   enforced is a boundary that will be gone within six months.**

## Event bus + transactional outbox

In-process and typed, but persisted:

1. A module writes its own tables **and** an `kernel.outbox` row in the same
   transaction.
2. A dispatcher reads the outbox and delivers to subscribers.
3. Subscribers are idempotent, keyed on event id.

Today the dispatcher is an in-process loop — fast, zero infrastructure. The day
you extract a module into its own service, you swap the dispatcher for NATS or
Postgres logical replication and **no module code changes.** That is the whole
point.

```ts
// Procurement emits; it does not know or care that Inventory and Accounts listen.
await emit('procurement.goods_receipt.posted', {
  grnId, poId, supplierId, lines, receivedAt, warehouseId,
});
```

## Multi-tenancy

- Every table: `tenant_id uuid not null`.
- Postgres **RLS** on every table, keyed on `current_setting('app.tenant_id')`.
- The API sets that session variable from the authenticated session before any
  query runs — a connection cannot see another tenant's rows even if application
  code is buggy. Defence in depth: CASL for "may this user do this", RLS for
  "may this connection see this row".
- Every index is composite, leading with `tenant_id`.
- One shared schema for all tenants. Revisit only if a customer contractually
  demands physical isolation — then it becomes a paid enterprise tier that funds
  its own infrastructure.

## Approval engine (kernel — used by all 17 modules)

Approvals must be **data**, not code, because every tenant's matrix differs.

```
approval_workflow      (tenant, entity_type, name, active)
approval_condition     (field, operator, value)      -- e.g. amount > 50000
approval_step          (seq, approver_type, approver_ref, sla_hours, parallel)
                       -- approver_type: role | user | manager_of_requester
                       --              | project_manager | department_head
approval_instance      (entity_type, entity_id, workflow_version, state)
approval_action        (step, user, decision, comment, acted_at, delegated_from)
```

Features to build in from the start, because retrofitting them is painful:
version-pinning (an in-flight approval keeps its original workflow version),
delegation and out-of-office, escalation on SLA breach, parallel *and* sequential
steps, amount-threshold routing, full audit trail, and "recall by requester".

Every module then just calls `approvals.request(entityType, entityId, context)`.
One implementation, seventeen consumers.

## The General Ledger spine

Build a real **double-entry ledger** in `accounts`, and have every other module
post to it through a **posting-rules table** rather than hard-coded account ids.

```
Goods receipt   → Dr Inventory        Cr GRNI
Supplier invoice→ Dr GRNI             Cr Accounts Payable
Material issue  → Dr WIP (job)        Cr Inventory
Labour booking  → Dr WIP (job)        Cr Labour Absorbed
Job completion  → Dr Finished Goods   Cr WIP
Sales invoice   → Dr Accounts Rec.    Cr Revenue, Cr VAT Payable
```

Non-negotiable properties: journals are **immutable** (correct by reversal, never
by edit), every entry carries `tenant_id`, `fiscal_period`, `cost_centre`,
`project_id` and `source_module` + `source_document_id`, and periods can be
locked. Get this right early — retrofitting a GL into a live ERP is the single
most expensive migration in this whole programme.

## Job costing (the thing that makes it an ERP and not a to-do list)

Every cost lands against a job/project with a cost code: material issued, labour
scanned, machine time, subcontract, logistics, overhead absorption. Then
budget-vs-actual by cost code, WIP valuation, earned value, and margin per job in
real time. This is what the owner of a joinery business actually wants to look at
every morning, and it is the reason all the modules have to share one database.

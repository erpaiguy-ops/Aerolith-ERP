# Aerolith-ERP

A modular ERP for joinery and fit-out contracting — factory production, site works,
and the commercial layer that joins them. Each module is sellable standalone; all
of them together are one ERP.

Target markets: UAE, Qatar and the wider Middle East. Country specifics are **data,
not code** — see [`docs/06-localisation.md`](docs/06-localisation.md).

## Status

Kernel, API, three business modules (Inventory, Production, Estimation), and the
cutlist optimiser. **The joinery wedge now runs end to end:** a priced tender
becomes a work order, becomes a cutting plan against real offcuts, becomes
labelled parts, becomes scanned progress.

**Built and working**

- Monorepo (pnpm + Turborepo), TypeScript strict, ESLint, **enforced module boundaries**
- Full kernel Postgres schema — tenancy, identity, RBAC, audit, numbering,
  documents, approvals, notifications, custom fields, master data, outbox, localisation
- **Row Level Security** on all tenant-scoped tables, with append-only enforcement
  on the audit trail
- **Approval engine** — data-driven workflows, amount thresholds, parallel steps
  with quorum, delegation, self-approval prevention, workflow version pinning
- **Document numbering** — pattern-driven, per-period reset, row-locked allocation
  for statutory gapless series
- **Audit trail** with automatic redaction of salary, passport and bank fields
- Module manifest + registry with per-tenant entitlement resolution
- Typed event bus over a transactional outbox
- Data-driven localisation with country packs for **AE, QA, SA, OM, BH, KW**
- **HTTP API** (Fastify) — auth, module/navigation resolution, localisation admin,
  approval inbox, inventory
- **Inventory module** — multi-warehouse stock, moving-average costing, batch and
  grain tracking, reorder alerts, and the **offcut register** with dimensional
  matching (see below)
- **Cutlist optimiser** (`@aerolith/cutlist`) — 2D guillotine bin-packing that
  plans against the live offcut register before opening a new sheet, with SVG
  cutting diagrams and edge-banding schedules
- **Production module** — work orders, routings through work centres, batch
  finishing with cure time, and barcode shop-floor tracking
- **Estimation module** — tendering with bid/no-bid decisions, BOQ pricing from a
  versioned rate library, margin scenarios, and conversion of a won tender into a
  work order
- **Projects and Contract Administration** — WBS with rules of credit, earned
  value, payment applications valued from progress, variations and the notice
  clock that preserves entitlement
- **Procurement** — requisitions, RFQ comparison on landed cost, orders, goods
  receipt and three-way matching, with the exception queue that catches an
  invoice for goods nobody received
- **Web app** (Next.js) — the shell and screens for every module: Projects,
  Contracts, Procurement, Inventory, Estimating and Production. **every** navigation
  destination is built — 27 of 27. Right-to-left aware and formatted in the
  user's own locale
- **923 tests**, including integration suites that prove tenant isolation holds and
  drive the approval engine, the API, stock posting, cutlist planning, the full
  factory flow and tender-to-work-order conversion end to end

**Not built yet** — Arabic translations of the interface, and PDF output.
See [`docs/05-roadmap.md`](docs/05-roadmap.md).

### Estimation

Two things here are where estimators actually lose money, and both are handled
explicitly rather than left to whoever writes the spreadsheet:

- **Margin is not markup.** Adding 20% to cost gives a *16.7%* margin, not 20%.
  Supplying both is rejected rather than silently merged, and both figures are
  always reported so the difference is impossible to miss.
- **Wastage applies to material, not labour.** Cutting 10% extra board does not
  mean paying the joiner 10% more. Wastage is per component.

Every rate and build-up is **snapshotted** onto the estimate. The library moves
on; the submitted price must not — the same reasoning as approval workflow
version pinning and routing rate snapshots.

Seeing an estimate and seeing its **margin** are separate permissions. A site
manager checking quantities should not see what the company makes on the job.

The rate library is fed by job actuals, weighted by recency and quantity, and it
**suggests** rather than applies. Every job finished makes the next estimate more
accurate; an estimator overriding a suggestion is exercising judgement, and the
system silently changing rates under them is how they stop trusting it.

### Production

Work orders carry their own parts, each with a scannable barcode derived from the
order number. A routing is instantiated onto the order with its **rates
snapshotted**, so editing a routing next month does not rewrite the planned times
of jobs already on the floor.

Two things generic MRP gets wrong and this does not:

- **Finishing is a batch process.** Forty doors through a booth that holds forty
  is *one* load, not forty run-times — and the cure clock then runs regardless of
  load. Scheduling it per unit either quotes a week for an afternoon's work or
  ignores the cure entirely, and cure is where joinery jobs lose days.
- **Cure runs overnight; machining does not.** Paint does not stop drying at five
  o'clock. Both behaviours are configurable per tenant.

WIP position, machine utilisation, operator productivity and real labour cost are
all **derived from barcode scans**, never from a timesheet. Scans are append-only
and enforced as such in the database; a mis-scan is corrected by a compensating
scan, exactly as a ledger is corrected by reversal.

### The offcut register

The piece no generic ERP has. A remnant is tracked by real dimensions, grain
direction and batch — not as "0.4 sheets of 18mm MDF", which is not something you
can cut anything out of.

`POST /api/v1/inventory/offcuts/match` takes a required part and returns the
**smallest** offcut it can be cut from, with the orientation. Deliberately the
smallest: consuming a full sheet for a small part is what destroys the value of
the register. It refuses to rotate a grained part just to make it fit, refuses to
mix grain or colour batches, and accounts for saw kerf.

Remnants are costed by their share of the parent sheet, so the job that creates
them is not over-credited and the job that consumes them is not under-charged.

### The cutlist optimiser

`POST /api/v1/inventory/cutlist/optimise` takes a cutting list and plans it
against **live stock** — the offcut rack first, then new sheets. It returns board
layouts with part positions, SVG cutting diagrams for the saw, an edge-banding
schedule in metres per tape, and what the register saved.

Guillotine, not free-form nesting: every cut runs the full width of the piece,
because that is what a panel saw physically does. A layout that ignores this is
undeliverable however good its yield looks.

Two yield figures are reported, deliberately:

- **Gross** — parts area over all board area opened. Treats a large reusable
  remnant as waste.
- **Net** — parts area over board area actually consumed, excluding remnants big
  enough to go back on the rack. The economically honest number.

On the sample wardrobe job those read 51.6% and 75.2%: opening a sheet to cut one
plinth is not 84% waste, it is 3.2 m² of material back on the rack.

## Getting started

```bash
pnpm install
pnpm db:up          # Postgres 17 in Docker
pnpm db:migrate     # schema + RLS policies + app role
pnpm db:seed        # rule catalogue + country packs

pnpm verify         # typecheck, lint, boundary check, tests
```

Integration tests need a database, and it must be **migrated and seeded** —
without the country packs the localisation suites fail on data, not on logic:

```bash
TEST_DATABASE_URL=postgres://aerolith:aerolith@localhost:5432/aerolith \
TEST_APP_DATABASE_URL=postgres://aerolith_app:aerolith_app@localhost:5432/aerolith \
pnpm test
```

Set **both**. `TEST_DATABASE_URL` connects as the table owner, which RLS policies
do not apply to — so a suite using only that one is testing a database with
isolation effectively switched off. `TEST_APP_DATABASE_URL` connects as the role
the API actually uses in production, and it is what the isolation suite needs.

Read that as part of `verify`, not an optional extra. With `TEST_DATABASE_URL`
unset the 240 integration tests do not fail — they are **skipped**, and `pnpm
verify` prints green having exercised nothing but the pure functions. That is
the whole API surface quietly not being tested, so set it.

Run the API:

```bash
DATABASE_URL=postgres://aerolith:aerolith@localhost:5432/aerolith \
pnpm --filter @aerolith/api dev
```

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness |
| `GET /api/v1/modules/catalogue` | Every module this deployment can serve |
| `GET /api/v1/me` | The caller's tenant, modules, navigation and permissions |
| `GET /api/v1/inventory/items` | Item catalogue, paged |
| `GET /api/v1/inventory/stock` | Stock on hand, paged — or one item's position with `?itemId=` |
| `GET /api/v1/inventory/offcuts` | Offcut register, paged, with a whole-register value summary |
| `GET /api/v1/inventory/counts` | Stock counts with progress and variance |
| `GET /api/v1/localisation/countries` | Countries available to adopt |
| `POST /api/v1/localisation/adopt` | Adopt a country; pre-fills the tenant's requirements |
| `GET /api/v1/localisation/requirements` | The tenant's own editable requirement set |
| `GET /api/v1/localisation/rules` | Resolved rules, with the layer each answer came from |
| `PUT /api/v1/localisation/rules/:key` | Override a rule (statutory rules are refused) |
| `GET /api/v1/approvals/inbox` | What is waiting on the caller |
| `POST /api/v1/approvals/tasks/:id/decide` | Approve or reject |
| `GET /api/v1/inventory/stock` | Stock on hand and value |
| `POST /api/v1/inventory/movements` | Post a receipt, issue, transfer or adjustment |
| `GET /api/v1/inventory/offcuts` | The offcut rack, with its total area and value |
| `POST /api/v1/inventory/offcuts/match` | Find the best offcut for a required part |
| `POST /api/v1/production/work-orders` | Create a work order with parts and a routing |
| `POST /api/v1/production/work-orders/:id/cutlist` | Plan against live stock, reserve the offcuts |
| `POST /api/v1/production/work-orders/:id/release` | Release to the floor |
| `POST /api/v1/production/work-orders/:id/scans` | Record a shop-floor scan |
| `GET /api/v1/production/board` | The live queue at each work centre |
| `POST /api/v1/estimating/tenders` | Open a tender |
| `POST /api/v1/estimating/tenders/:id/estimates` | Price a BOQ from the rate library |
| `POST /api/v1/estimating/estimates/:id/scenarios` | What-if margin analysis |
| `POST /api/v1/estimating/estimates/:id/convert-to-work-order` | Won tender → work order |

## Layout

```
apps/
  api/                 HTTP API — boots modules from the registry per tenant
packages/
  kernel/              the platform — everything depends on it, it depends on nothing
    src/db/schema/     the kernel Postgres schema
    src/db/rls.ts      tenant isolation policies
    src/modules/       manifest + registry (how standalone vs unified works)
    src/approvals/     workflow engine — used by every module, owned by none
    src/numbering/     document number allocation
    src/audit/         append-only trail with field redaction
    src/events/        typed event bus over the outbox
    src/localisation/  country-as-data: packs, rule resolution, adoption
    packs/             AE, QA, SA, OM, BH, KW — adding a country is a JSON file
  cutlist/             panel optimisation engine — zero dependencies, runs anywhere
  modules/
    inventory/         owns the `inventory` schema
      src/domain/      costing and offcut matching: pure, no framework, no DB
      src/service/     movement posting (atomic: stock, cost, number, event)
    production/        owns the `production` schema
      src/domain/      scheduling and WIP derivation: pure, no framework, no DB
      src/service/     work order lifecycle and scan handling
    estimation/        owns the `estimation` schema
      src/domain/      rate build-up, roll-up, margin scenarios: pure
      src/service/     tender and estimate lifecycle
docs/                  architecture and decisions
```

## Documentation

| Doc | Contents |
|---|---|
| [`docs/00-decisions.md`](docs/00-decisions.md) | The decisions that are expensive to reverse — start here |
| [`docs/01-tech-stack.md`](docs/01-tech-stack.md) | Full stack, with what was rejected and why |
| [`docs/02-architecture.md`](docs/02-architecture.md) | Modular monolith, boundaries, multi-tenancy, approvals, the GL |
| [`docs/03-modules.md`](docs/03-modules.md) | All modules, joinery detail, and the ones missing from the original list |
| [`docs/04-infrastructure.md`](docs/04-infrastructure.md) | Zero-budget hosting, domain, repo, CI/CD, backups, security |
| [`docs/05-roadmap.md`](docs/05-roadmap.md) | Phasing, scope reality, open risks |
| [`docs/06-localisation.md`](docs/06-localisation.md) | Country as data — packs, rule resolution, adoption |

## Headline decisions

- **TypeScript everywhere** — Next.js + Fastify + Drizzle + Postgres, one Turborepo.
- **Modular monolith** with mechanically enforced boundaries — not microservices,
  not a big ball of mud.
- **Standalone vs unified is a licensing concern**, not a deployment one: same
  binary, per-tenant module entitlements.
- **Documents, approvals and reporting are kernel capabilities**, built once and
  used by every module.
- **Country specifics are data** — three-layer rule resolution (tenant → country →
  default), with tenants editing their own copy of everything.
- **Self-hosted on free-tier infrastructure**, designed to move to paid hosting the
  day there is a paying customer.

> The statutory values in the country packs (leave, gratuity, VAT rates,
> accommodation standards) are seeded starting points and must be verified against
> current law before running payroll or issuing tax invoices in production.

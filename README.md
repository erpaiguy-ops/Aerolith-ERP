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
  Contracts, Procurement, Inventory, Estimating and Production, plus the approval
  inbox and the settings area, **including a detail screen for every register**
  — a work order followed from routing to the floor, with its cutting plan one
  click away. **Every** navigation destination is built — 39 of 39 — and a
  workspace can adopt its country, edit its own rules, add its own people and
  invent its own roles without a developer. Right-to-left aware and formatted
  in the user's own locale
- **PDF documents** (`@aerolith/pdf`) — a payment application renders to a
  sendable certificate with no dependencies and no headless browser
  (`GET /api/v1/contracts/applications/:id/pdf`)
- **Audit trail viewer** — every change any module already recorded (`kernel.audit_log`
  has been append-only and populated since the first migration), now readable
  from the workspace itself rather than a SQL client: filterable by entity type
  and action, searchable, attributed to a name and email, gated on its own
  `kernel.audit.read` permission (`GET /api/v1/admin/audit`, `/settings/audit`)
- **Notification centre** — the in-app inbox slice of it, the one channel actually
  wired end to end: the approval engine notifies every approver a step opens
  for, unpermissioned like the inbox itself (a notification is addressed to a
  person, not gated by a role), readable and markable-read from the workspace
  (`GET /api/v1/notifications`, `/notifications`). Email/Telegram/WhatsApp/SMS
  delivery, templates and quiet hours remain schema-only — see the roadmap
- **Custom fields** — the tenant-defined-fields catalogue (`kernel.custom_field_definition`)
  now wired to all three entities it was ever meant to cover: a project's own
  detail screen (which gained a proper header in the same pass — it had none),
  a party's, and an item's, all reading and editing whatever fields a
  `kernel.custom_fields.manage` admin has defined, validated server-side
  against each field's type. Settings → Custom Fields manages the catalogue
- **Parties register** — the master data every module was already joining
  against (`clientPartyId`, `supplierId`, ...) and nothing could create, list
  or edit directly: one table with role flags (customer/supplier/subcontractor/
  consultant/employee, held in any combination), contacts with a single
  primary, and blocking with a mandatory reason since it stops every module
  trading with them (`GET|POST /api/v1/master-data/parties`, `/master-data/parties`)
- **Item catalogue, create and edit** — `kernel.item` had a list and nothing
  else: no route existed to create one, edit one, or read a single item's
  detail, and `inventory.item.write` sat in the manifest declared but unused.
  The item detail screen now edits dimensions, grain direction, finish/colour
  codes, tracking flags, standard cost and wastage, alongside its resolved
  stock/purchase UOM and on-hand position — "never stocked" kept distinct from
  a zero balance, the same trap the register already avoided
  (`GET|POST /api/v1/inventory/items`, `GET|PATCH /api/v1/inventory/items/:id`,
  `/inventory/items/:id`)
- **Cost codes and cost centres** — the breakdown structure every cost booking
  resolves to (`costCodeId` on a stock movement, `costCentreId` on a
  requisition and an order) had the foreign keys and no way to create the row
  on the other end. A flat, retirable catalogue — cost codes optionally
  nested under a parent — kernel-owned like parties, since no module owns
  either (`GET|POST /api/v1/master-data/cost-codes`,
  `GET|POST /api/v1/master-data/cost-centres`, `/settings/cost-codes`)
- **1,028 tests**, including integration suites that prove tenant isolation holds and
  drive the approval engine, the API, stock posting, cutlist planning, the full
  factory flow and tender-to-work-order conversion end to end

**Not built yet** — Arabic translations of the interface, and the deployment
artefacts described in [`docs/04-infrastructure.md`](docs/04-infrastructure.md):
there is a development `docker-compose.yml` and no Dockerfile, production compose
or backup job. See [`docs/05-roadmap.md`](docs/05-roadmap.md).

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
schedule in metres per tape, and what the register saved. A plan generated
against a work order is stored and can be read back drawn:
`GET /api/v1/production/cutting-plans/:id`, and `/production/cutlist/:id` in the
UI.

**Reaching for the rack is a strategy, not a rule.** The packer runs its
portfolio both ways — rack-first and sheets-only — and keeps whichever plan uses
fewer sheets. A greedy pass that always prefers remnants will open one for the
first part that fits and then find the parts left still need the same number of
sheets, which spends a piece of stock to buy nothing. Edge trim is applied to a
full sheet and not to a remnant, for the same reason it exists: the factory edge
was squared when the sheet was first opened, and a remnant's edges are saw cuts.

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
| `POST /api/v1/inventory/items` | Create an item |
| `GET /api/v1/inventory/items/:id` | One item, with its resolved UOMs, category and on-hand position |
| `PATCH /api/v1/inventory/items/:id` | Update an item |
| `PATCH /api/v1/inventory/items/:id/custom-fields` | Set an item's tenant-defined fields |
| `GET /api/v1/inventory/stock` | Stock on hand, paged — or one item's position with `?itemId=` |
| `GET /api/v1/inventory/offcuts` | Offcut register, paged, with a whole-register value summary |
| `GET /api/v1/inventory/counts` | Stock counts with progress and variance |
| `GET /api/v1/inventory/movements` | The stock ledger, paged and filterable by type |
| `GET /api/v1/localisation/countries` | Countries available to adopt |
| `POST /api/v1/localisation/adopt` | Adopt a country; pre-fills the tenant's requirements |
| `GET /api/v1/localisation/requirements` | The tenant's own editable requirement set |
| `GET /api/v1/localisation/rules` | Resolved rules, with the layer each answer came from, the definition behind each, and a whole-set summary |
| `PUT /api/v1/localisation/rules/:key` | Override a rule (statutory rules are refused) |
| `GET /api/v1/contracts/applications/:id/pdf` | The application as a sendable PDF |
| `GET /api/v1/admin/members` | Everyone in the workspace, with their roles |
| `POST /api/v1/admin/members` | Add somebody; attaches an existing account by email |
| `PATCH /api/v1/admin/members/:userId` | Suspend, reinstate, set roles, hand over ownership |
| `GET /api/v1/admin/roles` | Roles with their permissions and how many hold them |
| `POST /api/v1/admin/roles` | Create a role |
| `PATCH /api/v1/admin/roles/:id` | Replace a role's permissions |
| `GET /api/v1/admin/permissions` | The permission catalogue every module declares |
| `GET /api/v1/admin/audit` | The audit trail, paged, filtered by entity type or action, searchable |
| `GET /api/v1/estimating/tenders/:id` | One tender, with client, consultant and main contractor resolved, and its priced versions |
| `GET /api/v1/procurement/requisitions/:id` | One requisition, with what it spends against and who acted on it |
| `GET /api/v1/procurement/rfqs/:id` | One enquiry, its lines and every quote received, with the landed-cost comparison as last stored |
| `GET /api/v1/estimating/rates/:id` | One rate, exploded into the components that price it, recomputed from the build-up rather than a stale cache |
| `PATCH /api/v1/estimating/rates/:id` | Edit a rate's header — description, unit, category, overhead, margin |
| `PUT /api/v1/estimating/rates/:id/components` | Replace a rate's whole build-up in one call — the save behind the spreadsheet-style grid |
| `GET /api/v1/approvals/inbox` | What is waiting on the caller |
| `POST /api/v1/approvals/tasks/:id/decide` | Approve or reject |
| `GET /api/v1/notifications` | The caller's own in-app inbox, unread-filterable and paged |
| `GET /api/v1/notifications/unread-count` | For a bell badge, without paying for the whole inbox |
| `POST /api/v1/notifications/:id/read` | Mark one notification read |
| `POST /api/v1/notifications/read-all` | Mark every unread notification read |
| `GET /api/v1/admin/custom-fields` | The field catalogue for one entity type — open to anyone signed in |
| `POST /api/v1/admin/custom-fields` | Define a new field, gated on `kernel.custom_fields.manage` |
| `PATCH /api/v1/admin/custom-fields/:id` | Edit or retire a field definition |
| `GET /api/v1/projects/:id` | One project, with its client, PM and QS resolved to names |
| `PATCH /api/v1/projects/:id/custom-fields` | Set a project's custom field values, validated against the catalogue |
| `GET /api/v1/master-data/parties` | The party register, searchable and filterable by role |
| `POST /api/v1/master-data/parties` | Create a party — at least one role required |
| `GET /api/v1/master-data/parties/:id` | One party, with its contacts |
| `PATCH /api/v1/master-data/parties/:id` | Edit a party, or block it (a reason is required) |
| `POST /api/v1/master-data/parties/:id/contacts` | Add a contact — a second primary demotes the first |
| `PATCH /api/v1/master-data/parties/:id/custom-fields` | Set a party's custom field values |
| `GET|POST /api/v1/master-data/cost-codes` | The cost code catalogue; create one, optionally nested under a parent |
| `PATCH /api/v1/master-data/cost-codes/:id` | Edit or retire a cost code |
| `GET|POST /api/v1/master-data/cost-centres` | The cost centre catalogue; create one |
| `PATCH /api/v1/master-data/cost-centres/:id` | Edit or retire a cost centre |
| `POST /api/v1/inventory/movements` | Post a receipt, issue, transfer or adjustment |
| `POST /api/v1/inventory/offcuts/match` | Find the best offcut for a required part |
| `POST /api/v1/production/work-orders` | Create a work order with parts and a routing |
| `POST /api/v1/production/work-orders/:id/cutlist` | Plan against live stock, reserve the offcuts |
| `GET /api/v1/production/cutting-plans/:id` | One stored plan, with its boards drawn as SVG |
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
  pdf/                 document writer — zero dependencies, no headless browser
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

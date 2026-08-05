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
  click away. **Every** navigation destination is built — 41 of 41 — and a
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
- **Snags can now be raised and closed** — `projects.snag.write` gated
  nothing; the register was read-only. Raising allocates a reference from
  the `SNG-{YYYY}-{SEQ}` series already declared for it; closing refuses to
  re-close or un-reject a snag already in a terminal state, and a critical
  snag still open still blocks handover on the same screen
  (`POST /api/v1/projects/snags`, `POST /api/v1/projects/snags/:id/close`)
- **Production routings, work centres and finishing batches, made
  editable** — `production.routing.manage` and `production.finishing.manage`
  drove navigation and gated nothing else; the registers were read-only.
  Routings now get operations added in sequence (a duplicate sequence number
  is refused, not silently overwritten), and finishing batches move through
  an explicit queued → spraying → curing → completed/rejected transition map
  rather than a free-form status field
  (`POST /api/v1/production/routings/:id/operations`,
  `POST /api/v1/production/finishing/:id/status`, `/production/routings/:id`)
- **Document management, from zero to a working upload** — `folder`,
  `document`, `documentVersion`, `documentLink` and `documentLock` existed
  since the first migration with no service, route or screen anywhere. Bytes
  never touch the API process: the browser uploads and downloads directly
  against the S3-compatible object store (Cloudflare R2 in production)
  through a short-lived presigned URL the API mints, per
  `docs/04-infrastructure.md`'s own design. Every other operation — creating
  a folder, listing the register, linking a document to another module's
  record, checking one in and out — works with zero storage configured, which
  is what lets it run in this environment at all
  (`POST /api/v1/documents/upload`, `GET /api/v1/documents/:id/download-url`,
  `/documents`)
- **An approved supplier list, distinct from "this party trades with us"** —
  `procurement.supplier.manage` had no backing table at all. A party's
  `isSupplier` flag means it CAN be a supplier; qualifying one records
  whether procurement actually vetted them, with a mandatory reason before
  suspending — the same shape as blocking a party
  (`GET|POST /api/v1/procurement/suppliers`, `/procurement/suppliers`)
- **Back charges deduct themselves** — the `backCharge` table existed since
  the first migration; every payment application since had taken
  `backChargesToDate` as a manually typed number, trusting whoever filled in
  the form to remember what the register would say. A back charge can now be
  raised, agreed at a different amount than claimed, disputed or written
  off, and `createPaymentApplication` defaults `backChargesToDate` straight
  from the register — everything `agreed` or `recovered`, at the agreed
  figure — when the caller does not explicitly override it. `disputed` is
  deliberately excluded from the deduction: unilaterally withholding a
  contested figure is how a dispute over one line becomes a dispute over the
  whole certificate
  (`GET /api/v1/contracts/back-charges`, `POST /api/v1/contracts/:id/back-charges`,
  `PATCH /api/v1/contracts/back-charges/:id`, `/contracts/:id`)
- **The notice register can now be written to** — `contracts.correspondence.manage`
  gated the nav entry, labelled "Manage the notice register" in its own
  manifest, while the register underneath was a list route and nothing else:
  no way to raise an RFI, a notice or an EOT claim, record a response, or
  set the `variationId` the register already displayed ("became
  VO-2026-00003") on every row without anything ever setting it. All three
  are wired now — raising validates type and direction, a duplicate
  reference on the same type and contract is refused, and linking a
  variation checks it belongs to the same contract before allowing it
  (`POST /api/v1/contracts/:id/correspondence`,
  `PATCH /api/v1/contracts/correspondence/:id`, `/contracts/correspondence`)
- **Stock counts, from a list to a reconciliation** — `inventory.stock_count.reconcile`
  gated the nav entry and nothing else; the schema's own
  `draft → counting → pending_approval → posted` lifecycle had no code
  behind it at all. Generating a sheet freezes the book quantity per line;
  a count moves to `pending_approval` on its own once every line is
  counted, not on a separate button; reconciling posts one adjustment
  movement for every line that varied and leaves the ones that matched the
  book alone — including writing a shelf down to genuine zero, which
  needed a real fix to `postMovement`'s "quantity must be positive" check,
  since an adjustment *sets* an absolute quantity and zero is a valid one
  (`POST /api/v1/inventory/counts`, `POST /api/v1/inventory/counts/:id/generate`,
  `PATCH /api/v1/inventory/counts/lines/:id`, `POST /api/v1/inventory/counts/:id/reconcile`,
  `/inventory/counts`)
- **A stock transfer or a scrap now stages for sign-off instead of moving
  stock on the strength of a hand-typed form** — `inventory.stock_movement.approve`
  gated nothing; `postMovement` posted every movement type immediately,
  including the two the manifest itself names as needing review
  (`approvableEntities: ['inventory.stock_transfer', 'inventory.stock_write_off']`).
  A transfer or a scrap now lands as `pending_approval` with the stock
  untouched, and only `approveMovement` — re-checking the warehouse and
  re-reading CURRENT stock, not whatever was true when it was proposed —
  actually moves it. Receipts, issues, adjustments, returns and production
  output are unaffected: they have a generating document or a count behind
  them already, and post exactly as before
  (`POST /api/v1/inventory/movements/:id/approve`,
  `POST /api/v1/inventory/movements/:id/reject`, `/inventory/movements`)
- **A contract can now be created and activated from the web** — the routes
  existed with no screen behind them at all. Country and payment terms are
  typed once, at creation, and never again: activating just stamps
  `commencedOn` and reads the retention/DLP/payment-terms rules the country
  pack already snapshotted onto the contract, the same as an activated
  contract already displayed them
  (`POST /api/v1/contracts`, `POST /api/v1/contracts/:id/activate`, `/contracts`)
- **A project can now list, create and approve budget versions from the
  web** — `projects.budget.read` was declared in the manifest with a label
  and never referenced anywhere, and there was no route to list a project's
  budgets at all, only to create and approve one blind. A budget version is
  create-once-immutable (every line supplied together, `.min(1)`, no "add a
  line later"), so the new screen is a repeating-line grid, not a form;
  approving supersedes whichever version was previously approved and
  rebuilds the work breakdown's cached budget figures from the new lines
  (`GET /api/v1/projects/:id/budgets`, `GET /api/v1/projects/budgets/:id`,
  `POST /api/v1/projects/:id/budgets`, `POST /api/v1/projects/budgets/:id/approve`,
  `/projects/:id`)
- **Practical completion and retention release scheduling, from the web** —
  recording practical completion (which starts the defects liability period)
  and checking for a releasable retention amount both had working routes and
  no screen. The two are coupled: retention has nothing to release until
  practical completion is recorded, so the same card offers both, gated on
  contract status rather than only on "active" — a contract in its defects
  liability period still needs the retention check available, which the
  first pass of this screen missed and Playwright verification against a
  live contract caught
  (`POST /api/v1/contracts/:id/practical-completion`,
  `POST /api/v1/contracts/:id/retention/schedule`, `/contracts/:id`)
- **Document check-in/check-out and version history, from the web** — lock
  and unlock routes worked with no way to see who held a lock or release
  one, and there was no route to list a document's version history at all.
  The register now surfaces the lock holder's name on every row, offers
  Check out/Check in gated on `kernel.document.manage` and on actually
  holding the lock (the service enforces this too — only the lock holder
  can check a document back in, no manager override), and a version count
  links to a server-rendered history of every version with its uploader,
  size and change note
  (`GET /api/v1/documents/:id/versions`, `/documents`)
- **The submittal register — the fit-out approval clock** had no screen because
  it had no table at all: a shop drawing, sample or method statement submitted
  for review, and the cycle it goes through until a consultant signs it off.
  Split into a register row (where the ball sits now, who acts next) and a
  revision history (every submit-review cycle it took to get there) — the same
  reasoning a payment application is split from its certificate. A drawing sent
  back for revision and resubmitted is a new revision, never the old one edited
  in place. `submitRevision` refuses once approved; `recordReview` refuses
  reviewing the current revision twice and refuses reviewing a submittal with
  nothing submitted yet
  (`POST /api/v1/contracts/:id/submittals`, `POST /api/v1/contracts/submittals/:id/revisions`,
  `POST /api/v1/contracts/submittals/:id/review`, `/contracts/submittals`)
- **The cutlist optimiser's one known gap is closed.** It used to settle for 8
  of a possible 9 identical parts on a sheet, and separately missed layouts
  combining a grid with a rotated part in a leftover strip — both traced to the
  same cause, a guillotine split that always kept whichever half was locally
  larger, committing to a leftover shape before the rest of the cutting list
  was known. The split axis is now one more thing the existing multi-strategy
  search tries, the same mechanism that already searches sort order and fit
  score. A realistic wardrobe-carcass job that used to need 21 sheets now runs
  in 20.
- **The kernel's own administrative surface**, which was the last place a
  declared permission gated nothing. Four gaps, found by auditing every
  permission against every route:
  - **Modules can be enabled and disabled** (`kernel.module.manage`).
    Entitlements were rows a SQL script inserted. Enabling now also provisions
    the number series each manifest declares — `provisionSeries` was written for
    exactly that and had never been called by anything, which is why every
    series until now was created by hand in the seed and in each test's setup.
    Disabling refuses while another enabled module depends on it, and keeps the
    row so re-enabling restores rather than recreates
    (`GET/POST /api/v1/admin/modules*`, `/settings/modules`)
  - **Approval workflows can be created and versioned**
    (`kernel.approval_workflow.manage`). The engine could route, resolve
    approvers, hold a quorum and pin a running instance to its version; nothing
    could create the workflow it routes by. Editing publishes a **new** version
    and leaves the old one untouched, which is what stops a change to the
    matrix rewriting the rules a half-finished approval is being judged by. A
    step approved by a role or person that names neither is refused at publish
    time, because the engine resolves it to nobody and the approval would stall
    with nothing to say why
    (`GET/POST/PATCH /api/v1/approvals/workflows*`, `/settings/workflows`)
  - **Document numbering is editable** (`kernel.number_series.manage`). A series
    could be created and consumed but never changed. The counter cannot be
    rewound onto a number already issued — that collides with the
    `(series, period, value)` index on the *next* document created, surfacing as
    a constraint error nowhere near the edit that caused it
    (`GET/PATCH /api/v1/admin/number-series*`, `/settings/number-series`)
  - **`kernel.localisation.read` is actually enforced.** It was declared from
    the start and checked nowhere, leaving the country-pack reads open to any
    authenticated principal
- **Two latent bugs found while building the above**: `modulesForTenant` selected
  every `tenant_module` row regardless of `status`, so a disabled entitlement
  still granted access and an `expired` one never expired — disabling a module
  would have appeared to work and changed nothing. And `WorkflowCondition.value`
  was required although `exists` takes no operand and the engine already handled
  its absence in every branch.
- **1,153 tests**, including integration suites that prove tenant isolation holds and
  drive the approval engine, the API, stock posting, cutlist planning, the full
  factory flow and tender-to-work-order conversion end to end

**Deployment artefacts** — `apps/api/Dockerfile`, `apps/web/Dockerfile` and
`apps/operator/Dockerfile`
(multi-stage, `turbo prune`-based), `render.yaml` (a free three-service
blueprint for trying the app, the operator surface included and removable),
`docker-compose.prod.yml` (Postgres +
migrate/seed + api + web + Cloudflare Tunnel, no port opened publicly),
`scripts/backup.sh` (hourly `pg_dump` to R2, 7 daily / 4 weekly / 12 monthly
retention) and `.github/workflows/backup-verify.yml` (the monthly
restore-into-a-throwaway-container-and-assert row counts). Not build-tested
end to end — no Docker daemon in the environment that built them — but the
web image's `output: 'standalone'` layout was checked against a real `next
build`, not assumed. See [`docs/04-infrastructure.md`](docs/04-infrastructure.md).

**Not built yet** — Arabic translations of the interface. See
[`docs/05-roadmap.md`](docs/05-roadmap.md).

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
| `POST /api/v1/projects/snags` | Raise a snag — allocates its SNG-{YYYY}-{SEQ} reference |
| `POST /api/v1/projects/snags/:id/close` | Close or reject a snag (refuses to re-close a terminal one) |
| `POST /api/v1/documents/upload` | Start an upload — creates the document row and mints a presigned R2 PUT URL |
| `GET /api/v1/documents/:id/download-url` | Mints a presigned, expiring R2 GET URL |
| `POST /api/v1/documents/:id/lock` \| `/unlock` | Check a document out for editing, or back in |
| `GET|POST /api/v1/procurement/suppliers` | The approved supplier list; qualify a supplier |
| `PATCH /api/v1/procurement/suppliers/:id` | Approve or suspend (a reason is required to suspend) |
| `POST /api/v1/production/routings/:id/operations` | Add a step to a routing — refuses a duplicate sequence |
| `POST /api/v1/production/finishing/:id/status` | Move a spray load through queued → spraying → curing → completed |
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

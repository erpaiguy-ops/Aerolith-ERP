# 05 — Roadmap & Notes

## The honest scope assessment

Seventeen modules, done properly, is 4-6 years for a small team. SAP and Oracle
have thousands of engineers on this problem. So the sequencing below is built
around one idea: **be sellable at the end of phase 2, not at the end of phase 6.**

The wedge is the joinery workflow — Estimation → Production/Cutlist → Projects →
Contract Admin. That is what Odoo, ERPNext, Zoho and every generic ERP does badly
or not at all, and it is the only part a joinery business cannot buy elsewhere.
The generic modules are table stakes; build them second, and never try to
out-feature Odoo on CRM.

## Phase 0 — Kernel (weeks 1-8)

Nothing else works without this, and retrofitting any of it is brutal.

Tenancy + RLS · auth & sessions · RBAC + CASL · audit log · numbering series ·
document store on R2 · **approval engine** · notification centre · custom fields ·
event bus + outbox · master data (party, item, project, UoM, currency, cost
centre) · reporting registry · i18n (en/ar + RTL) · the module manifest and
entitlement system · UI shell and design system · CI with boundary enforcement.

Ship one thin vertical slice end-to-end to prove the architecture before writing
module two.

## Phase 1 — Foundation modules (months 3-6)

**Inventory** and **Procurement**. They feed everything else, they exercise the
kernel hard, and they are immediately useful internally — which means real users
and real feedback while the stakes are low.

### Phase 1 status — both shipped, and the loop is closed

Procurement was the last phase-1 module and it closed three dangling ends left
by the modules built before it: `projects.commitment` had a `relieveCommitment`
nothing called, Inventory had goods-receipt movement types with no purchase order
to receive against, and Estimation produced material demand with no consumer.

The chain is proven by an integration test that runs it as one story against a
real database:

> requisition → RFQ → landed-cost comparison → award → purchase order →
> **commitment against the budget** → delivery → **stock in and cost accrued** →
> supplier invoice matched three ways → **commitment relieved**.

The link nobody else joins is the middle one. Issuing an order registers what the
job is committed to; receiving the goods charges the job on the day the material
lands rather than whenever the invoice arrives; the matched invoice reverses one
and relieves the other. A cost report is therefore true *during* the job, which
is the only time it can change a decision.

Both compositions live in `apps/api/src/routes/procurement.ts`. The boundary
checker enforces that Procurement imports neither Inventory nor Projects, and
each composition degrades to the procurement-only behaviour when the other module
is not entitled — so a firm that buys purchasing alone gets a complete purchasing
system, not a broken ERP.

## Phase 2 — The wedge (months 6-14) ← this is the product

**Estimation & Tendering** → **Production (cutlist, routing, shop-floor scanning,
polishing)** → **Projects** → **Contract Administration (variations + IPCs)**.

The continuity across these four is the entire pitch: a BOQ line becomes an
estimate build-up, becomes a budget, becomes a production BOM, becomes cut parts
with barcodes, becomes scanned progress, becomes a payment application. **Nobody
else joins those dots.** At the end of phase 2 you have something a joinery
business will pay for.

### Cutlist optimiser — delivered, with a known gap

`@aerolith/cutlist` is built and tested (57 tests). Two things to be honest about:

- **Achieved yield depends on the parts, not the algorithm.** The optimiser
  reaches the grid-optimal count per sheet on every shape tested. A mix with
  large awkward panels has a low geometric ceiling nothing can beat — the
  wardrobe test job tops out near 74% because a 2100x900 back leaves a 340mm
  strip nothing else fits into.
- **Known gap:** it does not find layouts combining a grid with a rotated part in
  the leftover strip, worth roughly one sheet in twenty on mixes like that job.
  Closing it needs a real search rather than a greedy pass. Recorded rather than
  hidden; worth doing once there is a customer whose material bill justifies it.

### Phase 2 status — the wedge is joined end to end

All four modules are shipped at v0.1, and the chain they exist to form is proven
by an integration test that runs it as one continuous story:

> BOQ line → rate build-up → estimate → **won tender** → project budget →
> production work order → cut parts → **measured site progress** → interim
> payment application → certificate.

Two links in that chain are the ones nobody else joins:

- `POST /estimating/estimates/:id/convert-to-work-order` — priced build-ups
  become a work order with its parts, Estimation and Production composed in one
  transaction without either importing the other.
- `POST /contracts/:id/applications/from-progress` — the WBS roll-up values every
  contract BOQ line at its measured percentage, and the total becomes a
  cumulative payment application. Contract lines with no WBS link are **named**
  in the response rather than counted, because an unvalued BOQ line is unbilled
  work and "3 lines skipped" is a number nobody investigates.

Both compositions live in the application layer. The boundary checker enforces
that neither module imports the other, which is what keeps each one sellable on
its own — and what leaves the door open to extracting any of them later.

Remaining in phase 2, deliberately deferred rather than forgotten: shop drawing
and submittal registers (the fit-out approval clock), certificate PDF generation,
and the cutlist gap recorded above.

### The web shell — delivered

`apps/web` is a Next.js 15 App Router shell, and the thing worth stating about
it is what it does **not** contain: **no module names anywhere.** The sidebar is
whatever `/me` returned — the tenant's entitled modules, filtered by the user's
permissions. A tenant who bought only Estimating sees a focused estimating
product; a tenant who bought everything sees an ERP. Same binary, same code path.
That is requirement 19 made visible rather than merely argued.

Built so far: sign-in, the shell and navigation, the project screen (WBS with
rules of credit, earned value, forecast, margin gated behind
`projects.margin.view`), and the contract screen (position, variation register,
and the time-bar warning above everything else because it is the one fact on the
page with a deadline attached).

Inventory, Procurement, Estimating and Production have working, tested APIs and
no UI yet. Their nav links render a "not built yet" page **inside the shell**
rather than a 404, so the gap is explicit instead of looking broken.

Security posture: the session token is an httpOnly cookie, every API call is made
from the server, and no credential ever reaches client JavaScript. Verified in a
real browser, not asserted — `document.cookie` is checked to be empty of it.

Run it:

```
pnpm db:migrate && pnpm db:seed && pnpm db:seed:demo
pnpm --filter @aerolith/api start          # :3001
pnpm --filter @aerolith/web dev            # :3000
# demo@aerolith.test / demo-passphrase-2026
```

The demo seed builds one continuous story rather than disconnected rows — budget
→ progress → payment application → certificate, plus a variation instructed on
site and now past its notice deadline, so the screens have something true to show.

Still missing before this is a usable product: list endpoints (every screen
reaches an entity by id), write flows in the UI (everything is read-only so far),
Arabic translations to exercise the RTL support that is wired but untested, and
PDF output for certificates and applications.

## Phase 3 — Commercial completion (months 14-20)

**Accounts/GL** (start the ledger design early even if it ships here — everything
must be able to post to it), **Sales/CRM**, **Quality/QA-QC**, **Job costing
dashboards**.

## Phase 4 — Operations (months 20-28)

**HR & Payroll**, **Accommodation**, **Logistics & Fleet**, **Assets**,
**Maintenance/CMMS**, **HSE**, **Service Desk** (which absorbs IT Management).

## Phase 5 — Platform & scale (ongoing)

Customer/supplier portal · integration hub and public API · advanced BI · mobile
polish · tenant billing and self-serve onboarding · localisation packs for the
second country.

## Notes, risks and things to decide early

**Get the data model right before the features.** Item, party, project, cost code,
UoM and the GL are the six things you cannot cheaply change later. Everything else
is refactorable.

**Build the boundary enforcement in week one, not month twelve.** dependency-cruiser
plus the ESLint import rule. A modular monolith without mechanical enforcement is
just a monolith with good intentions.

**Resist premature extraction.** Do not pull a module into a service until a
specific, measured problem demands it. The outbox design means you can, cheaply,
when the day comes.

**Do not build a generic "workflow builder" for everything.** Build the approval
engine (bounded, well-understood) and resist the pull toward a general-purpose BPM
platform. That is a product in itself and it will consume the whole roadmap.

**Multi-currency and multi-company from day one** in the schema, even if the UI
does not expose them. Adding a currency column to a live ledger is a migration
nobody enjoys.

**Design the invoice model for e-invoicing now.** UAE is moving to a Peppol-based
model; confirm the current FTA timeline, but include the required identifiers,
line-level tax codes and document references from the first migration.

**Offline is a scoped feature, not an architecture.** Six specific flows need it
(stock count, GRN, production scan, QC/snag, POD, site attendance). Do not attempt
a fully offline ERP.

**Your data-import story is a sales feature.** Every prospect has ten years in
Excel. A good Excel importer with validation and dry-run preview closes deals.
Budget real time for it.

**Single point of failure.** One free VM. The backup restore test in
`04-infrastructure.md` is what makes that acceptable. Move to paid hosting with a
managed database the week you sign customer one — that is a cost of revenue, not a
cost of building.

**Use your own factory as customer zero.** The fastest route to a good ERP is a
short feedback loop with real users who cannot ignore your bugs. Run the business
on it before selling it.

**Licence hygiene.** Keep dependencies MIT/Apache/BSD. Watch for AGPL and for
"open source" packages with commercial add-on tiers (AG Grid, some chart libraries)
where the feature you eventually want is behind the paywall. Check before adopting,
not after building on it.

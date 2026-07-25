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

Next in the wedge: the Production module proper — work orders, BOM explosion,
routing through work centres, and shop-floor barcode scanning. The optimiser is
the hard part and it is done; Production wires it to jobs and to the factory.

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

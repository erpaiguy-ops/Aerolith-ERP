# 03 — Modules

Your 17, plus the ones you will discover you needed. Anything marked **kernel** is
a platform capability, not a sellable module.

## Reclassified from your list

| Your item | Where it belongs | Why |
|---|---|---|
| 12. Document Management | **kernel** | Every module attaches files. One implementation, or you get fourteen |
| 15. Reporting | **kernel** | A registry + export pipeline every module plugs into |
| 16. Approval Process Flow | **kernel** | Same. This is the classic ERP mistake — do not build it per module |
| 11. IT Management | module, but scope it | See below — this is really two different things |

---

## 1. Inventory / Stores

Multi-warehouse, multi-location (rack/shelf/bin), barcode-driven.

- Item master with variants, UoM conversion (sheet ↔ m² ↔ linear m — essential for
  boards and edge tape), and **sheet goods handled by dimension not just count**.
- **Offcut register** — joinery-specific and commercially significant. Track usable
  offcuts by dimension and material, make them consumable by the cutlist optimiser.
  This is real money recovered.
- Batch/lot and serial tracking, grain/colour batch matching for veneer and laminate.
- Goods receipt, issue to job, inter-warehouse transfer, return, scrap with reason.
- Costing: moving average or FIFO (pick one, make it tenant configuration).
- Cycle counting and stock take with mobile scan and variance approval.
- Reorder levels → auto purchase requisition (fires only if Procurement is enabled).
- Consignment stock, supplier-owned stock, and site stock (material at a project site).

## 2. HR & Admin

- Employee master, org chart, contracts, probation, grades.
- **Document expiry tracking** — passport, visa, Emirates ID, labour card, medical
  insurance, driving licence, trade licence. Automated escalating alerts. In the
  GCC this single feature sells the module.
- Attendance & timesheets — biometric device import (most export CSV; ZKTeco has an
  open SDK), plus **mobile geofenced clock-in for site staff** and barcode scan on
  the factory floor. Timesheet hours must flow to job costing.
- Leave management with accrual rules, air-ticket entitlement, gratuity/EOSB accrual.
- Payroll: salary structures, allowances, deductions, overtime, and **WPS SIF file
  generation** if UAE. Payroll posts to the GL.
- Recruitment, onboarding/offboarding checklists, appraisals, training & certification
  matrix (relevant to HSE compliance), disciplinary records.
- Self-service portal — payslips, leave requests, document downloads.

## 3. Sales & Marketing / CRM

- Leads → opportunities → quotations → orders, with pipeline and weighted forecast.
- **Tender pipeline** is distinct from a product sales pipeline: prequalification,
  bid/no-bid decision, bond tracking, submission deadlines. Model it properly.
- Client/consultant/main-contractor contact management with relationship mapping —
  in fit-out, who specified you matters as much as who pays you.
- Quotation versioning (revisions are constant), approval routing, PDF generation.
- Activity log, follow-up reminders, email integration.
- Marketing is light: campaign tracking, source attribution, a project portfolio /
  reference-works library. Skip marketing automation entirely.

## 4. Procurement

- Purchase requisition → RFQ → quote comparison → PO → GRN → invoice matching.
- **3-way matching** (PO / GRN / invoice) with tolerance rules. Non-negotiable.
- Supplier master with prequalification, categories, trade licence expiry,
  performance scoring (on-time %, quality rejection %, price variance).
- **Subcontractor procurement is a separate flow** — back-to-back terms, retention,
  work orders, payment certificates, not just POs. Build it explicitly.
- Framework agreements and rate contracts, budget checking against project cost codes
  before a PO is released, landed cost (freight, duty, clearing) apportioned to items.

## 5. Production (Joinery Factory) — *your differentiator, build it well*

- **Job/work order** from a project or sales order, with a BOM per item.
- **Cutlist optimisation** — nesting for panels, guillotine layouts, yield %,
  offcut generation back to inventory, edge-banding metres per tape type, drilling
  and hardware schedules. Barcode label per part.
- **Routing through work centres** — beam saw → CNC → edgebander → drilling/insertion
  → sanding → **polishing/spray booth** → assembly → QC → packing → dispatch.
  Each with capacity, setup and run rates.
- **Shop-floor scan terminals** — operator scans a part barcode at each station;
  that single scan gives you WIP position, machine utilisation, operator
  productivity, real labour cost against the job, and live progress on the project
  Gantt. This is the highest-value feature in the whole system.
- **Polishing/finishing needs its own model** — it is a batch process, not a unit
  process. Spray booth capacity, cure/dry time as a scheduled constraint, number of
  coats, colour/finish matching, rework loops, humidity holds. Generic MRP does this
  badly; doing it well is a genuine selling point.
- Assembly: sub-assembly hierarchy, hardware kitting, fitting checklists.
- Capacity planning and a finite-capacity scheduling board (drag-and-drop, dnd-kit).
- Machine breakdown → link to Maintenance module.
- Rework and scrap tracking with root cause, costed back to the job.
- Material reservation and shortage report against the production plan.

## 6. Projects (Joinery Works)

**Status: shipped (v0.1).** WBS with rules of credit, versioned budgets, an
append-only job cost ledger, commitments, value-weighted progress, earned value
and forecasting, milestones and snagging. What follows in this list beyond those
is still to build.

Three decisions worth recording, because they are the ones that were tempting to
get wrong:

- **Progress is value-weighted, always.** Averaging percentages across WBS nodes
  reports 80% on a job that is 20% done, every time the work is unevenly
  distributed — which it always is. The weight is the budget.
- **Rules of credit replace opinions with counts.** A self-assessed percentage is
  permitted, needs its own dangerous permission, and is capped below 100%: only
  marking a node finished reaches 100. Without the cap, "100% complete" arrives
  weeks before the work does.
- **Earned value is rolled up in COST units as well as revenue units.** CPI is
  earned value over actual cost; feeding it revenue-weighted earned value
  overstates the index by exactly the job's margin, so a job losing money reads
  comfortably above 1.0 until the final account. Both roll-ups are kept, and they
  are not interchangeable.

Still to build:

- Gantt with dependencies and baselines, resource loading.
- **Site survey & measurement records** with photos and dimension sheets.
- **Shop drawing register: submission → consultant review → approved/approved-as-noted
  → revision.** Fit-out lives and dies by this. Include the approval clock, because
  consultant delay is your single biggest cause of claims.
- Material submittals, mock-up approvals, sample tracking.
- **RFI register** with response SLA.
- Installation planning, **photo markup on drawings** for snags (the register
  itself is shipped), final handover certificate.

## 7. Estimation & Tendering

- BOQ import from Excel and PDF (the client will send both; support both).
- **Item build-up**: material + labour + machine + finishing + hardware + wastage %
  + subcontract + overhead + margin. Roll up to element, area, and tender total.
- **Rate library** with versioning, so last year's rates are auditable — and a
  historical-cost feedback loop: actuals from completed jobs update the library.
  Nobody else does this well, and it compounds in value with every job you finish.
- Multiple pricing scenarios and what-if margin analysis on one tender.
- Alternates/optional items, provisional sums, prime cost items, day-work rates.
- Preliminaries and general-condition costing.
- Tender document register, addenda tracking, submission checklist and deadline alerts.
- **Won tender → project + BOM + budget in one click.** The estimate becomes the
  budget becomes the production BOM. That continuity is the product.

## 8. Contract Administration

**Status: shipped (v0.1).** Contract register (receivable and payable from one
table), variations with valuation by contract rates / pro-rata / star rate /
dayworks / lump sum, interim payment applications and certificates, retention
with caps and a release schedule, advance recovery, back charges and the notice
register.

The four things that make it worth building rather than doing in Excel:

- **Everything is cumulative-to-date; the certificate is the difference.** Never
  "this month's work". A monthly-increment model has nowhere to put a downward
  re-measurement, so the correction silently disappears and the overpayment
  stands. This is the most common spreadsheet error in the trade.
- **The application and the certificate are separate rows.** What you asked for
  and what the client agreed to pay both survive. Typing one over the other
  destroys the disallowance, and a client who certifies 94% of everything never
  becomes a fact anyone can price against.
- **Only approved variations move the contract sum.** Instructed-but-unapproved
  work is reported as *exposure*, weighted by how much of it is actually built,
  and kept separate from merely-claimed work that carries no instruction. Those
  two have very different chances of ever being paid.
- **Commercial terms come from the country pack.** A UAE contract gets 10%
  retention, a 50/50 release, a 12-month defects period and 60-day terms with
  nobody configuring anything — then they are snapshotted onto the contract, so
  an admin editing a default later cannot restate a signed, part-certified deal.

Still to build:

- Certificate and application PDF generation.
- Claims, EOT records, delay/disruption event log with contemporaneous records.
- Sales invoices, credit notes, VAT treatment, ageing, dunning (with Accounts).
- Back-to-back subcontractor certificates mirroring the main contract.

## 9. Logistics

- Delivery planning, load lists, vehicle assignment, route sequencing.
- **Delivery notes with barcode scan-out and mobile proof of delivery** (signature +
  photo + GPS + timestamp).
- Packing lists and crate/blanket-wrap manifests tied to production output.
- Fleet: vehicle register, insurance and registration expiry, fuel log, mileage,
  fines, driver assignment, service schedule.
- Gate pass, material return from site, import/export shipment tracking with
  customs documents.

## 10. Accommodation

- Property/camp register, rooms, beds, occupancy and allocation.
- Assignment history per employee, room transfer, vacancy forecast against
  mobilisation plan.
- Rent and utility tracking, lease register with renewal alerts, deposit tracking.
- Inspections, maintenance requests, HSE/municipality compliance checklists,
  occupancy-limit violations.
- Transport allocation from camp to factory/site, bus routes and rosters.
- Mess/catering headcount, cost per employee allocated to overhead.

## 11. IT Management

Scope this deliberately — it is two products:
- **IT asset & licence tracking** → merge it into Asset Management. Do not duplicate.
- **Service desk** → ticketing, SLA, knowledge base, change log. Build it as a
  generic **Service Desk / Helpdesk** module instead, so the same engine serves
  IT tickets, maintenance requests, accommodation complaints and customer
  after-sales calls. One module, four revenue justifications.

## 12. Document Management — **kernel**

- R2 storage, Postgres metadata, folder + tag + full-text search, versioning with
  check-in/check-out, retention rules.
- Every document is polymorphically attached to any entity in any module.
- Drawing register with revision control, transmittals with acknowledgement.
- Templates and mail-merge for letters, transmittals, certificates.
- E-signature via Documenso; OCR on upload for searchable scans.
- Access control inherits from the parent entity's permissions — do not build a
  second permission system.

## 13. Asset Management

- Register: machinery, vehicles, tools, IT equipment, furniture, with parent/child.
- QR/barcode tag, custody assignment, location, transfer and check-out log.
- Depreciation schedules posting to the GL, insurance, warranty, disposal.
- Calibration and statutory inspection records.
- Links to Maintenance (below) and to Production work centres.

## 14. Accounts

- Double-entry GL with the posting-rules design in `02-architecture.md`.
- Chart of accounts (tenant-configurable), cost centres, multi-currency with
  revaluation, fiscal periods with locking.
- AR / AP sub-ledgers with ageing, bank and cash management, reconciliation
  (statement import), petty cash, fixed-asset register integration.
- Budgeting and budget control at cost-code level.
- **Tax engine isolated in `packages/localisation`** — VAT/GST rules, reverse charge,
  designated zones, tax returns, and **e-invoicing** (UAE is moving to a Peppol-based
  5-corner model; confirm the current FTA timeline before you design the invoice
  payload, and build the invoice model with the extra fields from day one).
- Financial statements: P&L, balance sheet, cash flow, trial balance — plus by
  project and by cost centre, which is what actually gets used.

## 15. Reporting — **kernel**

- A report registry: modules declare reports; the kernel handles parameters,
  permissions, scheduling, export (PDF/Excel/CSV) and email delivery.
- Dashboards per role — MD, project manager, factory manager, storekeeper, accountant.
- Metabase self-hosted against a read-only `reporting` schema of published views,
  for ad-hoc analysis you did not anticipate.
- Materialised views refreshed by `pg_cron` for the heavy aggregates.
- Design rule: modules publish **views**, never let a report query another module's
  tables directly. That is how reporting quietly destroys your boundaries.

## 16. Approvals — **kernel**

Fully specified in `02-architecture.md`.

## 17. The modules you did not list but will need

| Module | Why it is not optional |
|---|---|
| **Quality / QA-QC** | Inspection & test plans, checklists at each production stage, NCRs, snagging, material inspection at GRN. In fit-out this is contractual, not nice-to-have |
| **HSE** | Incidents, near misses, toolbox talks, permits to work, PPE issue, risk assessments, audits. Required to prequalify for most serious clients |
| **Maintenance (CMMS)** | Preventive schedules for CNC/beam saw/edgebander, breakdown logging, spare parts (links to Inventory), downtime cost. A stopped edgebander stops the factory |
| **Job costing / WIP** | Cross-cutting, sits over Production + Projects + Accounts. Arguably the point of the entire ERP |
| **Subcontractor management** | Distinct enough from Procurement to warrant its own screens |
| **Warranty / after-sales** | DLP callbacks, service jobs, warranty claims. Also a revenue stream |
| **Customer & supplier portal** | External limited-access views: order status, drawing approvals, invoices, PO acknowledgement. Cheap to build on your existing auth, disproportionately impressive in demos |
| **Master data management** | Owned by the kernel: item, party, project, UoM, numbering series, approval of master-data changes |
| **Integration hub** | Email/IMAP ingestion, bank file import, accounting export, webhooks, public API |
| **Tenant admin & billing** | You are selling SaaS: tenant provisioning, module entitlement, usage metering, subscription state. You need this to have a business, not just software |
| **Audit & compliance** | Kernel: immutable audit trail, data retention, GDPR/PDPL export & erasure |

## Sequencing note

The list above is roughly 4-6 years of work at small-team velocity. `05-roadmap.md`
sequences it so that you have something sellable at the end of phase 2, not at the
end of phase 6.

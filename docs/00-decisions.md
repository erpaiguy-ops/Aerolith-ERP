# 00 — Key Decisions (read this first)

Status: proposed, 2026-07
Context: greenfield. Zero cash budget. Target domain is a joinery / fit-out
contractor (factory + site works + labour accommodation), with the intent to sell
each module standalone **and** as one unified ERP.

## Assumption to confirm

The module list (Accommodation Management, Estimation & Tendering, Contract
Administration with variations, Joinery factory) reads as **UAE / GCC contracting**.
That assumption drives several decisions below (VAT at 5%, WPS payroll files,
Peppol/PINT e-invoicing, Emirates ID & visa expiry tracking, labour accommodation
compliance, retention + payment certificates).

If the target market is elsewhere, the architecture does not change — only the
localisation pack (tax engine, payroll, statutory reports) does. That is exactly
why localisation is isolated into its own package in the design.

---

## Decision 1 — Build custom, or build on ERPNext?

This is the single highest-leverage fork in the road, so take it deliberately.

**Option A — ERPNext / Frappe (free, open source).**
Ships ~60-70% of your list on day one: Accounts, Inventory, Procurement, CRM,
HR & Payroll, Projects, Assets, Manufacturing, Approvals. You would build only the
joinery layer (cutlist, machine routing, polishing/assembly WIP, estimation,
contract admin).

- Fastest path to a working system by a wide margin. Months, not years.
- Costs: Python/Frappe framework lock-in, a genuinely opinionated data model you
  will fight, and **AGPL v3** — if you host it as a SaaS you must offer your
  source (including your joinery modules) to your users. That is a real
  commercial constraint, not a technicality.
- Fatal against your requirement 19: ERPNext is a monolith. You cannot cleanly
  sell "Aerolith Inventory" as a standalone product out of it.

**Option B — Custom modular monolith. ← recommended**
More work, but it is the only option that satisfies "individual working apps AND
one ERP", lets you own the joinery IP under whatever licence you want, and lets
you sell modules separately.

**Recommendation: Option B**, with one caveat — be honest that 17 modules is a
multi-year programme for a small team. The way to survive it is the phased
roadmap in `05-roadmap.md`: build the kernel, then the *joinery wedge*
(Estimation → Production/Cutlist → Projects → Contract Admin/Invoicing). That
wedge is what no generic ERP does well, and it is what you actually sell. The
generic modules (Inventory, HR, Accounts) are table stakes and can follow.

A defensible hybrid, if speed matters more than product ownership: run ERPNext
internally to operate the business now, build Option B as the product in
parallel, and migrate. Do **not** try to build custom modules inside ERPNext and
also extract them later — that path gives you the costs of both options.

## Decision 2 — Modular monolith, not microservices

One deployable, one database, hard internal boundaries. See `02-architecture.md`.
17 microservices cannot be operated by a small team, and cross-module
transactions (goods receipt → stock → GL posting) become distributed-transaction
problems for no benefit at your scale.

## Decision 3 — Postgres, single database, shared schema, RLS multi-tenancy

`tenant_id` on every table, Postgres Row Level Security as the enforcement floor,
one schema per module inside the one database. Not schema-per-tenant (migration
pain), not database-per-tenant (cost you do not have).

## Decision 4 — TypeScript end to end

Next.js (web) + NestJS (API) + Drizzle (data) + Zod (contracts) in one Turborepo.
One language across factory tablets, site PWA, API and jobs is worth more to a
small team than picking the theoretically-best tool per layer.

## Decision 5 — Document Management, Approvals and Reporting are *kernel*, not modules

Your items 12, 15 and 16 are cross-cutting platform capabilities. Every module
attaches documents, routes approvals and emits reportable facts. Building them as
peer modules is the most common way this kind of project goes wrong — you end up
with fourteen approval implementations. They go in the kernel, built first.

## Decision 6 — Self-host on Oracle Cloud Always Free, not a serverless free tier

4 ARM cores / 24 GB RAM / 200 GB storage, free indefinitely, runs the whole stack.
Serverless free tiers (Supabase 500 MB and pausing, Vercel Hobby's
non-commercial clause) will not carry an ERP with documents. See
`04-infrastructure.md`.

## Decision 7 — Spend the $10

You said no money, and the stack below costs nothing. The one exception worth
naming: a real domain is ~$10/year at cost from Cloudflare Registrar. You cannot
credibly sell B2B ERP from a `*.workers.dev` subdomain. Free options are listed in
`04-infrastructure.md` for the pre-revenue phase, but plan to buy the domain
before the first customer demo.

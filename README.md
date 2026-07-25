# Aerolith-ERP

A modular ERP for joinery and fit-out contracting — factory production, site works,
and the commercial layer that joins them. Each module is sellable standalone; all
of them together are one ERP.

Target markets: UAE, Qatar and the wider Middle East. Country specifics are **data,
not code** — see [`docs/06-localisation.md`](docs/06-localisation.md).

## Status

Kernel, API and the first business module (Inventory).

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
- **274 tests**, including integration suites that prove tenant isolation holds and
  drive the approval engine, the API and stock posting end to end

**Not built yet** — the web app, and every module after Inventory.
See [`docs/05-roadmap.md`](docs/05-roadmap.md).

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

## Getting started

```bash
pnpm install
pnpm db:up          # Postgres 17 in Docker
pnpm db:migrate     # schema + RLS policies + app role
pnpm db:seed        # rule catalogue + country packs

pnpm verify         # typecheck, lint, boundary check, tests
```

Integration tests need a database:

```bash
TEST_DATABASE_URL=postgres://aerolith:aerolith@localhost:5432/aerolith pnpm test
```

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
  modules/
    inventory/         first business module — owns the `inventory` schema
      src/domain/      costing and offcut matching: pure, no framework, no DB
      src/service/     movement posting (atomic: stock, cost, number, event)
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

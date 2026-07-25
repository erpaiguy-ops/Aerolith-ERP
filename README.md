# Aerolith-ERP

A modular ERP for joinery and fit-out contracting — factory production, site works,
and the commercial layer that joins them. Each module is sellable standalone; all
of them together are one ERP.

## Status

Design phase. No code yet. The architecture and stack are documented below.

## Documentation

| Doc | Contents |
|---|---|
| [`docs/00-decisions.md`](docs/00-decisions.md) | The decisions that are expensive to reverse — start here |
| [`docs/01-tech-stack.md`](docs/01-tech-stack.md) | Full stack, with what was rejected and why |
| [`docs/02-architecture.md`](docs/02-architecture.md) | Modular monolith, module boundaries, multi-tenancy, approvals, the GL |
| [`docs/03-modules.md`](docs/03-modules.md) | All modules, joinery-specific detail, and the ones missing from the original list |
| [`docs/04-infrastructure.md`](docs/04-infrastructure.md) | Zero-budget hosting, domain, repo setup, CI/CD, backups, security |
| [`docs/05-roadmap.md`](docs/05-roadmap.md) | Phasing, scope reality, and open risks |

## Headline decisions

- **TypeScript everywhere** — Next.js + NestJS + Drizzle + Postgres, one Turborepo.
- **Modular monolith** with mechanically enforced boundaries — not microservices,
  not a big ball of mud.
- **Standalone vs unified is a licensing concern**, not a deployment one: same
  binary, per-tenant module entitlements.
- **Document management, approvals and reporting are kernel capabilities**, built
  once, used by every module.
- **Self-hosted on free-tier infrastructure**, designed to move to paid hosting the
  day there is a paying customer.

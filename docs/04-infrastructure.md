# 04 — Infrastructure, Domain, Repo & Ops (zero budget)

## Hosting — the recommendation

**Oracle Cloud Infrastructure "Always Free" — Ampere A1 ARM VM.**

- 4 OCPU / 24 GB RAM / 200 GB block storage / 10 TB egress per month, free with no
  time limit. This is by a wide margin the most capable genuinely-free compute
  available, and it comfortably runs Postgres + API + web + worker + Valkey +
  Metabase + monitoring on one box.
- Caveats, stated honestly:
  - ARM A1 capacity is frequently exhausted in popular regions. Retry, or pick a
    less busy region near your users. Expect this to take a few attempts.
  - Oracle reclaims *idle* Always Free compute. A running ERP with monitoring is
    not idle, but do not provision and abandon it.
  - It is one machine with no HA. That is acceptable pre-revenue **provided the
    backup plan below is actually in place.**

Set it up with **Coolify** (self-hosted, open source): git-push deploys, TLS
certificates, container management and backups, i.e. your own free Heroku.

**Fallback / second choice:** Google Cloud always-free e2-micro (too small for the
DB — use it as a monitoring and backup host), or accept a real bill later at
Hetzner (~€4/mo for a CX22, which is where you should move the day you have one
paying customer — one machine failure on the free tier is not something you want
to explain to a customer).

**Do not build on:** Vercel Hobby (commercial use is prohibited by its terms),
Supabase free (500 MB, pauses after ~a week idle), Render free (services spin
down and cold-start), Railway (no meaningful free tier any more).

## Edge and storage — Cloudflare (free tier, permanently)

| Service | Use | Free allowance |
|---|---|---|
| Cloudflare DNS | DNS for whatever domain you use | Unlimited |
| Cloudflare Tunnel | Expose the OCI box without opening ports or needing a static IP | Free |
| Cloudflare R2 | Documents, drawings, photos, PDFs | 10 GB, **no egress charges** |
| Cloudflare WAF / rate limiting | Basic protection | Free tier |
| Cloudflare Pages | Marketing site & docs | Free, commercial use allowed |

R2's zero egress is the point: a document-heavy ERP serving drawings and photos
would generate a meaningful S3 bill and generates none here.

## Domain

There is no good free domain any more — Freenom is gone. Options, in order:

1. **Buy one. ~$10/year at cost from Cloudflare Registrar.** For a B2B ERP this is
   the single highest-return $10 you will spend. `.com` or a country TLD.
2. Pre-revenue, free-only stopgaps:
   - `*.pages.dev` / `*.workers.dev` — instant, free, fine for internal builds.
   - `.eu.org` — genuinely free, but manual approval and can take weeks.
   - `js.org` / `is-a.dev` — free subdomains, open-source projects only. Not for a
     commercial SaaS; do not misuse them.

**Structure it for multi-tenancy from day one**, even on a free subdomain:

```
aerolith.app              marketing site        (Cloudflare Pages)
app.aerolith.app          the ERP shell
{tenant}.aerolith.app     tenant subdomain      (wildcard DNS + wildcard cert)
api.aerolith.app          API
docs.aerolith.app         documentation
```

Wildcard subdomains cost nothing extra and let you resolve the tenant before the
request reaches your code. Retrofitting this later is genuinely painful.

## Repository setup

**One monorepo.** With enforced module boundaries you get isolation without the
overhead of 17 repos, and cross-cutting changes stay atomic.

```
Repo:      erpaiguy-ops/aerolith-erp
Default:   main (protected — no direct pushes, PR + green CI required)
Branches:  feat/<module>-<slug>, fix/<slug>, chore/<slug>
Commits:   Conventional Commits (feat:, fix:, chore:) — drives changelogs
```

Free GitHub features worth turning on immediately:

- **Branch protection** on `main`: require PR, require CI, require conversation
  resolution.
- **CODEOWNERS** per module directory — even solo, it documents ownership.
- **GitHub Projects** — free, adequate; do not pay for Jira.
- **Issue & PR templates**, labels namespaced by module (`module:inventory`).
- **Dependabot / Renovate** — free.
- **Secret scanning + push protection** — free on public repos, and worth enabling.
- **GitHub Actions** — 2,000 min/month free on private repos, unlimited on public.
  Use Turborepo's affected-only builds and remote caching so you stay inside it.
- **GitHub Container Registry** — free image hosting for your deploys.
- **GitHub Pages** — free marketing/docs hosting.

CI pipeline: `lint → typecheck → dependency-cruiser (boundary check) → unit tests
(Vitest) → integration tests (Testcontainers + real Postgres) → build → E2E
(Playwright, on PRs to main only) → deploy on merge`.

The dependency-cruiser step is not optional. It is the only thing standing between
you and a big ball of mud in eighteen months.

## Database operations

- Postgres 17 in Docker on the OCI box, with tuned `shared_buffers` for 24 GB.
- Migrations: `drizzle-kit`, forward-only, checked into the repo, applied
  automatically on deploy. Every migration must be safe to run against a live
  database (add columns nullable, backfill, then constrain — never a blocking
  rewrite on a big table).
- **Backups — the part people skip and then regret:**
  - `pg_dump` hourly → R2, with 7 daily / 4 weekly / 12 monthly retention.
  - Enable WAL archiving to R2 for point-in-time recovery.
  - **A monthly GitHub Action that restores the latest dump into a throwaway
    container and runs a row-count assertion.** An untested backup is not a backup,
    and on a single free VM your backup is the only thing between you and losing
    the business.
  - Documents in R2 already have versioning — turn it on.

## Observability (free)

- **Sentry** free tier (5k errors/month) or self-hosted **GlitchTip**.
- **Grafana + Loki + Prometheus** on the same box, or Grafana Cloud's free tier
  (10k series, 50 GB logs) to keep monitoring off the box being monitored — which
  is the better arrangement, since a box that dies cannot alert you about itself.
- **Uptime Kuma**, self-hosted elsewhere, alerting to Telegram (free).
- Structured JSON logs (pino) with `tenant_id` and `request_id` on every line.

## Security baseline (all free, all mandatory)

- Postgres RLS on every tenant table (see `02-architecture.md`).
- Argon2id password hashing, TOTP 2FA (mandatory for approver roles).
- Application-level encryption for salary, passport and bank fields.
- Rate limiting at Cloudflare and in the API; short-lived JWTs + rotating refresh
  tokens; strict CSP; signed, expiring R2 URLs for document downloads.
- Immutable audit log for every mutation on financial and HR data.
- Secrets in the deployment environment only. Never in the repo — and enable push
  protection so that is enforced rather than hoped for.

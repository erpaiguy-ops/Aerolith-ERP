# 01 — Tech Stack

Everything here is free and self-hostable, or has a free tier that survives real
production use. Licences are permissive (MIT/Apache) unless flagged.

## Core

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript 5.x (strict) | One language across web, API, jobs, factory tablets |
| Monorepo | pnpm workspaces + Turborepo | Free, fast, affected-only CI |
| Web | Next.js 15 (App Router) + React 19 | SSR for heavy list screens, RSC cuts client bundle |
| API | Fastify 5 | See "Revised: Fastify over NestJS" below |
| Contracts | Zod + ts-rest | End-to-end type safety over plain REST, so third parties and mobile can integrate later |
| DB | PostgreSQL 17 | Transactions, RLS, JSONB custom fields, materialised views, full-text search, `pg_cron` |
| ORM | Drizzle ORM | SQL-first; ERP reporting needs real SQL, and Drizzle does not fight you. Migrations via drizzle-kit |
| Jobs/queue | pg-boss (start) → BullMQ + Valkey (later) | pg-boss needs no extra service; move when throughput demands |
| Cache | Valkey (Redis fork, BSD) | Only when measurements justify it |
| Auth | Kernel-owned, Node `crypto` scrypt | See "Revised: authentication in the kernel" below |
| Authorisation | CASL + DB permission matrix + Postgres RLS | Rules are data (tenant-configurable), enforced in app *and* database |
| Files | Cloudflare R2 (S3 API) | 10 GB free, **zero egress fees** — critical for a document-heavy ERP |
| Search | Postgres FTS → Meilisearch when needed | Avoids running Elasticsearch on a free box |
| Realtime | SSE over Postgres `LISTEN/NOTIFY` | Enough for approvals, notifications, live job status. WebSockets only if you add chat |

### Revised: Fastify over NestJS

This document originally specified NestJS, chosen because its `@Module` system
mapped onto the 17 business modules. Building the kernel changed the reasoning,
so the decision is revised here rather than left contradicting the code.

The module registry in `@aerolith/kernel` already does that job, and does it
better for this product: it resolves modules **per tenant at request time** from
entitlement rows, which is what makes one binary serve both the standalone
product and the full ERP. NestJS's module graph is static and resolved at boot,
so it cannot express that — which would leave two parallel module concepts to
keep in sync, one of which does not actually control anything.

Fastify keeps one module concept, the one that carries the licensing model.
NestJS's DI, guards and interceptors would have been genuine value if the
manifest system did not exist; given that it does, they duplicate it.

What is unchanged: typed contracts via Zod at the boundary, and REST rather than
RPC so third parties and the PWA can integrate later.

### Revised: authentication in the kernel

This document originally specified **Better Auth**. Building the kernel changed
the reasoning, so the decision is revised here rather than left contradicting the
code.

The kernel already owns `app_user`, `membership`, `session`, `role`,
`user_role` and `permission`, because tenancy, RBAC and Postgres RLS all hang off
them. A session library that owns its own user and session tables would sit
*beside* that, and every request would have to reconcile the two — with the RLS
guard, the per-tenant permission matrix and the audit actor all derived from the
kernel's copy. That is two sources of truth for identity, and the failure mode is
a session that is valid in one and not the other.

What was actually missing was small: verify a password, issue a row in the
session table the kernel already had, and count failures. That is
`packages/kernel/src/auth`, and it is about 300 lines.

What is unchanged: the intent to add TOTP and SSO. The schema already carries
`totp_secret`, `recovery_codes` and `email_verified_at` for exactly that, and an
OIDC provider can be added without moving where sessions live.

#### Password hashing: scrypt, not Argon2id

Measured, not assumed:

| Implementation | Cost per hash | Blocks the event loop |
|---|---|---|
| argon2id, pure JS, 19 MiB | 483 ms | **yes** |
| scrypt, Node native, 32 MiB | 246 ms | no |

Argon2id is the stronger primitive and OWASP prefers it — but that comparison
assumes a *native* Argon2, and a native binding needs a toolchain or prebuilt
binaries on every platform this runs on. A password hash that fails to build is
an authentication system that will not start.

The blocking is what settled it. `crypto.scrypt` is C and runs on the libuv
threadpool, so sixteen concurrent logins finish in about a second of wall time
and the API keeps serving everyone else. The pure-JS alternative stalls the whole
process for half a second per attempt, turning the one unauthenticated endpoint
in the system into a denial-of-service amplifier — on a free-tier single box,
that is not theoretical.

Parameters are OWASP's `N=2^15, r=8, p=3` (32 MiB) rather than the 128 MiB
variant they list as equivalent: memory is the scarce resource on the target box.

Hashes are PHC strings (`$scrypt$ln=15,r=8,p=3$…`), so the algorithm and its
parameters travel with the hash. That is what makes the cost raisable later, and
`verifyPassword` still understands `$argon2id$` so a tenant migrated in from an
Argon2 system signs in normally and is converted on the way past.

## UI

- **Tailwind CSS + shadcn/ui** — you own the component source, no licence, no vendor.
- **TanStack Table v8** — ERP is 80% data grids. Virtualised, server-side paginated.
  (AG Grid Community is the alternative; its good features are paid — avoid the trap.)
- **TanStack Query** — server-state, caching, optimistic updates, offline persistence.
- **React Hook Form + Zod** — one schema validates client, server and database.
- **Recharts** for in-app charts; **Metabase** (self-hosted, free) for ad-hoc BI.
- **dnd-kit** — production board, kanban, approval-step builder.

## Documents & output

| Need | Tool |
|---|---|
| PDF (quotes, invoices, delivery notes, payment certs) | React → HTML → **Playwright/Chromium** print-to-PDF. Full CSS control, no PDF DSL |
| Excel in/out | **ExcelJS** (styled export), **SheetJS** (import) |
| Barcode / QR generation | **bwip-js** — panel labels, bin locations, asset tags, GRNs |
| Barcode scanning | **@zxing/browser** in the PWA — phone camera, no scanner hardware to buy |
| OCR (invoices, delivery notes) | **Tesseract.js**, queued as a background job |
| E-signature | **Documenso** (self-hosted, free) for contracts and variation approvals |
| Drawings | **PDF.js** viewer + annotation layer for shop drawings, RFIs and snags |

## Joinery-specific engine (your actual differentiator)

- **Cutlist / panel optimisation** — 2D guillotine cutting-stock. Start with
  first-fit-decreasing + guillotine heuristic, then simulated annealing for yield.
  Written as a pure, dependency-free TS package (`@aerolith/cutlist`) so it can run
  in a worker, in the browser, or compile to WASM later.
  Outputs: cutting layouts (SVG), material yield %, offcut register, edge-banding
  metres by tape type, labelled part list with barcodes.
- **Irregular nesting** — **SVGnest** algorithm (OSS) for solid-surface and shaped parts.
- **DXF import/export** — `dxf-parser` / `dxf-writer` for part geometry.
- **CNC hand-off** — phase 1: optimised cutlist CSV + labelled PDF + barcodes.
  Phase 2: post-processors for your specific machines (Homag `.mpr`, Biesse `.bpp`,
  Nanxing). Do not attempt phase 2 until a paying customer names their machine.
- **Routing & WIP** — machine/work-centre routing (beam saw → CNC → edgebander →
  drilling → polishing/spray booth → assembly → QC → packing), each with capacity,
  setup time, run rate and a barcode scan-in/scan-out.

## Mobile / shop floor

**PWA first.** Installable, camera access for scanning, offline-capable, and it
avoids the $99/yr Apple + $25 Google developer fees — which is not a rounding
error at zero budget.

- Offline via IndexedDB (**Dexie**) + an **outbox pattern**: queue mutations locally,
  replay on reconnect, conflict-resolve server-side by version.
- Offline is scoped to the flows that genuinely need it: stock count, goods receipt,
  production scan, QC/snag capture, delivery proof-of-delivery, site attendance.
  Do not attempt a fully offline ERP.
- Native (Expo) only if you later need background BLE or push on iOS.

## Notifications

| Channel | Free option | Note |
|---|---|---|
| Email | Resend (3k/mo, 100/day) or Brevo (300/day) | Use your own domain + SPF/DKIM |
| In-app | SSE + notification centre in the kernel | Free, always works |
| Chat | **Telegram Bot API** — genuinely free, unlimited | Excellent for approval pings |
| WhatsApp | Meta Cloud API | Template messages are billed. Defer until revenue |

## Quality & operations

- **Vitest** (unit) + **Testcontainers** (real Postgres in tests) + **Playwright** (E2E).
- **ESLint + dependency-cruiser** — these are what *mechanically enforce* module
  boundaries. Without them "modular monolith" degrades into a monolith in ~6 months.
- **Sentry** free tier (5k errors/mo) or self-hosted **GlitchTip**.
- **Uptime Kuma** + **Grafana/Loki/Prometheus**, self-hosted on the same box.
- **Renovate** (free) for dependency updates; **Changesets** for module versioning.

## Deliberately rejected

| Rejected | Reason |
|---|---|
| Microservices | 17 services, one small team, distributed transactions. No. |
| Prisma | Weaker at the complex analytical SQL an ERP lives on |
| Keycloak | 1 GB+ RAM for something the kernel does in 300 lines and one table it already owned |
| Elasticsearch | Same — Postgres FTS covers you until it genuinely does not |
| Temporal | Correct tool, wrong weight class. A DB-backed state machine suffices |
| Vercel Hobby | **Its terms prohibit commercial use.** Real trap for a SaaS |
| Supabase free | 500 MB, and projects **pause after ~1 week idle**. Fine for a prototype, not a product |
| Firebase | Document model is a poor fit for double-entry accounting and hard joins |

# 01 — Tech Stack

Everything here is free and self-hostable, or has a free tier that survives real
production use. Licences are permissive (MIT/Apache) unless flagged.

## Core

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript 5.x (strict) | One language across web, API, jobs, factory tablets |
| Monorepo | pnpm workspaces + Turborepo | Free, fast, affected-only CI |
| Web | Next.js 15 (App Router) + React 19 | SSR for heavy list screens, RSC cuts client bundle |
| API | NestJS 11 | Its `@Module` system maps 1:1 onto your 17 modules; DI makes boundaries enforceable |
| Contracts | Zod + ts-rest | End-to-end type safety over plain REST, so third parties and mobile can integrate later |
| DB | PostgreSQL 17 | Transactions, RLS, JSONB custom fields, materialised views, full-text search, `pg_cron` |
| ORM | Drizzle ORM | SQL-first; ERP reporting needs real SQL, and Drizzle does not fight you. Migrations via drizzle-kit |
| Jobs/queue | pg-boss (start) → BullMQ + Valkey (later) | pg-boss needs no extra service; move when throughput demands |
| Cache | Valkey (Redis fork, BSD) | Only when measurements justify it |
| Auth | Better Auth | Self-hosted, TS-native, organisation/multi-tenant + 2FA plugins, no per-MAU billing |
| Authorisation | CASL + DB permission matrix + Postgres RLS | Rules are data (tenant-configurable), enforced in app *and* database |
| Files | Cloudflare R2 (S3 API) | 10 GB free, **zero egress fees** — critical for a document-heavy ERP |
| Search | Postgres FTS → Meilisearch when needed | Avoids running Elasticsearch on a free box |
| Realtime | SSE over Postgres `LISTEN/NOTIFY` | Enough for approvals, notifications, live job status. WebSockets only if you add chat |

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
| Keycloak | 1 GB+ RAM for something Better Auth does in a fraction of that |
| Elasticsearch | Same — Postgres FTS covers you until it genuinely does not |
| Temporal | Correct tool, wrong weight class. A DB-backed state machine suffices |
| Vercel Hobby | **Its terms prohibit commercial use.** Real trap for a SaaS |
| Supabase free | 500 MB, and projects **pause after ~1 week idle**. Fine for a prototype, not a product |
| Firebase | Document model is a poor fit for double-entry accounting and hard joins |

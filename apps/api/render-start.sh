#!/bin/sh
# Render's `dockerCommand` field does not reliably shell-parse a quoted
# compound command passed inline in render.yaml — `/bin/sh -c "a && b && c"`
# arrived with `-c` and the quoting lost, and `sh` tried to execute the
# entire literal string (including the `&&`s) as one filename. A real script
# file sidesteps the question of how that field gets tokenized: `dockerCommand`
# becomes a single token (this file's path), which no splitting scheme can
# get wrong.
#
# `set -e` matters here specifically: without it, a failed migration would
# fall through to `db:seed` running against a broken schema, and then to
# `start` running against that. Each step must be the last thing that runs.
set -e

pnpm db:migrate
pnpm db:seed
# Opt-in, not automatic: `db:seed:demo` is idempotent (it wipes and rebuilds
# its own fixed demo tenant every run), but "idempotent" is not "cheap" — it
# recreates a realistic multi-module dataset spanning every module from
# scratch every single time. Running that on every free-tier cold-start wake
# would add real seconds to a boot that already has to beat Render's
# port-scan timeout, which is exactly what just failed once already. Set
# SEED_DEMO_DATA=true for one deploy to populate the demo tenant, then unset
# it (or set it back to anything else) — the data persists in Postgres and
# does not need to be seeded again on every subsequent boot.
#
# Deliberately NOT under `set -e`, unlike migrate and seed above. Those two are
# preconditions — a server running against a half-migrated schema is worse than
# a server that refused to start. The demo seed is not: it populates a sample
# tenant, and whether that works has no bearing on whether the API can serve
# the tenants already in the database.
#
# Getting this wrong took the whole service down once already. seed-demo.ts
# failed on a re-run (it cannot fully reset a tenant that has already received
# goods — `goods_receipt_line` is append-only by design), `set -e` turned that
# into an exit before `start` was ever reached, and because this script runs on
# every CONTAINER START rather than only on deploy, every free-tier cold-start
# wake crash-looped and every request 502'd. The seed is now idempotent on its
# own (it detects an existing demo tenant and returns), and this `|| echo`
# means even a genuine failure leaves a log line rather than a dead API.
if [ "$SEED_DEMO_DATA" = "true" ]; then
  pnpm db:seed:demo || echo "! demo seed failed — continuing to start the API anyway"
fi
exec pnpm --filter @aerolith/api run start

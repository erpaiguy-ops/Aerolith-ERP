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

# The first vendor operator, for a host with no shell.
#
# It runs from THIS service rather than from aerolith-operator because creating
# an operator is an OWNER operation: `pnpm operator` connects as DATABASE_URL,
# and the whole point of the operator app is that it holds only the SELECT-only
# platform credential. Putting the owner URL on that service to bootstrap it
# would hand the cross-tenant read surface a connection that can also write
# every tenant — permanently, for one first-run convenience.
#
# Idempotent: with the account already present this prints one line and exits.
# BOOTSTRAP_OPERATOR_RESET replaces the account (new password, new TOTP secret,
# existing sessions revoked), which is how the credentials printed below get
# rotated once they have been read off a log.
#
# Its VALUE is passed through, not just its presence, and that matters here more
# than anywhere else this script runs: this file executes on every container
# start, which on a free tier means every wake from idle, several times a day.
# A presence-only switch left set in a dashboard would therefore rotate the
# credentials again on every wake and silently break the authenticator somebody
# had just enrolled. `operator bootstrap` records each applied value, so setting
# it once rotates once and leaving it set does nothing — rotating again means
# changing the value.
#
# Not under `set -e`, for the same reason as the demo seed above: a failure to
# create a vendor account has no bearing on whether the API can serve the
# customers already in the database, and a boot script that exits here would
# crash-loop the entire service on every cold start.
if [ -n "$BOOTSTRAP_OPERATOR_EMAIL" ]; then
  if [ -n "$BOOTSTRAP_OPERATOR_RESET" ] && [ "$BOOTSTRAP_OPERATOR_RESET" != "false" ]; then
    set -- --reset "$BOOTSTRAP_OPERATOR_RESET"
  else
    set --
  fi
  pnpm operator bootstrap \
    --email "$BOOTSTRAP_OPERATOR_EMAIL" \
    --name "${BOOTSTRAP_OPERATOR_NAME:-$BOOTSTRAP_OPERATOR_EMAIL}" \
    "$@" || echo "! operator bootstrap failed — continuing to start the API anyway"
fi
exec pnpm --filter @aerolith/api run start

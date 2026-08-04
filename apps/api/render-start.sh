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
exec pnpm --filter @aerolith/api run start

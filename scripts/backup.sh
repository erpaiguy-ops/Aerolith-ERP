#!/usr/bin/env bash
#
# Hourly Postgres backup, per docs/04-infrastructure.md: `pg_dump` to R2, with
# 7 daily / 4 weekly / 12 monthly retention. Meant to run inside the
# `postgres` container (or anywhere with `pg_dump` and `aws` on PATH and a
# route to both Postgres and R2), on an hourly cron/systemd timer on the host.
#
# An untested backup is not a backup — see .github/workflows/backup-verify.yml
# for the monthly restore-and-verify job this script's own retention scheme
# depends on actually being trustworthy.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set (the owner-role connection string)}"
: "${S3_BUCKET:?S3_BUCKET must be set}"
: "${S3_ENDPOINT:?S3_ENDPOINT must be set}"
: "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID must be set}"
: "${S3_SECRET_ACCESS_KEY:?S3_SECRET_ACCESS_KEY must be set}"

export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="${S3_REGION:-auto}"

now="$(date -u +%Y%m%dT%H%M%SZ)"
dow="$(date -u +%u)"    # 1 = Monday
dom="$(date -u +%d)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

dump_path="$tmp/aerolith-$now.dump"

echo "→ dumping database to $dump_path"
# Custom format: compressed, and restorable with pg_restore --jobs for speed
# on a box this size (see docs/04-infrastructure.md's OCI sizing).
pg_dump "$DATABASE_URL" --format=custom --file="$dump_path"

upload() {
  local key="$1"
  echo "→ uploading to s3://$S3_BUCKET/$key"
  aws s3 cp "$dump_path" "s3://$S3_BUCKET/$key" --endpoint-url "$S3_ENDPOINT"
}

# Always keep the hourly copy — daily/weekly/monthly are additional copies
# under a different prefix, not a replacement for it. Pruned below by
# `find`-style age checks against the bucket listing, not by local state,
# since this script may run on a fresh container every hour.
upload "hourly/aerolith-$now.dump"

if [ "$(date -u +%H)" = "00" ]; then
  upload "daily/aerolith-$now.dump"
fi

# Weekly: Monday's midnight run.
if [ "$dow" = "1" ] && [ "$(date -u +%H)" = "00" ]; then
  upload "weekly/aerolith-$now.dump"
fi

# Monthly: the 1st of the month, midnight run.
if [ "$dom" = "01" ] && [ "$(date -u +%H)" = "00" ]; then
  upload "monthly/aerolith-$now.dump"
fi

prune() {
  local prefix="$1" keep="$2"
  # Oldest-first listing, drop everything past the retention count.
  aws s3api list-objects-v2 \
    --endpoint-url "$S3_ENDPOINT" \
    --bucket "$S3_BUCKET" \
    --prefix "$prefix/" \
    --query 'sort_by(Contents, &LastModified)[].Key' \
    --output text 2>/dev/null \
  | tr '\t' '\n' \
  | grep -v '^$' \
  | head -n "-$keep" \
  | while read -r key; do
      echo "→ pruning s3://$S3_BUCKET/$key"
      aws s3 rm "s3://$S3_BUCKET/$key" --endpoint-url "$S3_ENDPOINT"
    done || true
}

# 24 hourly (a day's worth); the daily/weekly/monthly tiers hold the longer
# history per docs/04-infrastructure.md's stated retention.
prune "hourly" 24
prune "daily" 7
prune "weekly" 4
prune "monthly" 12

echo "✓ backup complete: $now"

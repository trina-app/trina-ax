#!/usr/bin/env bash
# Daily copy of the relay registry next to Litestream (control-plane 3.6.1): VACUUM INTO -> age (organisation recovery
# recipient) -> R2 teamax-ops/relay/daily/<date>.db.age (R2 lifecycle deletes after 30 days). Runs as root from
# registry-backup.timer. Needs: age, curl >= 7.75 (--aws-sigv4), /etc/default/litestream (R2 key) and
# /etc/mycel-relay/backup.env (ORG_RECIPIENT=age1..., R2_ACCOUNT_ID=...).
set -euo pipefail
. /etc/default/litestream
. /etc/mycel-relay/backup.env
: "${ORG_RECIPIENT:?}" "${R2_ACCOUNT_ID:?}" "${LITESTREAM_ACCESS_KEY_ID:?}" "${LITESTREAM_SECRET_ACCESS_KEY:?}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
chmod 700 "$tmp"
/opt/node-26/bin/node -e 'const { DatabaseSync } = require("node:sqlite"); const d = new DatabaseSync(process.argv[1]); d.exec("PRAGMA busy_timeout = 15000"); d.prepare("VACUUM INTO ?").run(process.argv[2]); d.close()' /var/lib/mycel-relay/registry.db "$tmp/registry.db"
age -r "$ORG_RECIPIENT" -o "$tmp/registry.db.age" "$tmp/registry.db"
head -c 21 "$tmp/registry.db.age" | grep -q '^age-encryption.org/v1' || { echo "not an age file" >&2; exit 1; }
curl -fsS --max-time 300 --aws-sigv4 "aws:amz:auto:s3" --user "$LITESTREAM_ACCESS_KEY_ID:$LITESTREAM_SECRET_ACCESS_KEY" \
  -T "$tmp/registry.db.age" "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com/teamax-ops/relay/daily/$(date -u +%F).db.age"
echo "registry backup uploaded ($(stat -c %s "$tmp/registry.db.age") bytes)"

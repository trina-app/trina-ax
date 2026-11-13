#!/usr/bin/env bash
# Is Litestream still copying the relay registry to R2? Every 15 minutes (litestream-check.timer, through relay-checkin
# as monitor relay-litestream). Installed as /usr/local/sbin/relay-litestream-check by setup-host.sh. Exit 0 = yes;
# anything else = no, with the reason on stderr (journald):
#   1. the litestream unit is not active;
#   2. the replica's file list cannot be read (`litestream ltx`: R2 unreachable, the key revoked, the config broken);
#   3. the registry changed more than STALE_MIN minutes after the newest file in the replica (Litestream runs but
#      uploads nothing). A registry that did not change needs no new file, so an idle relay is not an error.
# Reads only file names and times from the replica, never its contents. Needs litestream 0.5 (setup-host.sh pins it),
# /etc/default/litestream (R2 key, R2_ACCOUNT_ID) and Node 26 (install-node.sh) to read the JSON.
set -euo pipefail
DB=${RELAY_REGISTRY_DB:-/var/lib/mycel-relay/registry.db}
CONFIG=${LITESTREAM_CONFIG:-/etc/litestream.yml}
NODE=${NODE_BIN:-/opt/node-26/bin/node}
STALE_MIN=${STALE_MIN:-15}
ENV_FILE=${LITESTREAM_ENV_FILE:-/etc/default/litestream}

systemctl is-active --quiet litestream || { echo "litestream is not running" >&2; exit 1; }
[ -f "$DB" ] || { echo "no registry at $DB" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
if ! files=$(timeout 60 litestream ltx -config "$CONFIG" -level all -json "$DB" 2>&1); then
  echo "cannot list the replica: $(printf '%s' "$files" | head -c 300)" >&2
  exit 1
fi

# the newest replica file and the registry's last change (the database or its WAL), in seconds since 1970
newest=$(printf '%s' "$files" | "$NODE" -e '
  let t = 0
  try {
    for (const f of JSON.parse(require("fs").readFileSync(0, "utf8")) ?? []) {
      const s = Date.parse(f.timestamp ?? f.created_at ?? "")
      if (Number.isFinite(s)) t = Math.max(t, s)
    }
  } catch { process.exit(2) }
  console.log(Math.floor(t / 1000))
') || { echo "cannot read the replica file list (litestream ltx -json changed?)" >&2; exit 1; }
changed=$(date -r "$DB" +%s)
if [ -f "$DB-wal" ]; then
  wal=$(date -r "$DB-wal" +%s)
  if [ "$wal" -gt "$changed" ]; then changed=$wal; fi
fi

if [ "$newest" = 0 ]; then echo "the replica has no files" >&2; exit 1; fi
behind=$(( changed - newest ))
if [ "$behind" -gt $(( STALE_MIN * 60 )) ]; then
  echo "the registry changed $(( behind / 60 )) min after the newest replica file: Litestream is not uploading" >&2
  exit 1
fi
echo "litestream ok: newest replica file $(( ( $(date +%s) - newest ) / 60 )) min old"

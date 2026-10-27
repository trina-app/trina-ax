#!/usr/bin/env bash
# Zero-downtime relay deploy on the relay VM (control-plane 3.6.1 "무중단 배포"). Run as root:
#
#   relay-deploy.sh /tmp/teamax-relay-0.2.0.tar.zst            (the .sha256 next to it is checked)
#   relay-deploy.sh --rollback                                   (back to the release the idle instance ran before)
#
# 1. check the bundle's sha256, unpack it to /opt/mycel-relay/releases/<version> (MANIFEST.json checked file by file)
# 2. point the IDLE instance (mycel-relay@a or @b) at it and start it: both instances share :443 and :8090 through
#    SO_REUSEPORT, so new connections reach either one
# 3. wait until the idle instance's own health port (instance-<x>.env RELAY_HEALTH_LISTEN) says the new version
# 4. stop the old instance: SIGTERM -> GOAWAY(restart), team servers reconnect at once (to the new one, the only one
#    left listening), browser WebSockets get 1012 and resume, running HTTP streams get RELAY_GRACE_MS
# 5. enable the new instance for boot, disable the old one, `current` -> the new release, keep the last 3 releases
# On a failed health check the new instance is stopped again and the old one keeps running (exit 1).
set -euo pipefail

BASE=/opt/mycel-relay
ETC=/etc/mycel-relay
log() { printf '%s relay-deploy: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root"

active=""
for i in a b; do systemctl is-active --quiet "mycel-relay@$i" && active="$active $i"; done
active="${active# }"
case "$active" in
  a) idle=b ;;
  b) idle=a ;;
  "") idle=a ;;
  *) die "both instances are running (a deploy in progress or a failed one); stop one first: systemctl stop mycel-relay@b" ;;
esac

health_port() { sed -n 's/^RELAY_HEALTH_LISTEN=127\.0\.0\.1:\([0-9]*\)$/\1/p' "$ETC/instance-$1.env"; }

if [ "${1:-}" = "--rollback" ]; then
  prev=$(readlink "$BASE/instance-$idle" || true)
  [ -n "$prev" ] && [ -d "$BASE/$prev" -o -d "$prev" ] || die "the idle instance has no earlier release to go back to"
  release_dir=$(cd "$BASE" && cd "$prev" && pwd)
  version=$(cat "$release_dir/VERSION")
  log "rolling back to $version on instance $idle"
else
  bundle=${1:?usage: relay-deploy.sh <teamax-relay-VERSION.tar.zst> | --rollback}
  [ -f "$bundle" ] || die "no such file: $bundle"
  [ -f "$bundle.sha256" ] || die "missing $bundle.sha256"
  (cd "$(dirname "$bundle")" && sha256sum -c --quiet "$(basename "$bundle").sha256") || die "sha256 does not match"
  name=$(basename "$bundle" .tar.zst)
  version=${name#teamax-relay-}
  release_dir="$BASE/releases/$version"
  if [ ! -d "$release_dir" ]; then
    tmp=$(mktemp -d "$BASE/releases/.unpack.XXXXXX")
    zstd -dc "$bundle" | tar -x -C "$tmp" --no-same-owner
    [ -d "$tmp/$name" ] || die "bundle has no $name/ folder"
    # every file as listed in MANIFEST.json, nothing else
    node_bin=/opt/node-26/bin/node
    "$node_bin" -e '
      const fs = require("fs"), path = require("path"), crypto = require("crypto")
      const dir = process.argv[1], m = JSON.parse(fs.readFileSync(path.join(dir, "MANIFEST.json"), "utf8"))
      const seen = new Set()
      const walk = (rel) => { for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const r = rel ? rel + "/" + d.name : d.name
        if (d.isDirectory()) { walk(r); continue }
        if (r === "MANIFEST.json") continue
        const want = m.files[r]; if (!want) throw new Error("not in MANIFEST: " + r)
        const b = fs.readFileSync(path.join(dir, r))
        if (b.length !== want.size || crypto.createHash("sha256").update(b).digest("hex") !== want.sha256) throw new Error("changed: " + r)
        seen.add(r) } }
      walk("")
      for (const r of Object.keys(m.files)) if (!seen.has(r)) throw new Error("missing: " + r)
    ' "$tmp/$name" || die "bundle does not match its MANIFEST.json"
    chown -R root:root "$tmp/$name"
    chmod -R go-w "$tmp/$name"
    mv "$tmp/$name" "$release_dir"
    rmdir "$tmp"
  fi
  log "deploying $version on instance $idle (running: ${active:-none})"
fi

port=$(health_port "$idle")
[ -n "$port" ] || die "$ETC/instance-$idle.env has no RELAY_HEALTH_LISTEN=127.0.0.1:<port>"

ln -sfn "$release_dir" "$BASE/.instance-$idle.new" && mv -Tf "$BASE/.instance-$idle.new" "$BASE/instance-$idle"
systemctl start "mycel-relay@$idle"

ok=""
for _ in $(seq 1 60); do
  got=$(curl -fsS --max-time 2 "http://127.0.0.1:$port/healthz" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true)
  if [ -n "$got" ]; then
    want_rel=$(sed -n 's/^export const RELAY_VERSION = .\([^"'"'"']*\).*/\1/p' "$release_dir/relay/src/relay.ts")
    [ "$got" = "$want_rel" ] && { ok=1; break; }
  fi
  sleep 0.5
done
if [ -z "$ok" ]; then
  log "the new instance $idle did not come up healthy; stopping it, $active keeps serving"
  systemctl stop "mycel-relay@$idle" || true
  journalctl -u "mycel-relay@$idle" -n 30 --no-pager >&2 || true
  exit 1
fi
log "instance $idle is healthy on $version"

if [ -n "$active" ]; then
  log "stopping instance $active (GOAWAY restart to team servers, 1012 to browsers)"
  systemctl stop "mycel-relay@$active"
  systemctl disable --quiet "mycel-relay@$active" || true
fi
systemctl enable --quiet "mycel-relay@$idle"
ln -sfn "$release_dir" "$BASE/.current.new" && mv -Tf "$BASE/.current.new" "$BASE/current"

# keep the three newest releases plus whatever an instance points at
keep=$( (readlink -f "$BASE/instance-a" 2>/dev/null; readlink -f "$BASE/instance-b" 2>/dev/null) | sort -u)
ls -1dt "$BASE"/releases/*/ 2>/dev/null | tail -n +4 | while read -r d; do
  d=${d%/}
  printf '%s\n' "$keep" | grep -qx "$d" || { log "removing old release $d"; rm -rf "$d"; }
done
log "done: $version serving from instance $idle"

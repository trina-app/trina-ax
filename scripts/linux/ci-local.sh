#!/bin/bash
# Run the Linux CI jobs locally, in order, on the pve-ci tenant while GitHub Actions is paused for billing
# (linux-runtime spec 3.9.4, R10). A systemd timer on that tenant runs this daily and keeps the result JSON. Each
# stage is best-effort and reported; a failing stage does not stop the later ones, so one run gives the whole picture.
#
#   scripts/linux/ci-local.sh [--arch amd64|arm64] [--out DIR] [--skip t1,t2,t3]
#
# T1 (docker attack suite), T2 (install on this host's VM/LXC), T3 (real-engine lockdown) mirror the ci.yml jobs.
set -uo pipefail
cd "$(dirname "$0")/../.."
ARCH=$([ "$(uname -m)" = aarch64 ] && echo arm64 || echo amd64)
OUT=dist/ci-local
SKIP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --skip) SKIP="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$OUT"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RESULT="$OUT/ci-local-$STAMP.json"
skipped() { case ",$SKIP," in *",$1,"*) return 0 ;; *) return 1 ;; esac }
declare -A R
stage() {
  local name="$1"; shift
  if skipped "$name"; then R[$name]=skipped; echo "== $name: skipped"; return; fi
  echo "== $name: $*"
  if "$@" >"$OUT/$name-$STAMP.log" 2>&1; then R[$name]=pass; else R[$name]=fail; fi
  echo "== $name: ${R[$name]} (log: $OUT/$name-$STAMP.log)"
}

stage check bash -c "ARCHS=$ARCH bash native/build.sh && cd native && go vet ./... && go test ./..."
stage t1 bash -c "ARCHS=$ARCH bash native/build.sh && bun run tests/linux/run.ts"
stage t2 bash -c "ARCHS=$ARCH bash native/build.sh && sudo env \"PATH=$PATH\" bun tests/install/g-linux-install.ts"
# T3 needs L25 (installed-mode lockdown harness, the pve-ci tenant and test logins); skip until it exists
[ -f scripts/linux/lockdown-setup.sh ] || { SKIP="$SKIP,t3"; echo "== t3: needs L25 (scripts/linux/lockdown-setup.sh)"; }
stage t3 bash -c "sudo bash scripts/linux/lockdown-setup.sh --kit dist/kit --id mycel-ci --base /var/lib/mycel-ci && sudo MYCEL_LOCKDOWN_INSTALLED=/var/lib/mycel-ci bun run tests/engine/lockdown-claude.ts && sudo MYCEL_LOCKDOWN_INSTALLED=/var/lib/mycel-ci bun run tests/engine/lockdown-codex.ts"

{
  printf '{"at":"%s","arch":"%s","stages":{' "$STAMP" "$ARCH"
  first=1
  for k in check t1 t2 t3; do
    [ -n "${R[$k]:-}" ] || continue
    [ $first -eq 1 ] || printf ','
    printf '"%s":"%s"' "$k" "${R[$k]}"; first=0
  done
  printf '}}\n'
} | tee "$RESULT"

for k in check t1 t2 t3; do [ "${R[$k]:-pass}" = fail ] && exit 1; done
exit 0

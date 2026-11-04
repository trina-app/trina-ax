#!/bin/bash
# Build the Trina AX image, start it with docker-compose.yml and check it (docs/INSTALL-DOCKER.md "Test").
# Then stop it and remove the container, the test volume and the test network.
#
#   TRINA_AX_VERSION=0.3.0 bash docker/test.sh             published release kit (signed)
#   TRINA_AX_KIT=local bash docker/test.sh                 docker/kit-local/ (an unpacked kit; unsigned is accepted)
#   KEEP=1 ...                                             leave the test project running
#
# Checks: health, the setup page, the setup link, first-run setup through the published port, the engine firewall
# (axagent reaches only the model proxy), Landlock and seccomp inside a bubblewrap sandbox as axagent, and a restart
# that does not run the installer again.
set -euo pipefail
cd "$(dirname "$0")"
export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-trina-ax-test}
export TRINA_AX_PORT=${TRINA_AX_PORT:-47899}
export TRINA_AX_BIND=127.0.0.1
KIT_MODE=${TRINA_AX_KIT:-release}
if [ "$KIT_MODE" = local ]; then
  [ -f kit-local/VERSION ] || { echo "test: docker/kit-local/VERSION missing (unpack a kit there)" >&2; exit 2; }
  export TRINA_AX_VERSION=${TRINA_AX_VERSION:-$(tr -d '[:space:]' < kit-local/VERSION)}
fi
: "${TRINA_AX_VERSION:?set TRINA_AX_VERSION (or TRINA_AX_KIT=local)}"
C="docker compose -f docker-compose.yml"
[ "$KIT_MODE" = local ] && C="$C -f test-local.override.yml"
pass() { echo "test: ok   $*"; }
fail() { echo "test: FAIL $*" >&2; $C logs --no-log-prefix --tail 80 trina-ax >&2 || true; exit 1; }
cleanup() { [ "${KEEP:-0}" = 1 ] || $C down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker info >/dev/null 2>&1 || { echo "test: docker is not available here" >&2; exit 2; }
if [ "$KIT_MODE" = local ]; then
  cat > test-local.override.yml <<'EOF'
services:
  trina-ax:
    build:
      args:
        TRINA_AX_KIT: local
    environment:
      TRINA_AX_ALLOW_UNSIGNED: "1"
EOF
fi

$C build trina-ax
$C up -d trina-ax
CID=$($C ps -q trina-ax)
# first start downloads the engine (about 300 MB) and installs: allow 10 minutes
for _ in $(seq 1 120); do
  st=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CID")
  case "$st" in "running healthy") break ;; exited*|dead*) fail "container stopped: $st" ;; esac
  sleep 5
done
[ "$st" = "running healthy" ] || fail "not healthy after 10 minutes ($st)"
pass "container healthy"

H=$(curl -fsS "http://127.0.0.1:$TRINA_AX_PORT/api/health") || fail "health from the host"
case "$H" in *"\"version\":\"$TRINA_AX_VERSION\""*) pass "health answers version $TRINA_AX_VERSION" ;; *) fail "health: $H" ;; esac
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$TRINA_AX_PORT/setup")" = 200 ] || fail "setup page"
pass "setup page 200"

# the engine lockdown inside the container
X() { $C exec -T trina-ax "$@"; }
X runuser -u axagent -- curl -sS --max-time 5 -o /dev/null https://example.com 2>/dev/null && fail "axagent reached the internet"
X runuser -u axagent -- curl -sS --max-time 5 -o /dev/null "http://127.0.0.1:47820/api/health" 2>/dev/null && fail "axagent reached the app port"
X runuser -u axagent -- bash -c 'exec 3<>/dev/tcp/127.0.0.1/47821' || fail "axagent cannot reach the model proxy"
pass "engine firewall: axagent reaches only 127.0.0.1:47821"
P=$(X runuser -u axagent -- /var/lib/mycel/root/mycel-sandbox probe)
case "$P" in *'"seccomp":true'*) ;; *) fail "seccomp not available: $P" ;; esac
case "$P" in *'"landlockAbi":0'*|*'"landlockAbi":-'*) fail "no Landlock: $P" ;; esac
X bash -c 'cd / && runuser -u axagent -- bwrap --unshare-all --unshare-user --disable-userns --die-with-parent --new-session --cap-drop ALL \
  --ro-bind /usr /usr --symlink usr/lib /lib --symlink usr/bin /bin --ro-bind /etc/ld.so.cache /etc/ld.so.cache \
  --proc /proc --dev /dev --tmpfs /tmp --ro-bind /var/lib/mycel/root/mycel-sandbox /tmp/s --remount-ro / --chdir /tmp -- \
  /tmp/s exec --landlock required --exec-allow /usr/bin --exec-allow /usr/lib -- /usr/bin/bash -c "
    test \"\$(id -u)\" = 991 && test ! -e /var/lib/mycel && ! (exec 3<>/dev/tcp/1.1.1.1/443) 2>/dev/null && ! touch /usr/x 2>/dev/null"' \
  || fail "bubblewrap + Landlock sandbox as axagent"
pass "sandbox: bubblewrap (user, pid, net namespaces) + Landlock + seccomp as axagent ($P)"

# first-run setup through the published port (the token is not printed)
LINK=$(X trina-ax-setup-link) || fail "setup link"
TOK=${LINK#*token=}
PW=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TRINA_AX_PORT/api/setup" \
  -H 'Content-Type: application/json' -H 'x-mycel-csrf: 1' -H "Origin: http://127.0.0.1:$TRINA_AX_PORT" \
  --data "{\"setupToken\":\"$TOK\",\"teamName\":\"Docker test\",\"locale\":\"en\",\"owner\":{\"username\":\"owner\",\"name\":\"Test Owner\",\"password\":\"$PW\"}}")
unset TOK PW LINK
[ "$code" = 201 ] || fail "POST /api/setup: HTTP $code"
X trina-ax-setup-link >/dev/null 2>&1 && fail "setup link still offered after setup"
pass "first-run setup through the published port"

# a new container on the same volume does not run the installer again and keeps the team
$C down >/dev/null 2>&1
$C up -d trina-ax
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$TRINA_AX_PORT/api/health" >/dev/null 2>&1 && break
  sleep 2
done
$C logs --no-log-prefix trina-ax 2>&1 | grep -q "kit $TRINA_AX_VERSION is installed; starting" || fail "the installer ran again on a new container"
case "$(curl -fsS "http://127.0.0.1:$TRINA_AX_PORT/api/setup")" in *'"needed":false'*) pass "new container keeps the team" ;; *) fail "team lost after a new container" ;; esac

echo "test: all checks passed"

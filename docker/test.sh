#!/bin/bash
# Build the Trina AX image, start it with docker-compose.yml and check it (docs/INSTALL-DOCKER.md "Test").
# Then stop it and remove the container, the test volume and the test network.
#
#   TRINA_AX_VERSION=0.22.0 bash docker/test.sh             published release kit (signed)
#   TRINA_AX_KIT=local bash docker/test.sh                 docker/kit-local/ (an unpacked kit; unsigned is accepted)
#   KEEP=1 ...                                             leave the test project running
#
# Checks: health, the setup page, the setup link, first-run setup through the published port, the engine firewall
# (axagent reaches only the model proxy), Landlock and seccomp inside a bubblewrap sandbox as axagent, the launcher status, and a restart
# that does not run the installer again. The bubblewrap check passes --hostname mycel-turn as the launcher does for each
# turn (TC-2853: without sethostname in seccomp.json every AI turn stopped with "Can't set hostname"). No real AI turn.
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
  # a host problem (entrypoint host_stop): the container waits with its message; no need to wait 10 minutes
  grep -q 'the server does not start until this is fixed' <<<"$(docker logs "$CID" 2>&1)" && fail "the container stopped at a host check"
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
# TCP by address (no DNS): axserver must get out, axagent must not
X runuser -u axserver -- timeout 10 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' || fail "axserver cannot reach 1.1.1.1:443 (no outbound network for this test?)"
X runuser -u axagent -- timeout 10 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' 2>/dev/null && fail "axagent reached 1.1.1.1:443"
X runuser -u axagent -- curl -sS --max-time 5 -o /dev/null "http://127.0.0.1:47820/api/health" 2>/dev/null && fail "axagent reached the app port"
# the server listens on all container addresses (MYCEL_HOST=0.0.0.0): the container's own address too
CIP=$(X getent hosts trina-ax | awk '{print $1; exit}')
[ -n "$CIP" ] || fail "no container address"
X curl -fsS --max-time 5 -o /dev/null "http://$CIP:47820/api/health" || fail "root cannot reach $CIP:47820"
X runuser -u axagent -- curl -sS --max-time 5 -o /dev/null "http://$CIP:47820/api/health" 2>/dev/null && fail "axagent reached $CIP:47820"
X runuser -u axagent -- bash -c 'exec 3<>/dev/tcp/127.0.0.1/47821' || fail "axagent cannot reach the model proxy"
pass "engine firewall: axagent reaches only 127.0.0.1:47821"
P=$(X runuser -u axagent -- /var/lib/mycel/root/mycel-sandbox probe)
case "$P" in *'"seccomp":true'*) ;; *) fail "seccomp not available: $P" ;; esac
case "$P" in *'"landlockAbi":0'*|*'"landlockAbi":-'*) fail "no Landlock: $P" ;; esac
X bash -c 'cd / && runuser -u axagent -- bwrap --unshare-all --unshare-user --disable-userns --die-with-parent --new-session --cap-drop ALL --hostname mycel-turn \
  --ro-bind /usr /usr --symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/bin /bin --ro-bind /etc/ld.so.cache /etc/ld.so.cache \
  --proc /proc --dev /dev --tmpfs /tmp --ro-bind /var/lib/mycel/root/mycel-sandbox /tmp/s --remount-ro / --chdir /tmp -- \
  /tmp/s exec --landlock required --exec-allow /usr/bin --exec-allow /usr/lib -- /usr/bin/bash -c "
    test \"\$(id -u)\" = 981 && test \"\$(cat /proc/sys/kernel/hostname)\" = mycel-turn && test ! -e /var/lib/mycel && ! (exec 3<>/dev/tcp/1.1.1.1/443) 2>/dev/null && ! touch /usr/x 2>/dev/null"' \
  || fail "bubblewrap + Landlock sandbox as axagent"
pass "sandbox: bubblewrap (user, pid, net, UTS namespaces, hostname mycel-turn as each turn has) + Landlock + seccomp as axagent ($P)"
# the launcher's own view (the answer the server's diagnostics show): bwrap, Landlock required, firewall loaded
L=$(X runuser -u axserver -- python3 -I -c 'import socket,sys
s=socket.socket(socket.AF_UNIX); s.settimeout(10); s.connect("/var/lib/mycel/run-launcher/launcher.sock")
s.sendall(b"{\"op\":\"status\"}\n"); sys.stdout.write(s.makefile().readline())') || fail "launcher status"
python3 -c 'import json,sys
d=json.loads(sys.argv[1]); fw=d.get("firewall") or {}
ok=d.get("sandbox")=="bwrap" and d.get("landlockMode")=="required" and (d.get("landlockAbi") or 0)>=1 and d.get("seccomp") and fw.get("loaded") and not fw.get("problem")
print("sandbox=%s landlock=%s/%s seccomp=%s firewall=%s cgroup=%s" % (d.get("sandbox"),d.get("landlockMode"),d.get("landlockAbi"),d.get("seccomp"),fw,d.get("cgroup")))
sys.exit(0 if ok else 1)' "$L" || fail "launcher is not ready for turns: $L"
pass "launcher ready for turns"
# the engine check the bootstrap asks after an update (QA TC-3523): as axagent, the turn's sandbox launch with the bridge
# of app/current. It passes on the running version and fails once the version has the modes an update left on
# 2026-11-16 (folders and programs 0750, files 0640); the modes come back after. A kit older than the check: skipped.
SC='import socket,sys
s=socket.socket(socket.AF_UNIX); s.settimeout(30); s.connect("/var/lib/mycel/run-launcher/launcher.sock")
s.sendall(b"{\"op\":\"sandbox-check\"}\n"); sys.stdout.write(s.makefile().readline())'
R=$(X runuser -u axserver -- python3 -I -c "$SC") || fail "engine check request"
case "$R" in
  *'"ev":"sandbox-check"'*'"ok":true'*)
    X bash -c 'd=$(readlink -f /var/lib/mycel/app/current) && find "$d" ! -type l -printf "%m %p\n" > /root/engine-check-modes &&
      find "$d" -type d -exec chmod 0750 {} + && find "$d" -type f -perm -u+x -exec chmod 0750 {} + && find "$d" -type f ! -perm -u+x -exec chmod 0640 {} +'
    B=$(X runuser -u axserver -- python3 -I -c "$SC" || true)
    X bash -c 'set -e; while read -r m p; do chmod "$m" "$p"; done < /root/engine-check-modes; rm /root/engine-check-modes' || fail "engine check: the version's modes could not be put back"
    case "$B" in *'"ok":false'*) pass "engine check: passes on the running version, fails on one left 0750/0640" ;; *) fail "engine check passed a 0750/0640 version: $B" ;; esac ;;
  *'bad request'*) echo "test: skip the engine check (the launcher of this kit does not know it)" ;;
  *) fail "engine check on the running version: $R" ;;
esac

# first-run setup through the published port (the token is not printed)
LINK=$(X trina-ax-setup-link) || fail "setup link"
TOK=${LINK#*token=}
PW=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TRINA_AX_PORT/api/setup" \
  -H 'Content-Type: application/json' -H 'x-mycel-csrf: 1' -H "Origin: http://127.0.0.1:$TRINA_AX_PORT" \
  --data "{\"setupToken\":\"$TOK\",\"teamName\":\"Docker test\",\"locale\":\"en\",\"owner\":{\"username\":\"owner\",\"name\":\"Test Owner\",\"password\":\"$PW\"}}")
unset TOK LINK
[ "$code" = 201 ] || fail "POST /api/setup: HTTP $code"

# documents (docs/decisions/20261124-doc-kit-docker.md): when the image has the run kit, the server runs srt with no
# systemd under a root-owned offline plan, and says the dev environment works here (its self-test ran srt)
if X test -x /opt/trina/devenv/run-wrap; then
  X grep -qx 'MYCEL_DEV_ENV_SRT_DIRECT=1' /etc/default/mycel || fail "documents: no MYCEL_DEV_ENV_SRT_DIRECT=1 in /etc/default/mycel"
  X grep -qx 'MYCEL_RENDER_PARALLEL=1' /etc/default/mycel || fail "documents: renders are not one at a time"
  X bash -c 'p=/var/lib/mycel/root/dev-env.json; [ "$(stat -c %u:%a "$p")" = 0:644 ] && grep -q "\"network\":\"offline\"" "$p" && grep -q "\"maxRunning\":1" "$p"' || fail "documents: the plan file is not root's, offline, one run at a time"
  BT=$(curl -fsS -X POST "http://127.0.0.1:$TRINA_AX_PORT/api/auth/login" -H 'Content-Type: application/json' -H 'x-mycel-csrf: 1' -H "Origin: http://127.0.0.1:$TRINA_AX_PORT" \
    --data "{\"username\":\"owner\",\"password\":\"$PW\",\"client\":\"web\",\"tokenMode\":\"bearer\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])') || fail "documents: owner sign-in"
  DE=$(curl -fsS "http://127.0.0.1:$TRINA_AX_PORT/api/admin/dev-env" -H "Authorization: Bearer $BT") || fail "documents: GET /api/admin/dev-env"
  unset BT
  python3 -c 'import json,sys; d=json.loads(sys.argv[1]); a=d["availability"]; p=d["plan"] or {}
print("availability=%s plan=%s network=%s maxRunning=%s memoryMiB=%s" % (a, p.get("plan"), p.get("network"), p.get("maxRunning"), p.get("memoryMiB")))
sys.exit(0 if a.get("available") and p.get("plan")=="docker" and p.get("network")=="offline" and p.get("maxRunning")==1 else 1)' "$DE" || fail "documents: the server says the dev environment is not available here: $DE"
  pass "documents: srt runs here with no systemd, plan docker (offline, one run at a time)"
  # what a run does, as the server account through srt (offline settings, the base folder hidden): a Korean Word file
  # with the run's libraries; no network, no Unix socket, no base folder
  X bash -c 'rm -rf /tmp/dk && install -d -o axserver -g axserver -m 700 /tmp/dk && cat > /tmp/dk/s.json <<J
{"network":{"allowedDomains":[],"deniedDomains":[]},"filesystem":{"denyRead":["/var/lib/mycel"],"allowWrite":["/tmp/dk"],"denyWrite":[]}}
J
cat > /tmp/dk/build.py <<Y
import docx, socket
d = docx.Document(); d.add_heading("복합기 사용 안내", 1); d.add_paragraph("흑백은 월 300장까지 무료입니다. 한글이 그려져야 합니다."); d.save("/tmp/dk/안내.docx")
print("BUILT")
for fam, addr in ((socket.AF_INET, ("1.1.1.1", 443)),):
    try: socket.create_connection(addr, timeout=3); print("NET-OPEN")
    except OSError: print("NET-REFUSED")
try: socket.socket(socket.AF_UNIX); print("UNIX-OPEN")
except OSError: print("UNIX-REFUSED")
try: open("/var/lib/mycel/data/app.db","rb"); print("BASE-OPEN")
except OSError: print("BASE-HIDDEN")
Y
chown -R axserver:axserver /tmp/dk'
  srt=$(X bash -c 'ls /opt/trina/srt/*/cli.js | head -1')
  R=$(X bash -c "cd /tmp/dk && runuser -u axserver -- env -i PATH=/opt/trina/python/python-pptx/current/bin:/usr/bin:/bin HOME=/tmp/dk TMPDIR=/tmp/dk /opt/trina/node/bin/node $srt --settings /tmp/dk/s.json -c 'python3 /tmp/dk/build.py; curl -s -m 5 -o /dev/null https://example.com && echo CURL-OPEN || echo CURL-REFUSED'" 2>&1) || true
  for w in BUILT NET-REFUSED UNIX-REFUSED BASE-HIDDEN CURL-REFUSED; do grep -qx "$w" <<<"$R" || fail "documents: the srt run did not say $w: $R"; done
  pass "documents: a Korean Word file built in srt as axserver; network, Unix sockets and the base folder refused"
  # the page render as the server does it: LibreOffice in bwrap with no network, through the sandbox helper's seccomp
  # filter (--allow-listen: LibreOffice's own pipe), then the PDF's fonts
  X bash -c 'cd /tmp/dk && runuser -u axserver -- bwrap --unshare-all --die-with-parent --new-session --cap-drop ALL \
    --ro-bind /usr /usr --symlink usr/lib /lib --symlink usr/bin /bin --symlink usr/sbin /sbin --ro-bind /etc /etc --proc /proc --dev /dev --tmpfs /tmp \
    --bind /tmp/dk /w --ro-bind /var/lib/mycel/root/mycel-sandbox /tmp/s --chdir /w --setenv HOME /w \
    /tmp/s exec --landlock off --allow-listen -- /usr/bin/soffice -env:UserInstallation=file:///w/profile --headless --norestore --nolockcheck --convert-to pdf --outdir /w /w/안내.docx >/dev/null 2>&1' \
    || fail "documents: LibreOffice in bwrap with the seccomp filter made no PDF"
  F=$(X pdffonts /tmp/dk/안내.pdf) || fail "documents: no PDF"
  grep -q 'NotoSansCJK\|NotoSerifCJK\|Noto Sans CJK' <<<"$F" || fail "documents: the PDF has no Noto CJK font (Korean not drawn): $F"
  X pdftotext /tmp/dk/안내.pdf - | grep -q '복합기 사용 안내' || fail "documents: the PDF's text has no Korean"
  X rm -rf /tmp/dk
  pass "documents: LibreOffice drew the Korean page with Noto CJK in bwrap and the seccomp filter"
else
  echo "test: skip documents (this image has no run kit)"
fi
unset PW
X trina-ax-setup-link >/dev/null 2>&1 && fail "setup link still offered after setup"
pass "first-run setup through the published port"

# a new container on the same volume does not run the installer again and keeps the team
$C down >/dev/null 2>&1
$C up -d trina-ax
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$TRINA_AX_PORT/api/health" >/dev/null 2>&1 && break
  sleep 2
done
# the whole log first: grep -q stops at its match, and under pipefail the writer's SIGPIPE would fail the check
LOGS=$($C logs --no-log-prefix trina-ax 2>&1)
grep -q "kit $TRINA_AX_VERSION is installed; starting" <<<"$LOGS" || fail "the installer ran again on a new container"
case "$(curl -fsS "http://127.0.0.1:$TRINA_AX_PORT/api/setup")" in *'"needed":false'*) pass "new container keeps the team" ;; *) fail "team lost after a new container" ;; esac

echo "test: all checks passed"

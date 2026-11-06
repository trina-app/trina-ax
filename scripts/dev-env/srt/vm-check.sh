#!/bin/bash
# Dev environment on srt: the systemd and polkit checks on a fresh Debian 13 VM (docs/research/srt-dev-env.md 10.3).
# Run as root on a THROWAWAY VM only: it makes a server account and a stand-in team server unit, then runs
# install-srt.sh for real.
#   1. a server account and <base> as install-linux.sh makes them, a Starter plan file, /etc/default/<ID> with a canary;
#   2. <ID>-server.service from scripts/linux/systemd/server.service.in (same account, slice, delegation and sandbox
#      rules), with tests/linux/srt-vm.ts as the program;
#   3. install-srt.sh (it starts the unit; the driver runs the checks as the server account and writes the results);
#   4. a restart of the unit: the long run that the driver started must still run.
# MODE "bench" runs tests/linux/srt-vm-bench.ts in place of the checks: real work (npm, Remotion, pip) through the real
# box_shell tool, the escapes with positive controls and the queue (results in <base>/data/bench-results.json).
# Usage (repo at REPO with bun install done, bun in /usr/local/bin): scripts/dev-env/srt/vm-check.sh REPO [checks|bench]
set -euo pipefail
REPO=${1:?repo folder}
MODE=${2:-checks}
ID=mycel
BASE=/var/lib/$ID
UNIT=$ID-server.service
BUN=/usr/local/bin/bun
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ -x "$BUN" ] || { echo "no $BUN" >&2; exit 1; }

command -v jq >/dev/null && command -v curl >/dev/null || { apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q jq curl; }
# the bench's test server makes the fixture team folder with pandoc
[ "$MODE" != bench ] || command -v pandoc >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends pandoc

# ---- 1. the server account and its folders ----
id "$ID" >/dev/null 2>&1 || useradd --system -U -d "$BASE/data" -s /usr/sbin/nologin "$ID"
install -d -o root -g root -m 755 "$BASE" "$BASE/root"
for d in app data team config secrets setup status run run/tools agent agent/codex-auth; do install -d -o "$ID" -g "$ID" -m 750 "$BASE/$d"; done
echo '{"hosted":true}' > "$BASE/root/install.json"
cat > "$BASE/root/dev-env.json" <<'EOF'
{"format":1,"plan":"starter","maxRunning":1,"cpus":1.5,"memoryMiB":1536,"pids":512,"diskGiB":4,"network":"open"}
EOF
chmod 644 "$BASE/root/install.json" "$BASE/root/dev-env.json"
printf 'MYCEL_TOKEN=CANARY-7f3a-etcdefault\n' > "/etc/default/$ID"; chown "root:$ID" "/etc/default/$ID"; chmod 640 "/etc/default/$ID"

# ---- 2. the stand-in server unit ----
DRIVER=srt-vm.ts; RESULTS=$BASE/data/vm-results.json; WAIT=240
# the bench: its test server keeps its files in <base>/data (the unit can write there); about 40 min on a t3a.medium
if [ "$MODE" = bench ]; then DRIVER=srt-vm-bench.ts; RESULTS=$BASE/data/bench-results.json; WAIT=900; fi
sed -e "s#@ID@#$ID#g" -e "s#@SRV@#$ID#g" -e "s#@BASE@#$BASE#g" -e "s#@PUBKEYS@##; s#@ALLOW_UNSIGNED_ENV@##" \
    -e "s#^ExecStart=.*#ExecStart=$BUN $REPO/tests/linux/$DRIVER#" \
    -e "/^After=/s/ $ID-launcher.service//" -e "/^Wants=/s/ $ID-launcher.service//" \
    "$REPO/scripts/linux/systemd/server.service.in" > "/etc/systemd/system/$UNIT"
install -d "/etc/systemd/system/$UNIT.d"
printf '[Service]\nEnvironment=MYCEL_VM_PHASE=checks MYCEL_WORK=%s\n' "$BASE/data/work" > "/etc/systemd/system/$UNIT.d/vm.conf"
# the bench runs once: no restart after a crash
[ "$MODE" != bench ] || printf 'Restart=no\n' >> "/etc/systemd/system/$UNIT.d/vm.conf"
systemctl daemon-reload

# ---- 3. the install (it restarts the unit, which runs the checks) ----
rm -f "$RESULTS"
"$REPO/scripts/dev-env/srt/install-srt.sh" --id "$ID"
if [ "$MODE" = bench ]; then
  echo "vm-check: bench running (up to $((WAIT * 5 / 60)) min); one line per check"
  # print each check line when it comes
  SHOWN=0
  for _ in $(seq 1 "$WAIT"); do
    LINES=$(journalctl -u "$UNIT" --no-pager -o cat | grep -E '^bench ' || true)
    N=$(printf '%s' "$LINES" | grep -c '^bench ' || true)
    [ "$N" -le "$SHOWN" ] || { printf '%s\n' "$LINES" | tail -n +"$((SHOWN + 1))"; SHOWN=$N; }
    grep -qs '"id": "END"' "$RESULTS" && break; systemctl is-active -q "$UNIT" || break; sleep 5
  done
  grep -qs '"id": "END"' "$RESULTS" || { journalctl -u "$UNIT" --no-pager | tail -60; echo "vm-check: the bench did not finish" >&2; }
  echo "vm-check: kernel OOM lines:"; journalctl -k --no-pager -q | grep -iE 'out of memory|killed process' || echo none
  echo "vm-check: server unit: $(systemctl show -p ActiveState,MainPID,NRestarts "$UNIT" | tr '\n' ' ')"
  echo "vm-check: server memory.events: $(tr '\n' ' ' < "/sys/fs/cgroup/$ID.slice/$UNIT/memory.events" 2>/dev/null)"
  echo "vm-check: /health $(curl -fsS -m 5 http://127.0.0.1:8099/health || echo down)"
  echo "vm-check: results json:"; cat "$RESULTS" 2>/dev/null || true
  FAILS=$(jq '[.results[] | select(.pass == false)] | length' "$RESULTS" 2>/dev/null || echo 99)
  grep -qs '"id": "END"' "$RESULTS" || FAILS=$((FAILS + 1))
  echo "vm-check: bench $FAILS failed"
  [ "$FAILS" = 0 ]; exit
fi
echo "vm-check: waiting for the driver (up to 20 min)"
for _ in $(seq 1 "$WAIT"); do [ -s "$RESULTS" ] && break; sleep 5; done
[ -s "$RESULTS" ] || { journalctl -u "$UNIT" --no-pager | tail -50; echo "vm-check: no results" >&2; exit 1; }
journalctl -u "$UNIT" --no-pager -o cat | grep -E '^(pass|FAIL|info) ' || true

# ---- 4. the restart: the long run outlives it ----
SURVIVOR=$(jq -r .survivor "$BASE/data/vm-results.json")
RESTARTS_BEFORE=$(systemctl show -p NRestarts --value "$UNIT")
printf '[Service]\nEnvironment=MYCEL_VM_PHASE=serve\n' > "/etc/systemd/system/$UNIT.d/vm.conf"
systemctl daemon-reload
systemctl restart "$UNIT"
sleep 3
STATE=$(systemctl show -p ActiveState --value "$SURVIVOR")
HEALTH=$(curl -fsS -m 5 http://127.0.0.1:8099/health || echo down)
echo "vm-check: after the restart: $SURVIVOR is $STATE; /health $HEALTH; NRestarts before $RESTARTS_BEFORE (memory bomb, fork bomb)"
systemctl stop "$SURVIVOR" || true
FAILS=$(jq '[.results[] | select(.pass == false)] | length' "$BASE/data/vm-results.json")
[ "$STATE" = active ] || FAILS=$((FAILS + 1))
[ "$HEALTH" = ok ] || FAILS=$((FAILS + 1))
[ "$RESTARTS_BEFORE" = 0 ] || FAILS=$((FAILS + 1))
echo "vm-check: $FAILS failed"
[ "$FAILS" = 0 ]

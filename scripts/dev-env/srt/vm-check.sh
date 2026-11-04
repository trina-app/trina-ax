#!/bin/bash
# Dev environment on srt: the systemd and polkit checks on a fresh Debian 13 VM (docs/research/srt-dev-env.md 10.3).
# Run as root on a THROWAWAY VM only: it makes a server account and a stand-in team server unit, then runs
# install-srt.sh for real.
#   1. a server account and <base> as install-linux.sh makes them, a Starter plan file, /etc/default/<ID> with a canary;
#   2. <ID>-server.service from scripts/linux/systemd/server.service.in (same account, slice, delegation and sandbox
#      rules), with tests/linux/srt-vm.ts as the program;
#   3. install-srt.sh (it starts the unit; the driver runs the checks as the server account and writes the results);
#   4. a restart of the unit: the long run that the driver started must still run.
# Usage (repo at REPO with bun install done, bun in /usr/local/bin): scripts/dev-env/srt/vm-check.sh REPO
set -euo pipefail
REPO=${1:?repo folder}
ID=mycel
BASE=/var/lib/$ID
UNIT=$ID-server.service
BUN=/usr/local/bin/bun
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ -x "$BUN" ] || { echo "no $BUN" >&2; exit 1; }

command -v jq >/dev/null && command -v curl >/dev/null || { apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q jq curl; }

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
sed -e "s#@ID@#$ID#g" -e "s#@SRV@#$ID#g" -e "s#@BASE@#$BASE#g" -e "s#@PUBKEYS@##; s#@ALLOW_UNSIGNED_ENV@##" \
    -e "s#^ExecStart=.*#ExecStart=$BUN $REPO/tests/linux/srt-vm.ts#" \
    -e "/^After=/s/ $ID-launcher.service//" -e "/^Wants=/s/ $ID-launcher.service//" \
    "$REPO/scripts/linux/systemd/server.service.in" > "/etc/systemd/system/$UNIT"
install -d "/etc/systemd/system/$UNIT.d"
printf '[Service]\nEnvironment=MYCEL_VM_PHASE=checks\n' > "/etc/systemd/system/$UNIT.d/vm.conf"
systemctl daemon-reload

# ---- 3. the install (it restarts the unit, which runs the checks) ----
rm -f "$BASE/data/vm-results.json"
"$REPO/scripts/dev-env/srt/install-srt.sh" --id "$ID"
echo "vm-check: waiting for the driver (up to 20 min)"
for _ in $(seq 1 240); do [ -s "$BASE/data/vm-results.json" ] && break; sleep 5; done
[ -s "$BASE/data/vm-results.json" ] || { journalctl -u "$UNIT" --no-pager | tail -50; echo "vm-check: no results" >&2; exit 1; }
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

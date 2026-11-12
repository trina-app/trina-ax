#!/bin/bash
# Attack checks of the dev environment on a Mac team server (tests/macos/srt-attack-mac.ts), on a TEST install of this
# Mac: scripts/install-macos.sh --id <name>-test ... (the dev environment is on by default). Run with sudo from your own
# account (it builds the driver and the probe as you, then runs them as the install's server account):
#
#   sudo tests/macos/srt-attack-mac.sh <id> <port> <proxy-port> <tls-port> [report.json]
#
# The ports are the install's --port, --proxy-port and --tls-port (0 = off).
#
# Also checks, as root: the sudoers rule allows nothing else, and a run outlives the end of the launchd job that
# started it (a server restart or update keeps the runs).
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
ID=${1:?usage: srt-attack-mac.sh <id> <port> <proxy-port> <tls-port> [report.json]}
SERVER_PORT=${2:?port} PROXY_PORT=${3:?proxy port} TLS_PORT=${4:?tls port}
REPORT=${5:-}
[[ "$ID" =~ ^[a-z][a-z0-9-]*-test$ ]] || { echo "only on a test install (an id that ends in -test)" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 2; }
[ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] || { echo "run with sudo from your own account" >&2; exit 2; }
REPO=$(cd "$(dirname "$0")/../.." && pwd -P)
BASE="/Library/Application Support/$ID"
LABEL="app.treesoop.$ID"
PLIST="/Library/LaunchDaemons/$LABEL.server.plist"
[ -f "$PLIST" ] || { echo "no $PLIST: install the test server first" >&2; exit 2; }
SRV=$(plutil -extract UserName raw -o - "$PLIST")
envv() { plutil -extract "EnvironmentVariables.$1" raw -o - "$PLIST" 2>/dev/null || true; }
[ "$(envv MYCEL_DEV_ENV)" = 1 ] || { echo "the dev environment is not on in $PLIST" >&2; exit 2; }
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
U_HOME=$(dscl . -read "/Users/$SUDO_USER" NFSHomeDirectory | awk '{print $2}')

OUT=$(mktemp -d /private/tmp/srt-attack.XXXXXX); chmod 755 "$OUT"
trap 'rm -rf "$OUT"; launchctl bootout "system/$LABEL.attackrestart" >/dev/null 2>&1 || true; rm -f "/Library/LaunchDaemons/$LABEL.attackrestart.plist"' EXIT
sudo -u "$SUDO_USER" "$U_HOME/.bun/bin/bun" build "$REPO/tests/macos/srt-attack-mac.ts" --target bun --outfile "$OUT/attack.js" >/dev/null
PROBE=""
if [ -x /usr/bin/cc ] && sudo -u "$SUDO_USER" /usr/bin/cc -O -o "$OUT/argv-probe" "$REPO/tests/macos/argv-probe.c" 2>/dev/null; then PROBE="$OUT/argv-probe"; fi
chmod -R a+rX "$OUT"
BUN="$BASE/app/current/bin/bun"
ENVS=(PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$BASE/data" MYCEL_INSTALL_BASE="$BASE")
for k in MYCEL_DEV_ENV_SLOTS MYCEL_DEV_ENV_PORT_BASE MYCEL_DEV_ENV_POOL_MIB MYCEL_DEV_ENV_PIDS_MAX MYCEL_DEV_ENV_ACL; do ENVS+=("$k=$(envv "$k")"); done
ENVS+=(ATTACK_SERVER_PORT="$SERVER_PORT" ATTACK_PROXY_PORT="$PROXY_PORT" ATTACK_TLS_PORT="$TLS_PORT" ATTACK_LAN_IP="$LAN_IP" ATTACK_OWNER_HOME="$U_HOME" ATTACK_PROBE="$PROBE")
[ -n "$REPORT" ] && { touch "$OUT/report.json"; chown "$SRV" "$OUT/report.json"; ENVS+=(ATTACK_REPORT="$OUT/report.json"); }

echo "== as root: the sudoers rule allows run-wrap-mac as a slot account, nothing else"
SLOT1=$(envv MYCEL_DEV_ENV_SLOTS | cut -d, -f1)
R=0
(cd / && sudo -n -u "$SRV" sudo -n -u "$SLOT1" /opt/trina/devenv/run-wrap-mac check) | grep -qx "ok $SLOT1" && echo "PASS S1 the server account runs run-wrap-mac check as $SLOT1" || { echo "FAIL S1 run-wrap-mac check as $SLOT1"; R=1; }
for c in "-u $SLOT1 /bin/sh -c id" "-u root /opt/trina/devenv/run-wrap-mac check" "-u $(stat -f %Su "$U_HOME") /opt/trina/devenv/run-wrap-mac check" "-u $SLOT1 /opt/trina/node/bin/node -e 1"; do
  # shellcheck disable=SC2086
  if (cd / && sudo -n -u "$SRV" sudo -n $c) >/dev/null 2>&1; then echo "FAIL S2 the server account may run: sudo $c"; R=1; else echo "PASS S2 refused: sudo $c"; fi
done

echo "== as the server account $SRV: the attack checks"
(cd / && sudo -u "$SRV" env -i "${ENVS[@]}" "$BUN" "$OUT/attack.js") || R=1

echo "== as root: a run outlives the launchd job that started it"
cat > "/Library/LaunchDaemons/$LABEL.attackrestart.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL.attackrestart</string>
  <key>UserName</key><string>$SRV</string>
  <key>ProgramArguments</key><array><string>$BUN</string><string>$OUT/attack.js</string></array>
  <key>EnvironmentVariables</key><dict>$(for e in "${ENVS[@]}" ATTACK_MODE=restart-spawn; do printf '<key>%s</key><string>%s</string>' "${e%%=*}" "$(printf '%s' "${e#*=}" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g')"; done)</dict>
  <key>WorkingDirectory</key><string>/</string>
  <key>StandardOutPath</key><string>$OUT/restart.log</string>
  <key>StandardErrorPath</key><string>$OUT/restart.log</string>
</dict></plist>
EOF
touch "$OUT/restart.log"; chown "$SRV" "$OUT/restart.log"
launchctl bootstrap system "/Library/LaunchDaemons/$LABEL.attackrestart.plist"
for i in $(seq 1 30); do grep -q '^RUN ' "$OUT/restart.log" && break; sleep 1; done
read -r _ RUNID ACCT < <(grep '^RUN ' "$OUT/restart.log" | head -n 1) || true
if [ -z "${ACCT:-}" ]; then echo "FAIL S3 the job did not start a run: $(tail -5 "$OUT/restart.log")"; R=1
else
  launchctl bootout "system/$LABEL.attackrestart"; sleep 3
  if pgrep -U "$(id -u "$ACCT")" sleep >/dev/null; then echo "PASS S3 the run of $ACCT is still there after launchd ended the job that started it"; else echo "FAIL S3 the run ended with its launchd job"; R=1; fi
  (cd / && sudo -n -u "$SRV" sudo -n -u "$ACCT" /opt/trina/devenv/run-wrap-mac stop) || true
  rm -f "$BASE/devenv/run/$RUNID.slot" "$BASE/devenv/run/$RUNID.json"
fi
[ -n "$REPORT" ] && cp "$OUT/report.json" "$REPORT" && chown "$SUDO_USER" "$REPORT"
exit $R

#!/bin/bash
# Team AX server installer for macOS (design tab 6 "설치 마법사 / 파일 위치와 제거", tab 2 "엔진 계정"). Component G.
# This is the work the signed setup .pkg's postinstall does; it is idempotent (running it again repairs the install).
#
#   sudo scripts/install-macos.sh --from <build dir> [options]
#
#   --from DIR            output of `bun scripts/build-bundle.ts` (app/<version>/, root/, VERSION)
#   --id ID               product id: folder names, LaunchDaemon labels (default mycel; tests use mycel-test)
#   --server-user NAME    server role account (default _axserver)
#   --agent-user NAME     engine role account (default _axagent)
#   --port N              server HTTP port on 127.0.0.1 (default 47820)
#   --tls-port N          office-network TLS port (default 8443; 0 = off)
#   --proxy-port N        local model proxy port the engine may reach (default 47821)
#   --engine NAME=FILE    install an engine executable into app/engines/NAME/<sha>/ (repeatable); the first one is the
#                         server's engine. Real Claude Code / Codex for the role account need the owner's subscription
#                         login (claude setup-token / codex login --device-auth), see docs/WORKPLAN.md.
#   --allow-unsigned      accept bundles without a release signature (development and test builds)
#   --no-power            do not change sleep / power-failure settings (pmset); for test installs on a laptop
#   --skip-tmutil         do not add Time Machine exclusions
#
# What it does: role accounts (UID 450-499, hidden, shell /usr/bin/false, no password, home off /var/empty) and same-name
# groups; folders with fixed owners and modes; root-owned files (bootstrap, launcher, sandbox profile, pf rules,
# pf-load); config/server.json; a self-signed TLS certificate for the office network; the one-time setup code;
# LaunchDaemons <label>.server / .launcher / .pf; the engine account in /var/at/cron.deny and at.deny;
# /etc/newsyslog.d/<id>.conf; Time Machine exclusions; then it waits until /api/health answers.
set -euo pipefail
umask 022
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

ID=mycel SRV_USER=_axserver AGT_USER=_axagent PORT=47820 TLS_PORT=8443 PROXY_PORT=47821
FROM="" ALLOW_UNSIGNED=0 POWER=1 TMUTIL=1
ENGINES=()
WARNINGS=()
die() { echo "install: $*" >&2; exit 1; }
say() { echo "install: $*"; }
warn() { WARNINGS+=("$*"); echo "install: warning: $*" >&2; }
# Some steps touch places macOS guards with Full Disk Access (/var/at, Time Machine settings). The setup package's
# postinstall has it; a terminal without it gets a consent prompt (unattended: the call blocks) or a refusal. Those
# steps get a time limit and become warnings, and the server's diagnostics report what is missing.
limited() {  # seconds command...
  local secs=$1 pid i; shift
  "$@" & pid=$!
  for i in $(seq 1 $((secs * 2))); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" >/dev/null 2>&1; wait "$pid" >/dev/null 2>&1; return 124; fi
  wait "$pid"
}
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM=$2; shift 2 ;;
    --id) ID=$2; shift 2 ;;
    --server-user) SRV_USER=$2; shift 2 ;;
    --agent-user) AGT_USER=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --tls-port) TLS_PORT=$2; shift 2 ;;
    --proxy-port) PROXY_PORT=$2; shift 2 ;;
    --engine) ENGINES+=("$2"); shift 2 ;;
    --allow-unsigned) ALLOW_UNSIGNED=1; shift ;;
    --no-power) POWER=0; shift ;;
    --skip-tmutil) TMUTIL=0; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done

# ---- checks (the script validates its own arguments: the menubar app passes them through osascript) ----
[ "$(id -u)" = 0 ] || die "run as root (sudo)"
[ "$(uname -s)" = Darwin ] || die "macOS only"
[[ "$ID" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "bad --id"
for u in "$SRV_USER" "$AGT_USER"; do [[ "$u" =~ ^_[a-z][a-z0-9]{2,30}$ ]] || die "role account names start with _ and use a-z0-9: $u"; done
[ "$SRV_USER" != "$AGT_USER" ] || die "server and engine accounts must differ"
for p in "$PORT" "$TLS_PORT" "$PROXY_PORT"; do [[ "$p" =~ ^[0-9]{1,5}$ ]] && [ "$p" -le 65535 ] || die "bad port $p"; done
[ -n "$FROM" ] && [ -f "$FROM/VERSION" ] || die "--from must be a build-bundle output folder"
VERSION=$(tr -d '[:space:]' < "$FROM/VERSION")
[[ "$VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z.+_-]{0,49}$ ]] || die "bad VERSION"
BUNDLE="$FROM/app/$VERSION"
[ -f "$BUNDLE/manifest.json" ] || die "$BUNDLE/manifest.json missing"
for f in mycel-bootstrap mycel-launcher engine.sb pf-load; do [ -f "$FROM/root/$f" ] || die "$FROM/root/$f missing"; done
[ ${#ENGINES[@]} -gt 0 ] || die "at least one --engine NAME=FILE is needed"
if [ "$ALLOW_UNSIGNED" = 0 ] && [ ! -f "$BUNDLE/manifest.sig" ]; then die "bundle is not signed (use --allow-unsigned for development builds)"; fi

BASE="/Library/Application Support/$ID"
LOGS="/Library/Logs/$ID"
LABEL="app.treesoop.$ID"
ANCHOR="com.apple/250.$ID"
LD=/Library/LaunchDaemons

# ---- role accounts ----
used_ids() { { dscl . -list /Users UniqueID; dscl . -list /Groups PrimaryGroupID; } | awk '{print $2}' | sort -n -u; }
free_id() {
  local used n
  used=$(used_ids)
  for n in $(seq 450 499); do
    if ! echo "$used" | grep -qx "$n"; then echo "$n"; return 0; fi
  done
  return 1
}
ensure_account() {  # name, description, home
  local name=$1 desc=$2 home=$3 uid gid
  if dscl . -read "/Users/$name" UniqueID >/dev/null 2>&1; then
    uid=$(dscl . -read "/Users/$name" UniqueID | awk '{print $2}')
    [ "$uid" -ge 450 ] && [ "$uid" -le 499 ] || die "$name exists with UID $uid outside 450-499; refusing to use it"
  else
    # dscl, not `sysadminctl -roleAccount`: on macOS 26 sysadminctl run non-interactively as root ignored -UID (the account
    # got 502, a regular user with a picture and a password policy) and its follow-up record changes hung for 270 s
    # waiting for an authorization nobody could answer. Plain dscl records are created instantly (docs/DECISIONS.md, G).
    uid=$(free_id) || die "no free UID in 450-499"
    dscl . -create "/Users/$name" || die "could not create $name"
    dscl . -create "/Users/$name" UniqueID "$uid"
    dscl . -create "/Users/$name" Password '*'
    say "created role account $name ($uid)"
  fi
  if dscl . -read "/Groups/$name" PrimaryGroupID >/dev/null 2>&1; then
    gid=$(dscl . -read "/Groups/$name" PrimaryGroupID | awk '{print $2}')
  else
    gid=$uid
    if used_ids | grep -qx "$gid" && ! dscl . -list /Users UniqueID | awk '{print $2}' | grep -qx "$gid"; then gid=$(free_id); fi
    dseditgroup -o create -i "$gid" -r "$desc" "$name" || die "could not create group $name"
  fi
  dseditgroup -o edit -a "$name" -t user "$name" >/dev/null 2>&1 || true
  dscl . -create "/Users/$name" PrimaryGroupID "$gid"
  dscl . -create "/Users/$name" UserShell /usr/bin/false
  dscl . -create "/Users/$name" NFSHomeDirectory "$home"
  dscl . -create "/Users/$name" IsHidden 1
  dscl . -create "/Users/$name" RealName "$desc"
  dscl . -delete "/Users/$name" AuthenticationAuthority >/dev/null 2>&1 || true # locked by an earlier uninstall
}
ensure_account "$SRV_USER" "Team AX server ($ID)" "$BASE/data"
ensure_account "$AGT_USER" "Team AX AI engine ($ID)" "$BASE/agent/home"
SRV_UID=$(id -u "$SRV_USER"); AGT_UID=$(id -u "$AGT_USER")
SRV_GRP=$(id -gn "$SRV_USER"); AGT_GRP=$(id -gn "$AGT_USER")
say "accounts: $SRV_USER=$SRV_UID:$SRV_GRP $AGT_USER=$AGT_UID:$AGT_GRP"

# ---- folders: owner group mode path ----
mk() { mkdir -p "$4"; chown "$1:$2" "$4"; chmod "$3" "$4"; }
mk root wheel 755 "$BASE"
mk "$SRV_USER" "$SRV_GRP" 755 "$BASE/app"
mk "$SRV_USER" "$SRV_GRP" 755 "$BASE/app/versions"
mk "$SRV_USER" "$AGT_GRP" 750 "$BASE/app/engines"
mk "$SRV_USER" "$SRV_GRP" 700 "$BASE/data"
mk "$SRV_USER" "$SRV_GRP" 700 "$BASE/team"
mk "$SRV_USER" "$SRV_GRP" 700 "$BASE/config"
mk "$SRV_USER" "$SRV_GRP" 700 "$BASE/secrets"
mk "$SRV_USER" admin 750 "$BASE/setup"
mk "$SRV_USER" admin 750 "$BASE/status"
mk "$AGT_USER" "$AGT_GRP" 700 "$BASE/agent"
mk root wheel 555 "$BASE/agent/home"
mk root wheel 755 "$BASE/run"
mk "$SRV_USER" "$AGT_GRP" 750 "$BASE/run/tools"
# the launcher (engine account) creates launcher.sock itself; group = server group, so only the server can connect.
# (launchd socket activation with a root-owned folder needs launch_activate_socket in the launcher: later.)
mk "$AGT_USER" "$SRV_GRP" 750 "$BASE/run-launcher"
mk root wheel 755 "$BASE/root"
mk "$SRV_USER" admin 750 "$LOGS"
mk root wheel 755 "$LOGS/crash"
for f in server:"$SRV_USER":admin:640 launcher:"$AGT_USER":"$AGT_GRP":600 pf:root:wheel:644; do
  IFS=: read -r n o g m <<< "$f"
  touch "$LOGS/crash/$n.log"; chown "$o:$g" "$LOGS/crash/$n.log"; chmod "$m" "$LOGS/crash/$n.log"
done

# ---- root-owned files ----
install -o root -g wheel -m 755 "$FROM/root/mycel-bootstrap" "$BASE/root/mycel-bootstrap"
install -o root -g wheel -m 755 "$FROM/root/mycel-launcher" "$BASE/root/mycel-launcher"
install -o root -g wheel -m 644 "$FROM/root/engine.sb" "$BASE/root/engine.sb"
install -o root -g wheel -m 755 "$FROM/root/pf-load" "$BASE/root/pf-load"
TMPF=$(mktemp)
cat > "$TMPF" <<EOF
# Team AX ($ID) engine firewall, loaded into anchor "$ANCHOR" by root/pf-load. Generated by install-macos.sh.
# The engine account may reach only the local model proxy; everything else (other localhost ports such as the
# server API, the office network, the internet, IPv4 and IPv6) is dropped. The tools socket is a Unix socket.
pass out quick proto tcp from any to 127.0.0.1 port $PROXY_PORT user $AGT_USER keep state
block drop out quick user $AGT_USER
EOF
pfctl -n -a "$ANCHOR" -f "$TMPF" >/dev/null 2>&1 || { rm -f "$TMPF"; die "pf rules do not parse"; }
install -o root -g wheel -m 644 "$TMPF" "$BASE/root/pf.anchor"; rm -f "$TMPF"

# ---- engines (app/engines/<name>/<sha12>/<file>, current -> <sha12>) ----
ENGINE_CMDS=()
for spec in "${ENGINES[@]}"; do
  name=${spec%%=*}; file=${spec#*=}
  [[ "$name" =~ ^[a-z][a-z0-9-]{0,30}$ ]] || die "bad engine name $name"
  [ -f "$file" ] || die "engine file $file missing"
  sha=$(shasum -a 256 "$file" | cut -c1-12)
  dir="$BASE/app/engines/$name/$sha"
  mk "$SRV_USER" "$AGT_GRP" 750 "$BASE/app/engines/$name"
  mk "$SRV_USER" "$AGT_GRP" 750 "$dir"
  install -o "$SRV_USER" -g "$AGT_GRP" -m 750 "$file" "$dir/$(basename "$file")"
  ln -sfn "$sha" "$BASE/app/engines/$name/current"
  chown -h "$SRV_USER:$AGT_GRP" "$BASE/app/engines/$name/current"
  ENGINE_CMDS+=("$BASE/app/engines/$name/current/$(basename "$file")")
done

# ---- server version ----
DEST="$BASE/app/versions/$VERSION"
if [ -d "$DEST" ] && cmp -s "$DEST/manifest.json" "$BUNDLE/manifest.json"; then
  say "version $VERSION already installed"
else
  rm -rf "$DEST.partial"; cp -R "$BUNDLE" "$DEST.partial"; rm -rf "$DEST"; mv "$DEST.partial" "$DEST"
fi
chown -R "$SRV_USER:$SRV_GRP" "$DEST"
find "$DEST" -type d -exec chmod 755 {} +
chmod -R go-w "$DEST"
if [ ! -L "$BASE/app/current" ] || [ ! -f "$BASE/app/current/manifest.json" ]; then
  ln -sfn "versions/$VERSION" "$BASE/app/current"
  chown -h "$SRV_USER:$SRV_GRP" "$BASE/app/current"
fi
CUR=$(basename "$(readlink "$BASE/app/current")")
BUN="$BASE/app/current/bin/bun"
if [ ! -f "$BASE/app/state.json" ]; then
  printf '{"format":1,"current":"%s","previous":null,"pending":null,"pendingSince":null,"attempts":0,"history":[]}\n' "$CUR" > "$BASE/app/state.json"
fi
chown "$SRV_USER:$SRV_GRP" "$BASE/app/state.json"; chmod 640 "$BASE/app/state.json"

# ---- office-network TLS certificate (ECDSA P-256, 10 years; SAN <host>.local + 127.0.0.1 [+ LAN IP]) ----
if [ "$TLS_PORT" != 0 ] && [ ! -f "$BASE/secrets/lan-tls.key" ]; then
  HOST=$(scutil --get LocalHostName 2>/dev/null || hostname -s)
  SAN="DNS:$HOST.local,IP:127.0.0.1"
  LAN=$(ipconfig getifaddr en0 2>/dev/null || true); [ -n "$LAN" ] && SAN="$SAN,IP:$LAN"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 -subj "/CN=$HOST.local" \
    -addext "subjectAltName=$SAN" -keyout "$BASE/secrets/lan-tls.key" -out "$BASE/secrets/lan-tls.crt" >/dev/null 2>&1 || die "openssl failed"
fi
if [ "$TLS_PORT" != 0 ]; then
  chown "$SRV_USER:$SRV_GRP" "$BASE/secrets/lan-tls.key" "$BASE/secrets/lan-tls.crt"; chmod 600 "$BASE/secrets/lan-tls.key"; chmod 644 "$BASE/secrets/lan-tls.crt"
  openssl x509 -in "$BASE/secrets/lan-tls.crt" -noout -fingerprint -sha256 | sed 's/.*=//' > "$BASE/setup/lan-cert.sha256"
  chown "$SRV_USER:admin" "$BASE/setup/lan-cert.sha256"; chmod 640 "$BASE/setup/lan-cert.sha256"
fi

# ---- config/server.json (merged: owner choices such as relay and update channel survive a reinstall) ----
CFG="$BASE/config/server.json"
MYCEL_I_CFG="$CFG" MYCEL_I_BASE="$BASE" MYCEL_I_LOGS="$LOGS" MYCEL_I_PORT="$PORT" MYCEL_I_TLS="$TLS_PORT" \
MYCEL_I_AGT_UID="$AGT_UID" MYCEL_I_ENGINE="${ENGINE_CMDS[0]}" "$BUN" -e '
const fs = require("fs"), e = process.env, b = e.MYCEL_I_BASE
let old = {}; try { old = JSON.parse(fs.readFileSync(e.MYCEL_I_CFG, "utf8")) } catch {}
const cfg = {
  ...old,
  mode: "prod",
  listen: { host: "127.0.0.1", port: Number(e.MYCEL_I_PORT) },
  tls: e.MYCEL_I_TLS === "0" ? null : { port: Number(e.MYCEL_I_TLS), certFile: b + "/secrets/lan-tls.crt", keyFile: b + "/secrets/lan-tls.key" },
  teamRoot: b + "/team", dataDir: b + "/data", logDir: e.MYCEL_I_LOGS,
  engine: { ...(old.engine ?? {}), authMode: old.engine?.authMode ?? "proxy", claudeBin: e.MYCEL_I_ENGINE,
    runDir: b + "/run/tools", agentRoot: b + "/agent", launcherSock: b + "/run-launcher/launcher.sock", agentUid: Number(e.MYCEL_I_AGT_UID) },
  relay: old.relay ?? { url: null, teamName: null },
  update: old.update ?? { channel: "stable", feedUrl: null },
}
fs.writeFileSync(e.MYCEL_I_CFG + ".tmp", JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 })
fs.renameSync(e.MYCEL_I_CFG + ".tmp", e.MYCEL_I_CFG)
' || die "writing $CFG failed"
chown "$SRV_USER:$SRV_GRP" "$CFG"; chmod 600 "$CFG"

# ---- one-time setup code (fresh install only): the menubar app reads setup/code, the server data/setup-token ----
if [ ! -f "$BASE/data/app.db" ] && [ ! -f "$BASE/setup/code" ]; then
  CODE=$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=\n')
  printf '%s\n' "$CODE" > "$BASE/setup/code"; chown "$SRV_USER:admin" "$BASE/setup/code"; chmod 640 "$BASE/setup/code"
  printf '%s\n' "$CODE" > "$BASE/data/setup-token"; chown "$SRV_USER:$SRV_GRP" "$BASE/data/setup-token"; chmod 600 "$BASE/data/setup-token"
  unset CODE
fi

# ---- LaunchDaemons ----
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
args_xml() { local a; for a in "$@"; do printf '    <string>%s</string>\n' "$(xml "$a")"; done; }
BOOT_ARGS=("$BASE/root/mycel-bootstrap" --app "$BASE/app" --config "$CFG" --update-log "$LOGS/update.log")
[ "$ALLOW_UNSIGNED" = 1 ] && BOOT_ARGS+=(--allow-unsigned)
LAUNCH_ARGS=("$BASE/root/mycel-launcher" --listen "$BASE/run-launcher/launcher.sock" --mode 0660 --agent-root "$BASE/agent"
  --bridge "$BASE/app/current/native/mycel-bridge" --tools-sock "$BASE/run/tools/tools.sock" --server-uid "$SRV_UID"
  --dedicated-account --sandbox-profile "$BASE/root/engine.sb" --proxy-port "$PROXY_PORT")
for c in "${ENGINE_CMDS[@]}"; do LAUNCH_ARGS+=(--allow-cmd "$c"); done

write_plist() {  # label user group throttle keepalive(true/false) interval umask log env-xml args...
  local label=$1 user=$2 group=$3 throttle=$4 keep=$5 interval=$6 um=$7 log=$8 envxml=$9; shift 9
  local f="$LD/$label.plist" tmp
  tmp=$(mktemp)
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0"><dict>'
    echo "  <key>Label</key><string>$label</string>"
    echo "  <key>UserName</key><string>$user</string>"
    echo "  <key>GroupName</key><string>$group</string>"
    echo '  <key>ProgramArguments</key><array>'
    args_xml "$@"
    echo '  </array>'
    echo "  <key>EnvironmentVariables</key><dict>$envxml</dict>"
    echo '  <key>RunAtLoad</key><true/>'
    if [ "$keep" = true ]; then echo '  <key>KeepAlive</key><true/>'; echo "  <key>ThrottleInterval</key><integer>$throttle</integer>"; fi
    [ "$interval" != 0 ] && echo "  <key>StartInterval</key><integer>$interval</integer>"
    echo "  <key>Umask</key><integer>$um</integer>"
    echo '  <key>ProcessType</key><string>Standard</string>'
    echo "  <key>StandardOutPath</key><string>$(xml "$log")</string>"
    echo "  <key>StandardErrorPath</key><string>$(xml "$log")</string>"
    echo "  <key>AssociatedBundleIdentifiers</key><array><string>$LABEL.menubar</string></array>"
    echo '</dict></plist>'
  } > "$tmp"
  plutil -lint "$tmp" >/dev/null || { cat "$tmp" >&2; rm -f "$tmp"; die "bad plist for $label"; }
  install -o root -g wheel -m 644 "$tmp" "$f"; rm -f "$tmp"
}
ENV_SRV="<key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string><key>HOME</key><string>$(xml "$BASE/data")</string><key>MYCEL_INSTALL_BASE</key><string>$(xml "$BASE")</string><key>MYCEL_LABEL</key><string>$LABEL</string><key>MYCEL_WEB_DIST</key><string>$(xml "$BASE/app/current/web")</string>"
ENV_AGT="<key>PATH</key><string>/usr/bin:/bin</string><key>HOME</key><string>$(xml "$BASE/agent/home")</string>"
write_plist "$LABEL.server" "$SRV_USER" "$SRV_GRP" 2 true 0 23 "$LOGS/crash/server.log" "$ENV_SRV" "${BOOT_ARGS[@]}"
write_plist "$LABEL.launcher" "$AGT_USER" "$AGT_GRP" 1 true 0 63 "$LOGS/crash/launcher.log" "$ENV_AGT" "${LAUNCH_ARGS[@]}"
write_plist "$LABEL.pf" root wheel 0 false 300 18 "$LOGS/crash/pf.log" "<key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>" "$BASE/root/pf-load" "$BASE" "$ANCHOR"

# ---- cron / at: the engine account may not schedule anything ----
for f in /var/at/cron.deny /var/at/at.deny; do
  if ! limited 15 /bin/sh -c '[ -f "$1" ] || { touch "$1" && chown root:wheel "$1" && chmod 644 "$1"; }; grep -qx "$2" "$1" || echo "$2" >> "$1"' sh "$f" "$AGT_USER" >/dev/null 2>&1; then
    warn "could not add $AGT_USER to $f (needs Full Disk Access; the setup package has it). The engine sandbox still blocks crontab/at."
  fi
done

# ---- log rotation for the launchd crash logs (the server rotates its own JSON logs) ----
NS=$(mktemp)
cat > "$NS" <<EOF
# Team AX ($ID) launchd output (start failures only). logfilename [owner:group] mode count size(KB) when flags
$LOGS/crash/server.log $SRV_USER:admin 640 5 10240 * NZ
$LOGS/crash/launcher.log $AGT_USER:$AGT_GRP 600 5 10240 * NZ
$LOGS/crash/pf.log root:wheel 644 5 10240 * NZ
EOF
newsyslog -n -f "$NS" >/dev/null 2>&1 || { rm -f "$NS"; die "newsyslog config does not parse"; }
install -o root -g wheel -m 644 "$NS" "/etc/newsyslog.d/$ID.conf"; rm -f "$NS"

# ---- Time Machine: secrets, engine folders, sockets and the app (reinstallable) stay out of backups ----
if [ "$TMUTIL" = 1 ]; then
  for p in secrets agent run run-launcher app; do
    limited 15 tmutil addexclusion -p "$BASE/$p" >/dev/null 2>&1 || warn "Time Machine exclusion of $p failed (needs Full Disk Access; the setup package has it)"
  done
fi

# ---- power: stay awake, come back after a power failure (laptops: --no-power) ----
if [ "$POWER" = 1 ]; then pmset -a sleep 0 autorestart 1 womp 1 >/dev/null 2>&1 || say "pmset failed"; fi

# ---- (re)load the daemons: bootout + bootstrap (kickstart would not read a changed plist) ----
for d in pf launcher server; do
  launchctl bootout "system/$LABEL.$d" >/dev/null 2>&1 || true
done
for d in pf launcher server; do
  launchctl enable "system/$LABEL.$d"
  launchctl bootstrap system "$LD/$LABEL.$d.plist" || die "launchctl bootstrap $LABEL.$d failed"
done

say "waiting for the server on 127.0.0.1:$PORT"
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    say "installed $ID $CUR (server $SRV_USER, engine $AGT_USER)"
    [ ${#WARNINGS[@]} -eq 0 ] || { say "with ${#WARNINGS[@]} warning(s):"; printf '  %s\n' "${WARNINGS[@]}"; }
    exit 0
  fi
  sleep 1
done
die "the server did not answer within 60 s; see $LOGS/crash/server.log"

#!/bin/bash
# Team server installer for macOS (design tab 6 "설치 마법사 / 파일 위치와 제거", tab 2 "엔진 계정"). Component G.
# This is the work the signed setup .pkg's postinstall does; it is idempotent (running it again repairs the install).
#
#   sudo scripts/install-macos.sh --from <build dir> --engine claude=FILE [--engine codex=FILE] [options]
#        scripts/install-macos.sh --check --from <build dir> --engine ...   (no root: check everything, change nothing)
#
#   --from DIR            output of `bun scripts/build-bundle.ts` (app/<version>/, root/, VERSION)
#   --engine NAME=FILE    NAME is claude (Claude Code) or codex (Codex CLI), each at most once; FILE is that CLI's
#                         Mach-O executable (e.g. "$(readlink -f ~/.local/bin/claude)"). It is copied to
#                         app/engines/NAME/<sha12>/NAME and set as engine.claudeBin / engine.codexBin. An engine
#                         installed earlier and not named again stays installed. Claude Code answers once the owner
#                         stored a subscription token: claude setup-token, then
#                         pbpaste | sudo "<base>/root/set-claude-token" (docs/INSTALL.md 2.4); Codex once the owner
#                         signed the engine account in with admin.js codex-login (2.5).
#   --id ID               product id: folder names, LaunchDaemon labels (default mycel; tests use mycel-test)
#   --server-user NAME    server role account (default _axserver)
#   --agent-user NAME     engine role account (default _axagent)
#   --port N              server HTTP port on 127.0.0.1 (default 47820)
#   --tls-port N          office-network TLS port (default 8443; 0 = off)
#   --proxy-port N        local model proxy port the engine may reach (default 47821)
#   --codex-models FILE   with --engine codex: models_cache.json of the same Codex version, locked into
#                         app/engines/codex/<sha>/model_catalog.json with the shell off for every model (default: the
#                         invoking user's ~/.codex/models_cache.json, i.e. $SUDO_USER's)
#   --allow-unsigned      accept bundles without a release signature (development and test builds)
#   --no-power            do not change sleep / power-failure settings (pmset); for test installs on a laptop
#   --skip-tmutil         do not add Time Machine exclusions
#   --check               validate the arguments, the bundle (version, files, CPU type) and the engines, print the
#                         plan and exit; needs no root and changes nothing
#
# Versions: the first install points app/current at the bundle. Running it again with the same version repairs the
# install; with a NEWER bundle it switches app/current to it like an in-app update (the running version stays in
# app/versions as state.previous for "Roll back", and the bootstrap goes back to it by itself if the new one does not
# become healthy; the installer then exits 1). An OLDER bundle is only staged; app/current stays.
#
# What it does: role accounts (UID 450-499, hidden, shell /usr/bin/false, no password, home off /var/empty) and same-name
# groups; folders with fixed owners and modes (data kept by an earlier uninstall is given back to the server account);
# root-owned files (bootstrap, launcher, sandbox profile, pf rules, pf-load, the account tool root/mycel-account);
# config/server.json; the office-network TLS certificate naming <LocalHostName>.local and every LAN address (the
# server renews it when they change); the one-time setup code; LaunchDaemons <label>.server / .launcher / .pf; the
# engine account in /var/at/cron.deny and at.deny; /etc/newsyslog.d/<id>.conf; Time Machine exclusions; then it
# waits until /api/health answers with the version app/current points to.
#
# Owner password recovery (no email): sudo "<base>/root/mycel-account" reset-link   (also status, list-owners and
# create-owner; scripts/macos/account.sh).
#
# Root never trusts what the role accounts can change (design tab 6: root only copies, replaces and chowns there and
# never runs anything from app/, data/ or the team folder): on a repair run the daemons are stopped and every process
# of both accounts is killed first, so nothing can race the installer; every path it touches below the install folder
# is checked for symbolic links; files that land in folders the server owns are written in a root-only folder,
# owned and moded there, and renamed into place (rename replaces a planted link instead of following it); the only
# programs it runs come from the bundle it installs (--from) or the system.
set -euo pipefail
umask 022
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

ID=mycel SRV_USER=_axserver AGT_USER=_axagent PORT=47820 TLS_PORT=8443 PROXY_PORT=47821
FROM="" ALLOW_UNSIGNED=0 POWER=1 TMUTIL=1 CODEX_MODELS=""
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
CHECK=0
val() { [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --from) val "$@"; FROM=$2; shift 2 ;;
    --id) val "$@"; ID=$2; shift 2 ;;
    --server-user) val "$@"; SRV_USER=$2; shift 2 ;;
    --agent-user) val "$@"; AGT_USER=$2; shift 2 ;;
    --port) val "$@"; PORT=$2; shift 2 ;;
    --tls-port) val "$@"; TLS_PORT=$2; shift 2 ;;
    --proxy-port) val "$@"; PROXY_PORT=$2; shift 2 ;;
    --engine) val "$@"; ENGINES+=("$2"); shift 2 ;;
    --codex-models) val "$@"; CODEX_MODELS=$2; shift 2 ;;
    --allow-unsigned) ALLOW_UNSIGNED=1; shift ;;
    --no-power) POWER=0; shift ;;
    --skip-tmutil) TMUTIL=0; shift ;;
    --check) CHECK=1; shift ;;
    -h|--help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

# ---- checks (the script validates its own arguments: the menubar app passes them through osascript) ----
[ "$CHECK" = 1 ] || [ "$(id -u)" = 0 ] || die "run as root (sudo), or with --check to only check"
[ "$(uname -s)" = Darwin ] || die "macOS only"
[[ "$ID" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "bad --id"
for u in "$SRV_USER" "$AGT_USER"; do [[ "$u" =~ ^_[a-z][a-z0-9]{2,30}$ ]] || die "role account names start with _ and use a-z0-9: $u"; done
[ "$SRV_USER" != "$AGT_USER" ] || die "server and engine accounts must differ"
for p in "$PORT" "$TLS_PORT" "$PROXY_PORT"; do [[ "$p" =~ ^[0-9]{1,5}$ ]] && [ "$p" -le 65535 ] || die "bad port $p"; done
[ "$PORT" != 0 ] && [ "$PROXY_PORT" != 0 ] || die "only --tls-port may be 0 (off)"
[ "$PORT" != "$PROXY_PORT" ] && [ "$PORT" != "$TLS_PORT" ] && [ "$PROXY_PORT" != "$TLS_PORT" ] || die "--port, --tls-port and --proxy-port must differ"
[ -n "$FROM" ] && [ -f "$FROM/VERSION" ] || die "--from must be a build-bundle output folder"
FROM=$(cd "$FROM" && pwd -P)
VERSION=$(tr -d '[:space:]' < "$FROM/VERSION")
# the product's name for the role accounts' full names (product.env next to VERSION, written by build-bundle.ts from
# shared/src/product.ts): read, never sourced, and only plain characters are used (else the product id)
PRODUCT_NAME=$(sed -n 's/^PRODUCT_NAME=//p' "$FROM/product.env" 2>/dev/null | head -n 1 || true)
[[ "$PRODUCT_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9\ ._-]{0,40}$ ]] || PRODUCT_NAME=$ID
[[ "$VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z.+_-]{0,49}$ ]] || die "bad VERSION"
BUNDLE="$FROM/app/$VERSION"
[ -f "$BUNDLE/manifest.json" ] || die "$BUNDLE/manifest.json missing"
for f in mycel-bootstrap mycel-launcher mycel-account engine.sb pf-load set-claude-token safe-fs.sh; do [ -f "$FROM/root/$f" ] || die "$FROM/root/$f missing (rebuild the bundle: bun run build:bundle)"; done
for f in bin/bun server/src/main.js server/src/admin.js server/src/account.js native/mycel-gate native/mycel-bridge; do [ -f "$BUNDLE/$f" ] || die "$BUNDLE/$f missing"; done
if [ "$ALLOW_UNSIGNED" = 0 ] && [ ! -f "$BUNDLE/manifest.sig" ]; then die "bundle is not signed (use --allow-unsigned for development builds)"; fi
# CPU type: every program of the bundle must run on this Mac (bun scripts/build-bundle.ts --arch universal builds both)
MACH=$(uname -m)
# (from file(1), part of macOS: /usr/bin/lipo is only a stub that asks to install the developer tools, which a server
# Mac usually does not have; arm64e, the system programs' arm64 flavour, runs on arm64)
archs_of() { file -bL "$1" 2>/dev/null | grep -oE 'Mach-O 64-bit executable [a-z0-9_]+' | awk '{print $NF}' | sed 's/^arm64e$/arm64/' | sort -u | tr '\n' ' ' | sed 's/ $//' || true; }
for f in "$BUNDLE/bin/bun" "$BUNDLE/native/mycel-gate" "$BUNDLE/native/mycel-bridge" "$FROM/root/mycel-bootstrap" "$FROM/root/mycel-launcher"; do
  archs=$(archs_of "$f"); [ -n "$archs" ] || archs="not a Mac program"
  case " $archs " in *" $MACH "*) ;; *) die "${f#"$FROM"/} is built for $archs, this Mac is $MACH: build the bundle with --arch universal (or --arch ${MACH/x86_64/amd64})" ;; esac
done
# engines: claude / codex, each at most once, a Mach-O executable (the sandbox allows no interpreter such as node)
CLAUDE_SRC="" CODEX_SRC=""
for spec in ${ENGINES[@]+"${ENGINES[@]}"}; do
  case "$spec" in *=*) ;; *) die "--engine takes NAME=FILE (claude=<Claude Code> or codex=<Codex CLI>), not $spec" ;; esac
  name=${spec%%=*} file=${spec#*=}
  case "$name" in
    claude) [ -z "$CLAUDE_SRC" ] || die "--engine claude given twice"; CLAUDE_SRC=$file ;;
    codex) [ -z "$CODEX_SRC" ] || die "--engine codex given twice"; CODEX_SRC=$file ;;
    *) die "unknown engine \"$name\": the engines are claude (Claude Code) and codex (Codex CLI)" ;;
  esac
  [ -f "$file" ] || die "engine $name: $file not found"
  [ -x "$file" ] || die "engine $name: $file is not executable"
  case "$(file -bL "$file")" in
    Mach-O*) ;;
    *) die "engine $name: $file is not a Mac program ($(file -bL "$file" | cut -c1-60)); give the real executable, e.g. \"\$(readlink -f \$(which $name))\"" ;;
  esac
  archs=$(archs_of "$file")
  case " $archs " in *" $MACH "*) ;; *) die "engine $name: $file is built for $archs, this Mac is $MACH" ;; esac
done

BASE="/Library/Application Support/$ID"
LOGS="/Library/Logs/$ID"
LABEL="app.treesoop.$ID"
ANCHOR="com.apple/250.$ID"
LD=/Library/LaunchDaemons
if [ "$CHECK" = 1 ]; then
  say "check passed: bundle $VERSION ($MACH) from $FROM"
  [ -n "$CLAUDE_SRC" ] && say "engine claude: $CLAUDE_SRC -> $BASE/app/engines/claude/<sha12>/claude (engine.claudeBin)"
  [ -n "$CODEX_SRC" ] && say "engine codex: $CODEX_SRC -> $BASE/app/engines/codex/<sha12>/codex (engine.codexBin)"
  [ -n "$CLAUDE_SRC$CODEX_SRC" ] || say "no --engine given: only engines installed earlier will be used (at least one is needed)"
  CUR_T=$(readlink "$BASE/app/current" 2>/dev/null || true)
  case "$CUR_T" in
    versions/"$VERSION") say "version: $VERSION is installed: repair" ;;
    versions/*) say "version: installed ${CUR_T#versions/}, bundle $VERSION (a newer bundle switches app/current, an older one is only staged)" ;;
    *) say "version: no install found at $BASE (or not readable without root): fresh install of $VERSION" ;;
  esac
  say "ports: http 127.0.0.1:$PORT, office TLS $([ "$TLS_PORT" = 0 ] && echo off || echo "0.0.0.0:$TLS_PORT"), model proxy 127.0.0.1:$PROXY_PORT; accounts $SRV_USER / $AGT_USER; id $ID"
  exit 0
fi

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
uattr() {  # user attribute plist-key -> first value
  dscl -plist . -read "/Users/$1" "$2" 2>/dev/null | plutil -extract "$3.0" raw -o - - 2>/dev/null || true
}
ensure_account() {  # name, description, home
  # Accounts are created with dscl, not `sysadminctl -roleAccount`: on macOS 26 sysadminctl run unattended as root
  # ignored -UID (the account got 502, a regular user with a picture and a password policy) and its follow-up changes
  # hung waiting for an approval nobody could give. A new record takes all its attributes at once; an existing
  # account is only checked, never rewritten: macOS asks the logged-in administrator to approve changes to an
  # existing user record (unattended the change blocks for ~5 minutes and the record stays busy until a restart).
  local name=$1 desc=$2 home=$3 uid gid
  if dscl . -read "/Users/$name" UniqueID >/dev/null 2>&1; then
    uid=$(uattr "$name" UniqueID dsAttrTypeStandard:UniqueID)
    [ -n "$uid" ] && [ "$uid" -ge 450 ] && [ "$uid" -le 499 ] || die "$name exists with UID $uid outside 450-499; refusing to use it"
    [ "$(uattr "$name" UserShell dsAttrTypeStandard:UserShell)" = /usr/bin/false ] || die "$name exists with a login shell; refusing to use it"
    [ "$(uattr "$name" NFSHomeDirectory dsAttrTypeStandard:NFSHomeDirectory)" = "$home" ] || warn "$name has a different home folder (the LaunchDaemons set HOME themselves)"
    [ "$(uattr "$name" IsHidden dsAttrTypeNative:IsHidden)" = 1 ] || warn "$name is not hidden"
    case "$(uattr "$name" AuthenticationAuthority dsAttrTypeStandard:AuthenticationAuthority)" in
      *DisabledUser*) say "$name is locked (no login) from an earlier uninstall; daemons still run as it" ;;
    esac
  else
    uid=$(free_id) || die "no free UID in 450-499"
    gid=$uid
    if dscl . -read "/Groups/$name" PrimaryGroupID >/dev/null 2>&1; then gid=$(dscl . -read "/Groups/$name" PrimaryGroupID | awk '{print $2}'); fi
    dscl . -create "/Users/$name" || die "could not create $name"
    dscl . -create "/Users/$name" UniqueID "$uid"
    dscl . -create "/Users/$name" PrimaryGroupID "$gid"
    dscl . -create "/Users/$name" UserShell /usr/bin/false
    dscl . -create "/Users/$name" NFSHomeDirectory "$home"
    dscl . -create "/Users/$name" RealName "$desc"
    dscl . -create "/Users/$name" IsHidden 1
    dscl . -create "/Users/$name" Password '*'
    say "created role account $name ($uid)"
  fi
  gid=$(dscl . -read "/Users/$name" PrimaryGroupID | awk '{print $2}')
  if ! dscl . -read "/Groups/$name" PrimaryGroupID >/dev/null 2>&1; then
    if used_ids | grep -qx "$gid" && ! dscl . -list /Users PrimaryGroupID | awk -v n="$name" '$1 == n {print $2}' | grep -qx "$gid"; then die "GID $gid of $name is taken by another group"; fi
    dseditgroup -o create -i "$gid" -r "$desc" "$name" || die "could not create group $name"
  fi
  [ "$(dscl . -read "/Groups/$name" PrimaryGroupID | awk '{print $2}')" = "$gid" ] || die "group $name does not have GID $gid"
  # explicit member too (checkmember answers yes through the primary group alone)
  dscl . -read "/Groups/$name" GroupMembership 2>/dev/null | grep -qw -- "$name" || dseditgroup -o edit -a "$name" -t user "$name" >/dev/null 2>&1 || warn "could not add $name to group $name"
}
ensure_account "$SRV_USER" "$PRODUCT_NAME server ($ID)" "$BASE/data"
ensure_account "$AGT_USER" "$PRODUCT_NAME AI engine ($ID)" "$BASE/agent/home"
SRV_UID=$(id -u "$SRV_USER"); AGT_UID=$(id -u "$AGT_USER")
SRV_GRP=$(id -gn "$SRV_USER"); AGT_GRP=$(id -gn "$AGT_USER")
say "accounts: $SRV_USER=$SRV_UID:$SRV_GRP $AGT_USER=$AGT_UID:$AGT_GRP"

# ---- repair run: stop our daemons and every process of the role accounts before touching their folders ----
for d in server launcher; do
  launchctl bootout "system/$LABEL.$d" >/dev/null 2>&1 || true
done
for u in "$SRV_UID" "$AGT_UID"; do
  # anything run as the account (sudo -u, e.g. the admin commands) gets a per-user launchd domain whose agents
  # (distnoted) launchd starts again after a kill: end the domain first
  launchctl bootout "user/$u" >/dev/null 2>&1 || true
  for i in 1 2 3 4 5; do
    pkill -KILL -u "$u" >/dev/null 2>&1 || true
    pgrep -u "$u" >/dev/null 2>&1 || break
    sleep 0.2
  done
  ! pgrep -u "$u" >/dev/null 2>&1 || die "processes of uid $u keep running; stop them and run the installer again"
done

# ---- safe paths and files: nolink / mk / put (scripts/macos/safe-fs.sh, tested in tests/unit/g-scripts.test.ts) ----
SAFE_ROOTS=("$BASE" "$LOGS")
# shellcheck source=macos/safe-fs.sh
. "$(cd "$(dirname "$0")" && pwd)/macos/safe-fs.sh"
mk root wheel 755 "$BASE"
ITMP="$BASE/.install-tmp"
rm -rf "$ITMP"; mkdir -m 700 "$ITMP"; chown root:wheel "$ITMP"
trap 'rm -rf "$ITMP"' EXIT
mk "$SRV_USER" "$SRV_GRP" 755 "$BASE/app"
mk "$SRV_USER" "$SRV_GRP" 755 "$BASE/app/versions"
mk "$SRV_USER" "$AGT_GRP" 750 "$BASE/app/engines"
# data and team folder kept by an earlier uninstall: it gave them to root (so no deleted uid owns them), and the server
# account cannot open its own database until they are its again. Folders and single-link files only (a hard link a
# role account made to some other file must not be chowned), and only what root or no account owns.
for d in data team; do
  if [ -d "$BASE/$d" ] && [ ! -L "$BASE/$d" ] && [ "$(stat -f %Su "$BASE/$d")" != "$SRV_USER" ]; then
    find "$BASE/$d" \( -type d -o \( -type f -links 1 \) \) \( -user root -o -nouser \) -exec chown -h "$SRV_USER:$SRV_GRP" {} +
    say "gave the kept $d/ folder back to $SRV_USER"
  fi
done
mk "$SRV_USER" "$SRV_GRP" 700 "$BASE/data"
mk "$SRV_USER" "$SRV_GRP" 700 "$BASE/team"
mk "$SRV_USER" "$SRV_GRP" 700 "$BASE/config"
mk "$SRV_USER" "$SRV_GRP" 700 "$BASE/secrets"
mk "$SRV_USER" admin 750 "$BASE/setup"
mk "$SRV_USER" admin 750 "$BASE/status"
mk "$AGT_USER" "$AGT_GRP" 700 "$BASE/agent"
mk root wheel 555 "$BASE/agent/home"
# the engine account's own Codex login (auth.json, written by `admin.js codex-login` through the launcher); one place
# for the launcher (--codex-auth-dir), the server CLI and the diagnostics. A reinstall keeps the login.
mk "$AGT_USER" "$AGT_GRP" 700 "$BASE/agent/codex-auth"
mk root wheel 755 "$BASE/run"
mk "$SRV_USER" "$AGT_GRP" 750 "$BASE/run/tools"
# the launcher (engine account) creates launcher.sock itself; group = server group, so only the server can connect.
# (launchd socket activation with a root-owned folder needs launch_activate_socket in the launcher: later.)
mk "$AGT_USER" "$SRV_GRP" 750 "$BASE/run-launcher"
mk root wheel 755 "$BASE/root"
# logs: root-owned top folder (launchd and newsyslog work in crash/ as root, so no role account may own a folder on the
# way there); 755 because launchd opens the launcher's output (crash/launcher.log) as the engine account. The
# server's own logs and update.log (written by the bootstrap, which runs as the server account) are in server/.
mk root wheel 755 "$LOGS"
mk root wheel 755 "$LOGS/crash"
mk "$SRV_USER" admin 750 "$LOGS/server"
for f in server:"$SRV_USER":admin:640 launcher:"$AGT_USER":"$AGT_GRP":600 pf:root:wheel:644; do
  IFS=: read -r n o g m <<< "$f"
  [ -L "$LOGS/crash/$n.log" ] && rm -f "$LOGS/crash/$n.log"
  touch "$LOGS/crash/$n.log"; chown -h "$o:$g" "$LOGS/crash/$n.log"; chmod -h "$m" "$LOGS/crash/$n.log"
done

# root runs only the bun (and admin.js) of the bundle it installs, never app/'s (the server account can replace those),
# and from the root-only staging folder with no environment of its own: bun reads bunfig.toml (whose "preload" runs
# any file) and .env from the current folder, and BUN_OPTIONS adds arguments, so an installer started from /tmp or
# /Users/Shared would otherwise run as root whatever another account left there
BUN="$BUNDLE/bin/bun"
ADMIN_JS="$BUNDLE/server/src/admin.js"
[ -x "$BUN" ] || die "$BUN missing"
rootbun() { (cd "$ITMP" && for v in $(compgen -e); do case "$v" in BUN_*|NODE_*) unset "$v" ;; esac; done && HOME="$ITMP" XDG_CONFIG_HOME="$ITMP" exec "$BUN" "$@"); }

# ---- root-owned files ----
# root/VERSION names the bundle the root programs came from. An older bundle (an old setup package run again, e.g. to
# repair after in-app updates) leaves newer ones in place: the launcher, the sandbox profile and the bootstrap only move
# forward, since security fixes land there and in-app updates never touch them. To really go back: uninstall (the
# data is kept) and install the older package.
ROOT_V=$(tr -d '[:space:]' 2>/dev/null < "$BASE/root/VERSION" || true)
ROOT_KEEP=0
if [[ "$ROOT_V" =~ ^[0-9A-Za-z][0-9A-Za-z.+_-]{0,49}$ ]] && [ "$(rootbun "$ADMIN_JS" compare-versions "$ROOT_V" "$VERSION")" = 1 ]; then
  ROOT_KEEP=1
  warn "the root programs (bootstrap, launcher, sandbox profile, account tool) stay at $ROOT_V, newer than this bundle ($VERSION); to go back, uninstall (the data is kept) and install $VERSION"
fi
rootfile() {  # mode name
  if [ "$ROOT_KEEP" = 1 ] && [ -f "$BASE/root/$2" ] && [ ! -L "$BASE/root/$2" ]; then return 0; fi
  install -o root -g wheel -m "$1" "$FROM/root/$2" "$BASE/root/$2" || die "installing root/$2 failed"
}
rootfile 755 mycel-bootstrap
rootfile 755 mycel-launcher
rootfile 644 engine.sb
rootfile 755 pf-load
rootfile 755 mycel-account
# the owner's Claude subscription token goes in with this (pbpaste | sudo root/set-claude-token; docs/INSTALL.md 2.4)
rootfile 755 set-claude-token
rootfile 644 safe-fs.sh
if [ "$ROOT_KEEP" = 0 ]; then
  printf '%s\n' "$VERSION" > "$ITMP/root-version"
  install -o root -g wheel -m 644 "$ITMP/root-version" "$BASE/root/VERSION"
fi
TMPF=$(mktemp)
cat > "$TMPF" <<EOF
# $PRODUCT_NAME ($ID) engine firewall, loaded into anchor "$ANCHOR" by root/pf-load. Generated by install-macos.sh.
# The engine account may reach only the local model proxy; everything else (other localhost ports such as the
# server API, the office network, the internet, IPv4 and IPv6) is dropped. The tools socket is a Unix socket.
pass out quick proto tcp from any to 127.0.0.1 port $PROXY_PORT user $AGT_USER keep state
block drop out quick user $AGT_USER
EOF
pfctl -n -a "$ANCHOR" -f "$TMPF" >/dev/null 2>&1 || { rm -f "$TMPF"; die "pf rules do not parse"; }
install -o root -g wheel -m 644 "$TMPF" "$BASE/root/pf.anchor"; rm -f "$TMPF"

# ---- engines: app/engines/<name>/<sha12>/<name>, current -> <sha12>; claude -> engine.claudeBin, codex -> codexBin ----
# (the file is named after the engine, not the source: Claude Code's own file is called after its version, 2.1.305)
CLAUDE_CMD="" CODEX_CMD=""
for name in claude codex; do
  if [ "$name" = claude ]; then src=$CLAUDE_SRC; else src=$CODEX_SRC; fi
  cmd="$BASE/app/engines/$name/current/$name"
  if [ -n "$src" ]; then
    sha=$(shasum -a 256 "$src" | cut -c1-12)
    dir="$BASE/app/engines/$name/$sha"
    mk "$SRV_USER" "$AGT_GRP" 750 "$BASE/app/engines/$name"
    mk "$SRV_USER" "$AGT_GRP" 750 "$dir"
    put "$src" "$SRV_USER" "$AGT_GRP" 750 "$dir/$name"
    rm -rf "$BASE/app/engines/$name/current"
    ln -s "$sha" "$BASE/app/engines/$name/current"
    chown -h "$SRV_USER:$AGT_GRP" "$BASE/app/engines/$name/current"
    say "engine $name: $src ($sha)"
  else
    # installed earlier and not named this time: keep it when it is still in place
    t=$(readlink "$BASE/app/engines/$name/current" 2>/dev/null || true)
    if [[ "$t" =~ ^[0-9a-f]{12}$ ]] && [ ! -L "$BASE/app/engines/$name" ] && [ -f "$BASE/app/engines/$name/$t/$name" ] && [ ! -L "$BASE/app/engines/$name/$t/$name" ]; then
      say "engine $name: keeping the one installed earlier ($t)"
    else
      cmd=""
    fi
  fi
  if [ "$name" = claude ]; then CLAUDE_CMD=$cmd; else CODEX_CMD=$cmd; fi
  if [ "$name" = codex ] && [ -n "$cmd" ]; then
    # locked model catalog next to it (server account owns it, the engine account only reads it): no shell, no
    # code mode, no apply_patch for any model (design tab 2). Codex refuses turns without it (diagnostics say so).
    dir="$BASE/app/engines/codex/$(readlink "$BASE/app/engines/codex/current")"
    # (a Codex kept from an earlier run keeps its catalog unless --codex-models names a new one)
    msrc=$CODEX_MODELS
    if [ -z "$msrc" ] && [ -n "$src" ] && [[ "${SUDO_USER:-}" =~ ^[A-Za-z0-9._-]+$ ]]; then
      h=$(dscl . -read "/Users/$SUDO_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
      [ -n "$h" ] && msrc="$h/.codex/models_cache.json"
    fi
    if [ -n "$msrc" ] && [ -f "$msrc" ] && [ ! -L "$msrc" ]; then
      rm -f "$ITMP/model_catalog.json"
      cp "$msrc" "$ITMP/models_cache.json"
      rootbun "$(cd "$(dirname "$0")" && pwd)/macos/codex-catalog.mjs" "$ITMP/models_cache.json" "$ITMP/model_catalog.json" >/dev/null || die "could not lock the Codex model catalog from $msrc"
      put "$ITMP/model_catalog.json" "$SRV_USER" "$AGT_GRP" 640 "$dir/model_catalog.json"
      rm -f "$ITMP/model_catalog.json" "$ITMP/models_cache.json"
    elif [ ! -f "$dir/model_catalog.json" ]; then
      warn "no Codex model catalog (pass --codex-models <models_cache.json of this Codex version>); Codex turns stay off until there is one"
    fi
  fi
done
[ -n "$CLAUDE_CMD$CODEX_CMD" ] || die "no engine: give --engine claude=<Claude Code executable> and/or --engine codex=<Codex CLI executable>"
ENGINE_CMDS=()
[ -n "$CLAUDE_CMD" ] && ENGINE_CMDS+=("$CLAUDE_CMD")
[ -n "$CODEX_CMD" ] && ENGINE_CMDS+=("$CODEX_CMD")

# ---- server version ----
DEST="$BASE/app/versions/$VERSION"
nolink "$DEST"
# always a fresh copy from the bundle: the chown below must only ever touch files root just copied (a folder the
# server account could write may hold hard links to system files, and chown -R would hand those over)
rm -rf "$DEST.partial"; cp -R "$BUNDLE" "$DEST.partial"
chown -R "$SRV_USER:$SRV_GRP" "$DEST.partial"
find "$DEST.partial" -type d -exec chmod 755 {} +
chmod -R go-w "$DEST.partial"
rm -rf "$DEST"; mv "$DEST.partial" "$DEST"
# ---- app/current and state.json (server/src/system/install-plan.ts): init | repair | switch (newer) | older ----
CUR_T=$(readlink "$BASE/app/current" 2>/dev/null || true)
CUR=""
if [[ "$CUR_T" =~ ^versions/([0-9A-Za-z][0-9A-Za-z.+_-]{0,49})$ ]] && [ -L "$BASE/app/current" ] && [ -f "$BASE/app/$CUR_T/manifest.json" ]; then
  CUR=${BASH_REMATCH[1]}
fi
if [ -f "$BASE/app/state.json" ] && [ ! -L "$BASE/app/state.json" ] && [ "$(stat -f %l "$BASE/app/state.json")" = 1 ]; then
  cp "$BASE/app/state.json" "$ITMP/state.old.json"
else
  echo null > "$ITMP/state.old.json"
fi
ACTION=$(rootbun "$ADMIN_JS" install-state --current "$CUR" --version "$VERSION" --state "$ITMP/state.old.json" --out "$ITMP/state.json") \
  || die "planning app/current failed"
case "$ACTION" in
  init|switch)
    rm -rf "$BASE/app/current"
    ln -s "versions/$VERSION" "$BASE/app/current"
    chown -h "$SRV_USER:$SRV_GRP" "$BASE/app/current"
    RUNNING=$VERSION
    [ "$ACTION" = switch ] && say "switching $CUR -> $VERSION ($CUR stays for roll-back; the server goes back to it by itself if $VERSION does not start)"
    ;;
  repair) RUNNING=$CUR ;;
  older)
    RUNNING=$CUR
    warn "this bundle ($VERSION) is older than the installed $CUR, so $CUR keeps running; $VERSION is staged in app/versions (switch to it on purpose as the server account: admin.js switch $VERSION --restart)"
    ;;
  *) die "unexpected plan: $ACTION" ;;
esac
put "$ITMP/state.json" "$SRV_USER" "$SRV_GRP" 640 "$BASE/app/state.json"

# ---- office-network TLS certificate: every LAN address + <LocalHostName>.local (server/src/system/lan-cert.ts) ----
# Made or kept by the bundle's admin.js in the root-only staging folder, then put in place. The server checks it again
# every minute and renews it itself when an address is not covered (new Wi-Fi, DHCP lease) or it is about to expire.
# Only regular, single-link files the server account owns are taken over (never a link it planted to another file).
if [ "$TLS_PORT" != 0 ]; then
  for f in lan-tls.key lan-tls.crt; do
    if [ -f "$BASE/secrets/$f" ] && [ ! -L "$BASE/secrets/$f" ] && [ "$(stat -f '%l:%Su' "$BASE/secrets/$f")" = "1:$SRV_USER" ]; then
      cp "$BASE/secrets/$f" "$ITMP/$f"
    fi
  done
  rootbun "$ADMIN_JS" lan-cert --cert "$ITMP/lan-tls.crt" --key "$ITMP/lan-tls.key" --fingerprint "$ITMP/lan-cert.sha256" > "$ITMP/lan-cert.json" \
    || die "making the office TLS certificate failed"
  put "$ITMP/lan-tls.key" "$SRV_USER" "$SRV_GRP" 600 "$BASE/secrets/lan-tls.key"
  put "$ITMP/lan-tls.crt" "$SRV_USER" "$SRV_GRP" 644 "$BASE/secrets/lan-tls.crt"
  put "$ITMP/lan-cert.sha256" "$SRV_USER" admin 640 "$BASE/setup/lan-cert.sha256"
  grep -q '"changed":true' "$ITMP/lan-cert.json" && say "office TLS certificate: new ($(tr -d '\n' < "$ITMP/lan-cert.sha256"))"
fi

# ---- config/server.json (merged: owner choices such as relay and update channel survive a reinstall) ----
CFG="$BASE/config/server.json"
OLD_CFG="$ITMP/server.old.json"
if [ -f "$CFG" ] && [ ! -L "$CFG" ]; then cp "$CFG" "$OLD_CFG"; else echo '{}' > "$OLD_CFG"; fi
MYCEL_I_OLD="$OLD_CFG" MYCEL_I_OUT="$ITMP/server.json" MYCEL_I_BASE="$BASE" MYCEL_I_LOGS="$LOGS/server" MYCEL_I_PORT="$PORT" MYCEL_I_TLS="$TLS_PORT" \
MYCEL_I_AGT_UID="$AGT_UID" MYCEL_I_CLAUDE="$CLAUDE_CMD" MYCEL_I_CODEX="$CODEX_CMD" MYCEL_I_PROXY_PORT="$PROXY_PORT" rootbun -e '
const fs = require("fs"), e = process.env, b = e.MYCEL_I_BASE
let old = {}; try { old = JSON.parse(fs.readFileSync(e.MYCEL_I_OLD, "utf8")) } catch {}
if (!old || typeof old !== "object" || Array.isArray(old)) old = {}
// engine paths are the installed engines only (an older install named any file, or the wrong key for codex)
const { claudeBin: _c, codexBin: _x, ...engineOld } = old.engine && typeof old.engine === "object" ? old.engine : {}
const cfg = {
  ...old,
  mode: "prod",
  listen: { host: "127.0.0.1", port: Number(e.MYCEL_I_PORT) },
  tls: e.MYCEL_I_TLS === "0" ? null : { port: Number(e.MYCEL_I_TLS), certFile: b + "/secrets/lan-tls.crt", keyFile: b + "/secrets/lan-tls.key", managed: true },
  teamRoot: b + "/team", dataDir: b + "/data", logDir: e.MYCEL_I_LOGS,
  // subscription: the engine account talks to the model proxy (127.0.0.1:proxyPort, the only address pf allows it),
  // which adds the owner token from secrets/claude-oauth-token and tunnels Codex HTTPS. Earlier installers wrote
  // "proxy" (company key, which the server refuses), so that value is replaced too; a hand-set "local-login" is kept.
  engine: { ...engineOld, authMode: old.engine?.authMode === "local-login" ? "local-login" : "subscription",
    ...(e.MYCEL_I_CLAUDE ? { claudeBin: e.MYCEL_I_CLAUDE } : {}), ...(e.MYCEL_I_CODEX ? { codexBin: e.MYCEL_I_CODEX } : {}),
    proxyPort: Number(e.MYCEL_I_PROXY_PORT),
    runDir: b + "/run/tools", agentRoot: b + "/agent", launcherSock: b + "/run-launcher/launcher.sock", agentUid: Number(e.MYCEL_I_AGT_UID) },
  relay: old.relay ?? { url: null, teamName: null },
  update: old.update ?? { channel: "stable", feedUrl: null },
}
fs.writeFileSync(e.MYCEL_I_OUT, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 })
' || die "writing $CFG failed"
put "$ITMP/server.json" "$SRV_USER" "$SRV_GRP" 600 "$CFG"

# ---- one-time setup code while the team has no account: setup/code for the Mac administrator
# (sudo cat "<base>/setup/code"), data/setup-token for the server, which deletes it once the first account exists.
# A reinstall over data kept by an uninstall before anyone set the team up (setup/ is gone, data/setup-token is not)
# gets a new code too. ----
if [ ! -f "$BASE/setup/code" ] && { [ ! -f "$BASE/data/app.db" ] || [ -e "$BASE/data/setup-token" ]; }; then
  CODE=$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=\n')
  (umask 077 && printf '%s\n' "$CODE" > "$ITMP/code")
  put "$ITMP/code" "$SRV_USER" admin 640 "$BASE/setup/code"
  put "$ITMP/code" "$SRV_USER" "$SRV_GRP" 600 "$BASE/data/setup-token"
  rm -f "$ITMP/code"
  unset CODE
fi

# ---- LaunchDaemons ----
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
args_xml() { local a; for a in "$@"; do printf '    <string>%s</string>\n' "$(xml "$a")"; done; }
BOOT_ARGS=("$BASE/root/mycel-bootstrap" --app "$BASE/app" --config "$CFG" --update-log "$LOGS/server/update.log")
[ "$ALLOW_UNSIGNED" = 1 ] && BOOT_ARGS+=(--allow-unsigned)
LAUNCH_ARGS=("$BASE/root/mycel-launcher" --listen "$BASE/run-launcher/launcher.sock" --mode 0660 --agent-root "$BASE/agent"
  --bridge "$BASE/app/current/native/mycel-bridge" --tools-sock "$BASE/run/tools/tools.sock" --server-uid "$SRV_UID"
  --dedicated-account --sandbox-profile "$BASE/root/engine.sb" --proxy-port "$PROXY_PORT"
  --codex-auth-dir "$BASE/agent/codex-auth")
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
# $PRODUCT_NAME ($ID) launchd output (start failures only). logfilename [owner:group] mode count size(KB) when flags
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

# a switch to a newer version: the bootstrap gives it 120 s (or 3 crashes) to answer before it goes back to $CUR
WAIT=60; [ "$ACTION" = switch ] && WAIT=180
say "waiting for the server on 127.0.0.1:$PORT ($RUNNING)"
done_ok() {
  say "installed $ID $RUNNING (server $SRV_USER, engine $AGT_USER)"
  [ -f "$BASE/setup/code" ] && [ -e "$BASE/data/setup-token" ] && say "first-run setup: open http://127.0.0.1:$PORT/setup?token=<code> on this Mac; the code: sudo cat \"$BASE/setup/code\""
  say "owner password recovery: sudo \"$BASE/root/mycel-account\" reset-link"
  [ ${#WARNINGS[@]} -eq 0 ] || { say "with ${#WARNINGS[@]} warning(s):"; printf '  %s\n' "${WARNINGS[@]}"; }
  exit 0
}
for i in $(seq 1 "$WAIT"); do
  H=$(curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)
  if [ -n "$H" ]; then
    case "$H" in
      *"\"version\":\"$RUNNING\""*) done_ok ;;
      *)
        GOT=$(printf '%s' "$H" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
        [ "$ACTION" = switch ] && die "$VERSION did not become healthy, so the server went back to ${GOT:-the previous version}; see $LOGS/server/update.log and $LOGS/crash/server.log"
        warn "the server answers as version ${GOT:-?}, not $RUNNING (an update was pending?)"
        done_ok
        ;;
    esac
  fi
  sleep 1
done
die "the server did not answer within $WAIT s; see $LOGS/crash/server.log"

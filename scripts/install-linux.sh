#!/bin/bash
# Team server installer for Linux (linux-runtime spec 3.5; the Linux sibling of scripts/install-macos.sh). The same kit
# installs Team AX Cloud tenants (--hosted) and self-hosted servers. Idempotent: running it again repairs the install.
#
#   sudo ./install-linux.sh install   --from <kit> [--engine claude[=FILE]] [--engine codex[=FILE]] [options]
#   sudo ./install-linux.sh update    --from <newer kit>          (= install; switches app/current to the new version)
#   sudo ./install-linux.sh repair    [--from <kit>]              (install again with the arguments in root/install.json)
#   sudo ./install-linux.sh uninstall [--purge] [--keep-logins]   (default: the team folder, data and config stay)
#        ./install-linux.sh check     --from <kit> [...]          (no root: checks the system and the kit, changes nothing)
#
#   --from DIR            the unpacked kit (TeamAX-server-<v>-linux-<arch>.tar.gz): VERSION, app/<v>/ (+ this script)
#   --engine NAME[=FILE]  NAME is claude (Claude Code) or codex (Codex CLI), each at most once. Without FILE the pinned
#                         release (app/<v>/engines.lock.json) is downloaded from its official address and its SHA-256
#                         checked; hosted tenants copy it from the host's read-only cache /var/cache/mycel-engines.
#                         With FILE that ELF executable is used (version checked against the pin: hosted refuses a
#                         different one, self-install warns). An engine installed earlier and not named stays.
#   --id ID               product id: /var/lib/<id>, unit names <id>-*.service, nft table inet <id> (default mycel)
#   --server-user NAME    server account (default axserver; required with a non-default --id)
#   --agent-user NAME     engine account (default axagent; required with a non-default --id)
#   --port N              server HTTP port on 127.0.0.1 (default 47820)
#   --proxy-port N        local model proxy port, the engine account's only network path (default 47821)
#   --tls-port N          direct TLS port for an office network (default 0 = off)
#   --hosted              Team AX Cloud tenant: stricter checks (Landlock ABI >= 6, cgroup delegation, ptrace_scope),
#                         deployment "hosted", no automatic updates (the control plane runs mycel-ctl update)
#   --plan FILE           plan.json for this tenant (mycel-ctl apply-plan; spec 3.8.5)
#   --codex-models FILE   with --engine codex: models_cache.json of that Codex version, locked into model_catalog.json
#   --allow-unsigned      accept kits without a release signature (development and test builds)
#   --no-auto-update      self-install: do not enable the daily root-level update timer
#   --public-host HOST    the team's public address https://HOST (server.json tunnel.host), for example a Cloudflare
#                         Tunnel that delivers it to 127.0.0.1:<port> (the tunnel itself is set up apart from this
#                         installer). "none" removes it. Kept for repair / update; earlier allowFrom / countries stay.
#   --app-connectors      let people connect their own Claude to this server (remote MCP with OAuth) at
#                         https://<public host> (server.json appConnectors). Needs a public host. --no-app-connectors
#                         turns it off. Kept for repair / update.
#   --google-drive-client FILE  install the Google OAuth web client for personal Google Drive (docs/GOOGLE-DRIVE.md)
#                         as secrets/integrations/google-drive/client.json. FILE is the JSON that Google Cloud
#                         downloads ({"web": {...}}) or {"clientId", "clientSecret", "redirectUri"}. The redirect URI
#                         must be https://<public host>/api/integrations/google-drive/callback. Not kept: repair and
#                         update leave the installed file as it is.
#   --skip-apt            do not install distribution packages (they must already be there)
#   --no-systemd          no systemd here (a test container): write everything but the units and print how to run
#                         `mycel-ctl supervise` instead (not supported for real use)
#   uninstall: --purge also deletes the data, the team folder and the accounts; --keep-logins keeps agent/codex-auth
#
# Root never trusts what the role accounts can change (the macOS installer's principle): every process of both
# accounts is stopped before their folders are touched; every path it writes below the install folder is checked for
# symbolic links (scripts/linux/safe-fs.sh); files that land in folders the server owns are written in a root-only
# folder, owned and moded there, and renamed into place; the only programs it runs as root come from the kit it
# installs (--from) or the system. It never runs anything from app/, data/ or the team folder as root; the engine's
# version check runs as the engine account inside bwrap without network.
set -euo pipefail
umask 022
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C
shopt -u patsub_replacement 2>/dev/null || true

# (the release public key, spec D12, is built into mycel-ctl: verify-bundle checks with it and render-units gives it
# to the bootstrap as --pubkey; the feed comes from the kit's product.env, see RELEASE_FEED below)
ENGINE_CACHE=/var/cache/mycel-engines

CMD=${1:-}
case "$CMD" in
  install|update|repair|uninstall|check) shift ;;
  -h|--help|"") awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
  *) echo "install: unknown command $CMD (install, update, repair, uninstall, check)" >&2; exit 2 ;;
esac

ID=mycel SRV_USER="" AGT_USER="" PORT=47820 PROXY_PORT=47821 TLS_PORT=0
FROM="" HOSTED=0 PLAN="" CODEX_MODELS="" ALLOW_UNSIGNED=0 AUTO_UPDATE=1 SKIP_APT=0 SYSTEMD=1 PURGE=0 KEEP_LOGINS=0
PUBLIC_HOST="" APP_CONNECTORS="" DRIVE_CLIENT=""   # "" = not given: keep what server.json has
ENGINES=()
SET=()   # options given on the command line (repair/update keep the rest from install.json)
WARNINGS=()
die() { echo "install: $*" >&2; exit 1; }
say() { echo "install: $*"; }
warn() { WARNINGS+=("$*"); echo "install: warning: $*" >&2; }
val() { [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --from) val "$@"; FROM=$2; shift 2 ;;
    --id) val "$@"; ID=$2; SET+=(id); shift 2 ;;
    --server-user) val "$@"; SRV_USER=$2; SET+=(srv); shift 2 ;;
    --agent-user) val "$@"; AGT_USER=$2; SET+=(agt); shift 2 ;;
    --port) val "$@"; PORT=$2; SET+=(port); shift 2 ;;
    --proxy-port) val "$@"; PROXY_PORT=$2; SET+=(proxy); shift 2 ;;
    --tls-port) val "$@"; TLS_PORT=$2; SET+=(tls); shift 2 ;;
    --engine) val "$@"; ENGINES+=("$2"); shift 2 ;;
    --hosted) HOSTED=1; SET+=(hosted); shift ;;
    --plan) val "$@"; PLAN=$2; shift 2 ;;
    --codex-models) val "$@"; CODEX_MODELS=$2; shift 2 ;;
    --allow-unsigned) ALLOW_UNSIGNED=1; SET+=(unsigned); shift ;;
    --no-auto-update) AUTO_UPDATE=0; SET+=(noauto); shift ;;
    --public-host) val "$@"; PUBLIC_HOST=$2; SET+=(pubhost); shift 2 ;;
    --app-connectors) APP_CONNECTORS=1; SET+=(appconn); shift ;;
    --no-app-connectors) APP_CONNECTORS=0; SET+=(appconn); shift ;;
    --google-drive-client) val "$@"; DRIVE_CLIENT=$2; shift 2 ;;
    --skip-apt) SKIP_APT=1; shift ;;
    --no-systemd) SYSTEMD=0; SET+=(nosystemd); shift ;;
    --purge) PURGE=1; shift ;;
    --keep-logins) KEEP_LOGINS=1; shift ;;
    -h|--help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done
given() { local s; for s in ${SET[@]+"${SET[@]}"}; do [ "$s" = "$1" ] && return 0; done; return 1; }

[ "$(uname -s)" = Linux ] || die "Linux only (macOS: scripts/install-macos.sh)"
[ "$CMD" = check ] || [ "$(id -u)" = 0 ] || die "run as root (sudo), or \`$0 check --from <kit>\` to only check"
[[ "$ID" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "bad --id (a-z, 0-9 and -, 2-31 characters, starting with a letter)"
BASE="/var/lib/$ID"

# ---- repair / update: the arguments of the earlier install (root/install.json, root-owned) ----
INSTALL_JSON="$BASE/root/install.json"
if [ "$CMD" = repair ] || [ "$CMD" = update ] || [ "$CMD" = uninstall ]; then
  if [ -f "$INSTALL_JSON" ] && [ ! -L "$INSTALL_JSON" ] && [ "$(stat -c %U "$INSTALL_JSON")" = root ]; then
    j() { sed -n "s/^[[:space:]]*\"$1\":[[:space:]]*\"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}[[:space:]]*$/\1/p" "$INSTALL_JSON" | head -n 1; }
    given srv || SRV_USER=$(j serverUser)
    given agt || AGT_USER=$(j agentUser)
    given port || PORT=$(j port)
    given proxy || PROXY_PORT=$(j proxyPort)
    given tls || TLS_PORT=$(j tlsPort)
    given hosted || { [ "$(j hosted)" = true ] && HOSTED=1; }
    given unsigned || { [ "$(j allowUnsigned)" = true ] && ALLOW_UNSIGNED=1; }
    given noauto || { [ "$(j autoUpdate)" = false ] && AUTO_UPDATE=0; }
    given nosystemd || { [ "$(j systemd)" = false ] && SYSTEMD=0; }
    given pubhost || { h=$(j publicHost); [ "$h" = null ] || PUBLIC_HOST=$h; }
    given appconn || case "$(j appConnectors)" in true) APP_CONNECTORS=1 ;; false) APP_CONNECTORS=0 ;; esac
  elif [ "$CMD" != uninstall ]; then
    die "$CMD: no earlier install of $ID ($INSTALL_JSON missing); use install"
  fi
fi
if [ -z "$SRV_USER" ] || [ -z "$AGT_USER" ]; then
  [ "$ID" = mycel ] || die "--id $ID needs --server-user and --agent-user (two system accounts for this install alone)"
  SRV_USER=${SRV_USER:-axserver}; AGT_USER=${AGT_USER:-axagent}
fi
for u in "$SRV_USER" "$AGT_USER"; do [[ "$u" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "account names use a-z, 0-9 and -, starting with a letter: $u"; done
[ "$SRV_USER" != "$AGT_USER" ] || die "server and engine accounts must differ"
for u in "$SRV_USER" "$AGT_USER"; do case "$u" in root|nobody|daemon|bin|sys|www-data) die "$u is a system account of the distribution; choose another name" ;; esac; done
if [ -n "$PUBLIC_HOST" ] && [ "$PUBLIC_HOST" != none ]; then
  # the same rule as server/src/app-config.ts PUBLIC_HOST_RE: a lower-case DNS name, no scheme, port or path
  [[ "$PUBLIC_HOST" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z][a-z0-9-]{0,61}[a-z0-9]$ ]] && [ ${#PUBLIC_HOST} -le 253 ] \
    || die "bad --public-host $PUBLIC_HOST (a lower-case DNS name such as team.example.com, without https:// or a path)"
fi
if [ "$HOSTED" = 1 ] && { [ -n "$PUBLIC_HOST" ] && [ "$PUBLIC_HOST" != none ] || [ "$APP_CONNECTORS" = 1 ] || [ -n "$DRIVE_CLIENT" ]; }; then
  die "--public-host, --app-connectors and --google-drive-client are for self-installs; the hosted service sets its address"
fi
if [ -n "$DRIVE_CLIENT" ]; then
  [ -f "$DRIVE_CLIENT" ] && [ ! -L "$DRIVE_CLIENT" ] || die "--google-drive-client: $DRIVE_CLIENT is not a regular file"
  [ "$(stat -c %s "$DRIVE_CLIENT")" -le 16384 ] || die "--google-drive-client: $DRIVE_CLIENT is larger than 16 KiB"
fi
for p in "$PORT" "$TLS_PORT" "$PROXY_PORT"; do [[ "$p" =~ ^[0-9]{1,5}$ ]] && [ "$p" -le 65535 ] || die "bad port $p"; done
[ "$PORT" != 0 ] && [ "$PROXY_PORT" != 0 ] || die "only --tls-port may be 0 (off)"
[ "$PORT" != "$PROXY_PORT" ] && [ "$PORT" != "$TLS_PORT" ] && [ "$PROXY_PORT" != "$TLS_PORT" ] || die "--port, --tls-port and --proxy-port must differ"
DEPLOYMENT=self; [ "$HOSTED" = 1 ] && DEPLOYMENT=hosted
[ "$HOSTED" = 1 ] && AUTO_UPDATE=0

# the slice of the server and the launcher (mycel-ctl sliceUnit): "-" in a slice name means "inside", so it is written "_".
# An id that is one of systemd's own slices gets none (mycel-ctl ownSlice): writing or stopping system.slice would stop
# every service of the machine. A new install refuses such an id; an older one keeps its units in system.slice, without 1A.
case "$ID" in system|user|machine|capsule) SLICE="" ;; *) SLICE="${ID//-/_}.slice" ;; esac
[ -n "$SLICE" ] || [ "$CMD" != install ] || die "--id $ID is the name of one of systemd's own slices; choose another id"
UNITS=("$ID-firewall.service" "$ID-firewall.timer" "$ID-launcher.service" "$ID-server.service" "$ID-update.service" "$ID-update.timer" ${SLICE:+"$SLICE"})
UNIT_DIR=/etc/systemd/system
have_systemd() { [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; }
stop_units() {
  have_systemd || return 0
  local u
  for u in "$ID-update.timer" "$ID-firewall.timer" "$ID-server.service" "$ID-launcher.service"; do
    systemctl stop "$u" >/dev/null 2>&1 || true
  done
}
kill_accounts() {  # every process of both accounts (repair runs; nothing may race the installer)
  local u uid _
  for u in "$SRV_USER" "$AGT_USER"; do
    uid=$(id -u "$u" 2>/dev/null) || continue
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      pkill -KILL -u "$uid" >/dev/null 2>&1 || true
      pgrep -u "$uid" >/dev/null 2>&1 || break
      sleep 0.2
    done
    ! pgrep -u "$uid" >/dev/null 2>&1 || die "processes of $u keep running; stop them and run the installer again"
  done
}

# =====================================================================================================================
# uninstall
# =====================================================================================================================
if [ "$CMD" = uninstall ]; then
  stop_units
  if have_systemd; then
    for u in "${UNITS[@]}"; do systemctl disable "$u" >/dev/null 2>&1 || true; done
  fi
  for u in "${UNITS[@]}"; do rm -f "$UNIT_DIR/$u"; done
  have_systemd && { systemctl daemon-reload || true; systemctl reset-failed >/dev/null 2>&1 || true; }
  kill_accounts
  # the engine firewall table (the launcher is gone, so nothing runs as the engine account)
  if command -v nft >/dev/null 2>&1; then nft delete table inet "$ID" >/dev/null 2>&1 || true; fi
  KEEP_AUTH=""
  if [ "$KEEP_LOGINS" = 1 ] && [ "$PURGE" = 0 ] && [ -d "$BASE/agent/codex-auth" ] && [ ! -L "$BASE/agent" ] && [ ! -L "$BASE/agent/codex-auth" ]; then
    KEEP_AUTH="$BASE/.codex-auth-kept"
    rm -rf "$KEEP_AUTH"; mv -T "$BASE/agent/codex-auth" "$KEEP_AUTH"
  fi
  rm -rf "$BASE/app" "$BASE/root" "$BASE/run" "$BASE/run-launcher" "$BASE/agent" "$BASE/status" "$BASE/.install-tmp"
  if [ -n "$KEEP_AUTH" ]; then
    mkdir -m 700 "$BASE/agent"; mv -T "$KEEP_AUTH" "$BASE/agent/codex-auth"
    # root-owned until a reinstall gives it back (no deleted uid owns the login)
    find "$BASE/agent" \( -type d -o \( -type f -links 1 \) \) -exec chown -h root:root {} +
    say "kept the engine account's Codex login in $BASE/agent/codex-auth"
  fi
  if [ "$PURGE" = 1 ]; then
    rm -rf "$BASE"
  elif [ -d "$BASE" ]; then
    # folders and single-link files only: a hard link the server account made to some other file must not be chowned
    for d in data team config secrets setup; do
      [ -d "$BASE/$d" ] && [ ! -L "$BASE/$d" ] && find "$BASE/$d" \( -type d -o \( -type f -links 1 \) \) -exec chown -h root:root {} +
    done
    say "kept the team folder, data, config and secrets in $BASE (root-owned now; --purge removes them)"
  fi
  if [ -f "/etc/apparmor.d/$ID-bwrap" ]; then
    command -v apparmor_parser >/dev/null 2>&1 && apparmor_parser -R "/etc/apparmor.d/$ID-bwrap" >/dev/null 2>&1 || true
    rm -f "/etc/apparmor.d/$ID-bwrap"
  fi
  rm -f "/etc/sysctl.d/60-$ID.conf" "/etc/systemd/journald.conf.d/$ID.conf"
  # safe operations 1A's switch (`mycel-ctl safe-ops on`): a later install of this id starts with 1A off. The file's
  # other lines (the administrator's, mycel-enroll's) stay; a file left empty goes.
  DEF="/etc/default/$ID"
  if [ -f "$DEF" ] && [ ! -L "$DEF" ] && grep -q '^[[:space:]]*MYCEL_SAFE_OPS_1A[[:space:]]*=' "$DEF"; then
    grep -v '^[[:space:]]*MYCEL_SAFE_OPS_1A[[:space:]]*=' "$DEF" > "$DEF.mycel-tmp" || true
    if grep -q '[^[:space:]]' "$DEF.mycel-tmp"; then cat "$DEF.mycel-tmp" > "$DEF"; rm -f "$DEF.mycel-tmp"; else rm -f "$DEF" "$DEF.mycel-tmp"; fi
    say "turned safe operations 1A off in $DEF"
  fi
  CTL_LINK=/usr/local/sbin/mycel-ctl; [ "$ID" = mycel ] || CTL_LINK="/usr/local/sbin/$ID-ctl"
  [ -L "$CTL_LINK" ] && case "$(readlink "$CTL_LINK")" in "$BASE"/*) rm -f "$CTL_LINK" ;; esac
  for f in /etc/cron.deny /etc/at.deny; do
    if [ -f "$f" ] && grep -qxE "$AGT_USER|$SRV_USER" "$f"; then grep -vxE "$AGT_USER|$SRV_USER" "$f" > "$f.mycel-tmp" || true; cat "$f.mycel-tmp" > "$f"; rm -f "$f.mycel-tmp"; fi
  done
  for u in "$AGT_USER" "$SRV_USER"; do
    getent passwd "$u" >/dev/null || continue
    if [ "$PURGE" = 1 ]; then
      userdel "$u" >/dev/null 2>&1 || say "could not delete account $u"
      getent group "$u" >/dev/null && { groupdel "$u" >/dev/null 2>&1 || say "could not delete group $u"; }
    else
      usermod -L -e 1 "$u" >/dev/null 2>&1 || say "could not lock account $u"
    fi
  done
  LEFT=()
  for u in "${UNITS[@]}"; do [ -e "$UNIT_DIR/$u" ] && LEFT+=("$UNIT_DIR/$u"); done
  command -v nft >/dev/null 2>&1 && nft list table inet "$ID" >/dev/null 2>&1 && LEFT+=("nft table inet $ID")
  for p in app root run run-launcher agent/home status; do [ -e "$BASE/$p" ] && LEFT+=("$BASE/$p"); done
  [ "$PURGE" = 1 ] && [ -e "$BASE" ] && LEFT+=("$BASE")
  for u in "$SRV_USER" "$AGT_USER"; do pgrep -u "$u" >/dev/null 2>&1 && LEFT+=("processes of $u"); done
  if [ "$PURGE" = 1 ]; then for u in "$SRV_USER" "$AGT_USER"; do getent passwd "$u" >/dev/null && LEFT+=("account $u"); done; fi
  if [ ${#LEFT[@]} -gt 0 ]; then say "left over:"; printf '  %s\n' "${LEFT[@]}"; exit 1; fi
  say "removed $ID"
  exit 0
fi

# =====================================================================================================================
# install / update / repair / check
# =====================================================================================================================
# ---- the kit: repair without --from takes the installed version, copied and verified in a root-only folder ----
ITMP="$BASE/.install-tmp"
RKIT="$BASE/.install-kit"
if [ "$CMD" = repair ] && [ -z "$FROM" ]; then
  [ "$ALLOW_UNSIGNED" = 0 ] || die "repair of an unsigned (--allow-unsigned) install needs --from <kit>: the installed copy is not signed, so root cannot trust it"
  CURV=$(readlink "$BASE/app/current" 2>/dev/null | sed -n 's#^versions/\([0-9A-Za-z][0-9A-Za-z.+_-]*\)$#\1#p')
  [ -n "$CURV" ] || die "repair: app/current names no version; give --from <kit>"
  [ -x "$BASE/root/mycel-ctl" ] && [ "$(stat -c %U "$BASE/root/mycel-ctl")" = root ] || die "repair: root/mycel-ctl missing; give --from <kit>"
  [ ! -L "$BASE" ] && [ ! -L "$BASE/app" ] && [ ! -L "$BASE/app/versions" ] && [ ! -L "$BASE/app/versions/$CURV" ] || die "repair: a link in the install folder; give --from <kit>"
  trap 'rm -rf "$RKIT"' EXIT
  rm -rf "$RKIT"; mkdir -m 700 "$RKIT"
  mkdir -p "$RKIT/app"
  # a root-only copy first: the server account can change app/versions, never this copy (verified, then installed)
  cp -a --no-preserve=ownership "$BASE/app/versions/$CURV" "$RKIT/app/$CURV"
  chown -R root:root "$RKIT"
  "$BASE/root/mycel-ctl" verify-bundle "$RKIT/app/$CURV" >/dev/null || die "repair: the installed version $CURV does not verify against the release key; give --from <kit>"
  printf '%s\n' "$CURV" > "$RKIT/VERSION"
  FROM="$RKIT"
fi
[ -n "$FROM" ] && [ -f "$FROM/VERSION" ] || die "--from must be an unpacked kit folder (VERSION, app/<version>/)"
FROM=$(cd "$FROM" && pwd -P)
VERSION=$(tr -d '[:space:]' < "$FROM/VERSION")
[[ "$VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z.+_-]{0,49}$ ]] || die "bad VERSION"
PRODUCT_NAME=$(sed -n 's/^PRODUCT_NAME=//p' "$FROM/product.env" 2>/dev/null | head -n 1 || true)
[[ "$PRODUCT_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9\ ._-]{0,40}$ ]] || PRODUCT_NAME="Team AX"
# the product's release feed (shared/src/release-channel.ts, written into product.env by build-bundle.ts): a new install
# updates from <feed>/server/<channel>.json. A repair from the installed copy has no product.env: server.json keeps its feed.
RELEASE_FEED=$(sed -n 's/^RELEASE_FEED=//p' "$FROM/product.env" 2>/dev/null | head -n 1 || true)
FEED_BASE=""
if [ -n "$RELEASE_FEED" ]; then
  [[ "$RELEASE_FEED" =~ ^https://[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ ]] || die "product.env: RELEASE_FEED is not an https address"
  FEED_BASE="$RELEASE_FEED/server"
fi
BUNDLE="$FROM/app/$VERSION"
KROOT="$BUNDLE/root"
[ -f "$BUNDLE/manifest.json" ] || die "$BUNDLE/manifest.json missing"
for f in mycel-bootstrap mycel-launcher mycel-sandbox mycel-ctl mycel-account set-claude-token safe-fs.sh apparmor-bwrap.in \
         systemd/firewall.service.in systemd/firewall.timer.in systemd/launcher.service.in systemd/server.service.in \
         systemd/update.service.in systemd/update.timer.in systemd/slice.in; do
  [ -f "$KROOT/$f" ] || die "$KROOT/$f missing (not a Linux kit? bun scripts/build-bundle.ts --os linux)"
done
for f in bin/bun bin/pandoc server/src/main.js server/src/admin.js server/src/account.js server/src/office-worker.js native/mycel-gate native/mycel-bridge native/mycel-safeops; do [ -f "$BUNDLE/$f" ] || die "$BUNDLE/$f missing"; done
if [ "$ALLOW_UNSIGNED" = 0 ] && [ ! -f "$BUNDLE/manifest.sig" ]; then die "the kit is not signed (use --allow-unsigned for development builds)"; fi

# ---- 1) system checks (also `check`) ----
# (read in a subshell: os-release sets ID and VERSION, names this script uses for the product id and the kit version)
[ -r /etc/os-release ] || die "/etc/os-release missing"
OSID=$(. /etc/os-release && echo "${ID:-}"); OSVER=$(. /etc/os-release && echo "${VERSION_ID:-}")
OS_OK=0
case "$OSID:$OSVER" in debian:12|debian:13|ubuntu:24.04) OS_OK=1 ;; esac
[ "$OS_OK" = 1 ] || die "unsupported system $OSID $OSVER: Debian 12/13 or Ubuntu 24.04 only (spec 1)"
MACH=$(uname -m)
case "$MACH" in x86_64) ARCH=amd64 ;; aarch64) ARCH=arm64 ;; *) die "unsupported processor $MACH (x86_64 or aarch64)" ;; esac
if [ "$ARCH" = amd64 ] && ! grep -qw sse4_2 /proc/cpuinfo; then die "this x86_64 processor has no SSE4.2 (bun and Claude Code need it; in a VM use CPU type x86-64-v2 or host)"; fi
if [ "$SYSTEMD" = 1 ] && ! have_systemd; then die "no systemd here; use --no-systemd (test containers only)"; fi
[ "$(stat -fc %T /sys/fs/cgroup 2>/dev/null)" = cgroup2fs ] || die "cgroup v2 (unified) is required; /sys/fs/cgroup is $(stat -fc %T /sys/fs/cgroup 2>/dev/null || echo missing)"

# ---- 2) the kit's programs are ELF for this processor; the kit verifies (manifest + release signature) ----
# (read from the ELF header itself: file(1) may not be installed yet) machine 0x3e = x86-64, 0xb7 = aarch64
elf_arch() {
  local magic cls mach
  magic=$(od -An -tx1 -N4 "$1" 2>/dev/null | tr -d ' \n')
  [ "$magic" = 7f454c46 ] || { echo none; return; }
  cls=$(od -An -tx1 -j4 -N1 "$1" | tr -d ' \n')
  mach=$(od -An -tx1 -j18 -N2 "$1" | tr -d ' \n')
  [ "$cls" = 02 ] || { echo elf32; return; }
  case "$mach" in 3e00) echo amd64 ;; b700) echo arm64 ;; *) echo "elf-$mach" ;; esac
}
for f in "$BUNDLE/bin/bun" "$BUNDLE/native/mycel-gate" "$BUNDLE/native/mycel-bridge" "$KROOT/mycel-bootstrap" "$KROOT/mycel-launcher" "$KROOT/mycel-sandbox" "$KROOT/mycel-ctl"; do
  a=$(elf_arch "$f")
  [ "$a" = "$ARCH" ] || die "${f#"$FROM"/} is $a, this server is $ARCH: use the $ARCH kit"
done
CTL_KIT="$KROOT/mycel-ctl"
VERIFY_ARGS=(); [ "$ALLOW_UNSIGNED" = 1 ] && VERIFY_ARGS+=(--allow-unsigned)
if ! VOUT=$("$CTL_KIT" verify-bundle "$BUNDLE" ${VERIFY_ARGS[@]+"${VERIFY_ARGS[@]}"} 2>&1); then
  die "the kit does not verify: $(printf '%s' "$VOUT" | tail -n 3 | tr '\n' ' ')"
fi
PREFLIGHT_ARGS=(--json); [ "$HOSTED" = 1 ] && PREFLIGHT_ARGS+=(--hosted)

# engines.lock.json: the pinned engine releases (read with the kit's bun as a plain JSON reader, no install folder)
LOCK="$BUNDLE/engines.lock.json"
lockget() {  # name field -> value for this arch (field: url sha256 size member version modelCatalog)
  [ -f "$LOCK" ] || return 0
  MYCEL_L="$LOCK" MYCEL_N="$1" MYCEL_F="$2" MYCEL_A="linux-$ARCH" kitbun -e '
const e = process.env; let j; try { j = JSON.parse(require("fs").readFileSync(e.MYCEL_L, "utf8")) } catch { process.exit(0) }
const n = j?.[e.MYCEL_N]; if (!n) process.exit(0)
const v = e.MYCEL_F === "version" || e.MYCEL_F === "modelCatalog" ? n[e.MYCEL_F] : n[e.MYCEL_A]?.[e.MYCEL_F]
if (v !== undefined && v !== null) console.log(String(v))'
}
# root runs only the bun of the kit it installs, from a root-only folder with no environment of its own (bun reads
# bunfig.toml and .env from the current folder, and BUN_OPTIONS adds arguments)
KBUN="$BUNDLE/bin/bun"
ADMIN_JS="$BUNDLE/server/src/admin.js"
# its working folder: empty, 700, made by this run (as root: root-only)
KIT_WORK=$(mktemp -d)
trap 'rm -rf "$KIT_WORK" "$RKIT"' EXIT
kitbun() {
  (cd "$KIT_WORK" && for v in $(compgen -e); do case "$v" in BUN_*|NODE_*) unset "$v" ;; esac; done && HOME="$KIT_WORK" XDG_CONFIG_HOME="$KIT_WORK" exec "$KBUN" "$@")
}

# engine requests: NAME or NAME=FILE
CLAUDE_REQ="" CODEX_REQ="" CLAUDE_FILE="" CODEX_FILE=""
for spec in ${ENGINES[@]+"${ENGINES[@]}"}; do
  name=${spec%%=*} file=""
  case "$spec" in *=*) file=${spec#*=}; [ -n "$file" ] || die "--engine $name= names no file" ;; esac
  case "$name" in
    claude) [ -z "$CLAUDE_REQ" ] || die "--engine claude given twice"; CLAUDE_REQ=1; CLAUDE_FILE=$file ;;
    codex) [ -z "$CODEX_REQ" ] || die "--engine codex given twice"; CODEX_REQ=1; CODEX_FILE=$file ;;
    *) die "unknown engine \"$name\": the engines are claude (Claude Code) and codex (Codex CLI)" ;;
  esac
  if [ -n "$file" ]; then
    [ -f "$file" ] || die "engine $name: $file not found"
    a=$(elf_arch "$file")
    [ "$a" = "$ARCH" ] || die "engine $name: $file is not a Linux $ARCH program ($a); give the real executable (not a shell script or the npm wrapper), e.g. \"\$(readlink -f \"\$(command -v $name)\")\""
  else
    [ -f "$LOCK" ] || die "engine $name: the kit has no engines.lock.json; give --engine $name=FILE"
    [ -n "$(lockget "$name" url)" ] && [[ "$(lockget "$name" sha256)" =~ ^[0-9a-f]{64}$ ]] || die "engine $name: engines.lock.json has no linux-$ARCH entry"
  fi
done

if [ "$CMD" = check ]; then
  say "check: system $OSID $OSVER $ARCH, cgroup v2$([ "$SYSTEMD" = 1 ] && echo ", systemd")"
  say "check: kit $VERSION ($ARCH) from $FROM verifies$([ "$ALLOW_UNSIGNED" = 1 ] && echo " (unsigned allowed)")"
  if command -v bwrap >/dev/null 2>&1; then say "check: bubblewrap $(bwrap --version 2>/dev/null | awk '{print $2}')"; else say "check: bubblewrap not installed yet (install adds it)"; fi
  if PF=$("$CTL_KIT" preflight "${PREFLIGHT_ARGS[@]}" 2>&1); then say "check: preflight ok: $(printf '%s' "$PF" | tr -d '\n' | cut -c1-400)"
  else
    if [ "$HOSTED" = 1 ]; then die "preflight failed for a hosted tenant: $(printf '%s' "$PF" | tr -d '\n' | cut -c1-600)"; fi
    warn "preflight: $(printf '%s' "$PF" | tr -d '\n' | cut -c1-600)"
  fi
  for n in claude codex; do
    if [ "$n" = claude ]; then r=$CLAUDE_REQ f=$CLAUDE_FILE; else r=$CODEX_REQ f=$CODEX_FILE; fi
    [ -n "$r" ] || continue
    if [ -n "$f" ]; then say "check: engine $n: $f -> $BASE/app/engines/$n/<sha12>/$n (pinned version $(lockget "$n" version))"
    else say "check: engine $n $(lockget "$n" version): download $(lockget "$n" url) (sha256 $(lockget "$n" sha256 | cut -c1-12)…)"; fi
  done
  CUR_T=$(readlink "$BASE/app/current" 2>/dev/null || true)
  case "$CUR_T" in
    versions/"$VERSION") say "check: version $VERSION is installed: repair" ;;
    versions/*) say "check: installed ${CUR_T#versions/}, kit $VERSION (a newer kit switches app/current, an older one is only staged)" ;;
    *) say "check: no install found at $BASE (or not readable without root): fresh install of $VERSION" ;;
  esac
  say "check: id $ID ($DEPLOYMENT), accounts $SRV_USER / $AGT_USER, http 127.0.0.1:$PORT, model proxy 127.0.0.1:$PROXY_PORT, TLS $([ "$TLS_PORT" = 0 ] && echo off || echo "0.0.0.0:$TLS_PORT")"
  exit 0
fi
trap 'rm -rf "$KIT_WORK" "$RKIT" "$ITMP"' EXIT

# ---- 2b) public address, app connectors and the Google Drive client: checked before anything changes ----
# (runs on every install / repair / update; the server account still runs here, so its files are read with O_NOFOLLOW,
# non-blocking, as a regular single-link file of at most 1 MiB, and nothing from them is trusted without a check)
if [ "$CMD" != check ]; then
  [ -z "$DRIVE_CLIENT" ] || (umask 077 && cat "$DRIVE_CLIENT" > "$KIT_WORK/drive-in.json")
  MYCEL_I_OLD="$BASE/config/server.json" MYCEL_I_OLDDRIVE="$BASE/secrets/integrations/google-drive/client.json" \
  MYCEL_I_PUBHOST="$PUBLIC_HOST" MYCEL_I_APPCONN="$APP_CONNECTORS" \
  MYCEL_I_IN="${DRIVE_CLIENT:+$KIT_WORK/drive-in.json}" MYCEL_I_OUT="$KIT_WORK/drive-client.json" kitbun -e '
const fs = require("fs"), e = process.env
const CALLBACK = "/api/integrations/google-drive/callback"
const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/
const fail = (m) => { console.error(m); process.exit(3) }
const readSafe = (p) => {
  let fd; try { fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK) } catch { return null }
  try { const st = fs.fstatSync(fd); if (!st.isFile() || st.nlink !== 1 || st.size > 1048576) return null; return JSON.parse(fs.readFileSync(fd, "utf8")) }
  catch { return null } finally { fs.closeSync(fd) }
}
const old = readSafe(e.MYCEL_I_OLD) ?? {}
const oldHost = typeof old.tunnel?.host === "string" && HOST_RE.test(old.tunnel.host) ? old.tunnel.host : null
const host = e.MYCEL_I_PUBHOST === "none" ? null : e.MYCEL_I_PUBHOST || oldHost
const app = e.MYCEL_I_APPCONN === "" ? old.appConnectors === true : e.MYCEL_I_APPCONN === "1"
if (e.MYCEL_I_APPCONN === "1" && !host) fail("app connectors need a public address: add --public-host HOST")
if (app && !host) console.error("warning: server.json turns app connectors on but has no public address: they stay off")
if (!e.MYCEL_I_IN) {
  // a new public host: an installed Drive client still names the old callback, so Google sign-in would fail
  const d = e.MYCEL_I_PUBHOST ? readSafe(e.MYCEL_I_OLDDRIVE) : null
  let dh = null; try { dh = d ? new URL(d.redirectUri).host : null } catch {}
  if (dh && dh !== host) console.error(`warning: the Google Drive client redirects to ${HOST_RE.test(dh) ? dh : "another host"}, not ${host ?? "a public host"}: give a new client with --google-drive-client`)
  process.exit(0)
}
if (!host) fail("--google-drive-client needs a public address: add --public-host HOST")
let j; try { j = JSON.parse(fs.readFileSync(e.MYCEL_I_IN, "utf8")) } catch { fail("--google-drive-client: the file is not JSON") }
const ok = (u) => { try { const x = new URL(u); return x.protocol === "https:" && !x.username && !x.password && !x.search && !x.hash && x.pathname === CALLBACK && (!host || x.host === host) } catch { return false } }
const want = `https://${host ?? "<public host>"}${CALLBACK}`
let out
if (j && typeof j.web === "object" && j.web) {
  // the file Google Cloud downloads for a web client: pick the redirect URI of this server
  const r = (Array.isArray(j.web.redirect_uris) ? j.web.redirect_uris : []).filter((u) => typeof u === "string" && ok(u))
  if (r.length !== 1) fail(`--google-drive-client: the client needs exactly one redirect URI ${want} (found ${r.length})`)
  out = { clientId: j.web.client_id, clientSecret: j.web.client_secret, redirectUri: r[0] }
} else if (j && typeof j === "object" && !Array.isArray(j)) {
  const extra = Object.keys(j).filter((k) => !["clientId", "clientSecret", "redirectUri"].includes(k))
  if (extra.length) fail("--google-drive-client: unknown keys " + extra.join(", "))
  if (!ok(j.redirectUri)) fail(`--google-drive-client: redirectUri must be ${want}`)
  out = { clientId: j.clientId, clientSecret: j.clientSecret, redirectUri: j.redirectUri }
} else fail("--google-drive-client: the file is not a Google OAuth client")
if (typeof out.clientId !== "string" || !out.clientId || out.clientId.length > 512) fail("--google-drive-client: clientId is missing")
if (typeof out.clientSecret !== "string" || !out.clientSecret || out.clientSecret.length > 4096) fail("--google-drive-client: clientSecret is missing")
fs.writeFileSync(e.MYCEL_I_OUT, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 })
' || { rm -f "$KIT_WORK/drive-in.json" "$KIT_WORK/drive-client.json"; die "nothing changed (see the message above)"; }
  rm -f "$KIT_WORK/drive-in.json"
fi

# ---- 3) distribution packages ----
PKGS=(bubblewrap nftables poppler-utils ffmpeg libheif-examples ca-certificates curl gnupg file zstd util-linux)
RESTRICT_USERNS=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)
[ "$RESTRICT_USERNS" = 1 ] && PKGS+=(apparmor)
if [ "$SKIP_APT" = 0 ]; then
  say "installing packages: ${PKGS[*]}"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null || die "apt-get update failed"
  apt-get install -y -qq --no-install-recommends "${PKGS[@]}" >/dev/null || die "apt-get install failed"
fi
for c in bwrap nft curl sha256sum tar runuser; do command -v "$c" >/dev/null 2>&1 || die "$c is missing (packages: ${PKGS[*]})"; done
# minimum versions (deps.txt of the kit: one "package" or "package>=version" per line)
if [ -f "$BUNDLE/deps.txt" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%%#*}; line=$(printf '%s' "$line" | tr -d '[:space:]')
    [ -n "$line" ] || continue
    [[ "$line" =~ ^([a-z0-9][a-z0-9.+-]*)(>=([0-9][0-9A-Za-z.+:~-]*))?$ ]] || { warn "deps.txt: cannot read \"$line\""; continue; }
    pkg=${BASH_REMATCH[1]} min=${BASH_REMATCH[3]}
    have=$(dpkg-query -W -f='${Version}' "$pkg" 2>/dev/null || true)
    [ -n "$have" ] || die "package $pkg is not installed$([ "$SKIP_APT" = 1 ] && echo " (--skip-apt)")"
    if [ -n "$min" ] && ! dpkg --compare-versions "$have" ge "$min"; then die "package $pkg is $have, at least $min is needed"; fi
  done < "$BUNDLE/deps.txt"
fi
BWRAP_V=$(bwrap --version 2>/dev/null | awk '{print $2}')
dpkg --compare-versions "${BWRAP_V:-0}" ge 0.8.0 2>/dev/null || die "bubblewrap $BWRAP_V is too old (0.8.0 or newer: --disable-userns)"

# ---- 4) Ubuntu 24.04: unprivileged user namespaces only for bwrap (AppArmor profile; the global sysctl stays on) ----
# unprivileged user namespaces work for bwrap (as an unprivileged account)
userns_ok() { runuser -u nobody -- bwrap --unshare-user --ro-bind / / true >/dev/null 2>&1; }
# Our profile is refreshed when we installed it before; a NEW one is added only when bwrap cannot make a user
# namespace yet. AppArmor policy is kernel-wide: a second profile attached to /usr/bin/bwrap (another --id on this
# host, a distribution profile, another tenant sharing the kernel) makes the attachment ambiguous and then neither
# applies, which would break every install on the machine (seen when two test installs ran at once).
if [ "$RESTRICT_USERNS" = 1 ] && { [ -f "/etc/apparmor.d/$ID-bwrap" ] || ! userns_ok; }; then
  command -v apparmor_parser >/dev/null 2>&1 || die "kernel.apparmor_restrict_unprivileged_userns=1 but apparmor_parser is missing (package apparmor)"
  OTHER=$(grep -ls '/usr/bin/bwrap' /etc/apparmor.d/* 2>/dev/null | grep -vx "/etc/apparmor.d/$ID-bwrap" || true)
  [ -z "$OTHER" ] || warn "another AppArmor profile names /usr/bin/bwrap ($OTHER); checking that bwrap still works"
  T=$(mktemp)
  sed "s/@ID@/$ID/g" "$KROOT/apparmor-bwrap.in" > "$T"
  if ! cmp -s "$T" "/etc/apparmor.d/$ID-bwrap" 2>/dev/null; then install -o root -g root -m 644 "$T" "/etc/apparmor.d/$ID-bwrap"; fi
  rm -f "$T"
  if ! mountpoint -q /sys/kernel/security 2>/dev/null; then mount -t securityfs securityfs /sys/kernel/security 2>/dev/null || true; fi
  apparmor_parser -r "/etc/apparmor.d/$ID-bwrap" || die "loading the AppArmor profile /etc/apparmor.d/$ID-bwrap failed"
  say "AppArmor: $ID-bwrap lets /usr/bin/bwrap create user namespaces"
elif [ "$RESTRICT_USERNS" = 1 ]; then
  say "AppArmor: bwrap may already create user namespaces here (another profile allows it); no profile added"
fi
userns_ok || die "bwrap cannot create a user namespace as an unprivileged account (kernel.unprivileged_userns_clone=0, user.max_user_namespaces=0, a container without nesting, or an AppArmor profile in the way)"
# nftables works here (a container needs CAP_NET_ADMIN in its own network namespace)
{ nft add table inet mycel_probe && nft delete table inet mycel_probe; } >/dev/null 2>&1 || die "nft cannot add a table (needs nf_tables and CAP_NET_ADMIN in this network namespace)"
if PF=$("$CTL_KIT" preflight "${PREFLIGHT_ARGS[@]}" 2>&1); then
  printf '%s\n' "$PF" > /dev/null
else
  [ "$HOSTED" = 1 ] && die "preflight failed for a hosted tenant: $(printf '%s' "$PF" | tr -d '\n' | cut -c1-800)"
  warn "preflight: $(printf '%s' "$PF" | tr -d '\n' | cut -c1-600)"
fi

# ---- 5) sysctl: ptrace only by parents (Debian's default is 0) ----
SYSCTL_F="/etc/sysctl.d/60-$ID.conf"
printf '# %s (%s): processes of one account may not attach to each other (linux-runtime spec 3.1.1)\nkernel.yama.ptrace_scope = 1\n' "$PRODUCT_NAME" "$ID" > "$SYSCTL_F.tmp"
install -o root -g root -m 644 "$SYSCTL_F.tmp" "$SYSCTL_F"; rm -f "$SYSCTL_F.tmp"
if ! sysctl -q -p "$SYSCTL_F" >/dev/null 2>&1 || [ "$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo 0)" -lt 1 ]; then
  if [ "$HOSTED" = 1 ] && [ "$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo 0)" -lt 1 ]; then die "kernel.yama.ptrace_scope is below 1 and cannot be set here (a container: the host must set it, spec 6.3)"; fi
  [ "$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo 0)" -ge 1 ] || warn "could not set kernel.yama.ptrace_scope = 1 (a container? the host must set it); diagnostics report it"
fi

# ---- 6) accounts ----
ensure_account() {  # name comment home
  local name=$1 desc=$2 home=$3 uid shell st
  if getent passwd "$name" >/dev/null; then
    # an existing account is only checked, never changed (the macOS installer's rule)
    uid=$(id -u "$name"); shell=$(getent passwd "$name" | cut -d: -f7)
    [ "$uid" -ge 100 ] && [ "$uid" -le 999 ] || die "$name exists with uid $uid outside the system range 100-999; refusing to use it"
    case "$shell" in /usr/sbin/nologin|/sbin/nologin|/usr/bin/false|/bin/false) ;; *) die "$name exists with the login shell $shell; refusing to use it" ;; esac
    st=$(passwd -S "$name" 2>/dev/null | awk '{print $2}')
    case "$st" in L|LK) ;; *) die "$name exists with a usable password (passwd -S: $st); refusing to use it (lock it: passwd -l $name)" ;; esac
    # an uninstall that kept the data locked and expired the account (usermod -L -e 1); the password stays locked
    if [ -n "$(getent shadow "$name" | cut -d: -f8)" ]; then usermod -e '' "$name" && say "$name: cleared the expiry an earlier uninstall set"; fi
  else
    getent group "$name" >/dev/null || groupadd --system "$name" || die "could not create group $name"
    useradd --system --gid "$name" --home-dir "$home" --shell /usr/sbin/nologin --no-create-home --comment "$desc" "$name" || die "could not create account $name"
    passwd -l "$name" >/dev/null 2>&1 || true
    say "created system account $name ($(id -u "$name"))"
  fi
  [ "$(id -gn "$name")" = "$name" ] || die "$name's primary group is $(id -gn "$name"), not $name"
  loginctl disable-linger "$name" >/dev/null 2>&1 || true
}
ensure_account "$SRV_USER" "$PRODUCT_NAME server ($ID)" "$BASE/data"
ensure_account "$AGT_USER" "$PRODUCT_NAME AI engine ($ID)" "$BASE/agent/home"
# the engine account is in no other group (the server reaches it only through run-launcher's group ownership)
[ "$(id -Gn "$AGT_USER")" = "$AGT_USER" ] || die "$AGT_USER is also in other groups ($(id -Gn "$AGT_USER")); remove them first"
SRV_UID=$(id -u "$SRV_USER"); AGT_UID=$(id -u "$AGT_USER")
SRV_GRP=$SRV_USER; AGT_GRP=$AGT_USER
AGT_GID=$(id -g "$AGT_USER")
say "accounts: $SRV_USER=$SRV_UID $AGT_USER=$AGT_UID"

# ---- stop the units and every process of both accounts before touching their folders ----
stop_units
kill_accounts

# ---- folders (spec 3.1.1) ----
# shellcheck disable=SC2034  # used by safe-fs.sh
SAFE_ROOTS=("$BASE")
# shellcheck source=linux/safe-fs.sh
. "$KROOT/safe-fs.sh"
mk root root 755 "$BASE"
rm -rf "$ITMP"; mkdir -m 700 "$ITMP"; chown root:root "$ITMP"
mk "$SRV_USER" "$SRV_GRP" 755 "$BASE/app"
mk "$SRV_USER" "$SRV_GRP" 755 "$BASE/app/versions"
mk "$SRV_USER" "$AGT_GRP" 750 "$BASE/app/engines"
# data kept by an earlier uninstall: it gave the folders to root (so no deleted uid owns them); give them back.
# Folders and single-link files only, and only what root or no account owns.
for d in data team config secrets setup; do
  if [ -d "$BASE/$d" ] && [ ! -L "$BASE/$d" ] && [ "$(stat -c %U "$BASE/$d")" != "$SRV_USER" ]; then
    find "$BASE/$d" \( -type d -o \( -type f -links 1 \) \) \( -user root -o -nouser \) -exec chown -h "$SRV_USER:$SRV_GRP" {} +
    say "gave the kept $d/ folder back to $SRV_USER"
  fi
done
mk "$SRV_USER" "$SRV_GRP" 700 "$BASE/data"
mk "$SRV_USER" "$SRV_GRP" 700 "$BASE/team"
mk "$SRV_USER" "$SRV_GRP" 700 "$BASE/config"
mk "$SRV_USER" "$SRV_GRP" 700 "$BASE/secrets"
mk "$SRV_USER" root 750 "$BASE/setup"
mk "$SRV_USER" root 750 "$BASE/status"
# a Codex login kept by `uninstall --keep-logins` is root's until now
if [ -d "$BASE/agent/codex-auth" ] && [ ! -L "$BASE/agent" ] && [ ! -L "$BASE/agent/codex-auth" ] && [ "$(stat -c %U "$BASE/agent/codex-auth")" = root ]; then
  find "$BASE/agent/codex-auth" \( -type d -o \( -type f -links 1 \) \) -user root -exec chown -h "$AGT_USER:$AGT_GRP" {} +
fi
mk "$AGT_USER" "$AGT_GRP" 700 "$BASE/agent"
mk root root 555 "$BASE/agent/home"
mk "$AGT_USER" "$AGT_GRP" 700 "$BASE/agent/codex-auth"
mk root root 755 "$BASE/run"
# setgid on both socket folders: Linux otherwise gives new sockets the creator's primary group. The gate runs as
# the server account, but tools.sock (0660) must inherit the engine group so the engine can connect.
mk "$SRV_USER" "$AGT_GRP" 2750 "$BASE/run/tools"
# The reverse direction: the launcher runs as the engine account, but launcher.sock (0660) needs the server group.
# (macOS gives new files the folder's group by itself.)
mk "$AGT_USER" "$SRV_GRP" 2750 "$BASE/run-launcher"
mk root root 755 "$BASE/root"

# ---- 7) root-owned files ----
# root/VERSION names the kit the root programs came from. An older kit (re-run to repair after in-app updates) leaves
# newer ones in place: the launcher, the sandbox helper and the bootstrap only move forward (mycel-ctl update replaces
# them from a verified newer release).
ROOT_V=$( { tr -d '[:space:]' < "$BASE/root/VERSION"; } 2>/dev/null || true)
ROOT_KEEP=0
if [[ "$ROOT_V" =~ ^[0-9A-Za-z][0-9A-Za-z.+_-]{0,49}$ ]] && [ "$(kitbun "$ADMIN_JS" compare-versions "$ROOT_V" "$VERSION")" = 1 ]; then
  ROOT_KEEP=1
  warn "the root programs (bootstrap, launcher, sandbox helper, mycel-ctl) stay at $ROOT_V, newer than this kit ($VERSION); to go back, uninstall (the data is kept) and install $VERSION"
fi
rootfile() {  # mode name
  if [ "$ROOT_KEEP" = 1 ] && [ -f "$BASE/root/$2" ] && [ ! -L "$BASE/root/$2" ]; then return 0; fi
  nolink "$BASE/root/$2"
  install -o root -g root -m "$1" "$KROOT/$2" "$BASE/root/$2" || die "installing root/$2 failed"
}
for f in mycel-bootstrap mycel-launcher mycel-sandbox mycel-ctl mycel-account set-claude-token; do rootfile 755 "$f"; done
rootfile 644 safe-fs.sh
# the unit templates go with the root programs (mycel-ctl render-units and update read them from root/systemd/)
mk root root 755 "$BASE/root/systemd"
for t in firewall.service firewall.timer launcher.service server.service update.service update.timer slice; do rootfile 644 "systemd/$t.in"; done
# root's own copies of the programs safe operations 1A run (docs/SAFE-OPS-1A.md; QA 2026-10-30 B1): a 1A job runs only
# executables that root owns in folders only root can write, and the version folders belong to the server account (the
# server's own updates write them). The server unit names this folder (MYCEL_SAFE_OPS_BIN); `mycel-ctl update` keeps it
# current. With newer root programs kept (ROOT_KEEP), the copies of that newer version stay too.
mk root root 755 "$BASE/root/safe-ops"
if [ "$ROOT_KEEP" = 0 ] || [ ! -f "$BASE/root/safe-ops/mycel-safeops" ] || [ ! -f "$BASE/root/safe-ops/pandoc" ]; then
  [ "$ROOT_KEEP" = 0 ] || warn "root/safe-ops is incomplete; it gets the programs of this kit ($VERSION): run \`sudo $BASE/root/mycel-ctl safe-ops status\` after the install"
  put "$BUNDLE/native/mycel-safeops" root root 755 "$BASE/root/safe-ops/mycel-safeops"
  put "$BUNDLE/bin/pandoc" root root 755 "$BASE/root/safe-ops/pandoc"
fi
if [ "$ROOT_KEEP" = 0 ]; then
  printf '%s\n' "$VERSION" > "$ITMP/root-version"
  install -o root -g root -m 644 "$ITMP/root-version" "$BASE/root/VERSION"
fi
# the sandbox's /etc (spec 3.3.3): the real /etc/passwd would show the tenant's accounts
SBX="$BASE/root/sandbox-etc"
nolink "$SBX"; rm -rf "$SBX.new"; mkdir -m 755 "$SBX.new"
printf 'root:x:0:0::/:/usr/sbin/nologin\n%s:x:%s:%s::/nonexistent:/usr/sbin/nologin\n' "$AGT_USER" "$AGT_UID" "$AGT_GID" > "$SBX.new/passwd"
printf 'root:x:0:\n%s:x:%s:\n' "$AGT_USER" "$AGT_GID" > "$SBX.new/group"
printf '127.0.0.1 localhost\n::1 localhost\n' > "$SBX.new/hosts"
printf 'passwd: files\ngroup: files\nhosts: files\n' > "$SBX.new/nsswitch.conf"
: > "$SBX.new/empty"
mkdir "$SBX.new/empty.d"
chown -R root:root "$SBX.new"; chmod 644 "$SBX.new"/{passwd,group,hosts,nsswitch.conf,empty}; chmod 555 "$SBX.new/empty.d"; chmod 755 "$SBX.new"
rm -rf "$SBX"; mv -T "$SBX.new" "$SBX"
# the engine firewall's input (mycel-ctl firewall apply; spec 3.4)
printf '{"format":1,"id":"%s","engineUid":%s,"serverUid":%s,"proxyPort":%s,"serverPort":%s,"deployment":"%s","serverAllowPrivate":[]}\n' \
  "$ID" "$AGT_UID" "$SRV_UID" "$PROXY_PORT" "$PORT" "$DEPLOYMENT" > "$ITMP/firewall.conf.json"
install -o root -g root -m 644 "$ITMP/firewall.conf.json" "$BASE/root/firewall.conf.json"

# ---- 8) engines: app/engines/<name>/<sha12>/<name>, current -> <sha12> ----
download() {  # url sha256 size out
  local url=$1 sha=$2 size=$3 out=$4
  [[ "$url" =~ ^https://[A-Za-z0-9./_+%-]+$ ]] || die "engines.lock.json: bad address $url"
  curl --proto =https --proto-redir =https --tlsv1.2 -fsSL --retry 3 -o "$out" "$url" || die "downloading $url failed"
  [ "$(sha256sum "$out" | cut -d' ' -f1)" = "$sha" ] || { rm -f "$out"; die "$url: SHA-256 does not match engines.lock.json"; }
  if [[ "$size" =~ ^[1-9][0-9]*$ ]] && [ "$(stat -c %s "$out")" != "$size" ]; then rm -f "$out"; die "$url: size does not match engines.lock.json"; fi
}
from_cache() {  # name sha256 file-name out: the host's read-only engine cache (hosted tenants, spec 3.5.2)
  local c="$ENGINE_CACHE/$1/${2:0:12}/$3"
  [ -f "$c" ] && [ ! -L "$c" ] || return 1
  cp "$c" "$4" && [ "$(sha256sum "$4" | cut -d' ' -f1)" = "$2" ] || { rm -f "$4"; return 1; }
}
# the engine's version, as the engine account inside bwrap with no network (root never runs an engine)
engine_version() {  # path
  runuser -u "$AGT_USER" -- /usr/bin/env -i PATH=/usr/bin:/bin bwrap --unshare-all --die-with-parent --new-session \
    --ro-bind /usr /usr --symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/bin /bin \
    --ro-bind /etc/ld.so.cache /etc/ld.so.cache --ro-bind "$1" /engine --proc /proc --dev /dev --tmpfs /tmp \
    --setenv HOME /tmp --setenv TMPDIR /tmp --setenv DISABLE_AUTOUPDATER 1 --chdir /tmp -- /engine --version 2>/dev/null \
    | head -n 1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true
}
CLAUDE_CMD="" CODEX_CMD=""
for name in claude codex; do
  if [ "$name" = claude ]; then req=$CLAUDE_REQ src=$CLAUDE_FILE; else req=$CODEX_REQ src=$CODEX_FILE; fi
  cmd="$BASE/app/engines/$name/current/$name"
  pin=$(lockget "$name" version)
  if [ -n "$req" ]; then
    stage="$ITMP/engine-$name"; rm -f "$stage"
    if [ -n "$src" ]; then
      cp "$src" "$stage"
      if [ "$name" = claude ]; then
        # a dynamically linked Claude Code must use the glibc loader (no musl build on a glibc system, no wrapper)
        ftype=$(file -bL "$stage" 2>/dev/null || true)
        case "$ftype" in
          *"dynamically linked"*) case "$ftype" in *"interpreter /lib64/ld-linux-x86-64.so.2"*|*"interpreter /lib/ld-linux-aarch64.so.1"*) ;; *) die "engine claude: $src is not linked against this system's glibc loader ($ftype)" ;; esac ;;
        esac
      fi
    else
      sha=$(lockget "$name" sha256) url=$(lockget "$name" url) size=$(lockget "$name" size)
      if [ "$name" = claude ]; then
        from_cache claude "$sha" claude "$stage" || download "$url" "$sha" "$size" "$stage"
      else
        member=$(lockget codex member)
        [[ "$member" =~ ^[A-Za-z0-9._-]+$ ]] || die "engines.lock.json: bad codex member name"
        if ! from_cache codex "$sha" codex "$stage"; then
          download "$url" "$sha" "$size" "$ITMP/codex.tar.gz"
          mkdir -m 700 "$ITMP/codex-x"
          tar -xzf "$ITMP/codex.tar.gz" -C "$ITMP/codex-x" --no-same-owner --no-same-permissions "$member" || die "codex: $member not in the release archive"
          [ -f "$ITMP/codex-x/$member" ] && [ ! -L "$ITMP/codex-x/$member" ] || die "codex: $member is not a file"
          mv "$ITMP/codex-x/$member" "$stage"; rm -rf "$ITMP/codex-x" "$ITMP/codex.tar.gz"
        fi
      fi
      [ "$(elf_arch "$stage")" = "$ARCH" ] || die "engine $name: the download is not a Linux $ARCH program"
    fi
    sha=$(sha256sum "$stage" | cut -c1-12)
    dir="$BASE/app/engines/$name/$sha"
    mk "$SRV_USER" "$AGT_GRP" 750 "$BASE/app/engines/$name"
    mk "$SRV_USER" "$AGT_GRP" 750 "$dir"
    put "$stage" "$SRV_USER" "$AGT_GRP" 750 "$dir/$name"
    rm -f "$stage"
    got=$(engine_version "$dir/$name")
    if [ -n "$pin" ] && [ "$got" != "$pin" ]; then
      if [ "$HOSTED" = 1 ]; then die "engine $name: version ${got:-unknown}, the kit pins $pin (hosted tenants run only the pinned version)"; fi
      warn "engine $name: version ${got:-unknown}, the kit pins $pin (the lockdown tests ran with $pin)"
    fi
    nolink "$BASE/app/engines/$name"
    rm -f "$BASE/app/engines/$name/current"
    ln -s "$sha" "$BASE/app/engines/$name/current"
    chown -h "$SRV_USER:$AGT_GRP" "$BASE/app/engines/$name/current"
    say "engine $name: ${got:-version unknown} ($sha)"
  else
    t=$(readlink "$BASE/app/engines/$name/current" 2>/dev/null || true)
    if [[ "$t" =~ ^[0-9a-f]{12}$ ]] && [ ! -L "$BASE/app/engines/$name" ] && [ -f "$BASE/app/engines/$name/$t/$name" ] && [ ! -L "$BASE/app/engines/$name/$t/$name" ]; then
      say "engine $name: keeping the one installed earlier ($t)"
    else
      cmd=""
    fi
  fi
  if [ "$name" = claude ]; then CLAUDE_CMD=$cmd; else CODEX_CMD=$cmd; fi
  if [ "$name" = codex ] && [ -n "$cmd" ]; then
    # the locked model catalog next to Codex (no shell, no code mode, no apply_patch for any model)
    dir="$BASE/app/engines/codex/$(readlink "$BASE/app/engines/codex/current")"
    if [ -n "$CODEX_MODELS" ]; then
      [ -f "$CODEX_MODELS" ] && [ ! -L "$CODEX_MODELS" ] || die "--codex-models: $CODEX_MODELS is not a file"
      CAT_MJS=""
      for c in "$(dirname "$0")/macos/codex-catalog.mjs" "$(dirname "$0")/linux/codex-catalog.mjs" "$FROM/codex-catalog.mjs" "$KROOT/codex-catalog.mjs"; do [ -f "$c" ] && { CAT_MJS=$(cd "$(dirname "$c")" && pwd -P)/$(basename "$c"); break; }; done
      [ -n "$CAT_MJS" ] || die "--codex-models needs codex-catalog.mjs (scripts/macos/ in the repository)"
      cp "$CODEX_MODELS" "$ITMP/models_cache.json"
      kitbun "$CAT_MJS" "$ITMP/models_cache.json" "$ITMP/model_catalog.json" >/dev/null || die "could not lock the Codex model catalog from $CODEX_MODELS"
      put "$ITMP/model_catalog.json" "$SRV_USER" "$AGT_GRP" 640 "$dir/model_catalog.json"
    elif [ -n "$req" ] || [ ! -f "$dir/model_catalog.json" ]; then
      cat_rel=$(lockget codex modelCatalog)
      if [ -n "$cat_rel" ] && [[ "$cat_rel" =~ ^[A-Za-z0-9._/-]+$ ]] && [[ "$cat_rel" != *..* ]] && [ -f "$BUNDLE/$cat_rel" ]; then
        put "$BUNDLE/$cat_rel" "$SRV_USER" "$AGT_GRP" 640 "$dir/model_catalog.json"
      elif [ ! -f "$dir/model_catalog.json" ]; then
        warn "no Codex model catalog (the kit has none; pass --codex-models <models_cache.json>); Codex turns stay off until there is one"
      fi
    fi
  fi
done
[ -n "$CLAUDE_CMD$CODEX_CMD" ] || die "no engine: give --engine claude and/or --engine codex"
ENGINE_ARGS=""
[ -n "$CLAUDE_CMD" ] && ENGINE_ARGS+="--allow-cmd $CLAUDE_CMD"
[ -n "$CODEX_CMD" ] && ENGINE_ARGS+="${ENGINE_ARGS:+ }--allow-cmd $CODEX_CMD"

# ---- 9) server version (fresh copy, chown only what root just copied), app/current and state.json ----
DEST="$BASE/app/versions/$VERSION"
nolink "$DEST"
rm -rf "$DEST.partial"; cp -a --no-preserve=ownership "$BUNDLE" "$DEST.partial"
chown -R "$SRV_USER:$SRV_GRP" "$DEST.partial"
find "$DEST.partial" -type d -exec chmod 755 {} +
chmod -R go-w "$DEST.partial"
rm -rf "$DEST"; mv -T "$DEST.partial" "$DEST"
CUR_T=$(readlink "$BASE/app/current" 2>/dev/null || true)
CUR=""
if [[ "$CUR_T" =~ ^versions/([0-9A-Za-z][0-9A-Za-z.+_-]{0,49})$ ]] && [ -L "$BASE/app/current" ] && [ -f "$BASE/app/$CUR_T/manifest.json" ]; then
  CUR=${BASH_REMATCH[1]}
fi
if [ -f "$BASE/app/state.json" ] && [ ! -L "$BASE/app/state.json" ] && [ "$(stat -c %h "$BASE/app/state.json")" = 1 ]; then
  cp "$BASE/app/state.json" "$ITMP/state.old.json"
else
  echo null > "$ITMP/state.old.json"
fi
ACTION=$(kitbun "$ADMIN_JS" install-state --current "$CUR" --version "$VERSION" --state "$ITMP/state.old.json" --out "$ITMP/state.json") \
  || die "planning app/current failed"
case "$ACTION" in
  init|switch)
    nolink "$BASE/app"
    rm -f "$BASE/app/current"
    ln -s "versions/$VERSION" "$BASE/app/current"
    chown -h "$SRV_USER:$SRV_GRP" "$BASE/app/current"
    RUNNING=$VERSION
    [ "$ACTION" = switch ] && say "switching $CUR -> $VERSION ($CUR stays for roll-back; the server goes back to it by itself if $VERSION does not start)"
    ;;
  repair) RUNNING=$CUR ;;
  older)
    RUNNING=$CUR
    warn "this kit ($VERSION) is older than the installed $CUR, so $CUR keeps running; $VERSION is staged in app/versions"
    ;;
  *) die "unexpected plan: $ACTION" ;;
esac
put "$ITMP/state.json" "$SRV_USER" "$SRV_GRP" 640 "$BASE/app/state.json"

# ---- office-network TLS certificate (only with --tls-port) ----
if [ "$TLS_PORT" != 0 ]; then
  for f in lan-tls.key lan-tls.crt; do
    if [ -f "$BASE/secrets/$f" ] && [ ! -L "$BASE/secrets/$f" ] && [ "$(stat -c '%h:%U' "$BASE/secrets/$f")" = "1:$SRV_USER" ]; then
      cp "$BASE/secrets/$f" "$ITMP/$f"
    fi
  done
  kitbun "$ADMIN_JS" lan-cert --cert "$ITMP/lan-tls.crt" --key "$ITMP/lan-tls.key" --fingerprint "$ITMP/lan-cert.sha256" > "$ITMP/lan-cert.json" \
    || die "making the office TLS certificate failed"
  put "$ITMP/lan-tls.key" "$SRV_USER" "$SRV_GRP" 600 "$BASE/secrets/lan-tls.key"
  put "$ITMP/lan-tls.crt" "$SRV_USER" "$SRV_GRP" 644 "$BASE/secrets/lan-tls.crt"
  put "$ITMP/lan-cert.sha256" "$SRV_USER" root 640 "$BASE/setup/lan-cert.sha256"
fi

# ---- 10) config/server.json (merged: owner choices such as relay and update channel survive a reinstall) ----
CFG="$BASE/config/server.json"
OLD_CFG="$ITMP/server.old.json"
if [ -f "$CFG" ] && [ ! -L "$CFG" ] && [ "$(stat -c %h "$CFG")" = 1 ]; then cp "$CFG" "$OLD_CFG"; else echo '{}' > "$OLD_CFG"; fi
MYCEL_I_OLD="$OLD_CFG" MYCEL_I_OUT="$ITMP/server.json" MYCEL_I_BASE="$BASE" MYCEL_I_PORT="$PORT" MYCEL_I_TLS="$TLS_PORT" \
MYCEL_I_AGT_UID="$AGT_UID" MYCEL_I_CLAUDE="$CLAUDE_CMD" MYCEL_I_CODEX="$CODEX_CMD" MYCEL_I_PROXY_PORT="$PROXY_PORT" \
MYCEL_I_DEPLOY="$DEPLOYMENT" MYCEL_I_AUTO="$AUTO_UPDATE" MYCEL_I_FEED="$FEED_BASE" \
MYCEL_I_PUBHOST="$PUBLIC_HOST" MYCEL_I_APPCONN="$APP_CONNECTORS" kitbun -e '
const fs = require("fs"), e = process.env, b = e.MYCEL_I_BASE
let old = {}; try { old = JSON.parse(fs.readFileSync(e.MYCEL_I_OLD, "utf8")) } catch {}
if (!old || typeof old !== "object" || Array.isArray(old)) old = {}
const { claudeBin: _c, codexBin: _x, ...engineOld } = old.engine && typeof old.engine === "object" ? old.engine : {}
const ou = old.update && typeof old.update === "object" ? old.update : {}
const channel = ou.channel === "beta" ? "beta" : "stable"
// --public-host: keep the narrowing (allowFrom, countries) the owner set for the earlier host; not given = as it was
const ot = old.tunnel && typeof old.tunnel === "object" ? old.tunnel : null
const tunnel = e.MYCEL_I_PUBHOST === "none" ? null : e.MYCEL_I_PUBHOST
  ? { host: e.MYCEL_I_PUBHOST, allowFrom: Array.isArray(ot?.allowFrom) ? ot.allowFrom : [], countries: Array.isArray(ot?.countries) ? ot.countries : [] }
  : ot
const appConnectors = e.MYCEL_I_APPCONN === "" ? old.appConnectors === true : e.MYCEL_I_APPCONN === "1"
const cfg = {
  ...old,
  mode: "prod",
  deployment: e.MYCEL_I_DEPLOY,
  listen: { host: "127.0.0.1", port: Number(e.MYCEL_I_PORT) },
  tls: e.MYCEL_I_TLS === "0" ? null : { port: Number(e.MYCEL_I_TLS), certFile: b + "/secrets/lan-tls.crt", keyFile: b + "/secrets/lan-tls.key", managed: true },
  // logs go to journald only (spec D4): stdout/stderr of the unit
  teamRoot: b + "/team", dataDir: b + "/data", logDir: null,
  engine: { ...engineOld, authMode: "subscription",
    ...(e.MYCEL_I_CLAUDE ? { claudeBin: e.MYCEL_I_CLAUDE } : {}), ...(e.MYCEL_I_CODEX ? { codexBin: e.MYCEL_I_CODEX } : {}),
    proxyPort: Number(e.MYCEL_I_PROXY_PORT),
    runDir: b + "/run/tools", agentRoot: b + "/agent", launcherSock: b + "/run-launcher/launcher.sock", agentUid: Number(e.MYCEL_I_AGT_UID) },
  relay: old.relay ?? { url: null, teamName: null },
  tunnel, appConnectors,
  update: { ...ou, channel, feedUrl: typeof ou.feedUrl === "string" && ou.feedUrl ? ou.feedUrl : e.MYCEL_I_FEED ? e.MYCEL_I_FEED + "/" + channel + ".json" : null,
    auto: e.MYCEL_I_DEPLOY === "hosted" ? false : e.MYCEL_I_AUTO === "1" },
}
fs.writeFileSync(e.MYCEL_I_OUT, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 })
' || die "writing $CFG failed"
put "$ITMP/server.json" "$SRV_USER" "$SRV_GRP" 600 "$CFG"

# ---- 10b) Google Drive OAuth client (checked and converted in 2b; never printed, never kept in install.json) ----
if [ -n "$DRIVE_CLIENT" ]; then
  mk "$SRV_USER" "$SRV_GRP" 700 "$BASE/secrets/integrations"
  mk "$SRV_USER" "$SRV_GRP" 700 "$BASE/secrets/integrations/google-drive"
  put "$KIT_WORK/drive-client.json" "$SRV_USER" "$SRV_GRP" 600 "$BASE/secrets/integrations/google-drive/client.json"
  rm -f "$KIT_WORK/drive-client.json"
  say "Google Drive: OAuth client installed (secrets/integrations/google-drive/client.json)"
fi

# ---- 11) one-time setup code while the team has no account (setup/code for root, data/setup-token for the server) ----
if [ ! -f "$BASE/setup/code" ] && { [ ! -f "$BASE/data/app.db" ] || [ -e "$BASE/data/setup-token" ]; }; then
  CODE=$(head -c 18 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')
  (umask 077 && printf '%s\n' "$CODE" > "$ITMP/code")
  put "$ITMP/code" "$SRV_USER" root 640 "$BASE/setup/code"
  put "$ITMP/code" "$SRV_USER" "$SRV_GRP" 600 "$BASE/data/setup-token"
  rm -f "$ITMP/code"
  unset CODE
fi

# root/install.json: the arguments of this install (repair / update / uninstall read them)
ENG_JSON=""
[ -n "$CLAUDE_CMD" ] && ENG_JSON='"claude"'
[ -n "$CODEX_CMD" ] && ENG_JSON="${ENG_JSON:+$ENG_JSON,}\"codex\""
jbool() { if [ "$1" = 1 ]; then echo true; else echo false; fi; }
cat > "$ITMP/install.json" <<EOF
{
  "format": 1,
  "id": "$ID",
  "base": "$BASE",
  "serverUser": "$SRV_USER",
  "agentUser": "$AGT_USER",
  "port": $PORT,
  "proxyPort": $PROXY_PORT,
  "tlsPort": $TLS_PORT,
  "hosted": $(jbool "$HOSTED"),
  "autoUpdate": $(jbool "$AUTO_UPDATE"),
  "allowUnsigned": $(jbool "$ALLOW_UNSIGNED"),
  "engines": [$ENG_JSON],
  "version": "$VERSION",
  "systemd": $(jbool "$SYSTEMD"),
  "publicHost": $(if [ -n "$PUBLIC_HOST" ] && [ "$PUBLIC_HOST" != none ]; then echo "\"$PUBLIC_HOST\""; else echo null; fi),
  "appConnectors": $(case "$APP_CONNECTORS" in 1) echo true ;; 0) echo false ;; *) echo null ;; esac)
}
EOF
install -o root -g root -m 644 "$ITMP/install.json" "$INSTALL_JSON"
if { [ -n "$PUBLIC_HOST" ] || [ -n "$APP_CONNECTORS" ]; } && [ -f "/etc/default/$ID" ] && grep -q '^[[:space:]]*MYCEL_REMOTE_MCP_ORIGIN=' "/etc/default/$ID"; then
  warn "/etc/default/$ID sets MYCEL_REMOTE_MCP_ORIGIN, which wins over --public-host / --app-connectors: remove that line to let server.json decide"
fi

# ---- 12) the engine firewall: loaded before any engine can run, or no install ----
FW_OUT=$("$BASE/root/mycel-ctl" firewall apply --base "$BASE" 2>&1) || die "loading the engine firewall failed: $(printf '%s' "$FW_OUT" | tail -n 3 | tr '\n' ' ')"
say "engine firewall: nft table inet $ID ($AGT_USER may reach only 127.0.0.1:$PROXY_PORT)"

# ---- 13) systemd units: rendered by mycel-ctl from root/systemd/*.in and root/install.json (one renderer for the
# installer, `mycel-ctl update` and `supervise`, so they never disagree on the launcher's sandbox flags) ----
if [ "$HOSTED" = 0 ] && ! grep -qw landlock /sys/kernel/security/lsm 2>/dev/null; then
  warn "this kernel has no Landlock in its LSM list: the launcher (--landlock required) will refuse every turn; use a Debian 13 / Ubuntu 24.04 kernel (or add lsm=...,landlock)"
fi
mkdir -m 700 "$ITMP/units"
RU=$("$BASE/root/mycel-ctl" render-units --base "$BASE" --out "$ITMP/units" 2>&1) || die "rendering the units failed: $(printf '%s' "$RU" | tail -n 3 | tr '\n' ' ')"
for u in "${UNITS[@]}"; do
  [ -f "$ITMP/units/$u" ] || die "mycel-ctl render-units wrote no $u"
  ! grep -q '@[A-Z_]*@' "$ITMP/units/$u" || die "$u has an unfilled placeholder"
done
if [ "$SYSTEMD" = 1 ]; then
  if command -v systemd-analyze >/dev/null 2>&1; then
    VERIFY=$(cd "$ITMP/units" && systemd-analyze verify ./*.service ./*.timer ${SLICE:+"./$SLICE"} 2>&1) || die "systemd-analyze verify: $(printf '%s' "$VERIFY" | tail -n 5 | tr '\n' ' ')"
  fi
  for f in "$ITMP/units"/*; do install -o root -g root -m 644 "$f" "$UNIT_DIR/$(basename "$f")"; done
  systemctl daemon-reload
  # both units are stopped (above): stopping their empty slice makes systemd create it again with the limits it has now
  # (daemon-reload alone does not change a running slice; the limits exist only while 1A is on, mycel-ctl safe-ops)
  [ -z "$SLICE" ] || systemctl stop "$SLICE" >/dev/null 2>&1 || true
fi
if [ -n "$PLAN" ]; then
  [ -f "$PLAN" ] || die "--plan: $PLAN not found"
  "$BASE/root/mycel-ctl" apply-plan --base "$BASE" < "$PLAN" || die "mycel-ctl apply-plan refused $PLAN"
fi

# ---- 14) cron / at, the admin's mycel-ctl, journald ----
for f in /etc/cron.deny /etc/at.deny; do
  if [ -f "$f" ]; then grep -qx "$AGT_USER" "$f" || echo "$AGT_USER" >> "$f"; grep -qx "$SRV_USER" "$f" || echo "$SRV_USER" >> "$f"; fi
done
CTL_LINK=/usr/local/sbin/mycel-ctl; [ "$ID" = mycel ] || CTL_LINK="/usr/local/sbin/$ID-ctl"
mkdir -p /usr/local/sbin
ln -sfn "$BASE/root/mycel-ctl" "$CTL_LINK"
JD="/etc/systemd/journald.conf.d/$ID.conf"
if [ "$HOSTED" = 1 ] || ! grep -qs '^[[:space:]]*SystemMaxUse=' /etc/systemd/journald.conf /etc/systemd/journald.conf.d/*.conf 2>/dev/null || [ -f "$JD" ]; then
  mkdir -p /etc/systemd/journald.conf.d
  printf '# %s (%s): the server and launcher log to journald only (spec D4)\n[Journal]\nSystemMaxUse=200M\nMaxRetentionSec=14day\n' "$PRODUCT_NAME" "$ID" > "$ITMP/journald.conf"
  if ! cmp -s "$ITMP/journald.conf" "$JD"; then
    install -o root -g root -m 644 "$ITMP/journald.conf" "$JD"
    have_systemd && { systemctl restart systemd-journald >/dev/null 2>&1 || true; }
  fi
fi

if [ "$SYSTEMD" = 0 ]; then
  say "installed $ID $VERSION without systemd (test containers only). Start everything with:"
  say "  $BASE/root/mycel-ctl supervise --base $BASE"
  [ ${#WARNINGS[@]} -eq 0 ] || { say "with ${#WARNINGS[@]} warning(s):"; printf '  %s\n' "${WARNINGS[@]}"; }
  exit 0
fi
ENABLE=("$ID-firewall.service" "$ID-firewall.timer" "$ID-launcher.service" "$ID-server.service")
if [ "$AUTO_UPDATE" = 1 ]; then ENABLE+=("$ID-update.timer"); else systemctl disable --now "$ID-update.timer" >/dev/null 2>&1 || true; fi
systemctl enable "${ENABLE[@]}" >/dev/null 2>&1 || die "systemctl enable failed"
systemctl restart "$ID-firewall.timer" || die "starting $ID-firewall.timer failed"
[ "$AUTO_UPDATE" = 1 ] && { systemctl restart "$ID-update.timer" || warn "starting $ID-update.timer failed"; }
systemctl restart "$ID-launcher.service" || die "starting $ID-launcher failed (journalctl -u $ID-launcher -n 50)"
systemctl restart "$ID-server.service" || die "starting $ID-server failed (journalctl -u $ID-server -n 50)"

# ---- 15) wait until the server answers with the version app/current points to ----
WAIT=60; [ "$ACTION" = switch ] && WAIT=180
say "waiting for the server on 127.0.0.1:$PORT ($RUNNING)"
done_ok() {
  say "installed $ID $RUNNING ($DEPLOYMENT; server $SRV_USER, engine $AGT_USER)"
  if [ -f "$BASE/setup/code" ] && [ -e "$BASE/data/setup-token" ]; then
    say "first-run setup: the code is in $BASE/setup/code (sudo cat $BASE/setup/code). This server has no screen: from your"
    say "  computer run ssh -L $PORT:127.0.0.1:$PORT <this server>, then open http://127.0.0.1:$PORT/setup?token=<code>"
  fi
  say "AI login: claude setup-token (anywhere), then sudo $BASE/root/set-claude-token < token.txt; Codex: sudo $CTL_LINK codex-login"
  say "owner password recovery: sudo $BASE/root/mycel-account reset-link; status: sudo $CTL_LINK status"
  [ ${#WARNINGS[@]} -eq 0 ] || { say "with ${#WARNINGS[@]} warning(s):"; printf '  %s\n' "${WARNINGS[@]}"; }
  exit 0
}
for _ in $(seq 1 "$WAIT"); do
  H=$(curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)
  if [ -n "$H" ]; then
    case "$H" in
      *"\"version\":\"$RUNNING\""*) done_ok ;;
      *)
        GOT=$(printf '%s' "$H" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
        [ "$ACTION" = switch ] && die "$VERSION did not become healthy, so the server went back to ${GOT:-the previous version}; see journalctl -u $ID-server -n 100"
        warn "the server answers as version ${GOT:-?}, not $RUNNING (an update was pending?)"
        done_ok
        ;;
    esac
  fi
  sleep 1
done
die "the server did not answer within $WAIT s; see journalctl -u $ID-server -n 100"

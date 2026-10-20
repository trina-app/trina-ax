#!/bin/bash
# Team AX server uninstaller for macOS ("설치 되돌리기", design tab 6). Component G. Idempotent.
#
#   sudo scripts/uninstall-macos.sh [--id mycel] [--server-user _axserver] [--agent-user _axagent] [--delete-data]
#                                   [--keep-accounts]   (repair / reinstall: leave the role accounts in place)
#
# Stops and removes the LaunchDaemons, empties the pf anchor and releases our pf reference, removes the role accounts
# and their groups, the app, root/, config, secrets, sockets, logs, the newsyslog config, the cron.deny / at.deny
# entries and the Time Machine exclusions. The team folder, the DB and the backups stay unless --delete-data is
# given (they are then owned by root so they are not left with the deleted account's uid). At the end it lists
# anything of this install that is still on the machine and exits 1 if there is something.
# The relay registration is released by the server/menubar app before this runs (it needs the team key).
set -uo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
ID=mycel SRV_USER=_axserver AGT_USER=_axagent DELETE_DATA=0 KEEP_ACCOUNTS=0
die() { echo "uninstall: $*" >&2; exit 2; }
say() { echo "uninstall: $*"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --id) ID=$2; shift 2 ;;
    --server-user) SRV_USER=$2; shift 2 ;;
    --agent-user) AGT_USER=$2; shift 2 ;;
    --delete-data) DELETE_DATA=1; shift ;;
    --keep-accounts) KEEP_ACCOUNTS=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done
[ "$(id -u)" = 0 ] || die "run as root (sudo)"
[[ "$ID" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "bad --id"
for u in "$SRV_USER" "$AGT_USER"; do [[ "$u" =~ ^_[a-z][a-z0-9]{2,30}$ ]] || die "bad account name $u"; done

BASE="/Library/Application Support/$ID"
LOGS="/Library/Logs/$ID"
LABEL="app.treesoop.$ID"
ANCHOR="com.apple/250.$ID"

# 1) daemons: the server first (it finishes or interrupts turns on SIGTERM), then the launcher and pf
for d in server launcher pf; do
  if launchctl print "system/$LABEL.$d" >/dev/null 2>&1; then
    launchctl bootout "system/$LABEL.$d" >/dev/null 2>&1 || say "bootout $LABEL.$d failed"
  fi
  rm -f "/Library/LaunchDaemons/$LABEL.$d.plist"
done
# processes of the role accounts that outlived their daemon
for u in "$SRV_USER" "$AGT_USER"; do
  if id "$u" >/dev/null 2>&1; then pkill -KILL -u "$(id -u "$u")" >/dev/null 2>&1 || true; fi
done

# 2) firewall: empty our anchor, release our reference (pf stays as it was before us)
pfctl -q -a "$ANCHOR" -F all >/dev/null 2>&1 || true
if [ -f "$BASE/run/pf.token" ]; then
  TOKEN=$(sed -n 's/^token=//p' "$BASE/run/pf.token")
  [ -n "$TOKEN" ] && { pfctl -X "$TOKEN" >/dev/null 2>&1 || say "pf reference $TOKEN was already released"; }
fi

limited() {  # seconds command... : run with a time limit (consent prompts nobody answers block for minutes)
  local secs=$1 pid i; shift
  "$@" >/dev/null 2>&1 & pid=$!
  for i in $(seq 1 "$secs"); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" >/dev/null 2>&1; wait "$pid" >/dev/null 2>&1; return 124; fi
  wait "$pid"
}

# 3) Time Machine exclusions (sticky path exclusions are removed explicitly; needs Full Disk Access)
for p in secrets agent run run-launcher app; do
  [ -e "$BASE/$p" ] && { limited 15 tmutil removeexclusion -p "$BASE/$p" || true; }
done

# 4) files
rm -rf "$BASE/app" "$BASE/root" "$BASE/config" "$BASE/secrets" "$BASE/run" "$BASE/run-launcher" "$BASE/agent" \
       "$BASE/setup" "$BASE/status"
rm -rf "$LOGS"
rm -f "/etc/newsyslog.d/$ID.conf"
if [ "$DELETE_DATA" = 1 ]; then
  rm -rf "$BASE"
else
  # folders and single-link files only: a hard link the server account made to some other file must not be chowned
  for d in data team; do
    [ -d "$BASE/$d" ] && [ ! -L "$BASE/$d" ] && find "$BASE/$d" \( -type d -o \( -type f -links 1 \) \) -exec chown -h root:wheel {} +
  done
  [ -d "$BASE" ] && say "kept the team folder and data in $BASE (use --delete-data to remove them)"
fi

# 5) cron / at deny entries (writing /var/at needs Full Disk Access)
for f in /var/at/cron.deny /var/at/at.deny; do
  if [ -f "$f" ] && grep -qx "$AGT_USER" "$f"; then
    limited 15 /bin/sh -c 'grep -vx "$2" "$1" > "$1.tmp"; cat "$1.tmp" > "$1"; rm -f "$1.tmp"' sh "$f" "$AGT_USER" || say "could not edit $f (needs Full Disk Access)"
  fi
done

# 6) accounts and groups. macOS 26 asks the logged-in administrator to approve deleting a user record: run from the
# menubar app ("설치 되돌리기", osascript with administrator privileges) the prompt appears; run unattended (no one at
# the screen) the deletion waits ~5 minutes and fails, from a LaunchDaemon it is refused at once. So each deletion gets
# a time limit. Each account is locked first (no login, no password, no shell): after a refused deletion macOS keeps
# the record busy and refuses further changes until the next restart, so locking afterwards would be too late.
for u in "$AGT_USER" "$SRV_USER"; do
  [ "$KEEP_ACCOUNTS" = 1 ] && break
  if dscl . -read "/Users/$u" >/dev/null 2>&1; then
    if ! dscl . -read "/Users/$u" AuthenticationAuthority 2>/dev/null | grep -q DisabledUser; then
      limited 20 dscl . -create "/Users/$u" UserShell /usr/bin/false
      limited 20 dscl . -create "/Users/$u" Password '*'
      limited 20 dscl . -create "/Users/$u" AuthenticationAuthority ';DisabledUser;'
    fi
    limited "${MYCEL_DELETE_TIMEOUT:-60}" dscl . -delete "/Users/$u"
    if dscl . -read "/Users/$u" >/dev/null 2>&1; then say "macOS did not let this session delete the account $u (administrator approval needed); it stays locked"; fi
  fi
  if dscl . -read "/Groups/$u" >/dev/null 2>&1; then
    dseditgroup -o delete "$u" >/dev/null 2>&1 || dscl . -delete "/Groups/$u" >/dev/null 2>&1 || say "could not delete group $u"
  fi
done

# 7) leftovers
LEFT=()
for d in server launcher pf; do
  launchctl print "system/$LABEL.$d" >/dev/null 2>&1 && LEFT+=("launchd job system/$LABEL.$d")
  [ -e "/Library/LaunchDaemons/$LABEL.$d.plist" ] && LEFT+=("/Library/LaunchDaemons/$LABEL.$d.plist")
done
for u in "$SRV_USER" "$AGT_USER"; do
  [ "$KEEP_ACCOUNTS" = 1 ] && break
  dscl . -read "/Users/$u" >/dev/null 2>&1 && LEFT+=("user $u (locked; delete it while logged in: sudo dscl . -delete /Users/$u, approve the prompt)")
  dscl . -read "/Groups/$u" >/dev/null 2>&1 && LEFT+=("group $u")
  pgrep -u "$u" >/dev/null 2>&1 && LEFT+=("processes of $u")
done
N=$(pfctl -a "$ANCHOR" -s rules 2>/dev/null | grep -c .)
[ "${N:-0}" -gt 0 ] && LEFT+=("pf anchor $ANCHOR ($N rules)")
[ -e "/etc/newsyslog.d/$ID.conf" ] && LEFT+=("/etc/newsyslog.d/$ID.conf")
[ -e "$LOGS" ] && LEFT+=("$LOGS")
for f in /var/at/cron.deny /var/at/at.deny; do [ -f "$f" ] && grep -qx "$AGT_USER" "$f" && LEFT+=("$f: $AGT_USER"); done
for p in app root config secrets run run-launcher agent setup status; do [ -e "$BASE/$p" ] && LEFT+=("$BASE/$p"); done
[ "$DELETE_DATA" = 1 ] && [ -e "$BASE" ] && LEFT+=("$BASE")
if [ ${#LEFT[@]} -gt 0 ]; then
  say "left over:"; printf '  %s\n' "${LEFT[@]}"; exit 1
fi
say "removed $ID"

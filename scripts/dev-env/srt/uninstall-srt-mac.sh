#!/bin/bash
# Remove the dev environment of a Mac team server (install-srt-mac.sh). scripts/install-macos.sh --no-dev-env and
# scripts/uninstall-macos.sh run it. Idempotent. Bash 3.2.
#
#   uninstall-srt-mac.sh --id ID --base BASE --server-user SRV --prefix PREFIX [--purge]
#
# Ends every run (every process of the slot accounts), removes the sudoers rule, the slot accounts and their group,
# the ACL entries on <base>/team and <base>/devenv, and /opt/trina when no other install uses it. --purge also deletes
# <base>/devenv (the runs' homes, logs and work folders of chats with no project).
set -uo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
OPT=/opt/trina
ID="" BASE="" SRV_USER="" PREFIX="" PURGE=0
die() { echo "uninstall-srt-mac: $*" >&2; exit 2; }
say() { echo "uninstall-srt-mac: $*" >&2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --id) ID=$2; shift 2 ;;
    --base) BASE=$2; shift 2 ;;
    --server-user) SRV_USER=$2; shift 2 ;;
    --prefix) PREFIX=$2; shift 2 ;;
    --purge) PURGE=1; shift ;;
    *) die "unknown option $1" ;;
  esac
done
[ "$(id -u)" = 0 ] || die "run as root"
[[ "$ID" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "bad --id"
[[ "$PREFIX" =~ ^_[a-z][a-z0-9]{0,30}dev$ ]] || die "--prefix must look like _axdev"
[[ "$SRV_USER" =~ ^_[a-z][a-z0-9]{2,30}$ ]] || die "bad --server-user"
limited() {  # seconds command... (macOS may wait for an administrator's approval to delete an account)
  local secs=$1 pid i; shift
  "$@" >/dev/null 2>&1 & pid=$!
  for i in $(seq 1 "$secs"); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" >/dev/null 2>&1; wait "$pid" >/dev/null 2>&1; return 124; fi
  wait "$pid"
}

# the ACL entries first, while the group still exists (an entry of a deleted group shows only its UUID). The inherited
# copies are not the same text, so the entries that name the slot group or the server account go; nothing else of an
# ACL there is touched
if [ -n "$BASE" ]; then
  for d in team devenv; do
    [ -d "$BASE/$d" ] && [ ! -L "$BASE/$d" ] || continue
    find "$BASE/$d" -print0 2>/dev/null | while IFS= read -r -d '' f; do
      # the highest index first, so the numbers of the ones still to remove stay right
      ls -led "$f" 2>/dev/null | awk -v g="group:$PREFIX" -v u="user:$SRV_USER" '$1 ~ /^[0-9]+:$/ && ($2 == g || $2 == u) { sub(":", "", $1); print $1 }' | sort -rn | while read -r i; do chmod -h -a# "$i" "$f" 2>/dev/null; done
    done
  done
  [ "$PURGE" = 1 ] && [ -d "$BASE/devenv" ] && [ ! -L "$BASE/devenv" ] && rm -rf "$BASE/devenv"
fi

rm -f "/etc/sudoers.d/$ID-devenv"
SLOT_USERS=$(dscl . -list /Users | grep -E "^${PREFIX}[0-9]{1,2}$" || true)
for u in $SLOT_USERS; do
  uid=$(id -u "$u" 2>/dev/null) || continue
  launchctl bootout "user/$uid" >/dev/null 2>&1 || true
  pkill -KILL -u "$uid" >/dev/null 2>&1 || true
done
for u in $SLOT_USERS; do
  limited 20 dscl . -create "/Users/$u" AuthenticationAuthority ';DisabledUser;'
  limited "${MYCEL_DELETE_TIMEOUT:-60}" dscl . -delete "/Users/$u"
  dscl . -read "/Users/$u" >/dev/null 2>&1 && say "macOS did not let this session delete $u (administrator approval needed); it stays locked"
done
if dscl . -read "/Groups/$PREFIX" >/dev/null 2>&1; then dseditgroup -o delete "$PREFIX" >/dev/null 2>&1 || dscl . -delete "/Groups/$PREFIX" >/dev/null 2>&1 || say "could not delete the group $PREFIX"; fi

# /opt/trina: only when no other install has a dev environment here
if ! ls /etc/sudoers.d/*-devenv >/dev/null 2>&1; then
  rm -rf "$OPT/srt" "$OPT/devenv" "$OPT"/node-v* "$OPT/node" "$OPT"/python3-* "$OPT/python3"
  rmdir "$OPT" 2>/dev/null || true
fi
say "done"

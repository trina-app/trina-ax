#!/bin/bash
# Removes the self-hosted release Mac runner that setup.sh made (docs/RELEASE-CI.md 13). Run as root:
#
#   sudo bash scripts/macos/release-runner/remove.sh
#
# Idempotent, holds no secret. Afterwards delete the one-time runner registrations left on GitHub (no sudo; the
# runner that was waiting for a job stays listed as offline until removed), revoke the fine-grained token on GitHub,
# and point RELEASE_MAC_RUNNER back at a hosted runner: see docs/RELEASE-CI.md 13 "지우기".
# This stops and deletes both LaunchDaemons, every process and launchd job of _trinaci, the pf rules (and our pf
# reference), the deny ACL on the admin's home, the cron.deny/at.deny lines, /Library/TrinaCI (with the stored token),
# the logs, the account's Apple temp/cache folders and files in /tmp, the TrinaCI volume (its /etc/fstab line too),
# and the _trinaci account and group.
set -uo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
U=_trinaci
V=/Volumes/TrinaCI
D=/Library/TrinaCI
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }

echo "== LaunchDaemons and processes"
launchctl bootout system/app.trina.ci.runner 2>/dev/null
launchctl bootout system/app.trina.ci.pf 2>/dev/null
rm -f /Library/LaunchDaemons/app.trina.ci.runner.plist /Library/LaunchDaemons/app.trina.ci.pf.plist
UID_=$(id -u "$U" 2>/dev/null || true)
if [ -n "$UID_" ]; then
  for d in DARWIN_USER_TEMP_DIR DARWIN_USER_CACHE_DIR; do
    p=$(sudo -u "$U" /usr/bin/getconf "$d" 2>/dev/null)
    case "$p" in /var/folders/*/[TC]/ | /private/var/folders/*/[TC]/) rm -rf "$p" ;; esac
  done
  for _ in 1 2 3 4 5; do
    pids=$(ps -axo pid=,uid= | awk -v u="$UID_" '$2 == u {print $1}')
    [ -z "$pids" ] && break
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null; sleep 1
  done
  launchctl bootout "user/$UID_" 2>/dev/null
  launchctl bootout "gui/$UID_" 2>/dev/null
  crontab -u "$U" -r 2>/dev/null
  find /private/tmp /private/var/tmp -xdev -user "$U" -delete 2>/dev/null
fi

echo "== pf"
pfctl -q -a com.apple/260.trina-ci -F all 2>/dev/null
pfctl -q -a com.apple/260.trina-ci -t trina_ci_lan6 -T kill 2>/dev/null
if [ -f "$D/run/pf.token" ]; then
  sed -n 's/^token=//p' "$D/run/pf.token" | while read -r t; do pfctl -X "$t" 2>/dev/null; done
fi

echo "== deny ACL, cron.deny, at.deny"
H=""
[ -f "$D/owner-home" ] && H=$(cat "$D/owner-home")
[ -z "$H" ] && [ -n "${SUDO_USER:-}" ] && H=$(dscl . -read "/Users/$SUDO_USER" NFSHomeDirectory | awk '{print $2}')
[ -n "$H" ] && [ -d "$H" ] && chmod -a "user:$U deny list,search,readattr,readextattr,readsecurity" "$H" 2>/dev/null
for f in /usr/lib/cron/cron.deny /usr/lib/cron/at.deny; do
  [ -f "$f" ] && sed -i '' "/^$U\$/d" "$f"
done

echo "== files"
[ -d "$D" ] && chflags -R nouchg "$D" && rm -rf "$D"
rm -rf /private/var/log/trina-ci

echo "== volume"
if diskutil info "$V" >/dev/null 2>&1; then
  UUID=$(diskutil info -plist "$V" | plutil -extract VolumeUUID raw -)
  DEV=$(diskutil info -plist "$V" | plutil -extract DeviceIdentifier raw -)
  chflags -R nouchg "$V" 2>/dev/null
  diskutil apfs deleteVolume "$DEV"
  [ -n "$UUID" ] && sed -i '' "/UUID=$UUID/d" /etc/fstab
fi

echo "== account"
dscl . -delete "/Users/$U" 2>/dev/null
dscl . -delete "/Groups/$U" 2>/dev/null
echo "remove.sh: done"

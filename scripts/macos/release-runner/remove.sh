#!/bin/bash
# Removes the self-hosted release Mac runner that setup.sh made (docs/RELEASE-CI.md 13). Run as root:
#
#   sudo bash scripts/macos/release-runner/remove.sh
#
# Deregister the runner on GitHub first (no sudo): Settings → Actions → Runners → trina-mac-1 → Remove, or
#   gh api -X DELETE repos/trina-app/trina-ax/actions/runners/$(gh api repos/trina-app/trina-ax/actions/runners \
#     --jq '.runners[] | select(.name=="trina-mac-1") | .id')
# Then this stops and deletes the LaunchDaemons, the pf rules (and our pf reference), the deny ACL on the admin's home,
# /Library/TrinaCI, the logs, the TrinaCI volume (its /etc/fstab line too) and the _trinaci account and group.
set -uo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
U=_trinaci
V=/Volumes/TrinaCI
D=/Library/TrinaCI
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
OWNER=${SUDO_USER:-}

echo "== LaunchDaemons"
launchctl bootout system/app.trina.ci.runner 2>/dev/null
launchctl bootout system/app.trina.ci.pf 2>/dev/null
rm -f /Library/LaunchDaemons/app.trina.ci.runner.plist /Library/LaunchDaemons/app.trina.ci.pf.plist

echo "== pf"
pfctl -q -a com.apple/260.trina-ci -F all 2>/dev/null
if [ -f "$D/run/pf.token" ]; then
  sed -n 's/^token=//p' "$D/run/pf.token" | while read -r t; do pfctl -X "$t" 2>/dev/null; done
fi

echo "== deny ACL"
if [ -n "$OWNER" ]; then
  H=$(dscl . -read "/Users/$OWNER" NFSHomeDirectory | awk '{print $2}')
  chmod -a "user:$U deny list,search,readattr,readextattr,readsecurity" "$H" 2>/dev/null
fi

echo "== files"
[ -d "$D" ] && chflags -R nouchg "$D" && rm -rf "$D"
rm -rf /private/var/log/trina-ci /private/var/log/trina-ci-pf.log

echo "== volume"
if diskutil info "$V" >/dev/null 2>&1; then
  UUID=$(diskutil info -plist "$V" | plutil -extract VolumeUUID raw -)
  DEV=$(diskutil info -plist "$V" | plutil -extract DeviceIdentifier raw -)
  chflags -R nouchg "$V/runner" 2>/dev/null
  diskutil apfs deleteVolume "$DEV"
  [ -n "$UUID" ] && sed -i '' "/UUID=$UUID/d" /etc/fstab
fi

echo "== account"
dscl . -delete "/Users/$U" 2>/dev/null
dscl . -delete "/Groups/$U" 2>/dev/null
echo "remove.sh: done"

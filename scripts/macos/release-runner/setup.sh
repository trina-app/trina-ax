#!/bin/bash
# Sets up the self-hosted release Mac runner on this Mac (docs/RELEASE-CI.md 13). Run by an admin, as root:
#
#   sudo bash scripts/macos/release-runner/setup.sh [token-file|-]
#
# Idempotent: run it again after a change or to repair; remove.sh undoes it. The script holds no secret.
# The one secret is a fine-grained GitHub token (resource owner trina-app, only the repository trina-ax, repository
# permission "Administration: Read and write"), which root's supervisor uses to ask GitHub for a one-time runner per
# job. It is stored as /Library/TrinaCI/secrets/github-auth.header (root 600; the runner account cannot read it).
# It is needed only when none is stored yet (or to replace it): from the file given (read, then deleted), else typed
# at a hidden prompt. Never printed, never in argv.
# Downloads it expects (pinned versions and sha256 below), in ~/.tfx/mac-runner-stage/ of the admin:
#   actions-runner-osx-arm64-$RUNNER_VERSION.tar.gz, node-$NODE_VERSION-darwin-arm64.tar.gz
# What it makes:
#   - the hidden standard account _trinaci (own group, not staff, not admin, no password, no login shell), listed in
#     cron.deny and at.deny;
#   - the APFS volume TrinaCI with a 60 GB quota, mounted nobrowse at /Volumes/TrinaCI (no Finder/Desktop icon), root
#     755; the account's HOME, TMPDIR and runner live there, so builds cannot fill the system disk;
#   - a deny ACL for _trinaci on the admin's home (on top of its 750 mode and the staff group it is not in);
#   - /Library/TrinaCI (root-owned): supervisor.sh, the job hooks, the sandbox profile, the pf rules and their loader,
#     the runner and Node.js programs (runner-dist/, node/), secrets/ (700), run/ (pf state);
#   - LaunchDaemons app.trina.ci.pf (root: pf rules, boot + every minute) and app.trina.ci.runner (root's
#     supervisor.sh: per job a fresh one-time runner as _trinaci, label trina-mac-release only).
# No certificate, key or password is stored for the account: mac-app.yml makes a keychain of the job from the
# repository secrets and deletes it. Ends with checks that print PASS/FAIL (no secrets).
set -euo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin

U=_trinaci
V=/Volumes/TrinaCI
VOLNAME=TrinaCI
QUOTA=60g
D=/Library/TrinaCI
LOGDIR=/private/var/log/trina-ci
RUNNER_VERSION=2.338.2
RUNNER_SHA256=25a065af409ffa317ab4d5a3b614dd15fc9c40f2172bc1b35a1b1258e919a388
NODE_VERSION=v22.23.5
NODE_SHA256=e7131995759b61a0170b646010d2ad35a5d37b4cb0d471f3e8317eac6f742f3d
REPO_API=https://api.github.com/repos/trina-app/trina-ax
JOB_PATH=/usr/bin:/bin:/usr/sbin:/sbin:$D/node/bin

HERE=$(cd "$(dirname "$0")" && pwd)
say() { printf '\n== %s\n' "$*"; }
die() { echo "setup.sh: $*" >&2; exit 1; }
regular() { [ -f "$1" ] && [ ! -L "$1" ]; }

[ "$(id -u)" = 0 ] || die "run with sudo"
[ "$(uname -m)" = arm64 ] || die "Apple silicon only"
OWNER=${SUDO_USER:?run with sudo from the admin account}
OWNER_HOME=$(dscl . -read "/Users/$OWNER" NFSHomeDirectory | awk '{print $2}')
[ -d "$OWNER_HOME" ] || die "no home for $OWNER"
STAGE="$OWNER_HOME/.tfx/mac-runner-stage"
RUNNER_TGZ="$STAGE/actions-runner-osx-arm64-$RUNNER_VERSION.tar.gz"
NODE_TGZ="$STAGE/node-$NODE_VERSION-darwin-arm64.tar.gz"
TOKEN_FILE=${1:--}
TOKEN=""
if [ "$TOKEN_FILE" != - ]; then
  regular "$TOKEN_FILE" || die "no token file $TOKEN_FILE"
  TOKEN=$(tr -d '[:space:]' < "$TOKEN_FILE"); rm -f "$TOKEN_FILE"
  [ -n "$TOKEN" ] || die "empty token"
fi
regular "$RUNNER_TGZ" && [ "$(shasum -a 256 "$RUNNER_TGZ" | awk '{print $1}')" = "$RUNNER_SHA256" ] || die "runner tarball missing or sha256 mismatch: $RUNNER_TGZ"
regular "$NODE_TGZ" && [ "$(shasum -a 256 "$NODE_TGZ" | awk '{print $1}')" = "$NODE_SHA256" ] || die "Node.js tarball missing or sha256 mismatch: $NODE_TGZ"

say "account $U"
if ! dscl . -read "/Users/$U" >/dev/null 2>&1; then
  id_=""
  for i in $(seq 450 499); do
    if ! dscl . -list /Users UniqueID | awk '{print $2}' | grep -qx "$i" && ! dscl . -list /Groups PrimaryGroupID | awk '{print $2}' | grep -qx "$i"; then id_=$i; break; fi
  done
  [ -n "$id_" ] || die "no free id in 450-499"
  dscl . -create "/Groups/$U"
  dscl . -create "/Groups/$U" PrimaryGroupID "$id_"
  dscl . -create "/Groups/$U" RealName "Trina release CI"
  dscl . -create "/Groups/$U" Password '*'
  dscl . -create "/Users/$U"
  dscl . -create "/Users/$U" UniqueID "$id_"
  dscl . -create "/Users/$U" PrimaryGroupID "$id_"
  dscl . -create "/Users/$U" RealName "Trina release CI"
  dscl . -create "/Users/$U" UserShell /usr/bin/false
  dscl . -create "/Users/$U" NFSHomeDirectory "$V/home"
  dscl . -create "/Users/$U" Password '*'
  dscl . -create "/Users/$U" IsHidden 1
fi
for g in admin staff; do
  dsmemberutil checkmembership -U "$U" -G "$g" | grep -q 'is not a member' || die "$U is a member of $g"
done
for f in /usr/lib/cron/cron.deny /usr/lib/cron/at.deny; do
  touch "$f"; grep -qx "$U" "$f" || echo "$U" >> "$f"
done

say "volume $VOLNAME ($QUOTA quota, nobrowse)"
if ! diskutil info "$V" >/dev/null 2>&1; then
  CONTAINER=$(diskutil info -plist / | plutil -extract APFSContainerReference raw -)
  DEV=$(diskutil apfs addVolume "$CONTAINER" APFS "$VOLNAME" -quota "$QUOTA" -nomount | sed -n 's/.*Disk from APFS operation: \(disk[0-9s]*\).*/\1/p')
  [ -n "$DEV" ] || die "addVolume gave no disk"
  UUID=$(diskutil info -plist "$DEV" | plutil -extract VolumeUUID raw -)
  grep -q "UUID=$UUID" /etc/fstab 2>/dev/null || printf 'UUID=%s none apfs rw,nobrowse\n' "$UUID" >> /etc/fstab
  diskutil mount "$DEV" >/dev/null
fi
diskutil info "$V" >/dev/null || die "$V is not mounted"
mount | grep " on $V " | grep -q nobrowse || echo "note: $V is mounted without nobrowse"
diskutil enableOwnership "$V" >/dev/null
mdutil -i off "$V" >/dev/null 2>&1 || true
tmutil addexclusion -v "$V" >/dev/null 2>&1 || true
[ ! -L "$V" ] || die "$V is a symbolic link"
chown root:wheel "$V"; chmod 755 "$V"

say "control folder $D"
launchctl bootout system/app.trina.ci.runner 2>/dev/null || true
install -d -o root -g wheel -m 755 "$D" "$D/run"
install -d -o root -g wheel -m 700 "$D/secrets"
chflags -R nouchg "$D" 2>/dev/null || true
install -o root -g wheel -m 755 "$HERE/supervisor.sh" "$HERE/job-started.sh" "$HERE/job-completed.sh" "$HERE/pf-load.sh" "$D/"
install -o root -g wheel -m 644 "$HERE/runner.sb" "$HERE/pf.anchor" "$D/"
printf '%s\n' "$OWNER_HOME" > "$D/owner-home"; chmod 644 "$D/owner-home"
rm -rf "$D/runner-dist" "$D/node"
install -d -o root -g wheel -m 755 "$D/runner-dist" "$D/node"
tar -xzf "$RUNNER_TGZ" -C "$D/runner-dist"
tar -xzf "$NODE_TGZ" -C "$D/node" --strip-components 1
chown -R root:wheel "$D/runner-dist" "$D/node"
chmod -R go-w "$D/runner-dist" "$D/node"
chflags -R uchg "$D/runner-dist" "$D/node"
install -d -o root -g wheel -m 755 "$LOGDIR"

say "GitHub token (root only)"
HEADER="$D/secrets/github-auth.header"
if [ -z "$TOKEN" ] && regular "$HEADER"; then
  echo "a token is stored: keeping it (give a token file to replace it)"
else
  if [ -z "$TOKEN" ]; then
    [ -t 0 ] || die "no token stored: give a token file, or run in a terminal to type it"
    IFS= read -rs -p "Fine-grained GitHub token (hidden): " TOKEN; echo
    [ -n "$TOKEN" ] || die "empty token"
  fi
  umask 077
  T=$(mktemp "$D/secrets/.hdr.XXXXXX")
  printf 'Authorization: Bearer %s\n' "$TOKEN" > "$T"
  mv -f "$T" "$HEADER"
  umask 022
fi
TOKEN=""
chown root:wheel "$HEADER"; chmod 600 "$HEADER"
code=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -H @"$HEADER" -H 'Accept: application/vnd.github+json' "$REPO_API/actions/runners")
[ "$code" = 200 ] || die "the stored token cannot list the repository's runners (HTTP $code): it needs Administration on trina-app/trina-ax"
echo "token works (HTTP 200)"

say "deny ACL for $U on $OWNER_HOME"
ls -led "$OWNER_HOME" | grep -q "user:$U deny" || chmod +a "user:$U deny list,search,readattr,readextattr,readsecurity" "$OWNER_HOME"

say "LaunchDaemons"
cat > /Library/LaunchDaemons/app.trina.ci.pf.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.trina.ci.pf</string>
  <key>ProgramArguments</key><array><string>$D/pf-load.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>$LOGDIR/pf.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/pf.log</string>
</dict></plist>
EOF
cat > /Library/LaunchDaemons/app.trina.ci.runner.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.trina.ci.runner</string>
  <key>ProgramArguments</key><array><string>$D/supervisor.sh</string></array>
  <key>WorkingDirectory</key><string>/</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>SessionCreate</key><true/>
  <key>Nice</key><integer>5</integer>
  <key>ExitTimeOut</key><integer>60</integer>
  <key>StandardOutPath</key><string>$LOGDIR/runner.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/runner.log</string>
</dict></plist>
EOF
chown root:wheel /Library/LaunchDaemons/app.trina.ci.pf.plist /Library/LaunchDaemons/app.trina.ci.runner.plist
chmod 644 /Library/LaunchDaemons/app.trina.ci.pf.plist /Library/LaunchDaemons/app.trina.ci.runner.plist
launchctl bootout system/app.trina.ci.pf 2>/dev/null || true
launchctl bootstrap system /Library/LaunchDaemons/app.trina.ci.pf.plist
for _ in $(seq 1 20); do [ -f "$D/run/pf.ok" ] && break; sleep 1; done
[ -f "$D/run/pf.ok" ] || die "pf rules did not load (see $LOGDIR/pf.log)"

say "checks (as $U, before the runner starts)"
install -d -o "$U" -g "$U" -m 700 "$V/home" "$V/tmp"
fails=0
as() { sudo -u "$U" /usr/bin/env -i HOME="$V/home" TMPDIR="$V/tmp/" PATH="$JOB_PATH" "$@"; }
sbx() { as /usr/bin/sandbox-exec -f "$D/runner.sb" "$@"; }
denied() { local d=$1; shift; if "$@" >/dev/null 2>&1; then echo "FAIL $d"; fails=$((fails + 1)); else echo "PASS $d"; fi; }
works() { local d=$1; shift; if "$@" >/dev/null 2>&1; then echo "PASS $d"; else echo "FAIL $d"; fails=$((fails + 1)); fi; }
denied "cannot list $OWNER_HOME" as ls "$OWNER_HOME"
denied "cannot read $OWNER_HOME/.ssh" as ls "$OWNER_HOME/.ssh"
denied "cannot read $OWNER_HOME/.config" as ls "$OWNER_HOME/.config"
denied "cannot read $OWNER_HOME/Library/Keychains" as ls "$OWNER_HOME/Library/Keychains"
denied "cannot read the GitHub token" as cat "$HEADER"
denied "no crontab" as crontab -l
denied "sandbox: no /Users/Shared" sbx ls /Users/Shared
denied "sandbox: no launchctl" sbx /bin/launchctl list
LOCAL_PORT=$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '$9 ~ /^127\.0\.0\.1:/ {sub(/.*:/, "", $9); print $9; exit}')
ANY_PORT=$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '$9 ~ /^\*:/ {sub(/.*:/, "", $9); print $9; exit}')
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
if [ -n "$LOCAL_PORT" ]; then denied "pf: no TCP to 127.0.0.1:$LOCAL_PORT" as nc -z -G 3 127.0.0.1 "$LOCAL_PORT"; fi
if [ -n "$ANY_PORT" ] && [ -n "$LAN_IP" ]; then denied "pf: no TCP to this Mac's LAN address :$ANY_PORT" as nc -z -G 3 "$LAN_IP" "$ANY_PORT"; fi
SOCK=$(find /private/tmp -maxdepth 2 -type s -perm -o+w 2>/dev/null | head -1)
if [ -n "$SOCK" ]; then denied "sandbox: no world-writable socket in /tmp" sbx nc -U -z "$SOCK"; fi
works "internet: api.github.com (pf + sandbox)" sbx curl -fsS -m 20 -o /dev/null https://api.github.com/zen
works "internet: Apple notary service" sbx curl -sS -m 20 -o /dev/null https://appstoreconnect.apple.com
works "sandbox: swiftc" sbx xcrun swiftc --version
works "sandbox: notarytool" sbx xcrun --find notarytool
works "sandbox: node" sbx node --version
KC="$V/tmp/selftest.keychain-db"
works "sandbox: a job keychain" sbx /bin/bash -c "security create-keychain -p selftest '$KC' && security unlock-keychain -p selftest '$KC' && security delete-keychain '$KC'"
IMG="$V/tmp/selftest.dmg"
works "sandbox: hdiutil create/attach/detach like dmg-builder" sbx /bin/bash -c "hdiutil create -quiet -size 20m -fs HFS+ -volname 'Trina AX selftest' '$IMG' && dev=\$(hdiutil attach -nobrowse -noautoopen -noverify '$IMG' | awk '/Apple_HFS/ {print \$1}') && touch '/Volumes/Trina AX selftest/x' && hdiutil detach -quiet \"\$dev\" && rm -f '$IMG'"
rm -rf "$V/home" "$V/tmp"

say "runner"
launchctl bootstrap system /Library/LaunchDaemons/app.trina.ci.runner.plist
for _ in $(seq 1 30); do grep -q "waiting for a job" "$LOGDIR/runner.log" 2>/dev/null && break; sleep 2; done
works "a one-time runner is waiting for a job" grep -q "waiting for a job" "$LOGDIR/runner.log"
echo
if [ "$fails" = 0 ]; then echo "setup.sh: done, all checks passed"; else echo "setup.sh: done, $fails check(s) FAILED"; exit 1; fi

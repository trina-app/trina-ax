#!/bin/bash
# Sets up the self-hosted release Mac runner on this Mac (docs/RELEASE-CI.md 13). Run once by an admin, as root:
#
#   sudo bash scripts/macos/release-runner/setup.sh <registration-token-file> <actions-runner-osx-arm64-VERSION.tar.gz>
#
# The token file holds a repository runner registration token (gh api -X POST
# repos/trina-app/trina-ax/actions/runners/registration-token --jq .token); it is read and deleted, never printed.
# What it makes (remove.sh undoes all of it):
#   - the hidden standard account _trinaci (own group, not staff, not admin, no password, no login shell);
#   - the APFS volume TrinaCI with a quota (60 GB), mounted nobrowse at /Volumes/TrinaCI (no Finder/Desktop icon),
#     with HOME (home/), TMPDIR (tmp/) and the runner (runner/) of that account; builds cannot fill the system disk;
#   - a deny ACL for _trinaci on the admin's home (on top of its 750 mode and the staff group it is not in);
#   - /Library/TrinaCI (root-owned): run.sh, the job hooks, the sandbox profile, the pf rules and their loader;
#   - LaunchDaemons app.trina.ci.pf (root: pf rules, boot + every 5 min) and app.trina.ci.runner (as _trinaci);
#   - the runner registered to trina-app/trina-ax as trina-mac-1 with ONLY the label trina-mac-release (no default
#     self-hosted/macOS/ARM64 labels), no auto-update; its programs and .env/.path are root-owned and immutable.
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
REPO_URL=https://github.com/trina-app/trina-ax
RUNNER_NAME=trina-mac-1
LABEL=trina-mac-release
JOB_PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin

HERE=$(cd "$(dirname "$0")" && pwd)
say() { printf '\n== %s\n' "$*"; }
die() { echo "setup.sh: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run with sudo"
[ "$(uname -m)" = arm64 ] || die "Apple silicon only"
TOKEN_FILE=${1:?registration token file}
TARBALL=${2:?actions-runner-osx-arm64-$RUNNER_VERSION.tar.gz}
OWNER=${SUDO_USER:?run with sudo from the admin account}
OWNER_HOME=$(dscl . -read "/Users/$OWNER" NFSHomeDirectory | awk '{print $2}')
[ -d "$OWNER_HOME" ] || die "no home for $OWNER"
TOKEN=$(tr -d '[:space:]' < "$TOKEN_FILE"); rm -f "$TOKEN_FILE"
[ -n "$TOKEN" ] || die "empty registration token"
[ "$(shasum -a 256 "$TARBALL" | awk '{print $1}')" = "$RUNNER_SHA256" ] || die "runner tarball sha256 mismatch"

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
chown root:wheel "$V"; chmod 755 "$V"
install -d -o "$U" -g "$U" -m 700 "$V/home" "$V/tmp"

say "control folder $D"
install -d -o root -g wheel -m 755 "$D" "$D/run"
install -o root -g wheel -m 755 "$HERE/run.sh" "$HERE/job-started.sh" "$HERE/job-completed.sh" "$HERE/pf-load.sh" "$D/"
install -o root -g wheel -m 644 "$HERE/runner.sb" "$HERE/pf.anchor" "$D/"
install -d -o "$U" -g "$U" -m 750 "$LOGDIR"

say "deny ACL for $U on $OWNER_HOME"
ls -led "$OWNER_HOME" | grep -q "user:$U deny" || chmod +a "user:$U deny list,search,readattr,readextattr,readsecurity" "$OWNER_HOME"

say "runner $RUNNER_VERSION in $V/runner"
R="$V/runner"
launchctl bootout system/app.trina.ci.runner 2>/dev/null || true
if [ -d "$R" ]; then chflags -R nouchg "$R"; fi
if [ ! -x "$R/config.sh" ]; then
  install -d -o root -g wheel -m 755 "$R"
  tar -xzf "$TARBALL" -C "$R"
fi
chown -R root:wheel "$R"
install -d -o "$U" -g "$U" -m 700 "$R/_diag" "$R/_work"
# the runner writes its registration (.runner, .credentials*) into its own folder
chown "$U:$U" "$R"; chmod 755 "$R"
rm -f "$R/.env" "$R/.path" "$R/.runner" "$R/.credentials" "$R/.credentials_rsaparams"
( cd "$R" && sudo -u "$U" env -i HOME="$V/home" TMPDIR="$V/tmp/" PATH="$JOB_PATH" LANG=en_US.UTF-8 \
    ./config.sh --unattended --url "$REPO_URL" --token "$TOKEN" --name "$RUNNER_NAME" --labels "$LABEL" \
    --no-default-labels --work _work --disableupdate --replace >/dev/null ) || die "config.sh failed (token expired? make a new one)"
unset TOKEN
for f in .runner .credentials .credentials_rsaparams; do [ -f "$R/$f" ] && chmod 600 "$R/$f"; done
# root-owned, immutable: what the runner runs and the environment of every job (hooks, PATH)
rm -f "$R/.env" "$R/.path"
cat > "$R/.env" <<EOF
LANG=en_US.UTF-8
ACTIONS_RUNNER_HOOK_JOB_STARTED=$D/job-started.sh
ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$D/job-completed.sh
EOF
printf '%s\n' "$JOB_PATH" > "$R/.path"
chown root:wheel "$R/.env" "$R/.path"; chmod 644 "$R/.env" "$R/.path"
# (run.sh copies run-helper.sh.template to run-helper.sh at every start, so that one stays writable)
for f in bin externals .env .path config.sh env.sh run.sh run-helper.sh.template run-helper.cmd.template safe_sleep.sh svc.sh; do
  [ -e "$R/$f" ] && chflags uchg "$R/$f"
done
[ -d "$R/bin" ] && chflags -R uchg "$R/bin" "$R/externals"

say "LaunchDaemons"
cat > /Library/LaunchDaemons/app.trina.ci.pf.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.trina.ci.pf</string>
  <key>ProgramArguments</key><array><string>$D/pf-load.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>/private/var/log/trina-ci-pf.log</string>
  <key>StandardErrorPath</key><string>/private/var/log/trina-ci-pf.log</string>
</dict></plist>
EOF
cat > /Library/LaunchDaemons/app.trina.ci.runner.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.trina.ci.runner</string>
  <key>UserName</key><string>$U</string>
  <key>GroupName</key><string>$U</string>
  <key>ProgramArguments</key><array><string>$D/run.sh</string></array>
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
[ -f "$D/run/pf.ok" ] || die "pf rules did not load (see /private/var/log/trina-ci-pf.log)"
launchctl bootout system/app.trina.ci.runner 2>/dev/null || true
launchctl bootstrap system /Library/LaunchDaemons/app.trina.ci.runner.plist

say "checks (as $U)"
fails=0
as() { sudo -u "$U" env -i HOME="$V/home" TMPDIR="$V/tmp/" PATH="$JOB_PATH" "$@"; }
sbx() { as /usr/bin/sandbox-exec -f "$D/runner.sb" "$@"; }
denied() { local d=$1; shift; if "$@" >/dev/null 2>&1; then echo "FAIL $d"; fails=$((fails + 1)); else echo "PASS $d"; fi; }
works() { local d=$1; shift; if "$@" >/dev/null 2>&1; then echo "PASS $d"; else echo "FAIL $d"; fails=$((fails + 1)); fi; }
denied "cannot list $OWNER_HOME" as ls "$OWNER_HOME"
denied "cannot read $OWNER_HOME/.ssh" as ls "$OWNER_HOME/.ssh"
denied "cannot read $OWNER_HOME/.config" as ls "$OWNER_HOME/.config"
denied "cannot read $OWNER_HOME/Library/Keychains" as ls "$OWNER_HOME/Library/Keychains"
denied "sandbox: no /Users/Shared" sbx ls /Users/Shared
works "own home is writable" as touch "$V/home/.selftest"
as rm -f "$V/home/.selftest"
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
KC="$V/tmp/selftest.keychain-db"
works "sandbox: a job keychain" sbx /bin/bash -c "security create-keychain -p selftest '$KC' && security unlock-keychain -p selftest '$KC' && security delete-keychain '$KC'"
sleep 10
works "runner is running" pgrep -u "$U" -f Runner.Listener
echo
if [ "$fails" = 0 ]; then echo "setup.sh: done, all checks passed"; else echo "setup.sh: done, $fails check(s) FAILED"; exit 1; fi

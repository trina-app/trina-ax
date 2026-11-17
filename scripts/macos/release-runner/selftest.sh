#!/bin/bash
# Checks of the self-hosted release Mac runner in the context the jobs run in (docs/RELEASE-CI.md 13): started by
# setup.sh as a one-shot LaunchDaemon app.trina.ci.selftest (root, SessionCreate, like app.trina.ci.runner), it runs
# each check as _trinaci inside the sandbox, the way supervisor.sh starts the runner. Writes PASS/FAIL lines to
# /Library/TrinaCI/run/selftest.out and "done" to selftest.done. No secrets: the signing check uses a throwaway
# self-signed identity (codesign itself needs a trusted identity, so the first release job is its real test).
set -u
PATH=/usr/bin:/bin:/usr/sbin:/sbin
U=_trinaci
V=/Volumes/TrinaCI
D=/Library/TrinaCI
OUT="$D/run/selftest.out"
JOB_PATH=/usr/bin:/bin:/usr/sbin:/sbin:$D/node/bin
[ "$(id -u)" = 0 ] || exit 1
rm -f "$OUT" "$D/run/selftest.done"
exec > "$OUT" 2>&1
install -d -o "$U" -g "$U" -m 700 "$V/home" "$V/tmp"
sbx() { sudo -u "$U" /usr/bin/env -i HOME="$V/home" TMPDIR="$V/tmp/" USER="$U" LOGNAME="$U" PATH="$JOB_PATH" \
  /usr/bin/sandbox-exec -f "$D/runner.sb" "$@"; }
works() { local d=$1; shift; if "$@" >/dev/null 2>&1; then echo "PASS $d"; else echo "FAIL $d"; fi; }

works "daemon context: internet (api.github.com)" sbx curl -fsS -m 20 -o /dev/null https://api.github.com/zen
works "daemon context: swiftc" sbx xcrun swiftc --version
works "daemon context: notarytool" sbx xcrun notarytool --version
works "daemon context: node" sbx node --version
works "daemon context: job keychain, .p12 import, key partition list (as mac-app.yml)" sbx /bin/bash -c '
  set -e; t=$(mktemp -d "$TMPDIR/kc.XXXXXX"); cd "$t"
  printf "[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=ext\n[dn]\nCN=Trina CI selftest\n[ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n" > o.cnf
  openssl req -x509 -newkey rsa:2048 -nodes -keyout k.pem -out c.pem -days 1 -config o.cnf
  openssl pkcs12 -export -inkey k.pem -in c.pem -out t.p12 -passout pass:selftest -name "Trina CI selftest"
  kc="$t/devid.keychain-db"; pw=$(openssl rand -base64 32)
  security create-keychain -p "$pw" "$kc"; security set-keychain-settings -lut 7200 "$kc"; security unlock-keychain -p "$pw" "$kc"
  security import t.p12 -k "$kc" -P selftest -x -T /usr/bin/codesign
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$pw" "$kc"
  security list-keychains -d user -s "$kc"
  security find-identity -p codesigning "$kc" | grep -q "Trina CI selftest"
  security delete-keychain "$kc"; security list-keychains -d user -s; cd /; rm -rf "$t"'
works "daemon context: hdiutil create/attach/write/detach under /Volumes/Trina AX (as dmg-builder)" sbx /bin/bash -c '
  set -e; img="$TMPDIR/selftest.dmg"
  hdiutil create -quiet -size 20m -fs HFS+ -volname "Trina AX selftest" "$img"
  dev=$(hdiutil attach -nobrowse -noautoopen -noverify "$img" | awk "/Apple_HFS/ {print \$1}")
  touch "/Volumes/Trina AX selftest/x"; hdiutil detach -quiet "$dev"; rm -f "$img"'
rm -rf "$V/home" "$V/tmp"
echo "done" > "$D/run/selftest.done"

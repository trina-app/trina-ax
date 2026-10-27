#!/bin/bash
# Runs INSIDE a privileged debian:trixie container (tests/cloud/enroll-docker.sh). /t holds mycel-enroll, fakecp and
# this script. Proves on a real kernel: blank-disk detection, mkfs.ext4 -L axdata, mount at BASE, the seed copy with
# fixed uids, file owners/modes, the enroll HTTP exchange, reattach (mount by label, no format), and that a disk with a
# filesystem is never formatted.
set -euo pipefail
pass=0
ok() { echo "  ok  $*"; pass=$((pass + 1)); }
die() { echo "  FAIL $*" >&2; exit 1; }

LOOPS=()
cleanup() {
  set +e
  umount /var/lib/mycel 2>/dev/null
  for l in "${LOOPS[@]}"; do losetup -d "$l" 2>/dev/null; done
  kill %1 2>/dev/null
}
trap cleanup EXIT

export DEBIAN_FRONTEND=noninteractive
apt-get -qq update >/dev/null && apt-get -qq install -y --no-install-recommends e2fsprogs >/dev/null

# accounts with the fixed uids of the image build (interfaces: axserver 990, axagent 991)
groupadd --system -g 990 axserver && useradd --system -u 990 -g axserver -M -s /usr/sbin/nologin axserver
groupadd --system -g 991 axagent && useradd --system -u 991 -g axagent -M -s /usr/sbin/nologin axagent

# a seed like the kit's image mode would leave in /usr/lib/mycel/seed-base
S=/usr/lib/mycel/seed-base
install -d -m 755 $S $S/root $S/app $S/app/versions/0.3.0
install -d -m 700 -o axserver -g axserver $S/data $S/config $S/secrets $S/team
echo 0.3.0 > $S/root/VERSION
ln -s versions/0.3.0 $S/app/current
cat > $S/root/mycel-ctl <<'CTL'
#!/bin/sh
# fake mycel-ctl: record the call and stdin
{ echo "ARGS $*"; cat; echo; } >> /tmp/ctl.log
echo '{"ok":true}'
CTL
chmod 755 $S/root/mycel-ctl
echo '{"mode":"prod","listen":{"host":"127.0.0.1","port":47820},"engine":{"authMode":"subscription","proxyPort":47821},"relay":{"url":null,"teamName":null,"officialAvailable":false}}' > $S/config/server.json
chown axserver:axserver $S/config/server.json && chmod 600 $S/config/server.json
mkdir -p /etc/default /etc/cloud /run/ax
echo "OTHER=1" > /etc/default/mycel

# two loop disks: a blank one (the data disk) and one that already has a filesystem
truncate -s 96M /disk-data.img /disk-other.img
D=$(losetup -f --show /disk-data.img); LOOPS+=("$D")
mkfs.ext4 -q -L someone-else /disk-other.img
O=$(losetup -f --show /disk-other.img); LOOPS+=("$O")
echo "data disk $D, foreign disk $O"

/t/fakecp -token ent_dockertest_abcdefghijk >/tmp/fakecp.log 2>&1 &
for _ in $(seq 50); do (exec 3<>/dev/tcp/127.0.0.1/18080) 2>/dev/null && break; sleep 0.1; done

enroll_json() { # mode token
  printf '{"v":1,"tenantId":"01JC8ZK3Q4M5N6P7R8S9T0V1W2","controlPlane":"http://127.0.0.1:18080","enrollToken":%s,"mode":"%s","teamSlug":"acme","relayTeamId":null,"timeZone":"Asia/Seoul","locale":"ko","backupWindowStartMin":150,"maintenanceWindowStartMin":270}' "$2" "$1" > /run/ax/enroll.json
  chmod 600 /run/ax/enroll.json
}

echo "-- a disk with a filesystem is never formatted"
enroll_json new '"ent_dockertest_abcdefghijk"'
if /t/mycel-enroll --data-device "$O" --no-start; then die "formatted a foreign disk"; fi
grep -q '"code":"data_disk_not_blank"' /run/ax/enroll-status.json || die "status: $(cat /run/ax/enroll-status.json)"
[ "$(blkid -s LABEL -o value "$O")" = someone-else ] || die "foreign disk label changed"
mountpoint -q /var/lib/mycel && die "mounted something"
ok "foreign disk refused (data_disk_not_blank), label untouched"

echo "-- new: format, mount, seed, enroll"
/t/mycel-enroll --data-device "$D" --no-start
grep -q '"state":"ok"' /run/ax/enroll-status.json || die "status: $(cat /run/ax/enroll-status.json)"
ok "status ok: $(cat /run/ax/enroll-status.json)"
[ "$(findmnt -n -o SOURCE,FSTYPE,LABEL /var/lib/mycel | tr -s ' ')" = "$D ext4 axdata" ] || die "mount: $(findmnt /var/lib/mycel)"
ok "data disk mounted at /var/lib/mycel (ext4, label axdata)"
[ "$(cat /var/lib/mycel/root/VERSION)" = 0.3.0 ] || die "seed not copied"
[ "$(stat -c '%U %G %a' /var/lib/mycel/data)" = "axserver axserver 700" ] || die "data owner $(stat -c '%U %G %a' /var/lib/mycel/data)"
ok "seed copied onto the data disk with owners kept"
[ "$(stat -c '%U %G %a' /var/lib/mycel/data/setup-token)" = "axserver axserver 600" ] || die "setup-token $(stat -c '%U %G %a' /var/lib/mycel/data/setup-token)"
[ "$(cat /var/lib/mycel/data/setup-token)" = stp_dockertest_0123456789abcdef ] || die "setup-token content"
ok "setup-token 0600 axserver"
[ "$(stat -c '%U %a' /var/lib/mycel/data/relay/team-key.pem)" = "axserver 600" ] || die "team key owner"
grep -q 'BEGIN PRIVATE KEY' /var/lib/mycel/data/relay/team-key.pem || die "team key format"
[ "$(stat -c '%U %a' /var/lib/mycel/data/relay/registration.json)" = "axserver 600" ] || die "registration owner"
ok "relay key + registration.json 0600 axserver (CP verified the register proof)"
grep -q '"deployment": "hosted"' /var/lib/mycel/config/server.json || die "server.json"
grep -q '"anthropic-api-key"' /var/lib/mycel/config/server.json || die "credential kinds"
grep -q '"authMode": "managed"' /var/lib/mycel/config/server.json || die "server.json: hosted is managed mode"
grep -q '"proxyPort": 47821' /var/lib/mycel/config/server.json || die "server.json lost a key"
[ "$(stat -c '%U %a' /var/lib/mycel/config/server.json)" = "axserver 600" ] || die "server.json owner"
ok "server.json merged (hosted, managed, API-key kinds, existing keys kept)"
grep -qx 'MYCEL_TEAM_TZ=Asia/Seoul' /etc/default/mycel && grep -qx 'OTHER=1' /etc/default/mycel || die "/etc/default/mycel: $(cat /etc/default/mycel)"
ok "/etc/default/mycel written, other lines kept"
grep -q 'ARGS apply-plan --json' /tmp/ctl.log && grep -q 'ARGS notices-set --json' /tmp/ctl.log || die "mycel-ctl: $(cat /tmp/ctl.log)"
ok "plan and notices handed to mycel-ctl"
[ ! -e /run/ax/enroll.json ] || die "enroll.json left behind"
ok "enroll.json removed"

echo "-- the token is single-use"
enroll_json new '"ent_dockertest_abcdefghijk"'
umount /var/lib/mycel
if /t/mycel-enroll --data-device "$D" --no-start; then die "second enroll with the same token succeeded"; fi
grep -q '401' /run/ax/enroll-status.json || die "status: $(cat /run/ax/enroll-status.json)"
ok "reused token refused (401), nothing formatted: $(blkid -s LABEL -o value "$D")"

echo "-- reattach: mount by label, never format, keep the data"
umount /var/lib/mycel 2>/dev/null || true
enroll_json reattach null
/t/mycel-enroll --no-start
grep -q '"state":"ok"' /run/ax/enroll-status.json || die "status: $(cat /run/ax/enroll-status.json)"
[ "$(cat /var/lib/mycel/data/setup-token)" = stp_dockertest_0123456789abcdef ] || die "data lost on reattach"
[ "$(grep -c '"mode":"reattach"' /tmp/fakecp-requests.jsonl || true)" = 0 ] || die "reattach called the CP"
ok "reattach mounted the existing data disk, no CP call, data intact"

echo "PASS $pass checks"

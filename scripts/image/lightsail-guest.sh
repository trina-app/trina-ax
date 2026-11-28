#!/bin/bash
# Team AX Lightsail image build, the part that runs ON THE BUILDER instance as root (trina-cloud
# docs/research/lightsail-paid-teams.md §6.2). build-lightsail.sh puts it in the stage; the builder's launch script
# downloads the stage, checks its sha256 and starts this script as the transient unit ax-image-build.service, ordered
# after cloud-final.service. So it runs when cloud-init is finished, and the clean-up below is the last write to
# /var/lib/cloud before the snapshot (a clean-up inside the launch script is undone by cloud-final when it returns).
#
#   lightsail-guest.sh --stage /root/ax-build/ax-image --template-version V --result-url-file F [--allow-missing-kit]
#
# 1. Runtime only: stop the apt timers and wait for the dpkg lock (the blueprint's first boot can run apt).
# 2. customize.sh on the LIVE system (not a chroot as on EC2): the same stage and the same script as the AMI.
# 3. Remove what the builder's own first boot made: the default user of cloud-init (admin) with the Lightsail key pair
#    in authorized_keys and its sudoers file, the Lightsail SSH CA key, SSH host keys, the host name, /etc/hosts.
# 4. Seal: cloud-init clean (logs, seed, machine-id), journal and logs, the random seed (also not written again at
#    shutdown), network state. Then the same checks as ami-chroot.sh.
# 5. Upload the result (one JSON line: ok, or the error, and the last lines of the log) to the presigned URL, then
#    power off. Lightsail gives no console log to the API: the result file is the only report. build-lightsail.sh
#    takes "stopped" + "ok" as success; "stopped" without a result is a failure.
# Any failure still uploads a result and powers off (the trap), so the job never waits for its time-out.
set -uo pipefail
export LC_ALL=C.UTF-8 DEBIAN_FRONTEND=noninteractive

STAGE=""; TEMPLATE_VERSION=""; RESULT_URL_FILE=""; ALLOW_MISSING_KIT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage) STAGE="$2"; shift 2 ;;
    --template-version) TEMPLATE_VERSION="$2"; shift 2 ;;
    --result-url-file) RESULT_URL_FILE="$2"; shift 2 ;;
    --allow-missing-kit) ALLOW_MISSING_KIT=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "lightsail-guest: unknown argument $1" >&2; exit 2 ;;
  esac
done
BUILD=/root/ax-build
LOG="$BUILD/build.log"
mkdir -p "$BUILD"; chmod 700 "$BUILD"
exec > >(tee -a "$LOG") 2>&1
say() { echo "lightsail-guest: $*"; }
STEP="start"
ERROR=""
die() { ERROR="$*"; echo "lightsail-guest: ERROR: $*" >&2; exit 1; }

# the result: one JSON line, then the tail of the log (no secrets: the presigned URLs are only in the url file and the
# user-data, both removed before this). python3 is always there (cloud-init is Python); curl may not be.
# shellcheck disable=SC2329 # called from the EXIT trap
upload_result() {
  local ok="$1" f="$BUILD/result.txt" url
  [[ -n "$RESULT_URL_FILE" && -s "$RESULT_URL_FILE" ]] || { say "no result URL"; return 1; }
  url="$(cat "$RESULT_URL_FILE")"
  python3 - "$ok" "$TEMPLATE_VERSION" "$STEP" "$ERROR" "${KIT_VERSION:-}" "${BLUEPRINT_VERSION:-}" "${FREE_GB:-}" "${TIME_SYNC:-}" > "$f" <<'PY'
import json, sys
ok, tv, step, err, kit, bp, free, ts = sys.argv[1:9]
print(json.dumps({"ok": ok == "1", "templateVersion": tv, "step": step, "error": err, "kitVersion": kit,
                  "blueprintVersion": bp, "freeGB": free, "timeSync169": ts}, separators=(",", ":")))
PY
  echo "--- log tail" >> "$f"
  tail -n 60 "$LOG" 2>/dev/null | sed -E 's#https://[^ ]*X-Amz-Signature=[0-9a-f]+#<url>#g' >> "$f" || true
  python3 - "$url" "$f" <<'PY'
import sys, time, urllib.request
url, path = sys.argv[1], sys.argv[2]
data = open(path, "rb").read()
for n in range(6):
    try:
        req = urllib.request.Request(url, data=data, method="PUT", headers={"Content-Type": "text/plain; charset=utf-8"})
        urllib.request.urlopen(req, timeout=60).read()
        sys.exit(0)
    except Exception as e:  # noqa: BLE001
        print(f"lightsail-guest: result upload try {n + 1}: {e}", file=sys.stderr)
        time.sleep(5 * (n + 1))
sys.exit(1)
PY
}

# shellcheck disable=SC2329 # the EXIT trap
finish() {
  local rc=$?
  trap - EXIT
  if [[ $rc -eq 0 ]]; then upload_result 1 || say "result upload failed"
  else
    [[ -n "$ERROR" ]] || ERROR="failed in step $STEP (exit $rc)"
    upload_result 0 || say "result upload failed"
  fi
  # the url file and the log are the last build files; nothing of the build stays in the image
  rm -rf "$BUILD"
  sync
  systemctl --no-block poweroff
}
trap finish EXIT

[[ $EUID -eq 0 ]] || die "run as root"
[[ -f "$STAGE/customize.sh" && -d "$STAGE/files" ]] || die "--stage must hold customize.sh and files/"
[[ "$TEMPLATE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?-d13-[0-9]{8}$ ]] || die "--template-version $TEMPLATE_VERSION is not <kit>-d13-<yyyymmdd>"
grep -q '^ID=debian' /etc/os-release || die "the builder is not Debian"
BLUEPRINT_VERSION="$(cat /etc/debian_version 2>/dev/null || true)"
say "template $TEMPLATE_VERSION on Debian $BLUEPRINT_VERSION ($(uname -r))"

# ---- 0. does Amazon Time Sync answer on 169.254.169.123 (the image's chrony.conf has it, not fd00:ec2::123)? Design
# P13 saw only the IPv6 address in use. One SNTP query; the answer goes into the result (a warning, not a failure).
TIME_SYNC="$(python3 - <<'PY'
import socket, struct
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(3)
try:
    s.sendto(b"\x1b" + 47 * b"\0", ("169.254.169.123", 123)); d, _ = s.recvfrom(512)
    print("yes" if len(d) >= 48 and struct.unpack("!I", d[40:44])[0] else "no")
except Exception:
    print("no")
PY
)"
say "Amazon Time Sync on 169.254.169.123: $TIME_SYNC"

# ---- 1. no apt run of the blueprint in parallel (runtime only: the image keeps its timers)
STEP=apt-quiet
systemctl stop apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service unattended-upgrades.service 2>/dev/null || true
printf 'DPkg::Lock::Timeout "900";\n' > /etc/apt/apt.conf.d/00ax-build-lock

# the login accounts of the builder's first boot (cloud-init's default user): only these are removed in step 3, never an
# account that customize.sh or the kit makes
BOOT_USERS="$(getent passwd | awk -F: '$3 >= 1000 && $3 < 60000 { print $1 }' | tr '\n' ' ')"
# shellcheck disable=SC2012 # a log line only
say "login accounts of the first boot: ${BOOT_USERS:-none}; cloud.cfg.d: $(ls /etc/cloud/cloud.cfg.d 2>/dev/null | tr '\n' ' ')"

# ---- 2. customize.sh on the live system
STEP=customize
extra=()
[[ $ALLOW_MISSING_KIT == 1 ]] && extra+=(--allow-missing-kit)
say "customize.sh (this takes a while)"
bash "$STAGE/customize.sh" --src "$STAGE" --template-version "$TEMPLATE_VERSION" ${extra[@]+"${extra[@]}"} || die "customize.sh failed"
rm -f /etc/apt/apt.conf.d/00ax-build-lock
grep -q "\"templateVersion\":\"$TEMPLATE_VERSION\"" /etc/ax-template.json || die "the image does not carry template version $TEMPLATE_VERSION"
KIT_VERSION="$(python3 -c 'import json; print(json.load(open("/etc/ax-template.json"))["kitVersion"])')"
if [[ $ALLOW_MISSING_KIT != 1 ]]; then
  grep -q '"production":true' /etc/ax-template.json || die "customize.sh made a non-production image"
fi

# ---- 3. what the builder's first boot made
STEP=builder-traces
# cloud-init's default user (admin on Debian), saved before customize.sh: its home holds the Lightsail key pair in
# authorized_keys. The image's own accounts (axserver 980, axagent 981) are system accounts below 1000.
for name in $BOOT_USERS; do
  uid="$(id -u "$name" 2>/dev/null)" || continue
  say "remove login account $name ($uid) of the builder's first boot"
  pkill -KILL -u "$uid" 2>/dev/null || true
  userdel -r -f "$name" 2>/dev/null || userdel -f "$name" || die "userdel $name failed"
done
rm -f /etc/sudoers.d/90-cloud-init-users
rm -rf /root/.ssh
# the Lightsail part of the launch script (it runs again on each new instance, harmlessly without sshd)
rm -f /etc/ssh/lightsail_instance_ca.pub /etc/ssh/ssh_host_*
echo localhost > /etc/hostname
cat > /etc/hosts <<'EOF'
127.0.0.1	localhost
::1		localhost ip6-localhost ip6-loopback
ff02::1		ip6-allnodes
ff02::2		ip6-allrouters
EOF

# ---- 4. seal
STEP=seal
# the random seed: unique per instance. systemd-random-seed saves it again at shutdown; a drop-in in /run (not in the
# image) turns that save off for this one shutdown.
mkdir -p /run/systemd/system/systemd-random-seed.service.d
printf '[Service]\nExecStop=\n' > /run/systemd/system/systemd-random-seed.service.d/ax-image.conf
systemctl daemon-reload
rm -f /var/lib/systemd/random-seed /var/lib/systemd/credential.secret
if command -v cloud-init >/dev/null 2>&1; then cloud-init clean --logs --seed --machine-id >/dev/null 2>&1 || cloud-init clean --logs --seed >/dev/null 2>&1 || true; fi
rm -rf /var/lib/cloud/* 2>/dev/null || true
rm -f /etc/cloud/cloud-init.disabled
[[ -s /etc/machine-id ]] && truncate -s 0 /etc/machine-id
[[ -f /var/lib/dbus/machine-id && ! -L /var/lib/dbus/machine-id ]] && rm -f /var/lib/dbus/machine-id
rm -f /etc/network/interfaces.d/50-cloud-init /etc/netplan/50-cloud-init.yaml /var/lib/dhcp/*.leases
rm -rf /var/lib/systemd/network/* 2>/dev/null || true
rm -f /root/.bash_history /root/.lesshst /root/.wget-hsts
# the journal to /run for the rest of this boot, then the persistent one removed
journalctl --relinquish-var >/dev/null 2>&1 || true
rm -rf /var/log/journal/* /tmp/* /var/tmp/* 2>/dev/null || true
find /var/log -type f \( -name '*.log' -o -name '*.gz' -o -name '*.[0-9]' -o -name 'wtmp' -o -name 'btmp' -o -name 'lastlog' \) -delete 2>/dev/null || true
apt-get clean
rm -rf /var/lib/apt/lists/*

# the checks of ami-chroot.sh
STEP=checks
[[ -z "$(find /var/lib/cloud -mindepth 1 -maxdepth 1 2>/dev/null)" ]] || die "/var/lib/cloud is not empty: a new instance would not run cloud-init as a first boot"
[[ ! -s /etc/machine-id ]] || die "/etc/machine-id is not empty"
! ls /etc/ssh/ssh_host_* >/dev/null 2>&1 || die "SSH host keys left in the image"
[[ -z "$(find /home -mindepth 1 -maxdepth 3 -name authorized_keys 2>/dev/null)" ]] || die "an authorized_keys file is left under /home"
[[ ! -e /root/.ssh/authorized_keys ]] || die "/root/.ssh/authorized_keys is left"
! dpkg-query -W -f '${db:Status-Status}\n' openssh-server 2>/dev/null | grep -qx installed || die "openssh-server is still installed"
[[ -z "$(find /var/lib/mycel -mindepth 1 -maxdepth 1 2>/dev/null)" ]] || die "/var/lib/mycel is not empty"
[[ -f /etc/udev/rules.d/99-axdata-mount.rules ]] || die "no 99-axdata-mount.rules in the image (late data disk)"
FREE_GB=$(df -Pk / | awk 'NR == 2 { printf "%.1f", $4 / 1048576 }')
say "root file system of the image: $(df -h / | awk 'NR == 2 { print $2 " size, " $3 " used, " $4 " free" }')"
STEP=finished
say "done: template $TEMPLATE_VERSION, kit $KIT_VERSION"
exit 0

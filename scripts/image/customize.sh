#!/bin/bash
# Team AX tenant template: configure a Debian 13 genericcloud image from the INSIDE, as root (isolation.md §5.1–5.3,
# task H-05). build.sh runs it through `virt-customize --run-command`; scripts/image/test-customize.sh runs it in a
# privileged Debian container. Idempotent: a second run changes nothing (it prints "customize: changed=0").
#
#   customize.sh [--src DIR] [--kit DIR] [--enroll-bin FILE] [--template-version V] [--allow-missing-kit] [--no-cleanup]
#
#   --src DIR            folder holding files/ (default: this script's folder)
#   --kit DIR            the W1 Linux kit (install-linux.sh + VERSION + app/<v>/…, linux-runtime.md §3.6.1)
#                        (default: <src>/kit when it exists)
#   --enroll-bin FILE    linux mycel-enroll binary (default: <src>/bin/mycel-enroll)
#   --template-version V written to /etc/ax-template.json (build.sh passes <kitVersion>-d13-<yyyymmdd>)
#   --allow-missing-kit  pipeline dry run: everything except the kit; the image is marked "not for production"
#   --no-cleanup         keep apt lists, machine-id, logs (debugging)
#
# Disk layout (decision L1, ee/cloud/README.md): BASE = /var/lib/mycel is the mount point of the tenant DATA disk.
# The kit is installed with `--image-mode` (install, do not enable or start units, no setup code) into BASE on the OS
# disk, then that tree is moved to /usr/lib/mycel/seed-base and BASE is left empty. mycel-enroll copies the seed onto
# the data disk at first boot. axserver/axagent get FIXED uids (990/991) so files on a data disk keep their owners
# when the OS disk is replaced by a newer template (reimageTenant).
set -euo pipefail
export LC_ALL=C.UTF-8 DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT=""
ENROLL_BIN=""
TEMPLATE_VERSION=""
ALLOW_MISSING_KIT=0
CLEANUP=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --src) SRC="$2"; shift 2 ;;
    --kit) KIT="$2"; shift 2 ;;
    --enroll-bin) ENROLL_BIN="$2"; shift 2 ;;
    --template-version) TEMPLATE_VERSION="$2"; shift 2 ;;
    --allow-missing-kit) ALLOW_MISSING_KIT=1; shift ;;
    --no-cleanup) CLEANUP=0; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "customize.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
FILES="$SRC/files"
[[ -z "$KIT" && -d "$SRC/kit" ]] && KIT="$SRC/kit"
[[ -z "$ENROLL_BIN" ]] && ENROLL_BIN="$SRC/bin/mycel-enroll"

BASE=/var/lib/mycel
LIBDIR=/usr/lib/mycel
SEED="$LIBDIR/seed-base"
KITDIR="$LIBDIR/kit"
SERVER_UID=990
AGENT_UID=991
PACKAGES=(systemd systemd-sysv udev tzdata qemu-guest-agent chrony nftables bubblewrap systemd-zram-generator
  unattended-upgrades needrestart ca-certificates e2fsprogs cloud-guest-utils util-linux procps perl-base)
PURGE=(openssh-server openssh-sftp-server)
MYCEL_UNITS=(mycel-firewall.service mycel-firewall.timer mycel-launcher.service mycel-server.service mycel-update.service mycel-update.timer)

CHANGED=0
say() { echo "customize: $*"; }
die() { echo "customize: ERROR: $*" >&2; exit 1; }
changed() { CHANGED=$((CHANGED + 1)); say "changed: $*"; }

[[ $EUID -eq 0 ]] || die "run as root (inside the image)"
[[ -d "$FILES" ]] || die "no files/ folder under $SRC"
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == debian && "${VERSION_ID:-}" == 13 ]] || say "warning: expected Debian 13, this is ${PRETTY_NAME:-unknown}"
fi

# ---- helpers (each one changes something only when needed and counts it)

# put_file SRC DEST MODE: install SRC as DEST (root:root, MODE) unless DEST already has the same bytes and mode
put_file() {
  local src="$1" dest="$2" mode="$3"
  if [[ -f "$dest" && ! -L "$dest" ]] && cmp -s "$src" "$dest" && [[ "$(stat -c %a "$dest")" == "${mode#0}" ]]; then return 0; fi
  install -D -o root -g root -m "$mode" "$src" "$dest"
  changed "$dest"
}
# put_text DEST MODE  (content on stdin)
put_text() {
  local tmp; tmp="$(mktemp)"
  cat > "$tmp"
  put_file "$tmp" "$1" "$2"
  rm -f "$tmp"
}
unit_state() { systemctl is-enabled "$1" 2>/dev/null || true; }
svc_enable() {
  local u="$1" s; s="$(unit_state "$u")"
  case "$s" in enabled|enabled-runtime|static|alias|indirect|generated|transient) return 0 ;; esac
  systemctl enable "$u" >/dev/null 2>&1 || systemctl --root=/ enable "$u" >/dev/null 2>&1 || { say "warning: could not enable $u ($s)"; return 0; }
  changed "enabled $u"
}
svc_disable() {
  local u="$1"
  [[ "$(unit_state "$u")" == enabled ]] || return 0
  systemctl disable "$u" >/dev/null 2>&1 || systemctl --root=/ disable "$u" >/dev/null 2>&1 || die "could not disable $u"
  changed "disabled $u"
}
svc_mask() {
  local u="$1"
  [[ "$(unit_state "$u")" == masked ]] && return 0
  [[ -L "/etc/systemd/system/$u" && "$(readlink "/etc/systemd/system/$u")" == /dev/null ]] && return 0
  systemctl mask "$u" >/dev/null 2>&1 || systemctl --root=/ mask "$u" >/dev/null 2>&1 || ln -sfn /dev/null "/etc/systemd/system/$u"
  changed "masked $u"
}
pkg_installed() { [[ "$(dpkg-query -W -f '${db:Status-Status}' "$1" 2>/dev/null || true)" == installed ]]; }

# ---- 1. accounts first: package postinsts (systemd-sysusers allocates system uids from 999 down) must not take 990/991

ensure_account() {
  local name="$1" id="$2" home="$3" comment="$4" u g
  if u="$(getent passwd "$name")"; then
    [[ "$(echo "$u" | cut -d: -f3)" == "$id" ]] || die "account $name exists with uid $(echo "$u" | cut -d: -f3), the template needs $id (data disks keep owners across templates)"
    [[ "$(echo "$u" | cut -d: -f4)" == "$id" ]] || die "account $name has gid $(echo "$u" | cut -d: -f4), needs $id"
  else
    if g="$(getent passwd "$id")"; then die "uid $id is taken by $(echo "$g" | cut -d: -f1); cannot create $name"; fi
    if g="$(getent group "$name")"; then
      [[ "$(echo "$g" | cut -d: -f3)" == "$id" ]] || die "group $name exists with gid $(echo "$g" | cut -d: -f3), needs $id"
    else
      if g="$(getent group "$id")"; then die "gid $id is taken by group $(echo "$g" | cut -d: -f1)"; fi
      groupadd --system --gid "$id" "$name"
    fi
    useradd --system --uid "$id" --gid "$id" --home-dir "$home" --no-create-home --shell /usr/sbin/nologin --comment "$comment" "$name"
    changed "account $name ($id)"
  fi
  if [[ "$(passwd -S "$name" | awk '{print $2}')" != L ]]; then passwd -l "$name" >/dev/null; changed "locked $name"; fi
}
ensure_account axserver "$SERVER_UID" "$BASE/data" "Team AX server (mycel)"
ensure_account axagent "$AGENT_UID" "$BASE/agent/home" "Team AX AI engine (mycel)"

# ---- 2. packages (no service starts while installing: we are in an image, not a running system)

POLICY_RC=/usr/sbin/policy-rc.d
cleanup_policy() { [[ -f "$POLICY_RC.ax" ]] && rm -f "$POLICY_RC" "$POLICY_RC.ax"; return 0; }
trap cleanup_policy EXIT
if [[ ! -e "$POLICY_RC" ]]; then printf '#!/bin/sh\nexit 101\n' > "$POLICY_RC"; chmod 755 "$POLICY_RC"; : > "$POLICY_RC.ax"; fi

missing=()
for p in "${PACKAGES[@]}"; do pkg_installed "$p" || missing+=("$p"); done
if [[ ${#missing[@]} -gt 0 ]]; then
  say "installing: ${missing[*]}"
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends -o Dpkg::Options::=--force-confold "${missing[@]}" >/dev/null
  changed "packages ${missing[*]}"
fi
gone=()
for p in "${PURGE[@]}"; do pkg_installed "$p" && gone+=("$p"); done
if [[ ${#gone[@]} -gt 0 ]]; then
  apt-get purge -y -qq "${gone[@]}" >/dev/null
  apt-get autoremove -y -qq --purge >/dev/null || true
  changed "purged ${gone[*]}"
fi
# no SSH server, ever (D15): even if a later package pulls it in, it cannot start
svc_mask ssh.service
svc_mask ssh.socket
svc_mask sshd.service

# ---- 3. configuration files

put_file "$FILES/99-ax.cfg" /etc/cloud/cloud.cfg.d/99-ax.cfg 0644
put_file "$FILES/99-ax-guest.conf" /etc/sysctl.d/99-ax-guest.conf 0644
put_file "$FILES/zram-generator.conf" /etc/systemd/zram-generator.conf 0644
put_file "$FILES/chrony.conf" /etc/chrony/chrony.conf 0644
put_file "$FILES/journald-ax.conf" /etc/systemd/journald.conf.d/ax.conf 0644
put_file "$FILES/20auto-upgrades" /etc/apt/apt.conf.d/20auto-upgrades 0644
put_file "$FILES/52unattended-upgrades-ax" /etc/apt/apt.conf.d/52unattended-upgrades-ax 0644
put_file "$FILES/needrestart-ax.conf" /etc/needrestart/conf.d/ax.conf 0644
put_file "$FILES/90-axdata-resize.rules" /etc/udev/rules.d/90-axdata-resize.rules 0644
put_file "$FILES/var-lib-mycel.mount" /etc/systemd/system/var-lib-mycel.mount 0644
put_file "$FILES/mycel-enroll.service" /etc/systemd/system/mycel-enroll.service 0644
for u in mycel-server mycel-launcher mycel-firewall mycel-update; do
  put_file "$FILES/10-ax-data.conf" "/etc/systemd/system/$u.service.d/10-ax-data.conf" 0644
done

# time zone: system UTC; the team's zone goes to the mycel units (MYCEL_TEAM_TZ, isolation.md §4.7)
if [[ "$(readlink /etc/localtime 2>/dev/null || true)" != /usr/share/zoneinfo/Etc/UTC ]]; then
  ln -sfn /usr/share/zoneinfo/Etc/UTC /etc/localtime; changed /etc/localtime
fi
[[ "$(cat /etc/timezone 2>/dev/null || true)" == Etc/UTC ]] || { echo Etc/UTC > /etc/timezone; changed /etc/timezone; }

# ---- 4. the data-disk mount point and the enroll binary

if [[ ! -d "$BASE" ]]; then mkdir -p "$BASE"; changed "$BASE"; fi
if [[ "$(stat -c '%U:%G %a' "$BASE")" != "root:root 755" ]]; then chown root:root "$BASE"; chmod 755 "$BASE"; changed "$BASE owner/mode"; fi
if [[ -f "$ENROLL_BIN" ]]; then
  put_file "$ENROLL_BIN" /usr/local/sbin/mycel-enroll 0755
elif [[ $ALLOW_MISSING_KIT == 1 ]]; then
  say "warning: no mycel-enroll binary ($ENROLL_BIN): dry-run image cannot enroll"
else
  die "no mycel-enroll binary at $ENROLL_BIN (build it: bash native/build.sh; it lands in native/bin/linux-<arch>/mycel-enroll)"
fi

# ---- 5. the Team AX Linux kit (W1) in image mode, moved to the seed

KIT_STATE=missing
KIT_VERSION=""
if [[ -n "$KIT" && -f "$KIT/install-linux.sh" ]]; then
  [[ -f "$KIT/VERSION" ]] || die "kit $KIT has install-linux.sh but no VERSION file"
  KIT_VERSION="$(tr -d '[:space:]' < "$KIT/VERSION")"
  [[ "$KIT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] || die "kit VERSION '$KIT_VERSION' is not a version"
  KIT_STATE=present
  have="$(cat "$KITDIR/VERSION" 2>/dev/null | tr -d '[:space:]' || true)"
  seeded="$(cat "$SEED/root/VERSION" 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ "$have" == "$KIT_VERSION" && -n "$seeded" ]]; then
    say "kit $KIT_VERSION already installed and seeded"
  else
    say "installing kit $KIT_VERSION (install-linux.sh --image-mode)"
    rm -rf "$KITDIR.new"
    mkdir -p "$LIBDIR"
    cp -a "$KIT" "$KITDIR.new"
    chown -R root:root "$KITDIR.new"
    rm -rf "$KITDIR"; mv "$KITDIR.new" "$KITDIR"
    # a previous interrupted run may have left a partial BASE on the OS disk
    find "$BASE" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    # linux-runtime.md §3.5.1 + the --image-mode contract (ee/cloud/README.md): install everything, do not enable or
    # start units, no setup code, no firewall load; the accounts above already exist (the installer only checks them).
    (cd "$KITDIR" && bash ./install-linux.sh install --from "$KITDIR" --hosted --image-mode --engine claude --engine codex) \
      || die "install-linux.sh --image-mode failed"
    [[ -f "$BASE/root/VERSION" ]] || die "install-linux.sh --image-mode left no $BASE/root/VERSION: the kit does not honour the image-mode contract"
    rm -rf "$SEED.new"; mkdir -p "$SEED.new"
    cp -a "$BASE/." "$SEED.new/"
    rm -rf "$SEED"; mv "$SEED.new" "$SEED"
    chown root:root "$SEED"; chmod 755 "$SEED"
    find "$BASE" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    changed "kit $KIT_VERSION -> $SEED"
  fi
  # image mode must not enable anything; enforce it (mycel-enroll enables them after the data disk is mounted)
  for u in "${MYCEL_UNITS[@]}"; do svc_disable "$u"; done
elif [[ $ALLOW_MISSING_KIT == 1 ]]; then
  say "warning: NO KIT (--allow-missing-kit): this image is a pipeline dry run, NOT for production"
  KIT_VERSION="0.0.0"
else
  die "no Team AX Linux kit (install-linux.sh) in '${KIT:-<none>}'. The template needs the W1 kit: scripts/install-linux.sh
  + bundle (linux-runtime.md §3.5.1 / §3.6.1), installed with 'install-linux.sh install --from <kit> --hosted --image-mode'
  (install only: no units enabled or started, no setup code; BASE is moved to $SEED). Use --allow-missing-kit only for a
  pipeline dry run."
fi
if [[ -n "$(find "$BASE" -mindepth 1 -maxdepth 1 2>/dev/null)" ]]; then die "$BASE is not empty; it must be a bare mount point in the template"; fi

# ---- 6. services

svc_enable fstrim.timer
svc_enable chrony.service
svc_enable serial-getty@ttyS0.service
# qemu-guest-agent is started by udev when the virtio port appears (static unit); enable only if it has [Install]
svc_enable qemu-guest-agent.service

# ---- 7. lock root (emergency access is the guest agent / serial console through the host, D15)

if [[ "$(passwd -S root | awk '{print $2}')" != L ]]; then passwd -l root >/dev/null; changed "locked root"; fi

# ---- 8. identity of this template (read by vm-smoke.sh, ax-hostd and support)

[[ -n "$TEMPLATE_VERSION" ]] || TEMPLATE_VERSION="$KIT_VERSION-d13-unversioned"
production=true; [[ "$KIT_STATE" == present ]] || production=false
put_text /etc/ax-template.json 0644 <<EOF
{"format":1,"templateVersion":"$TEMPLATE_VERSION","kitVersion":"$KIT_VERSION","kit":"$KIT_STATE","production":$production,"base":"$BASE","seed":"$SEED","serverUid":$SERVER_UID,"agentUid":$AGENT_UID}
EOF
pkglist="$(mktemp)"
dpkg-query -W -f '${Package}=${Version}\n' | sort > "$pkglist"
put_file "$pkglist" "$LIBDIR/image-packages.txt" 0644
rm -f "$pkglist"

# ---- 9. cleanup (housekeeping, not counted)

cleanup_policy
if [[ $CLEANUP == 1 ]]; then
  apt-get clean
  rm -rf /var/lib/apt/lists/*
  rm -f /etc/ssh/ssh_host_* /root/.bash_history
  if command -v cloud-init >/dev/null 2>&1; then cloud-init clean --logs --seed >/dev/null 2>&1 || true; fi
  rm -f /etc/cloud/cloud-init.disabled
  [[ -s /etc/machine-id ]] && truncate -s 0 /etc/machine-id
  [[ -f /var/lib/dbus/machine-id && ! -L /var/lib/dbus/machine-id ]] && rm -f /var/lib/dbus/machine-id
  rm -rf /var/log/journal/* /tmp/* /var/tmp/* 2>/dev/null || true
  find /var/log -type f \( -name '*.log' -o -name '*.gz' -o -name '*.[0-9]' \) -delete 2>/dev/null || true
fi
say "done: template $TEMPLATE_VERSION, kit $KIT_STATE, changed=$CHANGED"

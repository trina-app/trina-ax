#!/bin/bash
# Team AX AMI build, the part that runs ON THE BUILDER instance as root (scripts/image/build-ami.sh copies it there with
# the stage folder and runs it over SSH). It customizes the work volume, not the builder's own disk:
#
#   ami-chroot.sh --volume-id vol-… --stage /root/ax-image --template-version V [--allow-missing-kit]
#                 [--apt-snapshot YYYYMMDDTHHMMSSZ]
#
# 1. Find the work volume (made from the Debian AMI's root snapshot) by its EBS serial: on t3a every EBS volume is an
#    NVMe disk, so the attach name /dev/sdf means nothing here, and the root partition has the same file system UUID as
#    the builder's own root (both come from the same snapshot).
# 2. Grow partition 1 and its ext4 file system to the volume size (the snapshot is smaller than the 20 GiB volume).
# 3. Mount it, bind /dev /dev/pts /proc /sys /run, give the chroot a working resolv.conf, run customize.sh inside.
# 4. Put resolv.conf back, unmount everything, flush. The caller detaches the volume and snapshots it.
#
# Prints "ami-chroot: done" at the end. Any failure exits non-zero, and the trap unmounts what it mounted.
set -euo pipefail
export LC_ALL=C.UTF-8

VOLUME_ID=""
STAGE=""
TEMPLATE_VERSION=""
ALLOW_MISSING_KIT=0
APT_SNAPSHOT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --volume-id) VOLUME_ID="$2"; shift 2 ;;
    --stage) STAGE="$2"; shift 2 ;;
    --template-version) TEMPLATE_VERSION="$2"; shift 2 ;;
    --allow-missing-kit) ALLOW_MISSING_KIT=1; shift ;;
    --apt-snapshot) APT_SNAPSHOT="$2"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "ami-chroot: unknown argument $1" >&2; exit 2 ;;
  esac
done
say() { echo "ami-chroot: $*"; }
die() { echo "ami-chroot: ERROR: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "run as root"
[[ "$VOLUME_ID" =~ ^vol-[0-9a-f]+$ ]] || die "--volume-id vol-… is required"
[[ -n "$TEMPLATE_VERSION" ]] || die "--template-version is required"
[[ -f "$STAGE/customize.sh" && -d "$STAGE/files" ]] || die "--stage must hold customize.sh and files/"
for t in growpart e2fsck resize2fs findmnt mountpoint partx; do command -v "$t" >/dev/null 2>&1 || die "missing $t on the builder"; done

# ---- 1. the work volume by its EBS serial (vol-0abc… → nvme-Amazon_Elastic_Block_Store_vol0abc…)
DEV_LINK="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${VOLUME_ID/-/}"
for _ in $(seq 1 60); do [[ -e "$DEV_LINK" ]] && break; sleep 2; done
[[ -e "$DEV_LINK" ]] || die "volume $VOLUME_ID did not show up as $DEV_LINK"
DISK="$(readlink -f "$DEV_LINK")"
ROOT_SRC="$(findmnt -n -o SOURCE /)"
[[ "$ROOT_SRC" != "$DISK"* ]] || die "$DISK holds the builder's own root file system"
udevadm settle || true
PART1="$(lsblk -nrpo NAME,TYPE "$DISK" | awk '$2 == "part" && $1 ~ /p1$/ {print $1}')"
[[ -b "$PART1" ]] || die "no partition 1 on $DISK"
[[ "$(lsblk -nro FSTYPE "$PART1")" == ext4 ]] || die "$PART1 is not ext4 (the Debian AMI root)"
say "work volume $VOLUME_ID = $DISK, root partition $PART1"

# ---- 2. grow the root partition and its file system to the volume size
rc=0; growpart "$DISK" 1 || rc=$?
[[ $rc -le 1 ]] || die "growpart $DISK 1 failed ($rc)"   # 1 = NOCHANGE
# the Debian 13 AMI has no partprobe (parted); partx is in util-linux
partx -u "$DISK" || true
udevadm settle || true
rc=0; e2fsck -f -p "$PART1" || rc=$?
[[ $rc -le 1 ]] || die "e2fsck found errors on $PART1 ($rc)"   # 1 = errors fixed
resize2fs "$PART1"

# ---- 3. mount and chroot
MNT=/mnt/ax-image
MOUNTS=()
RESOLV_SAVED=""
cleanup() {
  local i
  if [[ -n "$RESOLV_SAVED" ]]; then
    rm -f "$MNT/etc/resolv.conf"; mv "$RESOLV_SAVED" "$MNT/etc/resolv.conf" 2>/dev/null || true
    RESOLV_SAVED=""
  fi
  for (( i=${#MOUNTS[@]}-1; i>=0; i-- )); do umount "${MOUNTS[$i]}" 2>/dev/null || umount -l "${MOUNTS[$i]}" 2>/dev/null || true; done
  MOUNTS=()
  sync
}
trap cleanup EXIT
mkdir -p "$MNT"
mountpoint -q "$MNT" && die "$MNT is already a mount point (an earlier run?): unmount it first"
mount "$PART1" "$MNT"; MOUNTS+=("$MNT")
# the EFI partition (15 on the Debian AMI), so a package that touches the boot loader writes to the right place
EFI="$(lsblk -nrpo NAME,FSTYPE "$DISK" | awk '$2 == "vfat" {print $1; exit}')"
if [[ -n "$EFI" && -d "$MNT/boot/efi" ]]; then mount "$EFI" "$MNT/boot/efi"; MOUNTS+=("$MNT/boot/efi"); fi
for d in dev dev/pts proc sys run; do
  mkdir -p "$MNT/$d"; mount --bind "/$d" "$MNT/$d"; MOUNTS+=("$MNT/$d")
done
grep -q '^ID=debian' "$MNT/etc/os-release" || die "the work volume is not Debian"
# DNS for apt and the kit's downloads. The image's resolv.conf may be a link into /run (systemd-resolved); keep it.
if [[ -e "$MNT/etc/resolv.conf" || -L "$MNT/etc/resolv.conf" ]]; then
  mv "$MNT/etc/resolv.conf" "$MNT/etc/resolv.conf.ax-build"; RESOLV_SAVED="$MNT/etc/resolv.conf.ax-build"
fi
cat /etc/resolv.conf > "$MNT/etc/resolv.conf"

rm -rf "$MNT/root/ax-image"
cp -a "$STAGE" "$MNT/root/ax-image"
extra=()
[[ $ALLOW_MISSING_KIT == 1 ]] && extra+=(--allow-missing-kit)
if [[ -n "$APT_SNAPSHOT" ]]; then
  [[ "$APT_SNAPSHOT" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die "--apt-snapshot $APT_SNAPSHOT is not YYYYMMDDTHHMMSSZ"
  extra+=(--apt-snapshot "$APT_SNAPSHOT")
fi
say "customize.sh in the chroot (this takes a while)"
chroot "$MNT" /bin/bash /root/ax-image/customize.sh --src /root/ax-image --template-version "$TEMPLATE_VERSION" ${extra[@]+"${extra[@]}"}
rm -rf "$MNT/root/ax-image"
grep -q "\"templateVersion\":\"$TEMPLATE_VERSION\"" "$MNT/etc/ax-template.json" || die "the image does not carry template version $TEMPLATE_VERSION"
cp "$MNT/etc/ax-template.json" "$STAGE.ax-template.json"
cp "$MNT/usr/lib/mycel/image-packages.txt" "$STAGE.packages.txt"
# no leftovers of this build in the image
rm -f "$MNT/root/.bash_history"
[[ -z "$(find "$MNT/var/lib/cloud" -mindepth 1 -maxdepth 1 2>/dev/null)" ]] || die "/var/lib/cloud is not empty: a new instance would not run cloud-init as a first boot"
[[ ! -s "$MNT/etc/machine-id" ]] || die "/etc/machine-id is not empty"
! ls "$MNT"/etc/ssh/ssh_host_* >/dev/null 2>&1 || die "SSH host keys left in the image"
# the disk the image leaves (PR #164 review, question 2): recorded in the build log; below 5 GiB free, grow the root
# volume (build-ami.sh --root-gb) before the image goes out
say "root file system of the image: $(df -h "$MNT" | awk 'NR == 2 { print $2 " size, " $3 " used, " $4 " free" }')"
free_kb=$(df -Pk "$MNT" | awk 'NR == 2 { print $4 }')
[[ "${free_kb:-0}" -ge $((5 * 1024 * 1024)) ]] || say "WARNING: less than 5 GiB free on the image's root file system: grow the root volume"

cleanup
trap - EXIT
say "done"

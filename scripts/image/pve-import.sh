#!/bin/bash
# Import a Team AX template qcow2 on a Proxmox VE 9.x host by hand (what ax-hostd installTemplate does through pvesh;
# isolation.md §5.3 hardware, §6.2 installTemplate). Idempotent: a template with the same name is reported, not redone.
#
#   scripts/image/pve-import.sh --image /var/lib/vz/import/teamax-0.3.0-debian13-amd64.qcow2 --version 0.3.0-d13-20261022
#       [--vmid 9000] [--storage ax-vm] [--sha256 HEX] [--sig FILE --pubkey PEM] [--dry-run]
#
#   --version   template version (<kitVersion>-d13-<yyyymmdd>); the VM is named tmpl-ax-<version>
#   --vmid      9000–9099 (default: the first free one)
#   --storage   Proxmox storage for the OS disk (default ax-vm = <pool>/ax/vm, isolation §4.3)
#   --sha256    expected sha256 (default: <image>.sha256 next to the image, when present)
#   --sig/--pubkey  verify the release signature (base64 Ed25519 over "ax-template-v1\n<version>\n<sha256>")
#   --dry-run   print the qm commands only
set -euo pipefail
IMAGE="" VERSION="" VMID="" STORAGE=ax-vm SHA="" SIG="" PUBKEY="" DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) IMAGE="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --vmid) VMID="$2"; shift 2 ;;
    --storage) STORAGE="$2"; shift 2 ;;
    --sha256) SHA="$2"; shift 2 ;;
    --sig) SIG="$2"; shift 2 ;;
    --pubkey) PUBKEY="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "pve-import: unknown argument $1" >&2; exit 2 ;;
  esac
done
die() { echo "pve-import: ERROR: $*" >&2; exit 1; }
run() { if [[ $DRY == 1 ]]; then printf '+'; printf ' %q' "$@"; printf '\n'; else "$@"; fi; }

[[ -n "$IMAGE" && -n "$VERSION" ]] || die "--image and --version are required"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]{1,40})?$ ]] || die "--version like 0.3.0-d13-20261022"
[[ "$STORAGE" =~ ^[A-Za-z0-9_-]+$ ]] || die "bad --storage"
[[ -f "$IMAGE" ]] || die "no image $IMAGE"
IMAGE="$(cd "$(dirname "$IMAGE")" && pwd)/$(basename "$IMAGE")"
NAME="tmpl-ax-$VERSION"
if [[ $DRY == 0 ]]; then command -v qm >/dev/null || die "qm not found: run on the Proxmox host"; fi

# ---- already there?
if command -v qm >/dev/null 2>&1; then
  for id in $(seq 9000 9099); do
    cfg="$(qm config "$id" 2>/dev/null)" || continue
    if grep -qx "name: $NAME" <<<"$cfg"; then
      grep -qx 'template: 1' <<<"$cfg" || die "VM $id is named $NAME but is not a template (half-finished import? check and remove it)"
      echo "pve-import: $NAME is already template $id"; exit 0
    fi
  done
fi

# ---- integrity
[[ -z "$SHA" && -f "$IMAGE.sha256" ]] && SHA="$(cut -d' ' -f1 "$IMAGE.sha256")"
if [[ -n "$SHA" ]]; then
  [[ "$SHA" =~ ^[0-9a-f]{64}$ ]] || die "bad --sha256"
  got="$(sha256sum "$IMAGE" | cut -d' ' -f1)"
  [[ "$got" == "$SHA" ]] || die "sha256 mismatch: want $SHA, got $got"
  echo "pve-import: sha256 ok"
else
  echo "pve-import: warning: no sha256 to check"
fi
if [[ -n "$SIG" ]]; then
  [[ -n "$PUBKEY" && -n "$SHA" ]] || die "--sig needs --pubkey and a sha256"
  t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
  printf 'ax-template-v1\n%s\n%s' "$VERSION" "$SHA" > "$t/msg"
  base64 -d < "$SIG" > "$t/sig.bin"
  openssl pkeyutl -verify -pubin -inkey "$PUBKEY" -rawin -in "$t/msg" -sigfile "$t/sig.bin" >/dev/null || die "release signature does not verify"
  echo "pve-import: signature ok"
fi

# ---- pick the VMID
if [[ -z "$VMID" ]]; then
  for id in $(seq 9000 9099); do
    if ! command -v qm >/dev/null 2>&1 || ! qm config "$id" >/dev/null 2>&1; then VMID="$id"; break; fi
  done
  [[ -n "$VMID" ]] || die "no free VMID in 9000-9099"
fi
[[ "$VMID" =~ ^90[0-9][0-9]$ ]] || die "--vmid must be 9000-9099"
if [[ $DRY == 0 ]] && qm config "$VMID" >/dev/null 2>&1; then die "VMID $VMID is in use"; fi

# ---- §5.3: q35, SeaBIOS, x86-64-v3, virtio-scsi-single, serial console only, rng, guest agent, no USB/audio/display,
# KSM off, not started at boot (ax-hostd starts tenants), protected. Tenants get memory/vcpus/NIC/data disk at clone.
run qm create "$VMID" --name "$NAME" --description "Team AX tenant template $VERSION sha256 ${SHA:-unknown}" --tags "ax;template" \
  --machine q35 --bios seabios --ostype l26 --cpu x86-64-v3 --cores 4 --sockets 1 --numa 0 \
  --memory 2048 --balloon 2048 --allow-ksm 0 --hotplug disk,network,cpu \
  --scsihw virtio-scsi-single --scsi0 "$STORAGE:0,import-from=$IMAGE,discard=on,iothread=1,ssd=1" --boot order=scsi0 \
  --serial0 socket --vga serial0 --tablet 0 --rng0 source=/dev/urandom,max_bytes=1024,period=1000 \
  --agent enabled=1,freeze-fs-on-backup=1,fstrim_cloned_disks=1 --onboot 0
run qm template "$VMID"
run qm set "$VMID" --protection 1
echo "pve-import: $NAME is template $VMID on $STORAGE"

#!/bin/bash
# Build the Team AX tenant template qcow2 (isolation.md §5.1–5.3, task H-05): Debian 13 genericcloud + the Team AX
# Linux kit in image mode + first-boot pieces, as one signed artifact that is both our Proxmox template and the
# self-host download (`teamax-<kitVersion>-debian13-<arch>.qcow2`).
#
#   scripts/image/build.sh --kit <TeamAX-server-<v>-linux-<arch>.tar.gz | kit dir> --enroll-bin <linux mycel-enroll>
#       [--arch amd64|arm64] [--out dist/image] [--base-url URL] [--date yyyymmdd] [--sign-key ed25519.pem]
#       [--allow-missing-kit] [--keep-work] [--smp 2] [--memsize 2048]
#
# Runs on Linux with libguestfs (virt-customize, virt-resize, virt-sparsify, virt-cat) and qemu-img, on the SAME
# architecture as --arch (the customize step executes the image's own binaries), ideally with /dev/kvm (TCG works,
# slowly). Debian/Ubuntu: apt-get install libguestfs-tools qemu-utils curl openssl file. See scripts/image/README.md.
#
# Output (in --out):
#   teamax-<kitVersion>-debian13-<arch>.qcow2          compressed, sparse
#   teamax-<kitVersion>-debian13-<arch>.qcow2.sha256   "<hex>  <file>"
#   teamax-<kitVersion>-debian13-<arch>.qcow2.sig      with --sign-key: base64 Ed25519 over templateSigningMessage
#   teamax-<kitVersion>-debian13-<arch>.json           manifest (template version, sha256, base image, packages)
# templateVersion = <kitVersion>-d13-<yyyymmdd>; Proxmox template name = tmpl-ax-<templateVersion>.
# Signed message (what ax-hostd installTemplate verifies with the release key):
#   "ax-template-v1\n<templateVersion>\n<sha256 hex>"   (no trailing newline)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

KIT=""
ENROLL_BIN=""
ARCH=amd64
OUT="$REPO/dist/image"
BASE_URL="https://cloud.debian.org/images/cloud/trixie/latest"
DATE="$(date -u +%Y%m%d)"
SIGN_KEY=""
ALLOW_MISSING_KIT=0
KEEP_WORK=0
SMP=2
MEMSIZE=2048
while [[ $# -gt 0 ]]; do
  case "$1" in
    --kit) KIT="$2"; shift 2 ;;
    --enroll-bin) ENROLL_BIN="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --base-url) BASE_URL="${2%/}"; shift 2 ;;
    --date) DATE="$2"; shift 2 ;;
    --sign-key) SIGN_KEY="$2"; shift 2 ;;
    --allow-missing-kit) ALLOW_MISSING_KIT=1; shift ;;
    --keep-work) KEEP_WORK=1; shift ;;
    --smp) SMP="$2"; shift 2 ;;
    --memsize) MEMSIZE="$2"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "build.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
say() { echo "build: $*"; }
die() { echo "build: ERROR: $*" >&2; exit 1; }

case "$ARCH" in amd64) DEB_ARCH=amd64; ELF_RE='x86-64' ;; arm64) DEB_ARCH=arm64; ELF_RE='aarch64|ARM aarch64' ;; *) die "--arch is amd64 or arm64" ;; esac
[[ "$DATE" =~ ^[0-9]{8}$ ]] || die "--date is yyyymmdd"
[[ "$(uname -s)" == Linux ]] || die "build on Linux (libguestfs); on a Mac use scripts/image/test-customize.sh for the customize step"
case "$(uname -m)" in x86_64) HOST_ARCH=amd64 ;; aarch64|arm64) HOST_ARCH=arm64 ;; *) HOST_ARCH=other ;; esac
[[ "$HOST_ARCH" == "$ARCH" ]] || die "build $ARCH images on a $ARCH host (virt-customize runs the image's own binaries); this is $(uname -m)"
for t in qemu-img virt-customize virt-resize virt-sparsify virt-cat curl sha512sum sha256sum tar; do
  command -v "$t" >/dev/null 2>&1 || die "missing $t (apt-get install libguestfs-tools qemu-utils curl)"
done
[[ -z "$SIGN_KEY" ]] || { command -v openssl >/dev/null || die "missing openssl (for --sign-key)"; [[ -r "$SIGN_KEY" ]] || die "cannot read $SIGN_KEY"; }
[[ -e /dev/kvm ]] || say "warning: no /dev/kvm: libguestfs falls back to TCG (much slower)"
# libguestfs uses passt for --network when it is installed; passt fails inside containers. Unset = libguestfs default.
export LIBGUESTFS_BACKEND="${LIBGUESTFS_BACKEND:-direct}"

mkdir -p "$OUT/cache"
OUT="$(cd "$OUT" && pwd)"
WORK="$OUT/work-$DATE-$ARCH"
rm -rf "$WORK"; mkdir -p "$WORK/stage/ax-image/bin"
STAGE="$WORK/stage/ax-image"
cleanup() { [[ $KEEP_WORK == 1 ]] || rm -rf "$WORK"; }
trap cleanup EXIT

# ---- 1. the kit (W1): install-linux.sh + VERSION + bundle, linux-runtime.md §3.5.1 / §3.6.1
KIT_STATE=missing
KIT_VERSION="0.0.0-kitless"
if [[ -n "$KIT" ]]; then
  [[ -e "$KIT" ]] || die "--kit $KIT does not exist"
  mkdir -p "$STAGE/kit"
  if [[ -d "$KIT" ]]; then cp -a "$KIT/." "$STAGE/kit/"
  else
    case "$KIT" in
      *.tar.gz|*.tgz) tar -xzf "$KIT" -C "$STAGE/kit" ;;
      *.tar.zst) tar --zstd -xf "$KIT" -C "$STAGE/kit" ;;
      *) die "--kit takes a folder or a .tar.gz / .tar.zst kit" ;;
    esac
    # a kit packed with one top-level folder
    if [[ ! -f "$STAGE/kit/install-linux.sh" ]] && [[ $(find "$STAGE/kit" -mindepth 1 -maxdepth 1 | wc -l) -eq 1 ]]; then
      top="$(find "$STAGE/kit" -mindepth 1 -maxdepth 1)"; mv "$top" "$WORK/kit-top"; rm -rf "$STAGE/kit"; mv "$WORK/kit-top" "$STAGE/kit"
    fi
  fi
fi
if [[ -f "$STAGE/kit/install-linux.sh" ]]; then
  [[ -f "$STAGE/kit/VERSION" ]] || die "kit has install-linux.sh but no VERSION"
  KIT_VERSION="$(tr -d '[:space:]' < "$STAGE/kit/VERSION")"
  [[ "$KIT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "kit VERSION '$KIT_VERSION' must be x.y.z[-pre] (the template version is <kitVersion>-d13-<date>)"
  KIT_STATE=present
  if command -v file >/dev/null 2>&1; then
    for b in "$STAGE"/kit/app/*/bin/bun "$STAGE"/kit/app/*/root/mycel-launcher; do
      [[ -f "$b" ]] || continue
      file -bL "$b" | grep -Eq "$ELF_RE" || die "kit binary $b is not a $ARCH ELF: $(file -bL "$b")"
    done
  fi
elif [[ $ALLOW_MISSING_KIT == 1 ]]; then
  rm -rf "$STAGE/kit"
  say "WARNING: no kit (--allow-missing-kit): pipeline dry run, the image is NOT for production"
else
  die "no Team AX Linux kit (install-linux.sh) in '${KIT:-<none given>}'.
  The template needs the W1 kit: scripts/install-linux.sh + the Linux bundle (linux-runtime.md §3.5.1, §3.6.1), and the
  installer must support '--image-mode' (install everything, enable/start nothing, no setup code; ee/cloud/README.md).
  Build it on the Linux runner (bun scripts/build-bundle.ts --os linux --arch $ARCH) and pass --kit <TeamAX-server-<v>-linux-$ARCH.tar.gz>.
  For a pipeline dry run only: --allow-missing-kit."
fi
TEMPLATE_VERSION="$KIT_VERSION-d13-$DATE"
TEMPLATE_NAME="tmpl-ax-$TEMPLATE_VERSION"
BASENAME="teamax-$KIT_VERSION-debian13-$ARCH"
say "template $TEMPLATE_VERSION ($TEMPLATE_NAME), kit $KIT_STATE"

# ---- 2. mycel-enroll (native/cmd/mycel-enroll, built by native/build.sh)
if [[ -n "$ENROLL_BIN" ]]; then
  [[ -f "$ENROLL_BIN" ]] || die "--enroll-bin $ENROLL_BIN does not exist"
  if command -v file >/dev/null 2>&1; then file -bL "$ENROLL_BIN" | grep -Eq "ELF.*($ELF_RE)" || die "$ENROLL_BIN is not a $ARCH Linux ELF"; fi
  cp "$ENROLL_BIN" "$STAGE/bin/mycel-enroll"; chmod 755 "$STAGE/bin/mycel-enroll"
elif [[ $ALLOW_MISSING_KIT != 1 ]]; then
  die "--enroll-bin is required (bash native/build.sh -> native/bin/linux-$ARCH/mycel-enroll)"
fi
cp -a "$HERE/customize.sh" "$HERE/files" "$STAGE/"

# ---- 3. the Debian base image, checked against the published SHA512SUMS
IMG="debian-13-genericcloud-$DEB_ARCH.qcow2"
say "base $BASE_URL/$IMG"
curl --proto '=https' --tlsv1.2 -fsSL -o "$OUT/cache/SHA512SUMS" "$BASE_URL/SHA512SUMS"
want="$(awk -v f="$IMG" '$2 == f || $2 == "*"f {print $1}' "$OUT/cache/SHA512SUMS")"
[[ "$want" =~ ^[0-9a-f]{128}$ ]] || die "no SHA512 for $IMG in $BASE_URL/SHA512SUMS"
if [[ ! -f "$OUT/cache/$IMG" ]] || [[ "$(sha512sum "$OUT/cache/$IMG" | cut -d' ' -f1)" != "$want" ]]; then
  say "downloading $IMG"
  curl --proto '=https' --tlsv1.2 -fsSL -o "$OUT/cache/$IMG.part" "$BASE_URL/$IMG"
  mv "$OUT/cache/$IMG.part" "$OUT/cache/$IMG"
fi
got="$(sha512sum "$OUT/cache/$IMG" | cut -d' ' -f1)"
[[ "$got" == "$want" ]] || { rm -f "$OUT/cache/$IMG"; die "SHA512 mismatch for $IMG (want $want, got $got)"; }
say "base image sha512 ok"

# ---- 4. 12 GiB OS disk (isolation §5.1): grow the root partition (sda1 is the last one in Debian cloud images)
DISK="$WORK/disk.qcow2"
qemu-img create -q -f qcow2 "$DISK" 12G
virt-resize --quiet --expand /dev/sda1 "$OUT/cache/$IMG" "$DISK" > "$WORK/virt-resize.log" 2>&1 || { cat "$WORK/virt-resize.log"; die "virt-resize failed"; }

# ---- 5. customize inside the image (network on: apt, engine downloads by the kit)
extra=()
[[ $ALLOW_MISSING_KIT == 1 ]] && extra+=(--allow-missing-kit)
say "virt-customize (this takes a while)"
if ! virt-customize -a "$DISK" --network --smp "$SMP" --memsize "$MEMSIZE" \
  --copy-in "$STAGE:/root" \
  --run-command "bash /root/ax-image/customize.sh --src /root/ax-image --template-version $TEMPLATE_VERSION ${extra[*]:-}" \
  --delete /root/ax-image > "$WORK/virt-customize.log" 2>&1; then
  tail -n 40 "$WORK/virt-customize.log" >&2
  KEEP_WORK=1
  die "virt-customize failed (full log kept: $WORK/virt-customize.log)"
fi
grep '^customize: ' "$WORK/virt-customize.log" | tail -n 5
virt-cat -a "$DISK" /usr/lib/mycel/image-packages.txt > "$WORK/packages.txt"
virt-cat -a "$DISK" /etc/ax-template.json > "$WORK/ax-template.json"
grep -q "\"templateVersion\":\"$TEMPLATE_VERSION\"" "$WORK/ax-template.json" || die "the image does not carry template version $TEMPLATE_VERSION"

# ---- 6. sparsify + compress, checksum, sign, manifest
FINAL="$OUT/$BASENAME.qcow2"
rm -f "$FINAL" "$FINAL.sha256" "$FINAL.sig" "$OUT/$BASENAME.json"
TMPDIR="$WORK" virt-sparsify --quiet --compress "$DISK" "$FINAL"
SHA="$(sha256sum "$FINAL" | cut -d' ' -f1)"
(cd "$OUT" && echo "$SHA  $BASENAME.qcow2" > "$BASENAME.qcow2.sha256")
SIZE="$(stat -c %s "$FINAL")"
VSIZE="$(qemu-img info --output=json "$FINAL" | sed -n 's/.*"virtual-size": *\([0-9]*\).*/\1/p' | head -n1)"
SIGJSON=null
if [[ -n "$SIGN_KEY" ]]; then
  printf 'ax-template-v1\n%s\n%s' "$TEMPLATE_VERSION" "$SHA" > "$WORK/sigmsg"
  openssl pkeyutl -sign -inkey "$SIGN_KEY" -rawin -in "$WORK/sigmsg" -out "$WORK/sig.bin"
  openssl pkey -in "$SIGN_KEY" -pubout -out "$WORK/pub.pem"
  openssl pkeyutl -verify -pubin -inkey "$WORK/pub.pem" -rawin -in "$WORK/sigmsg" -sigfile "$WORK/sig.bin" >/dev/null || die "signature self-check failed"
  base64 < "$WORK/sig.bin" | tr -d '\n' > "$FINAL.sig"
  PUB_RAW="$(openssl pkey -pubin -in "$WORK/pub.pem" -outform DER | tail -c 32 | base64 | tr -d '\n')"
  SIGJSON="{\"alg\":\"ed25519\",\"file\":\"$BASENAME.qcow2.sig\",\"message\":\"ax-template-v1\\n<templateVersion>\\n<sha256>\",\"publicKey\":\"$PUB_RAW\"}"
  say "signed with $SIGN_KEY (public key $PUB_RAW)"
fi
production=true; [[ $KIT_STATE == present ]] || production=false
{
  printf '{"format":1,"templateVersion":"%s","templateName":"%s","kitVersion":"%s","kit":"%s","production":%s,' \
    "$TEMPLATE_VERSION" "$TEMPLATE_NAME" "$KIT_VERSION" "$KIT_STATE" "$production"
  printf '"arch":"%s","file":"%s.qcow2","sha256":"%s","sizeBytes":%s,"virtualSizeBytes":%s,"signature":%s,' \
    "$ARCH" "$BASENAME" "$SHA" "$SIZE" "${VSIZE:-0}" "$SIGJSON"
  printf '"base":{"url":"%s/%s","sha512":"%s"},"builtAt":"%s","packages":[' "$BASE_URL" "$IMG" "$want" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  sed 's/.*/"&"/' "$WORK/packages.txt" | paste -sd, -
  printf ']}\n'
} > "$OUT/$BASENAME.json"
say "done: $FINAL"
say "  sha256 $SHA, $SIZE bytes (virtual $VSIZE)"
say "  manifest $OUT/$BASENAME.json"
[[ $production == true ]] || say "  NOT FOR PRODUCTION (built without the kit)"

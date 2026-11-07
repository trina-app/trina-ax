#!/bin/bash
# Build the Team AX team image for EC2 (an AMI) and its signed manifest (trina-cloud docs/research/ec2-per-team.md
# §10.2). It runs on the operator's Mac or Linux box with the owner's AWS CLI session. It needs no IAM role.
#
#   scripts/image/build-ami.sh --kit <TeamAX-server-<v>-linux-amd64.tar.gz | kit dir> \
#       --enroll-bin <linux-amd64 mycel-enroll> --link-bin <linux-amd64 mycel-link> --subnet-id subnet-… [options]
#
# Options (defaults):
#   --region ap-northeast-2     --profile P (AWS CLI profile)
#   --account ID                (required, except with --dry-run) the AWS account to build in. The script stops
#                               before any change when the session is another account: the default profile of a
#                               machine can belong to another company
#   --subnet-id subnet-…        (required) a subnet with a route to the internet and a NACL that lets SSH in from
#                               --ssh-cidr (the hostd subnet of trina-teams, or a default-VPC subnet). Not a team subnet:
#                               their NACL blocks inbound SSH.
#   --source-ami ami-…          default: the newest official Debian 13 amd64 AMI (Debian's SSM parameter), always
#                               checked against Debian's owner id 136693071363
#   --builder-type t3a.medium   --ssh-cidr <your IP>/32 (default: from https://checkip.amazonaws.com)
#   --date yyyymmdd             template version = <kitVersion>-d13-<date> (default: today, UTC)
#   --sign-key ed25519.pem      release key (PKCS#8 PEM). Without it the manifest is not signed (test only)
#   --out dist/image            --root-gb 20 (the AMI root size; the plans in the design use 20)
#   --test                      test build: every resource also gets trina-test=ec2-driver and a Name starting
#                               "trina-test-", so a check by tag finds all of it
#   --tag K=V                   one more tag on every resource (repeat for more)
#   --allow-missing-kit         pipeline dry run without the kit (kitVersion 0.0.0-kitless): NOT for production
#   --apt-snapshot TS           apt packages from snapshot.debian.org at TS (YYYYMMDDTHHMMSSZ): a rebuild gets the same versions
#   --dry-run                   print every aws command, run none, make nothing
#   --yes, -y                   no confirmation prompt (needed when stdin is not a terminal)
#   --cleanup STATEFILE         remove what a failed run left behind (only the ids in its state file), then exit
#   --manifest-v2 …             (first argument) no build: run ami-manifest-v2.sh with the other arguments. It copies
#                               a built AMI to more regions and/or writes the signed v2 manifest
#                               teamax-<templateVersion>.v2.ami.json for a hostd with several regions (see its --help)
#
# What it does:
#   1. A temporary security group (SSH from --ssh-cidr only) and a builder instance from the Debian AMI. Its SSH host
#      key and login key are made here and sent in user-data, so the first SSH login checks a known host key.
#   2. A 20 GiB gp3 work volume (encrypted) from the Debian AMI's root snapshot, attached to the builder.
#   3. ami-chroot.sh on the builder: grow the file system, run customize.sh in a chroot on the work volume. It also
#      puts the dev environment on srt (packages, node, srt; scripts/dev-env/srt/install-srt.sh --image-mode) into the
#      image. The dev environment stays off until install-srt.sh runs on the team server.
#   4. Detach, snapshot (wait "completed"), RegisterImage (x86_64, ENA, uefi-preferred, IMDSv2, /dev/xvda).
#   5. Terminate the builder, delete the work volume and the security group.
#   6. Write teamax-<templateVersion>.ami.json once, then its .sha256 and .sig. The release key signs
#      "ax-template-v1\n<templateVersion>\n<sha256 hex of the manifest file>" (no trailing newline), the same message
#      as for the qcow2 (build.sh). ax-hostd installTemplate checks it.
#
# Tags: builder, its root volume, the work volume and the security group: ax:managed=ami-build. Root snapshot and AMI:
# ax:managed=ami, ax:template=<templateVersion>. Every id it makes goes into <out>/ami-build-<templateVersion>.state
# first. On failure the script removes only those ids, and only when they carry the expected ax:managed tag. It never
# looks up resources by filter to delete them (production lives in the same account). The AMI and its snapshot are
# kept once the AMI is registered.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
if [[ "${1:-}" == --manifest-v2 ]]; then shift; exec "${BASH:-/bin/bash}" "$HERE/ami-manifest-v2.sh" "$@"; fi

KIT=""; ENROLL_BIN=""; LINK_BIN=""; SUBNET=""; REGION=ap-northeast-2; PROFILE=""; ACCOUNT_WANT=""; SOURCE_AMI=""
BUILDER_TYPE=t3a.medium; SSH_CIDR=""; DATE="$(date -u +%Y%m%d)"; SIGN_KEY=""; OUT="$REPO/dist/image"; ROOT_GB=20
TEST=0; EXTRA_TAGS=(); ALLOW_MISSING_KIT=0; DRY=0; YES=0; CLEANUP_STATE=""; APT_SNAPSHOT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --kit) KIT="$2"; shift 2 ;;
    --enroll-bin) ENROLL_BIN="$2"; shift 2 ;;
    --link-bin) LINK_BIN="$2"; shift 2 ;;
    --subnet-id) SUBNET="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --account) ACCOUNT_WANT="$2"; shift 2 ;;
    --source-ami) SOURCE_AMI="$2"; shift 2 ;;
    --builder-type) BUILDER_TYPE="$2"; shift 2 ;;
    --ssh-cidr) SSH_CIDR="$2"; shift 2 ;;
    --date) DATE="$2"; shift 2 ;;
    --sign-key) SIGN_KEY="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --root-gb) ROOT_GB="$2"; shift 2 ;;
    --test) TEST=1; shift ;;
    --tag) EXTRA_TAGS+=("$2"); shift 2 ;;
    --allow-missing-kit) ALLOW_MISSING_KIT=1; shift ;;
    --apt-snapshot) APT_SNAPSHOT="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --cleanup) CLEANUP_STATE="$2"; shift 2 ;;
    -h|--help) sed -n '2,51p' "$0"; exit 0 ;;
    *) echo "build-ami: unknown argument $1" >&2; exit 2 ;;
  esac
done
say() { echo "build-ami: $*"; }
die() { echo "build-ami: ERROR: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
sha256() { if have sha256sum; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

DEBIAN_OWNER=136693071363
NAME_PREFIX=""; [[ $TEST == 1 ]] && NAME_PREFIX="trina-test-"

AWS=(aws --region "$REGION")
[[ -n "$PROFILE" ]] && AWS+=(--profile "$PROFILE")
# q PLACEHOLDER aws-args…: run one aws command; in --dry-run print it and answer with the placeholder
exec 3>&2
q() { local ph="$1"; shift; if [[ $DRY == 1 ]]; then { printf '+'; printf ' %q' "${AWS[@]}" "$@"; echo; } >&3; echo "$ph"; else "${AWS[@]}" "$@"; fi; }

# ---- state file: one "kind id" line per resource, written right after the create call answers
STATE=""
record() { [[ $DRY == 1 ]] || echo "$1 $2" >> "$STATE"; }
forget() { [[ $DRY == 1 ]] || { grep -v "^$1 $2\$" "$STATE" > "$STATE.tmp" || true; mv "$STATE.tmp" "$STATE"; }; }
recorded() { [[ -f "$STATE" ]] && awk -v k="$1" '$1 == k {print $2}' "$STATE"; }
# the ax:managed tag of a resource, or "" (describe-tags works for every resource type)
managed_tag() {
  "${AWS[@]}" ec2 describe-tags --filters "Name=resource-id,Values=$1" Name=key,Values=ax:managed \
    --query 'Tags[0].Value' --output text 2>/dev/null || true
}
# remove what the state file names. An AMI and its snapshot stay once the AMI is registered.
cleanup_state() {
  local id t
  [[ -f "$STATE" ]] || return 0
  for id in $(recorded instance); do
    t="$(managed_tag "$id")"
    if [[ "$t" != ami-build ]]; then say "cleanup: $id has ax:managed=${t:-none}, not ami-build: left alone"; continue; fi
    say "cleanup: terminate builder $id"
    "${AWS[@]}" ec2 terminate-instances --instance-ids "$id" >/dev/null 2>&1 || true
    "${AWS[@]}" ec2 wait instance-terminated --instance-ids "$id" 2>/dev/null || true
    forget instance "$id"
  done
  for id in $(recorded volume); do
    t="$(managed_tag "$id")"
    if [[ "$t" != ami-build ]]; then say "cleanup: $id has ax:managed=${t:-none}, not ami-build: left alone"; continue; fi
    say "cleanup: delete work volume $id"
    "${AWS[@]}" ec2 detach-volume --volume-id "$id" --force >/dev/null 2>&1 || true
    "${AWS[@]}" ec2 wait volume-available --volume-ids "$id" 2>/dev/null || true
    if "${AWS[@]}" ec2 delete-volume --volume-id "$id" >/dev/null 2>&1; then forget volume "$id"; else say "cleanup: could not delete $id"; fi
  done
  if [[ -z "$(recorded image)" ]]; then
    for id in $(recorded snapshot); do
      t="$(managed_tag "$id")"
      if [[ "$t" != ami ]]; then say "cleanup: $id has ax:managed=${t:-none}, not ami: left alone"; continue; fi
      say "cleanup: delete unregistered snapshot $id"
      if "${AWS[@]}" ec2 delete-snapshot --snapshot-id "$id" >/dev/null 2>&1; then forget snapshot "$id"; else say "cleanup: could not delete $id"; fi
    done
  fi
  for id in $(recorded sg); do
    t="$(managed_tag "$id")"
    if [[ "$t" != ami-build ]]; then say "cleanup: $id has ax:managed=${t:-none}, not ami-build: left alone"; continue; fi
    say "cleanup: delete security group $id"
    local n
    for n in 1 2 3 4 5 6; do
      if "${AWS[@]}" ec2 delete-security-group --group-id "$id" >/dev/null 2>&1; then forget sg "$id"; break; fi
      sleep 10   # the builder's network interface goes away a little after "terminated"
    done
  done
  if [[ -n "$(recorded image)" ]]; then say "cleanup: kept AMI $(recorded image) and snapshot $(recorded snapshot)"; fi
  if [[ -n "$(awk '$1 != "image" && $1 != "snapshot"' "$STATE")" ]]; then
    say "cleanup: NOT removed (check by hand): $(awk '$1 != "image" && $1 != "snapshot" {printf "%s ", $2}' "$STATE")"
    return 1
  fi
}

[[ $DRY == 1 || -n "$ACCOUNT_WANT" ]] || die "--account <12-digit id> is required (the account to build in; see --help)"
[[ -z "$ACCOUNT_WANT" || "$ACCOUNT_WANT" =~ ^[0-9]{12}$ ]] || die "--account is a 12-digit AWS account id"
# the account of the AWS session; with --account, stop when it is another one
check_account() {
  ACCOUNT="$("${AWS[@]}" sts get-caller-identity --query Account --output text)" || die "aws credentials do not work (aws configure, or --profile)"
  [[ -z "$ACCOUNT_WANT" || "$ACCOUNT" == "$ACCOUNT_WANT" ]] || die "the AWS session is account $ACCOUNT, not --account $ACCOUNT_WANT (check --profile)"
  say "account $ACCOUNT"
}

if [[ -n "$CLEANUP_STATE" ]]; then
  [[ -f "$CLEANUP_STATE" ]] || die "no state file $CLEANUP_STATE"
  check_account
  STATE="$CLEANUP_STATE"
  cleanup_state
  say "cleanup done ($STATE)"
  exit 0
fi

# ---- 0. checks before any AWS call
[[ "$DATE" =~ ^[0-9]{8}$ ]] || die "--date is yyyymmdd"
[[ "$ROOT_GB" =~ ^[0-9]+$ && $ROOT_GB -ge 8 ]] || die "--root-gb is a whole number of GiB, at least 8"
# a signed manifest is installable; a kitless image must never be
[[ $ALLOW_MISSING_KIT == 0 || -z "$SIGN_KEY" ]] || die "--sign-key and --allow-missing-kit exclude each other (a kitless AMI is never for production)"
[[ -n "$SUBNET" ]] || die "--subnet-id is required (a subnet with internet access whose NACL lets SSH in; see --help)"
[[ "$SUBNET" =~ ^subnet-[0-9a-f]+$ ]] || die "--subnet-id looks wrong: $SUBNET"
[[ -z "$SOURCE_AMI" || "$SOURCE_AMI" =~ ^ami-[0-9a-f]+$ ]] || die "--source-ami looks wrong: $SOURCE_AMI"
[[ "$BUILDER_TYPE" =~ ^t3a\.(medium|large)$ ]] || die "--builder-type is t3a.medium or t3a.large"
for kv in ${EXTRA_TAGS[@]+"${EXTRA_TAGS[@]}"}; do [[ "$kv" =~ ^[A-Za-z0-9:._/-]+=[A-Za-z0-9:._/@+-]*$ ]] || die "--tag $kv: use K=V with plain characters"; done
for t in aws ssh scp ssh-keygen tar od; do have "$t" || die "missing $t"; done
if [[ $DRY != 1 ]]; then
  AWSV="$(aws --version 2>&1 | awk '{ print $1; exit }')"
  [[ "$AWSV" == aws-cli/2* ]] || die "aws CLI v2 required (found ${AWSV:-nothing})"
fi
if [[ -n "$SIGN_KEY" ]]; then
  have openssl || die "missing openssl (for --sign-key)"
  [[ -r "$SIGN_KEY" ]] || die "cannot read $SIGN_KEY"
  probe="$(mktemp "${TMPDIR:-/tmp}/ax-sign-probe.XXXXXX")"
  printf 'ax-template-v1\nprobe\n0' > "$probe"
  if ! openssl pkeyutl -sign -inkey "$SIGN_KEY" -rawin -in "$probe" -out /dev/null 2>/dev/null; then
    rm -f "$probe"; die "openssl cannot sign with $SIGN_KEY (an Ed25519 PKCS#8 PEM, and OpenSSL 3 or later: not the macOS LibreSSL)"
  fi
  rm -f "$probe"
fi
# x86-64 ELF check from the header bytes (file(1) is not needed): magic, 64-bit, e_machine 0x3e
is_amd64_elf() { local h; h="$(od -An -tx1 -N20 "$1" 2>/dev/null | tr -d ' \n')"; [[ "${h:0:10}" == 7f454c4602 && "${h:36:4}" == 3e00 ]]; }

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ax-ami.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/stage/ax-image"
mkdir -p "$STAGE/bin"

# the kit (as build.sh: a folder, or a .tar.gz / .tar.zst with one top folder)
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
    if [[ ! -f "$STAGE/kit/install-linux.sh" ]] && [[ $(find "$STAGE/kit" -mindepth 1 -maxdepth 1 | wc -l) -eq 1 ]]; then
      top="$(find "$STAGE/kit" -mindepth 1 -maxdepth 1)"; mv "$top" "$WORK/kit-top"; rm -rf "$STAGE/kit"; mv "$WORK/kit-top" "$STAGE/kit"
    fi
  fi
fi
if [[ -f "$STAGE/kit/install-linux.sh" ]]; then
  [[ -f "$STAGE/kit/VERSION" ]] || die "kit has install-linux.sh but no VERSION"
  KIT_VERSION="$(tr -d '[:space:]' < "$STAGE/kit/VERSION")"
  [[ "$KIT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "kit VERSION '$KIT_VERSION' must be x.y.z[-pre]"
  KIT_STATE=present
  for b in "$STAGE"/kit/app/*/bin/bun "$STAGE"/kit/app/*/root/mycel-launcher "$STAGE"/kit/root/mycel-launcher; do
    [[ -f "$b" ]] || continue
    is_amd64_elf "$b" || die "kit binary $b is not an x86-64 ELF (EC2 t3a is amd64: build the kit with --arch amd64)"
  done
elif [[ $ALLOW_MISSING_KIT == 1 ]]; then
  rm -rf "$STAGE/kit"
  say "WARNING: no kit (--allow-missing-kit): pipeline dry run, the AMI is NOT for production"
else
  die "no Team AX Linux kit (install-linux.sh) in '${KIT:-<none given>}'. Build it for linux amd64
  (bun scripts/build-bundle.ts --os linux --arch amd64) and pass --kit <TeamAX-server-<v>-linux-amd64.tar.gz>.
  For a pipeline dry run only: --allow-missing-kit."
fi
# mycel-enroll and mycel-link: linux amd64 (on a Mac: ARCHS=amd64 bash native/build.sh)
for pair in "enroll:$ENROLL_BIN" "link:$LINK_BIN"; do
  what="${pair%%:*}"; f="${pair#*:}"
  if [[ -n "$f" ]]; then
    [[ -f "$f" ]] || die "--$what-bin $f does not exist"
    is_amd64_elf "$f" || die "--$what-bin $f is not an x86-64 Linux ELF (build with GOOS=linux GOARCH=amd64)"
    cp "$f" "$STAGE/bin/mycel-$what"; chmod 755 "$STAGE/bin/mycel-$what"
  elif [[ $ALLOW_MISSING_KIT != 1 ]]; then
    die "--$what-bin is required (a linux amd64 mycel-$what; native/cmd/mycel-$what)"
  fi
done
cp -a "$HERE/customize.sh" "$HERE/files" "$STAGE/"
# the one list of packages and its reader: the kit's app/<v>/root/packages.{json,sh} (what the installer in the image
# reads), which must be this checkout's scripts/system/ (customize.sh and install-srt.sh read the staged copy). One list
# per image: a kit and a checkout of different commits stop the build. A kitless dry run takes the checkout's.
SYS_SRC="$REPO/scripts/system"
if [[ $KIT_STATE == present ]]; then
  for f in packages.json packages.sh; do
    k="$STAGE/kit/app/$KIT_VERSION/root/$f"
    [[ -f "$k" ]] || die "the kit has no app/$KIT_VERSION/root/$f (a kit from before the one list): build the kit from this checkout"
    cmp -s "$k" "$SYS_SRC/$f" || die "the kit's root/$f differs from scripts/system/$f in this checkout: build the kit and the image from one commit"
  done
  SYS_SRC="$STAGE/kit/app/$KIT_VERSION/root"
fi
mkdir -p "$STAGE/system" "$STAGE/dev-env-srt/system"
cp -p "$SYS_SRC/packages.sh" "$SYS_SRC/packages.json" "$STAGE/system/"
cp -p "$SYS_SRC/packages.sh" "$SYS_SRC/packages.json" "$STAGE/dev-env-srt/system/"
# the dev environment on srt, image part (customize.sh --srt, default <stage>/dev-env-srt): only the install files
SRT_FILES=(install-srt.sh uninstall-srt.sh package.json package-lock.json run-wrap srt-full.mjs devenv.rules.in devenv.slice.in README.md)
mkdir -p "$STAGE/dev-env-srt"
for f in "${SRT_FILES[@]}"; do
  [[ -f "$REPO/scripts/dev-env/srt/$f" ]] || die "missing scripts/dev-env/srt/$f"
  cp -p "$REPO/scripts/dev-env/srt/$f" "$STAGE/dev-env-srt/"
done
cp "$HERE/ami-chroot.sh" "$WORK/stage/ami-chroot.sh"

TEMPLATE_VERSION="$KIT_VERSION-d13-$DATE"
AMI_NAME="${NAME_PREFIX}teamax-$TEMPLATE_VERSION"
MANIFEST="$OUT/teamax-$TEMPLATE_VERSION.ami.json"
STATE="$OUT/ami-build-$TEMPLATE_VERSION.state"
say "template $TEMPLATE_VERSION, kit $KIT_STATE, region $REGION$([[ $DRY == 1 ]] && echo ', DRY RUN')"
[[ $DRY == 1 || ! -s "$STATE" ]] || die "$STATE names resources of an earlier run: clean up first (--cleanup $STATE)"
[[ $DRY == 1 || ! -e "$MANIFEST" ]] || die "$MANIFEST exists already: one manifest per template version"

# tags: tagspec RESOURCE-TYPE NAME MANAGED [K=V …]
tagspec() {
  local rt="$1" name="$2" managed="$3"; shift 3
  local s="ResourceType=$rt,Tags=[{Key=Name,Value=$name},{Key=ax:managed,Value=$managed}"
  local kv
  for kv in "$@" ${EXTRA_TAGS[@]+"${EXTRA_TAGS[@]}"}; do s+=",{Key=${kv%%=*},Value=${kv#*=}}"; done
  [[ $TEST == 1 ]] && s+=",{Key=trina-test,Value=ec2-driver}"
  echo "$s]"
}
BUILD_NAME="${NAME_PREFIX}ax-ami-build-$TEMPLATE_VERSION"

# ---- 1. read-only checks in AWS
[[ $DRY == 1 ]] || check_account
if [[ -z "$SOURCE_AMI" ]]; then
  SOURCE_AMI="$(q ami-DRYRUN ssm get-parameter --name /aws/service/debian/release/13/latest/amd64 --query Parameter.Value --output text 2>/dev/null || true)"
  [[ "$SOURCE_AMI" =~ ^ami- ]] || SOURCE_AMI="$(q ami-DRYRUN ec2 describe-images --owners "$DEBIAN_OWNER" --filters 'Name=name,Values=debian-13-amd64-*' \
    'Name=architecture,Values=x86_64' --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)"
fi
[[ "$SOURCE_AMI" =~ ^ami- ]] || die "no Debian 13 amd64 AMI found in $REGION"
# only Debian's own account: --owners makes AWS answer nothing for an AMI of anyone else
read -r SRC_ARCH SRC_ROOTDEV SRC_BDM_DEV SRC_SNAP SRC_NAME <<<"$(q 'x86_64 /dev/xvda /dev/xvda snap-DRYRUN debian-13-amd64-DRYRUN' ec2 describe-images \
  --image-ids "$SOURCE_AMI" --owners "$DEBIAN_OWNER" \
  --query 'Images[0].[Architecture,RootDeviceName,BlockDeviceMappings[0].DeviceName,BlockDeviceMappings[0].Ebs.SnapshotId,Name]' --output text)"
[[ "$SRC_ARCH" == x86_64 ]] || die "$SOURCE_AMI is not an x86_64 AMI owned by Debian ($DEBIAN_OWNER): got '${SRC_ARCH:-nothing}'"
[[ "$SRC_ROOTDEV" == /dev/xvda && "$SRC_BDM_DEV" == /dev/xvda ]] || die "$SOURCE_AMI root device is $SRC_ROOTDEV ($SRC_BDM_DEV), expected /dev/xvda"
[[ "$SRC_SNAP" =~ ^snap- ]] || die "$SOURCE_AMI has no root snapshot"
say "source $SOURCE_AMI ($SRC_NAME), root snapshot $SRC_SNAP"
read -r VPC AZ AZ_ID <<<"$(q 'vpc-DRYRUN ap-northeast-2a apne2-az1' ec2 describe-subnets --subnet-ids "$SUBNET" \
  --query 'Subnets[0].[VpcId,AvailabilityZone,AvailabilityZoneId]' --output text)"
[[ "$VPC" =~ ^vpc- ]] || die "subnet $SUBNET not found in $REGION"
say "subnet $SUBNET in $VPC, $AZ ($AZ_ID)"
EXIST="$(q None ec2 describe-images --owners self --filters "Name=tag:ax:template,Values=$TEMPLATE_VERSION" --query 'Images[].ImageId' --output text)"
[[ -z "$EXIST" || "$EXIST" == None ]] || die "an AMI for template $TEMPLATE_VERSION exists already: $EXIST (use another --date, or deregister it)"
if [[ -z "$SSH_CIDR" ]]; then
  if [[ $DRY == 1 ]]; then SSH_CIDR=203.0.113.10/32
  else
    ip="$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')" || die "cannot find your public IP: pass --ssh-cidr"
    [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "checkip answered '$ip': pass --ssh-cidr"
    SSH_CIDR="$ip/32"
  fi
fi
[[ "$SSH_CIDR" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/(2[4-9]|3[0-2])$ ]] || die "--ssh-cidr must be one address or a small range (/24 to /32): $SSH_CIDR"

if [[ $DRY != 1 && $YES != 1 ]]; then
  [[ -t 0 ]] || die "no terminal for the confirmation prompt: pass --yes"
  echo "build-ami: makes a $BUILDER_TYPE builder (about 30 min), a ${ROOT_GB} GiB gp3 work volume and a security group (SSH from"
  echo "           $SSH_CIDR), then keeps an AMI + one snapshot (${ROOT_GB} GiB, about \$0.05 per GB-month)."
  read -r -p "Build AMI $AMI_NAME in account $ACCOUNT, $REGION now? [y/N] " a
  [[ "$a" == y || "$a" == Y ]] || die "aborted"
fi

# ---- 2. builder: keys made here, a temporary security group, the instance, the work volume
[[ $DRY == 1 ]] || : > "$STATE"
on_exit() {
  local rc=$?
  if [[ $rc -ne 0 && $DRY != 1 && -n "$STATE" ]]; then
    say "failed (exit $rc): removing what this run made (state $STATE)"
    cleanup_state || say "run again later: $0 --cleanup $STATE"
  fi
  rm -rf "$WORK"
}
trap on_exit EXIT

ssh-keygen -q -t ed25519 -N '' -C ax-ami-build -f "$WORK/login" </dev/null
ssh-keygen -q -t ed25519 -N '' -C ax-ami-build-host -f "$WORK/hostkey" </dev/null
{
  echo '#cloud-config'
  echo 'ssh_authorized_keys:'
  echo "  - $(cat "$WORK/login.pub")"
  echo 'ssh_deletekeys: true'
  echo 'ssh_genkeytypes: []'
  echo 'ssh_keys:'
  echo '  ed25519_private: |'
  sed 's/^/    /' "$WORK/hostkey"
  echo "  ed25519_public: $(cat "$WORK/hostkey.pub")"
} > "$WORK/user-data"

SG="$(q sg-DRYRUN ec2 create-security-group --group-name "$BUILD_NAME-$(date -u +%H%M%S)" --vpc-id "$VPC" \
  --description "Team AX AMI build $TEMPLATE_VERSION: SSH from the operator only, deleted after the build" \
  --tag-specifications "$(tagspec security-group "$BUILD_NAME" ami-build "ax:template=$TEMPLATE_VERSION")" --query GroupId --output text)"
[[ "$SG" =~ ^sg- ]] || die "create-security-group answered '$SG'"
record sg "$SG"
q - ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 22 --cidr "$SSH_CIDR" >/dev/null
say "security group $SG (tcp 22 from $SSH_CIDR)"

BDM="[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":20,\"VolumeType\":\"gp3\",\"Encrypted\":true,\"DeleteOnTermination\":true}}]"
INSTANCE="$(q i-DRYRUN ec2 run-instances --image-id "$SOURCE_AMI" --instance-type "$BUILDER_TYPE" \
  --subnet-id "$SUBNET" --security-group-ids "$SG" --associate-public-ip-address \
  --block-device-mappings "$BDM" \
  --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled,InstanceMetadataTags=disabled \
  --instance-initiated-shutdown-behavior terminate \
  --tag-specifications "$(tagspec instance "$BUILD_NAME" ami-build "ax:template=$TEMPLATE_VERSION")" \
                       "$(tagspec volume "$BUILD_NAME-root" ami-build "ax:template=$TEMPLATE_VERSION")" \
  --user-data "file://$WORK/user-data" \
  --query 'Instances[0].InstanceId' --output text)"
[[ "$INSTANCE" =~ ^i- ]] || die "run-instances answered '$INSTANCE'"
record instance "$INSTANCE"
say "builder $INSTANCE ($BUILDER_TYPE)"

VOLUME="$(q vol-DRYRUN ec2 create-volume --snapshot-id "$SRC_SNAP" --availability-zone "$AZ" --size "$ROOT_GB" \
  --volume-type gp3 --encrypted \
  --tag-specifications "$(tagspec volume "$BUILD_NAME-work" ami-build "ax:template=$TEMPLATE_VERSION")" \
  --query VolumeId --output text)"
[[ "$VOLUME" =~ ^vol- ]] || die "create-volume answered '$VOLUME'"
record volume "$VOLUME"
say "work volume $VOLUME (${ROOT_GB} GiB gp3 from $SRC_SNAP)"

q - ec2 wait volume-available --volume-ids "$VOLUME" >/dev/null
q - ec2 wait instance-running --instance-ids "$INSTANCE" >/dev/null
IP="$(q 203.0.113.20 ec2 describe-instances --instance-ids "$INSTANCE" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
[[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "builder $INSTANCE has no public IP ('$IP'): the subnet needs a route to an internet gateway"
say "builder at $IP"

# ---- 3. customize the work volume over SSH (the host key is the one sent in user-data)
echo "$IP $(cut -d' ' -f1-2 "$WORK/hostkey.pub")" > "$WORK/known_hosts"
SSH_OPTS=(-i "$WORK/login" -o IdentitiesOnly=yes -o UserKnownHostsFile="$WORK/known_hosts" -o StrictHostKeyChecking=yes
  -o HostKeyAlgorithms=ssh-ed25519 -o ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=10 -o BatchMode=yes)
rssh() { if [[ $DRY == 1 ]]; then echo "+ ssh admin@$IP $*" >&3; else ssh "${SSH_OPTS[@]}" "admin@$IP" "$@"; fi; }
if [[ $DRY != 1 ]]; then
  ok=0
  for _ in $(seq 1 60); do if rssh true 2>/dev/null; then ok=1; break; fi; sleep 5; done
  [[ $ok == 1 ]] || die "no SSH to $IP after 5 minutes (NACL of $SUBNET, or --ssh-cidr $SSH_CIDR is not your address)"
fi
# attach only now: the builder has booted from its own root. The work volume has the same partition and file system
# UUIDs (both come from the same snapshot), so attached during boot it could be taken as the root.
q - ec2 attach-volume --volume-id "$VOLUME" --instance-id "$INSTANCE" --device /dev/sdf >/dev/null
q - ec2 wait volume-in-use --volume-ids "$VOLUME" >/dev/null
COPYFILE_DISABLE=1 tar -czf "$WORK/stage.tgz" -C "$WORK/stage" .
if [[ $DRY == 1 ]]; then echo "+ scp stage.tgz admin@$IP:/tmp/ax-stage.tgz" >&3
else scp -q "${SSH_OPTS[@]}" "$WORK/stage.tgz" "admin@$IP:/tmp/ax-stage.tgz"; fi
extra=""; [[ $ALLOW_MISSING_KIT == 1 ]] && extra=" --allow-missing-kit"
if [[ -n "$APT_SNAPSHOT" ]]; then
  [[ "$APT_SNAPSHOT" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die "--apt-snapshot $APT_SNAPSHOT is not YYYYMMDDTHHMMSSZ"
  extra+=" --apt-snapshot $APT_SNAPSHOT"
fi
say "customize on the builder (log: $OUT/ami-build-$TEMPLATE_VERSION.log)"
rssh "sudo bash -c 'set -e; rm -rf /root/ax-build; mkdir -m 700 /root/ax-build; tar --no-same-owner -xzf /tmp/ax-stage.tgz -C /root/ax-build; rm -f /tmp/ax-stage.tgz; bash /root/ax-build/ami-chroot.sh --volume-id $VOLUME --stage /root/ax-build/ax-image --template-version $TEMPLATE_VERSION$extra'" \
  > "$OUT/ami-build-$TEMPLATE_VERSION.log" 2>&1 || { tail -n 40 "$OUT/ami-build-$TEMPLATE_VERSION.log" >&2; die "customize on the builder failed (full log above)"; }
grep -E '^(ami-chroot|customize): ' "$OUT/ami-build-$TEMPLATE_VERSION.log" | tail -n 5 || true
if [[ $DRY != 1 ]]; then
  rssh "sudo cat /root/ax-build/ax-image.ax-template.json" > "$WORK/ax-template.json"
  grep -q "\"templateVersion\":\"$TEMPLATE_VERSION\"" "$WORK/ax-template.json" || die "the image does not carry template version $TEMPLATE_VERSION"
fi

# ---- 4. snapshot and register
q - ec2 detach-volume --volume-id "$VOLUME" --instance-id "$INSTANCE" >/dev/null
q - ec2 wait volume-available --volume-ids "$VOLUME" >/dev/null
SNAP="$(q snap-DRYRUN ec2 create-snapshot --volume-id "$VOLUME" --description "Team AX template $TEMPLATE_VERSION root" \
  --tag-specifications "$(tagspec snapshot "$AMI_NAME" ami "ax:template=$TEMPLATE_VERSION")" --query SnapshotId --output text)"
[[ "$SNAP" =~ ^snap- ]] || die "create-snapshot answered '$SNAP'"
record snapshot "$SNAP"
say "snapshot $SNAP: waiting for completed"
if [[ $DRY != 1 ]]; then
  for i in $(seq 1 120); do
    st="$(q - ec2 describe-snapshots --snapshot-ids "$SNAP" --query 'Snapshots[0].State' --output text)"
    [[ "$st" == completed ]] && break
    [[ "$st" == error ]] && die "snapshot $SNAP failed"
    [[ $i -lt 120 ]] || die "snapshot $SNAP not completed after 60 minutes"
    sleep 30
  done
fi
IMAGE="$(q ami-NEW-DRYRUN ec2 register-image --name "$AMI_NAME" --description "Team AX team server $TEMPLATE_VERSION (Debian 13)" \
  --architecture x86_64 --virtualization-type hvm --ena-support --boot-mode uefi-preferred --imds-support v2.0 \
  --root-device-name /dev/xvda \
  --block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"SnapshotId\":\"$SNAP\",\"VolumeSize\":$ROOT_GB,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
  --tag-specifications "$(tagspec image "$AMI_NAME" ami "ax:template=$TEMPLATE_VERSION")" \
  --query ImageId --output text)"
[[ "$IMAGE" =~ ^ami- ]] || die "register-image answered '$IMAGE'"
record image "$IMAGE"
q - ec2 wait image-available --image-ids "$IMAGE" >/dev/null
read -r CHK_STATE CHK_SNAP CHK_ENA <<<"$(q "available $SNAP True" ec2 describe-images --image-ids "$IMAGE" --owners self \
  --query 'Images[0].[State,BlockDeviceMappings[0].Ebs.SnapshotId,EnaSupport]' --output text)"
[[ "$CHK_STATE" == available && "$CHK_SNAP" == "$SNAP" && "$CHK_ENA" == True ]] || die "AMI $IMAGE: state $CHK_STATE, root snapshot $CHK_SNAP, ENA $CHK_ENA"
say "AMI $IMAGE available"

# ---- 5. remove the build resources (the AMI and its snapshot stay)
q - ec2 terminate-instances --instance-ids "$INSTANCE" >/dev/null
q - ec2 wait instance-terminated --instance-ids "$INSTANCE" >/dev/null
forget instance "$INSTANCE"
q - ec2 delete-volume --volume-id "$VOLUME" >/dev/null
forget volume "$VOLUME"
deleted=0
for _ in 1 2 3 4 5 6; do
  if q - ec2 delete-security-group --group-id "$SG" >/dev/null 2>&1; then deleted=1; break; fi
  sleep 10
done
[[ $deleted == 1 ]] || die "could not delete security group $SG (run: $0 --cleanup $STATE)"
forget sg "$SG"

# ---- 6. manifest: written once, then hashed and signed (the signature covers these exact bytes)
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [[ $DRY == 1 ]]; then say "dry run: would write $MANIFEST"; trap - EXIT; rm -rf "$WORK"; exit 0; fi
printf '{"v":1,"kind":"ami","templateVersion":"%s","region":"%s","imageId":"%s","rootSnapshotId":"%s","architecture":"x86_64","sourceImageId":"%s","kitVersion":"%s","builtAt":"%s"}\n' \
  "$TEMPLATE_VERSION" "$REGION" "$IMAGE" "$SNAP" "$SOURCE_AMI" "$KIT_VERSION" "$BUILT_AT" > "$MANIFEST"
chmod 444 "$MANIFEST"
SHA="$(sha256 "$MANIFEST")"
(cd "$OUT" && echo "$SHA  $(basename "$MANIFEST")" > "$(basename "$MANIFEST").sha256")
if [[ -n "$SIGN_KEY" ]]; then
  printf 'ax-template-v1\n%s\n%s' "$TEMPLATE_VERSION" "$SHA" > "$WORK/sigmsg"
  openssl pkeyutl -sign -inkey "$SIGN_KEY" -rawin -in "$WORK/sigmsg" -out "$WORK/sig.bin"
  openssl pkey -in "$SIGN_KEY" -pubout -out "$WORK/pub.pem"
  openssl pkeyutl -verify -pubin -inkey "$WORK/pub.pem" -rawin -in "$WORK/sigmsg" -sigfile "$WORK/sig.bin" >/dev/null || die "signature self-check failed"
  base64 < "$WORK/sig.bin" | tr -d '\n' > "$MANIFEST.sig"
  PUB_RAW="$(openssl pkey -pubin -in "$WORK/pub.pem" -outform DER | tail -c 32 | base64 | tr -d '\n')"
  say "signed (release public key $PUB_RAW)"
else
  say "WARNING: no --sign-key: the manifest is not signed, and ax-hostd installTemplate refuses it"
fi
rm -f "$STATE"
trap - EXIT
rm -rf "$WORK"
say "done: AMI $IMAGE ($AMI_NAME), root snapshot $SNAP"
say "  manifest $MANIFEST"
say "  sha256   $SHA"
[[ $KIT_STATE == present ]] || say "  NOT FOR PRODUCTION (built without the kit)"
cat "$MANIFEST"

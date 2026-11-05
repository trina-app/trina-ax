#!/bin/bash
# Write the signed v2 AMI manifest (one template version, one AMI per AWS region, one signature) for an ax-hostd that
# serves more than one region (trina-cloud multi-region design §6.1). It does not build an AMI: build-ami.sh builds it
# in one region. This script can copy that AMI to more regions, and then writes the manifest for all of them.
#
#   scripts/image/ami-manifest-v2.sh --template-version <ver> --account ID [--profile P] \
#       --image <awsRegion>=ami-…[:snap-…] [--image …] [--copy-to <awsRegion> …] [--sign-key ed25519.pem] [options]
#   scripts/image/build-ami.sh --manifest-v2 <the same arguments>        (the same script)
#
# Options:
#   --template-version V        (required) e.g. 0.4.0-beta.8-d13-20261105 (the ax:template tag of every AMI)
#   --account ID                (required, except with --dry-run) the script stops before any call when the AWS
#                               session is another account
#   --profile P                 AWS CLI profile
#   --image REGION=ami-…        an AMI that exists already in REGION (an AWS region name such as ap-southeast-1, not a
#                               Trina region id). Repeat for each region. ":snap-…" after the id also checks the root
#                               snapshot id; without it the script reads it from AWS.
#   --copy-to REGION            copy the AMI of the FIRST --image to REGION (CopyImage, encrypted), then tag the copy
#                               and its snapshot with the tags of the source AMI. Repeat for more regions. When REGION
#                               has an AMI with ax:template=<ver> already, the script uses it and copies nothing.
#   --sign-key ed25519.pem      release key (PKCS#8 PEM). Without it the manifest is not signed (test only)
#   --out dist/image            output folder
#   --dry-run                   print every aws command, run none, write nothing
#   --yes, -y                   no confirmation prompt before a copy (needed when stdin is not a terminal)
#
# What it does:
#   1. Checks every input before any AWS call (ids, regions, the sign key).
#   2. With --copy-to: CopyImage (--encrypted, a client token per version and region, so a second run makes no second
#      copy), waits for "available" (up to 90 minutes), then CreateTags on the new AMI and on its root snapshot.
#   3. In every region, read only, the checks of ax-hostd installTemplate: the AMI is ours (owner self), available,
#      x86_64, ENA on, ax:template=<ver>, ax:managed=ami, and its root snapshot is the expected one. The snapshot is
#      completed, encrypted and has ax:managed=ami (the hostd IAM policy lets RunInstances and CreateVolume use only a
#      snapshot with that tag). Any failure: nothing is written.
#   4. Writes teamax-<ver>.v2.ami.json once (the name ends in .ami.json: the CP and hostd take only that), then its
#      .sha256 and .sig. The release key signs "ax-template-v1\n<ver>\n<sha256 hex of the manifest file>" (no trailing
#      newline), the same message as the v1 manifest of build-ami.sh. A v1 manifest of the same version can exist: the
#      v2 file has another name.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

VER=""; ACCOUNT_WANT=""; PROFILE=""; SIGN_KEY=""; OUT="$REPO/dist/image"; DRY=0; YES=0
REGIONS=(); IMAGES=(); SNAPS=(); COPY_TO=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --template-version) VER="$2"; shift 2 ;;
    --account) ACCOUNT_WANT="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --image)
      [[ "$2" =~ ^([a-z0-9-]+)=(ami-[0-9a-f]+)(:(snap-[0-9a-f]+))?$ ]] || { echo "ami-manifest-v2: --image takes REGION=ami-…[:snap-…], not '$2'" >&2; exit 2; }
      REGIONS+=("${BASH_REMATCH[1]}"); IMAGES+=("${BASH_REMATCH[2]}"); SNAPS+=("${BASH_REMATCH[4]:-}"); shift 2 ;;
    --copy-to) COPY_TO+=("$2"); shift 2 ;;
    --sign-key) SIGN_KEY="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --yes|-y) YES=1; shift ;;
    -h|--help) sed -n '2,37p' "$0"; exit 0 ;;
    *) echo "ami-manifest-v2: unknown argument $1" >&2; exit 2 ;;
  esac
done
say() { echo "ami-manifest-v2: $*"; }
die() { echo "ami-manifest-v2: ERROR: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
sha256() { if have sha256sum; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

# ---- 1. checks before any AWS call
[[ -n "$VER" ]] || die "--template-version is required (e.g. 0.4.0-beta.8-d13-20261105)"
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?-d13-[0-9]{8}$ ]] || die "--template-version '$VER' must be <kit x.y.z[-pre]>-d13-<yyyymmdd>"
KIT_VERSION="${VER%-d13-*}"
[[ $DRY == 1 || -n "$ACCOUNT_WANT" ]] || die "--account <12-digit id> is required (the account of the AMIs; see --help)"
[[ -z "$ACCOUNT_WANT" || "$ACCOUNT_WANT" =~ ^[0-9]{12}$ ]] || die "--account is a 12-digit AWS account id"
[[ ${#REGIONS[@]} -ge 1 ]] || die "give at least one --image REGION=ami-…"
[[ ${#COPY_TO[@]} -eq 0 || ${#REGIONS[@]} -eq 1 ]] || die "--copy-to copies the AMI of one --image: give only one --image with --copy-to"
# an AWS region name (ap-southeast-1). A Trina region id (kr-seoul-1, sg-singapore-1) has the same shape: the list of
# AWS prefixes and directions tells them apart
is_region() { [[ "$1" =~ ^(af|ap|ca|cn|eu|il|me|mx|sa|us)(-gov|-iso[a-z]*)?-(north|south|east|west|central|northeast|northwest|southeast|southwest)-[0-9]+$ ]]; }
ALL=("${REGIONS[@]}" ${COPY_TO[@]+"${COPY_TO[@]}"})
for r in "${ALL[@]}"; do is_region "$r" || die "'$r' is not an AWS region name (e.g. ap-southeast-1; not a Trina region id like sg-singapore-1)"; done
dups="$(printf '%s\n' "${ALL[@]}" | sort | uniq -d)"
[[ -z "$dups" ]] || die "region given twice: $dups"
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
have aws || die "missing aws"
if [[ $DRY != 1 ]]; then
  AWSV="$(aws --version 2>&1 | awk '{ print $1; exit }')"
  [[ "$AWSV" == aws-cli/2* ]] || die "aws CLI v2 required (found ${AWSV:-nothing})"
fi
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
MANIFEST="$OUT/teamax-$VER.v2.ami.json"
[[ $DRY == 1 || ! -e "$MANIFEST" ]] || die "$MANIFEST exists already: one v2 manifest per template version"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ax-amiv2.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# a REGION aws-args…: one aws command in one region. q PLACEHOLDER REGION aws-args…: in --dry-run print it and answer
# with the placeholder
exec 3>&2
a() { local r="$1"; shift; if [[ -n "$PROFILE" ]]; then aws --region "$r" --profile "$PROFILE" "$@"; else aws --region "$r" "$@"; fi; }
q() {
  local ph="$1" r="$2"; shift 2
  if [[ $DRY == 1 ]]; then
    { printf '+ aws --region %q' "$r"; [[ -z "$PROFILE" ]] || printf ' --profile %q' "$PROFILE"; printf ' %q' "$@"; echo; } >&3
    echo "$ph"
  else a "$r" "$@"; fi
}

say "template $VER, regions ${ALL[*]}$([[ $DRY == 1 ]] && echo ', DRY RUN')"
if [[ $DRY != 1 ]]; then
  ACCOUNT="$(a "${REGIONS[0]}" sts get-caller-identity --query Account --output text)" || die "aws credentials do not work (aws configure, or --profile)"
  [[ -z "$ACCOUNT_WANT" || "$ACCOUNT" == "$ACCOUNT_WANT" ]] || die "the AWS session is account $ACCOUNT, not --account $ACCOUNT_WANT (check --profile)"
  say "account $ACCOUNT"
fi

# ---- 2. copy to more regions
if [[ ${#COPY_TO[@]} -gt 0 ]]; then
  SRC_REGION="${REGIONS[0]}"; SRC_IMAGE="${IMAGES[0]}"
  read -r SRC_NAME SRC_STATE <<<"$(q "teamax-$VER available" "$SRC_REGION" ec2 describe-images --image-ids "$SRC_IMAGE" --owners self \
    --query 'Images[0].[Name,State]' --output text)"
  [[ "$SRC_STATE" == available ]] || die "source AMI $SRC_IMAGE in $SRC_REGION: state ${SRC_STATE:-not found (owner self)}"
  # the tags of the source AMI (not aws:*), each K=V with plain characters (the CLI shorthand has no quoting)
  q "" "$SRC_REGION" ec2 describe-images --image-ids "$SRC_IMAGE" --owners self --query 'Images[0].Tags[].[Key,Value]' --output text > "$WORK/src-tags"
  TAGS="{Key=ax:managed,Value=ami},{Key=ax:template,Value=$VER}"
  CT_TAGS=("Key=ax:managed,Value=ami" "Key=ax:template,Value=$VER")
  have_name=0
  while IFS=$'\t' read -r k v; do
    [[ -n "$k" && "$k" != aws:* && "$k" != ax:managed && "$k" != ax:template ]] || continue
    [[ "$k" =~ ^[A-Za-z0-9:._/-]+$ && "$v" =~ ^[A-Za-z0-9:._/@+-]*$ ]] || die "source AMI tag '$k=$v' has characters this script cannot pass on: tag the copy by hand"
    [[ "$k" == Name ]] && have_name=1
    TAGS+=",{Key=$k,Value=$v}"; CT_TAGS+=("Key=$k,Value=$v")
  done < "$WORK/src-tags"
  if [[ $have_name != 1 ]]; then TAGS+=",{Key=Name,Value=$SRC_NAME}"; CT_TAGS+=("Key=Name,Value=$SRC_NAME"); fi
  say "source $SRC_IMAGE in $SRC_REGION ($SRC_NAME), tags for the copies: $TAGS"
  if [[ $DRY != 1 && $YES != 1 ]]; then
    [[ -t 0 ]] || die "no terminal for the confirmation prompt: pass --yes"
    echo "ami-manifest-v2: copies $SRC_IMAGE and its snapshot (20 GiB, about \$0.05 per GB-month and region) to ${COPY_TO[*]}."
    read -r -p "Copy AMI $SRC_NAME in account $ACCOUNT now? [y/N] " ans
    [[ "$ans" == y || "$ans" == Y ]] || die "aborted"
  fi
  for r in "${COPY_TO[@]}"; do
    have_ami="$(q None "$r" ec2 describe-images --owners self --filters "Name=tag:ax:template,Values=$VER" --query 'Images[].ImageId' --output text)"
    if [[ -n "$have_ami" && "$have_ami" != None ]]; then
      [[ "$have_ami" =~ ^ami-[0-9a-f]+$ ]] || die "$r has more than one AMI with ax:template=$VER: $have_ami (pass the right one with --image)"
      say "$r: AMI $have_ami has ax:template=$VER already: no copy"
      new="$have_ami"
    else
      new="$(q ami-COPY-DRYRUN "$r" ec2 copy-image --source-region "$SRC_REGION" --source-image-id "$SRC_IMAGE" --name "$SRC_NAME" \
        --description "Team AX team server $VER (Debian 13), copy of $SRC_IMAGE from $SRC_REGION" --encrypted \
        --client-token "ax-$VER-$r" \
        --tag-specifications "ResourceType=image,Tags=[$TAGS]" "ResourceType=snapshot,Tags=[$TAGS]" \
        --query ImageId --output text)"
      [[ "$new" =~ ^ami- ]] || die "copy-image to $r answered '$new'"
      say "$r: copy $new started"
    fi
    if [[ $DRY != 1 ]]; then
      for i in $(seq 1 180); do
        st="$(a "$r" ec2 describe-images --image-ids "$new" --owners self --query 'Images[0].State' --output text)"
        [[ "$st" == available ]] && break
        [[ "$st" == failed || "$st" == error || "$st" == invalid ]] && die "copy $new in $r: state $st"
        [[ $i -lt 180 ]] || die "copy $new in $r not available after 90 minutes (run again later: the client token makes no second copy)"
        sleep 30
      done
    fi
    snap="$(q snap-COPY-DRYRUN "$r" ec2 describe-images --image-ids "$new" --owners self --query 'Images[0].BlockDeviceMappings[0].Ebs.SnapshotId' --output text)"
    [[ "$snap" =~ ^snap- ]] || die "copy $new in $r has no root snapshot ('$snap')"
    # the tags again with CreateTags (idempotent): the snapshot tag is the one the hostd IAM policy needs
    q - "$r" ec2 create-tags --resources "$new" "$snap" --tags "${CT_TAGS[@]}" >/dev/null
    say "$r: AMI $new, root snapshot $snap, tagged"
    REGIONS+=("$r"); IMAGES+=("$new"); SNAPS+=("$snap")
  done
fi

# ---- 3. the checks of ax-hostd installTemplate, in every region (read only)
bad=()
for i in "${!REGIONS[@]}"; do
  r="${REGIONS[$i]}"; img="${IMAGES[$i]}"; want="${SNAPS[$i]}"
  if [[ $DRY == 1 ]]; then
    q - "$r" ec2 describe-images --image-ids "$img" --owners self >/dev/null
    [[ -n "$want" ]] || SNAPS[$i]=snap-DRYRUN
    q - "$r" ec2 describe-snapshots --snapshot-ids "${SNAPS[$i]}" --owner-ids self >/dev/null
    continue
  fi
  read -r st arch ena rs mg tp <<<"$(a "$r" ec2 describe-images --image-ids "$img" --owners self \
    --query 'Images[0].[State,Architecture,EnaSupport,BlockDeviceMappings[0].Ebs.SnapshotId,Tags[?Key==`ax:managed`]|[0].Value,Tags[?Key==`ax:template`]|[0].Value]' \
    --output text 2>/dev/null || true)"
  why=()
  if [[ -z "$st" || "$st" == None ]]; then bad+=("$r: AMI $img not found (owner self)"); continue; fi
  [[ "$st" == available ]] || why+=("state $st")
  [[ "$arch" == x86_64 ]] || why+=("architecture $arch")
  [[ "$ena" == True ]] || why+=("ENA $ena")
  [[ "$mg" == ami ]] || why+=("tag ax:managed=$mg")
  [[ "$tp" == "$VER" ]] || why+=("tag ax:template=$tp")
  [[ "$rs" =~ ^snap-[0-9a-f]+$ ]] || why+=("root snapshot '$rs'")
  [[ -z "$want" || "$rs" == "$want" ]] || why+=("root snapshot $rs, not $want")
  if [[ ${#why[@]} -eq 0 ]]; then
    read -r sst enc smg stp <<<"$(a "$r" ec2 describe-snapshots --snapshot-ids "$rs" --owner-ids self \
      --query 'Snapshots[0].[State,Encrypted,Tags[?Key==`ax:managed`]|[0].Value,Tags[?Key==`ax:template`]|[0].Value]' \
      --output text 2>/dev/null || true)"
    [[ "$sst" == completed ]] || why+=("snapshot $rs state ${sst:-not found}")
    [[ "$enc" == True ]] || why+=("snapshot $rs not encrypted")
    [[ "$smg" == ami ]] || why+=("snapshot $rs tag ax:managed=${smg:-None} (the hostd IAM policy needs ami)")
    [[ "$stp" == "$VER" ]] || why+=("snapshot $rs tag ax:template=${stp:-None}")
  fi
  if [[ ${#why[@]} -gt 0 ]]; then bad+=("$r: AMI $img: $(IFS=';'; echo "${why[*]}")"); continue; fi
  SNAPS[$i]="$rs"
  say "$r: AMI $img, root snapshot $rs: ok"
done
if [[ ${#bad[@]} -gt 0 ]]; then
  for b in "${bad[@]}"; do echo "ami-manifest-v2: ERROR: $b" >&2; done
  die "no manifest written (fix the AMIs above, e.g. aws ec2 create-tags --resources <ami> <snap> --tags Key=ax:managed,Value=ami Key=ax:template,Value=$VER)"
fi

# ---- 4. the manifest: written once, then hashed and signed (the signature covers these exact bytes)
if [[ $DRY == 1 ]]; then say "dry run: would write $MANIFEST"; exit 0; fi
images=""
for r in $(printf '%s\n' "${REGIONS[@]}" | sort); do
  for i in "${!REGIONS[@]}"; do
    [[ "${REGIONS[$i]}" == "$r" ]] || continue
    [[ -z "$images" ]] || images+=","
    images+="$(printf '"%s":{"imageId":"%s","rootSnapshotId":"%s"}' "$r" "${IMAGES[$i]}" "${SNAPS[$i]}")"
  done
done
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{"v":2,"kind":"ami","templateVersion":"%s","architecture":"x86_64","images":{%s},"kitVersion":"%s","builtAt":"%s"}\n' \
  "$VER" "$images" "$KIT_VERSION" "$BUILT_AT" > "$MANIFEST"
chmod 444 "$MANIFEST"
SHA="$(sha256 "$MANIFEST")"
(cd "$OUT" && echo "$SHA  $(basename "$MANIFEST")" > "$(basename "$MANIFEST").sha256")
if [[ -n "$SIGN_KEY" ]]; then
  printf 'ax-template-v1\n%s\n%s' "$VER" "$SHA" > "$WORK/sigmsg"
  openssl pkeyutl -sign -inkey "$SIGN_KEY" -rawin -in "$WORK/sigmsg" -out "$WORK/sig.bin"
  openssl pkey -in "$SIGN_KEY" -pubout -out "$WORK/pub.pem"
  openssl pkeyutl -verify -pubin -inkey "$WORK/pub.pem" -rawin -in "$WORK/sigmsg" -sigfile "$WORK/sig.bin" >/dev/null || die "signature self-check failed"
  base64 < "$WORK/sig.bin" | tr -d '\n' > "$MANIFEST.sig"
  PUB_RAW="$(openssl pkey -pubin -in "$WORK/pub.pem" -outform DER | tail -c 32 | base64 | tr -d '\n')"
  say "signed (release public key $PUB_RAW)"
else
  say "WARNING: no --sign-key: the manifest is not signed, and ax-hostd installTemplate refuses it"
fi
say "done: manifest $MANIFEST"
say "  sha256 $SHA"
[[ -z "$SIGN_KEY" ]] || say "  sig    $MANIFEST.sig"
cat "$MANIFEST"

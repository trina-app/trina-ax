#!/bin/bash
# Keep the newest team images that the release CI built and remove the older ones (docs/RELEASE-CI.md "새 팀 서버 이미지").
# Only AMIs with ax:managed=ami AND ax:built-by=release-ci (owner self) count; an AMI built by hand never does.
#
#   scripts/image/ami-prune.sh --account ID --region ap-northeast-2 [--region …] [--keep 3]
#       [--protect-template <templateVersion> …] [--profile P] [--dry-run]
#
# In each region: the CI's AMIs, newest release first (version order of their ax:template, not the creation date: an
# image built later for an older release, a backfill, ranks by its release). The first --keep stay. Of the others, an
# AMI stays when
#   - its ax:template is a --protect-template (the workflow passes the one it just published),
#   - it has the tag ax:keep=true (pin one by hand, e.g. the control plane's template:
#     aws ec2 create-tags --resources ami-… --tags Key=ax:keep,Value=true),
#   - an instance that is not terminated still runs from it,
#   - or the latest or default version of an EC2 launch template names it.
# When the launch templates cannot be read, nothing in that region is removed.
# Everything else: DeregisterImage, then DeleteSnapshot of its root snapshots that carry ax:built-by=release-ci.
# It never deletes by any other filter: production lives in the same account.
set -euo pipefail
ACCOUNT_WANT=""; PROFILE=""; KEEP=3; DRY=0; REGIONS=(); PROTECT=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --account) ACCOUNT_WANT="$2"; shift 2 ;;
    --region) REGIONS+=("$2"); shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    --protect-template) PROTECT+=("$2"); shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "ami-prune: unknown argument $1" >&2; exit 2 ;;
  esac
done
say() { echo "ami-prune: $*"; }
die() { echo "ami-prune: ERROR: $*" >&2; exit 1; }
[[ "$ACCOUNT_WANT" =~ ^[0-9]{12}$ ]] || die "--account <12-digit id> is required"
[[ "$KEEP" =~ ^[0-9]+$ && $KEEP -ge 1 ]] || die "--keep is a whole number, at least 1"
[[ ${#REGIONS[@]} -ge 1 ]] || die "give at least one --region"
for r in "${REGIONS[@]}"; do [[ "$r" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]] || die "'$r' is not an AWS region name"; done
a() { local r="$1"; shift; if [[ -n "$PROFILE" ]]; then aws --region "$r" --profile "$PROFILE" "$@"; else aws --region "$r" "$@"; fi; }
# run a change, or print it in --dry-run
w() { if [[ $DRY == 1 ]]; then { printf '+ aws --region %q' "$1"; shift; printf ' %q' "$@"; echo; }; else a "$@" >/dev/null; fi; }

ACCOUNT="$(a "${REGIONS[0]}" sts get-caller-identity --query Account --output text)" || die "aws credentials do not work"
[[ "$ACCOUNT" == "$ACCOUNT_WANT" ]] || die "the AWS session is account $ACCOUNT, not --account $ACCOUNT_WANT"

for r in "${REGIONS[@]}"; do
  # the AMIs the region's launch templates start (latest and default versions); unreadable = remove nothing here
  if ! lt="$(a "$r" ec2 describe-launch-template-versions --versions '$Latest' '$Default' \
      --query 'LaunchTemplateVersions[].LaunchTemplateData.ImageId' --output text 2>&1)"; then
    say "$r: WARNING: cannot read the launch templates ($lt): nothing removed in $r"; continue
  fi
  # template, id, ax:keep; newest release first
  rows=()
  while IFS= read -r line; do [[ -n "$line" ]] && rows+=("$line"); done < <(a "$r" ec2 describe-images --owners self \
    --filters Name=tag:ax:managed,Values=ami Name=tag:ax:built-by,Values=release-ci \
    --query 'Images[].[Tags[?Key==`ax:template`]|[0].Value,ImageId,Tags[?Key==`ax:keep`]|[0].Value]' --output text | sort -t$'\t' -k1,1 -V -r)
  say "$r: ${#rows[@]} image(s) built by the release CI, keeping the newest $KEEP releases"
  n=0
  for row in ${rows[@]+"${rows[@]}"}; do
    read -r tv img keep <<<"$row"
    [[ "$img" =~ ^ami-[0-9a-f]+$ ]] || continue
    n=$((n + 1))
    if [[ $n -le $KEEP ]]; then say "$r: keep $img ($tv)"; continue; fi
    if [[ " ${PROTECT[*]+${PROTECT[*]}} " == *" $tv "* ]]; then say "$r: keep $img ($tv): just published"; continue; fi
    if [[ "$keep" == true ]]; then say "$r: keep $img ($tv): ax:keep=true"; continue; fi
    if [[ " $lt " == *[[:space:]]"$img"[[:space:]]* ]]; then say "$r: keep $img ($tv): a launch template uses it"; continue; fi
    used="$(a "$r" ec2 describe-instances --filters "Name=image-id,Values=$img" Name=instance-state-name,Values=pending,running,stopping,stopped \
      --query 'Reservations[].Instances[].InstanceId' --output text)"
    if [[ -n "$used" && "$used" != None ]]; then say "$r: keep $img ($tv): instances run from it ($used)"; continue; fi
    snaps=()
    for s in $(a "$r" ec2 describe-images --image-ids "$img" --owners self \
      --query 'Images[0].BlockDeviceMappings[].Ebs.SnapshotId' --output text); do
      [[ "$s" =~ ^snap-[0-9a-f]+$ ]] && snaps+=("$s")
    done
    say "$r: remove $img ($tv) and its snapshot(s) ${snaps[*]+${snaps[*]}}"
    w "$r" ec2 deregister-image --image-id "$img"
    for s in ${snaps[@]+"${snaps[@]}"}; do
      by="$(a "$r" ec2 describe-tags --filters "Name=resource-id,Values=$s" Name=key,Values=ax:built-by --query 'Tags[0].Value' --output text 2>/dev/null || true)"
      if [[ "$by" != release-ci ]]; then say "$r: snapshot $s has ax:built-by=${by:-none}: left alone"; continue; fi
      w "$r" ec2 delete-snapshot --snapshot-id "$s"
    done
  done
done
say "done$([[ $DRY == 1 ]] && echo ' (dry run: nothing changed)')"

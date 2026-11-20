#!/bin/bash
# Remove the release CI's old team images, never one that is still needed (docs/RELEASE-CI.md "새 팀 서버 이미지").
# Only AMIs with ax:managed=ami AND ax:built-by=release-ci (owner self) count; an AMI built by hand never does.
#
#   scripts/image/ami-prune.sh --account ID --region ap-northeast-2 [--region …] [--keep 5] [--min-age-days 14]
#       [--protect-template <templateVersion> …] [--profile P] [--dry-run]
#
# In each region this script reads the facts and scripts/image/ami-prune-select.ts decides. An AMI stays when ANY of:
#   - its ax:template is a --protect-template (the workflow passes the one it just published),
#   - tag ax:keep=true (pin one by hand: aws ec2 create-tags --resources ami-… --tags Key=ax:keep,Value=true),
#     or tag ax:in-use with any value but false (for hostd or the control plane to set),
#   - its release is one of the newest --keep releases (versions in ax:template order, not images: every image of
#     those releases stays, and a backfill of an old release ranks by its release),
#   - it is younger than --min-age-days (CreationDate): the control plane makes new teams from an older release while
#     the newer one's hosted rollout bakes, and the CI cannot read the control plane,
#   - an instance that is not terminated runs from it, or the latest or default version of a launch template names it,
#   - an instance that is not terminated or an EBS volume carries its ax:template (hostd tags each tenant with it),
#   - its release is the newest one whose images are older than --min-age-days (the age counts from the build).
# ax:template on tenants and ax:in-use on images are set outside this repo (trina-cloud hostd / control plane); where
# they are missing, only the image-id matches (instances, launch templates; not resolve:ssm: ones) protect an image.
# Every image is logged with keep and all its reasons, or remove. When the launch templates, instances or volumes
# cannot be read, nothing in that region is removed. --dry-run only prints the changes.
# Everything else: DeregisterImage, then DeleteSnapshot of its root snapshots that carry ax:built-by=release-ci.
# It never deletes by any other filter: production lives in the same account.
set -euo pipefail
ACCOUNT_WANT=""; PROFILE=""; KEEP=5; MIN_AGE_DAYS=14; DRY=0; REGIONS=(); PROTECT=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --account) ACCOUNT_WANT="$2"; shift 2 ;;
    --region) REGIONS+=("$2"); shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    --min-age-days) MIN_AGE_DAYS="$2"; shift 2 ;;
    --protect-template) PROTECT+=("$2"); shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "ami-prune: unknown argument $1" >&2; exit 2 ;;
  esac
done
say() { echo "ami-prune: $*"; }
# a region left alone: a GitHub warning annotation (plain text outside Actions)
skip() { if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::warning title=ami-prune::$1: $2: nothing removed in $1"; else say "$1: WARNING: $2: nothing removed in $1"; fi; }
die() { echo "ami-prune: ERROR: $*" >&2; exit 1; }
[[ "$ACCOUNT_WANT" =~ ^[0-9]{12}$ ]] || die "--account <12-digit id> is required"
[[ "$KEEP" =~ ^[0-9]+$ && $KEEP -ge 1 ]] || die "--keep is a whole number, at least 1"
[[ "$MIN_AGE_DAYS" =~ ^[0-9]+$ ]] || die "--min-age-days is a whole number"
[[ ${#REGIONS[@]} -ge 1 ]] || die "give at least one --region"
for r in "${REGIONS[@]}"; do [[ "$r" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]] || die "'$r' is not an AWS region name"; done
SELECT="$(cd "$(dirname "$0")" && pwd)/ami-prune-select.ts"
command -v bun >/dev/null || die "bun is needed (scripts/image/ami-prune-select.ts)"
a() { local r="$1"; shift; if [[ -n "$PROFILE" ]]; then aws --region "$r" --profile "$PROFILE" "$@"; else aws --region "$r" "$@"; fi; }
# run a change, or print it in --dry-run
w() { if [[ $DRY == 1 ]]; then { printf '+ aws --region %q' "$1"; shift; printf ' %q' "$@"; echo; }; else a "$@" >/dev/null; fi; }

ACCOUNT="$(a "${REGIONS[0]}" sts get-caller-identity --query Account --output text)" || die "aws credentials do not work"
[[ "$ACCOUNT" == "$ACCOUNT_WANT" ]] || die "the AWS session is account $ACCOUNT, not --account $ACCOUNT_WANT"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
protect_args=(); for t in ${PROTECT[@]+"${PROTECT[@]}"}; do protect_args+=(--protect-template "$t"); done
[[ $DRY == 1 ]] && say "dry run: nothing is changed"

for r in "${REGIONS[@]}"; do
  # each fact read failing = remove nothing in this region
  # shellcheck disable=SC2016 # the backticks are JMESPath, not the shell
  if ! a "$r" ec2 describe-launch-template-versions --versions '$Latest' '$Default' \
      --query 'LaunchTemplateVersions[].LaunchTemplateData.ImageId' --output text >"$TMP/lt" 2>"$TMP/err"; then
    skip "$r" "cannot read the launch templates ($(head -c 300 "$TMP/err"))"; continue
  fi
  # shellcheck disable=SC2016
  if ! a "$r" ec2 describe-instances --filters Name=instance-state-name,Values=pending,running,shutting-down,stopping,stopped \
      --query 'Reservations[].Instances[].{id:InstanceId,image:ImageId,template:Tags[?Key==`ax:template`]|[0].Value}' --output json >"$TMP/inst" 2>"$TMP/err"; then
    skip "$r" "cannot read the instances ($(head -c 300 "$TMP/err"))"; continue
  fi
  # shellcheck disable=SC2016
  if ! a "$r" ec2 describe-volumes --filters Name=tag-key,Values=ax:template \
      --query 'Volumes[].{id:VolumeId,template:Tags[?Key==`ax:template`]|[0].Value}' --output json >"$TMP/vol" 2>"$TMP/err"; then
    skip "$r" "cannot read the volumes ($(head -c 300 "$TMP/err"))"; continue
  fi
  # shellcheck disable=SC2016
  if ! a "$r" ec2 describe-images --owners self \
      --filters Name=tag:ax:managed,Values=ami Name=tag:ax:built-by,Values=release-ci \
      --query 'Images[].{id:ImageId,created:CreationDate,tags:Tags,snaps:BlockDeviceMappings[].Ebs.SnapshotId}' --output json >"$TMP/img" 2>"$TMP/err"; then
    skip "$r" "cannot read the images ($(head -c 300 "$TMP/err"))"; continue
  fi
  if ! bun "$SELECT" --images "$TMP/img" --launch-templates "$TMP/lt" --instances "$TMP/inst" --volumes "$TMP/vol" \
      --keep "$KEEP" --min-age-days "$MIN_AGE_DAYS" ${protect_args[@]+"${protect_args[@]}"} >"$TMP/plan" 2>"$TMP/err"; then
    skip "$r" "the selection failed ($(head -c 300 "$TMP/err"))"; continue
  fi
  say "$r: $(wc -l <"$TMP/plan" | tr -d ' ') image(s) built by the release CI (keep the newest $KEEP releases, anything younger than $MIN_AGE_DAYS days, anything in use)"
  while IFS=$'\t' read -r act img tv rest; do
    [[ "$img" =~ ^ami-[0-9a-f]+$ ]] || continue
    if [[ "$act" != remove ]]; then say "$r: keep $img ($tv): $rest"; continue; fi
    snaps=(); for s in $rest; do [[ "$s" =~ ^snap-[0-9a-f]+$ ]] && snaps+=("$s"); done
    say "$r: remove $img ($tv) and its snapshot(s) ${snaps[*]+${snaps[*]}}"
    w "$r" ec2 deregister-image --image-id "$img"
    for s in ${snaps[@]+"${snaps[@]}"}; do
      by="$(a "$r" ec2 describe-tags --filters "Name=resource-id,Values=$s" Name=key,Values=ax:built-by --query 'Tags[0].Value' --output text 2>/dev/null || true)"
      if [[ "$by" != release-ci ]]; then say "$r: snapshot $s has ax:built-by=${by:-none}: left alone"; continue; fi
      w "$r" ec2 delete-snapshot --snapshot-id "$s"
    done
  done <"$TMP/plan"
done
say "done$([[ $DRY == 1 ]] && echo ' (dry run: nothing changed)')"

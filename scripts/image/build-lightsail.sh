#!/bin/bash
# Build the Team AX team image for AWS Lightsail (an instance snapshot) and its manifest (trina-cloud
# docs/research/lightsail-paid-teams.md §6.2). Lightsail cannot import an AMI, so the image is made again on Lightsail
# from the same stage as the AMI (build-ami.sh --stage-only) and the same customize.sh. The release CI runs it
# (.github/workflows/team-image.yml, job lightsail); the owner can run it with an AWS CLI session.
#
#   scripts/image/build-lightsail.sh --template-version <kit>-d13-<yyyymmdd> --account ID \
#       --kit <TeamAX-server-<v>-linux-amd64.tar.gz> --enroll-bin <mycel-enroll> --link-bin <mycel-link> [options]
#   scripts/image/build-lightsail.sh --cleanup STATEFILE --account ID     remove the builder a failed run left
#   scripts/image/build-lightsail.sh --prune --account ID [--keep 5] [--min-age-days 14] [--protect-template T] [--dry-run]
#
# Options (defaults):
#   --region ap-northeast-2      --profile P (AWS CLI profile)    --az ap-northeast-2a
#   --account ID                 (required) the build stops before any change when the session is another account
#   --template-version V         (required) the AMI's template version (team-image.json on the feed), so the AMI, the
#                                qcow2 and the Lightsail image of one release carry one version
#   --bundle medium_3_0          the smallest bundle of the paid plans: a snapshot launches only to the same or a larger
#                                bundle (hostd checks fromBundleId)
#   --blueprint debian_13
#   --wait-minutes 180           for the build on the builder (a new instance starts at about 0 % CPU burst, design R3)
#   --sign-key ed25519.pem       release key (PKCS#8 PEM). Without it the manifest is not signed (the CI signs it in
#                                its own step, where the key is)
#   --out dist/image             --tag K=V (one more tag on the builder and the snapshot; repeat)
#   --allow-missing-kit          pipeline dry run without the kit: NOT for production (no --sign-key with it)
#   --dry-run                    print every aws command, run none, make nothing (no R2 upload either)
#   --yes, -y                    no confirmation prompt
#
# What it does:
#   1. The stage (build-ami.sh --stage-only: kit, mycel-enroll, mycel-link, customize.sh, files/, system/, srt) as one
#      tar.gz into the release bucket under ci/lightsail-build/ (not served by the feed), with a presigned GET for the
#      builder and a presigned PUT for its result (lightsail-feed.ts; 6 h; never printed).
#   2. CreateInstances (blueprint, bundle, AZ, tags ax:managed=image-build, ax:template) named
#      ax-image-build-<templateVersion>, with a POSIX sh launch script (Lightsail puts its own #!/bin/sh part before
#      it, design §7): download the stage, check its sha256, start lightsail-guest.sh after cloud-final. As soon as the
#      builder runs: no public ports, IMDSv2 only. No SSH: customize.sh purges openssh.
#   3. Wait for "stopped" and the result file ("ok"): lightsail-guest.sh uploads it and powers off.
#   4. Check: no attached disks (an instance snapshot includes them). CreateInstanceSnapshot teamax-<templateVersion>
#      with ax:managed=image, ax:template, ax:built-by, ax:blueprint-version; wait "available".
#   5. DeleteInstance of the builder, delete the R2 files.
#   6. Write teamax-<templateVersion>.lightsail.json once, its .sha256 and (with --sign-key) .sig: the release key signs
#      "ax-template-v1\n<templateVersion>\n<sha256 hex of the manifest file>", as for the AMI. hostd installTemplate
#      checks it, then reads the snapshot's state and tags.
#   A re-run finds an "available" snapshot of the template with the right tags and only writes the manifest again.
#
# The builder name and the R2 folder go into <out>/lightsail-build-<templateVersion>.state first. On failure the script
# deletes only that builder, and only when it carries ax:managed=image-build, and the two R2 files. --prune deletes only snapshots with ax:managed=image
# and ax:built-by=release-ci, by the rules of ami-prune.sh: the newest --keep releases, anything younger than
# --min-age-days, ax:keep=true, and any template an instance carries in its ax:template tag (any owner) stay.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

KIT=""; ENROLL_BIN=""; LINK_BIN=""; REGION=ap-northeast-2; AZ=ap-northeast-2a; PROFILE=""; ACCOUNT_WANT=""
TEMPLATE_VERSION=""; BUNDLE=medium_3_0; BLUEPRINT=debian_13; WAIT_MIN=180; SIGN_KEY=""; OUT="$REPO/dist/image"
EXTRA_TAGS=(); ALLOW_MISSING_KIT=0; DRY=0; YES=0; CLEANUP_STATE=""; PRUNE=0; KEEP=5; MIN_AGE=14; PROTECT=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --kit) KIT="$2"; shift 2 ;;
    --enroll-bin) ENROLL_BIN="$2"; shift 2 ;;
    --link-bin) LINK_BIN="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --az) AZ="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --account) ACCOUNT_WANT="$2"; shift 2 ;;
    --template-version) TEMPLATE_VERSION="$2"; shift 2 ;;
    --bundle) BUNDLE="$2"; shift 2 ;;
    --blueprint) BLUEPRINT="$2"; shift 2 ;;
    --wait-minutes) WAIT_MIN="$2"; shift 2 ;;
    --sign-key) SIGN_KEY="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --tag) EXTRA_TAGS+=("$2"); shift 2 ;;
    --allow-missing-kit) ALLOW_MISSING_KIT=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --cleanup) CLEANUP_STATE="$2"; shift 2 ;;
    --prune) PRUNE=1; shift ;;
    --keep) KEEP="$2"; shift 2 ;;
    --min-age-days) MIN_AGE="$2"; shift 2 ;;
    --protect-template) PROTECT+=(--protect-template "$2"); shift 2 ;;
    -h|--help) sed -n '2,46p' "$0"; exit 0 ;;
    *) echo "build-lightsail: unknown argument $1" >&2; exit 2 ;;
  esac
done
say() { echo "build-lightsail: $*"; }
die() { echo "build-lightsail: ERROR: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
sha256() { if have sha256sum; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
TV_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?-d13-[0-9]{8}$'

AWS=(aws --region "$REGION")
[[ -n "$PROFILE" ]] && AWS+=(--profile "$PROFILE")
# q PLACEHOLDER aws-args…: one aws command; in --dry-run print it and answer with the placeholder
exec 3>&2
q() { local ph="$1"; shift; if [[ $DRY == 1 ]]; then { printf '+'; printf ' %q' "${AWS[@]}" "$@"; echo; } >&3; echo "$ph"; else "${AWS[@]}" "$@"; fi; }
# read-only calls also run in a dry run when there is a session (they make nothing); without one they answer $1
r() { local ph="$1"; shift; if [[ $DRY == 1 && $HAVE_SESSION != 1 ]]; then echo "$ph"; else "${AWS[@]}" "$@"; fi; }
FEED=(bun "$HERE/lightsail-feed.ts")

[[ -n "$ACCOUNT_WANT" || $DRY == 1 ]] || die "--account <12-digit id> is required"
[[ -z "$ACCOUNT_WANT" || "$ACCOUNT_WANT" =~ ^[0-9]{12}$ ]] || die "--account is a 12-digit AWS account id"
HAVE_SESSION=0
check_account() {
  local a
  if a="$("${AWS[@]}" sts get-caller-identity --query Account --output text 2>/dev/null)"; then HAVE_SESSION=1
  elif [[ $DRY == 1 ]]; then say "dry run without an AWS session: read-only calls answer placeholders"; return 0
  else die "aws credentials do not work (aws configure, or --profile)"; fi
  [[ -z "$ACCOUNT_WANT" || "$a" == "$ACCOUNT_WANT" ]] || die "the AWS session is account $a, not --account $ACCOUNT_WANT (check --profile)"
  say "account $a"
}
lstag() { # lstag JSON-TAGS KEY: the value of one Lightsail tag
  jq -r --arg k "$2" '(map(select(.key == $k))[0].value) // ""' <<<"$1"
}

# ---- the builder: its state file names it; only a builder tagged image-build is ever deleted
STATE=""
delete_builder() {
  local name="$1" tags
  tags="$("${AWS[@]}" lightsail get-instance --instance-name "$name" --query instance.tags --output json 2>/dev/null)" || { say "builder $name is gone"; return 0; }
  if [[ "$(lstag "$tags" ax:managed)" != image-build ]]; then say "cleanup: $name has ax:managed=$(lstag "$tags" ax:managed), not image-build: left alone"; return 1; fi
  say "delete builder $name"
  "${AWS[@]}" lightsail delete-instance --instance-name "$name" --no-force-delete-add-ons >/dev/null
}
cleanup_state() {
  local n rc=0
  [[ -f "$STATE" ]] || return 0
  while read -r kind n; do
    case "$kind" in
      builder) if delete_builder "$n"; then :; else rc=1; fi ;;
      # the build files in R2 (the stage and the result); needs CLOUDFLARE_API_TOKEN
      r2) for k in stage.tgz result.txt; do "${FEED[@]}" r2-delete --key "$n/$k" >/dev/null 2>&1 || { say "cleanup: could not delete R2 $n/$k"; rc=1; }; done ;;
    esac
  done < "$STATE"
  [[ $rc == 0 ]] && rm -f "$STATE"
  return $rc
}

if [[ -n "$CLEANUP_STATE" ]]; then
  [[ -f "$CLEANUP_STATE" ]] || die "no state file $CLEANUP_STATE"
  check_account; STATE="$CLEANUP_STATE"
  cleanup_state || die "cleanup did not finish: $STATE"
  say "cleanup done"; exit 0
fi

# ---- --prune
if [[ $PRUNE == 1 ]]; then
  check_account
  for t in jq bun; do have "$t" || die "missing $t"; done
  W="$(mktemp -d "${TMPDIR:-/tmp}/ax-ls-prune.XXXXXX")"; trap 'rm -rf "$W"' EXIT
  # every page (Lightsail Get* calls cannot filter by tag)
  pages() { local key="$1" tok="" out="[]" page; shift
    while :; do
      if [[ -n "$tok" ]]; then page="$("${AWS[@]}" lightsail "$@" --page-token "$tok" --output json)"; else page="$("${AWS[@]}" lightsail "$@" --output json)"; fi
      out="$(jq -c --argjson a "$out" --arg k "$key" '$a + (.[$k] // [])' <<<"$page")"
      tok="$(jq -r '.nextPageToken // ""' <<<"$page")"; [[ -n "$tok" ]] || break
    done; echo "$out"; }
  pages instanceSnapshots get-instance-snapshots | jq '[.[] | {name, createdAt, state, tags}]' > "$W/snapshots.json"
  pages instances get-instances | jq '[.[] | {name, tags}]' > "$W/instances.json"
  "${FEED[@]}" prune-select --snapshots "$W/snapshots.json" --instances "$W/instances.json" --keep "$KEEP" --min-age-days "$MIN_AGE" ${PROTECT[@]+"${PROTECT[@]}"} > "$W/decide.tsv"
  while IFS=$'\t' read -r action name tv why; do
    if [[ "$action" == keep ]]; then say "keep $name ($tv): $why"; continue; fi
    say "remove $name ($tv)"
    q - lightsail delete-instance-snapshot --instance-snapshot-name "$name" >/dev/null
  done < "$W/decide.tsv"
  exit 0
fi

# ---- 0. checks before any AWS call
[[ "$TEMPLATE_VERSION" =~ $TV_RE ]] || die "--template-version is <kitVersion>-d13-<yyyymmdd> (the AMI's: team-image.json)"
[[ "$BUNDLE" =~ ^[a-z0-9]+_[0-9]+_[0-9]+$ ]] || die "--bundle looks wrong: $BUNDLE"
[[ "$BLUEPRINT" == debian_13 ]] || die "--blueprint: only debian_13 (customize.sh is for Debian 13)"
[[ "$AZ" == "$REGION"[a-z] ]] || die "--az $AZ is not a zone of $REGION"
[[ "$WAIT_MIN" =~ ^[0-9]+$ && $WAIT_MIN -ge 10 ]] || die "--wait-minutes is a whole number, at least 10"
[[ $ALLOW_MISSING_KIT == 0 || -z "$SIGN_KEY" ]] || die "--sign-key and --allow-missing-kit exclude each other"
for kv in ${EXTRA_TAGS[@]+"${EXTRA_TAGS[@]}"}; do [[ "$kv" =~ ^[A-Za-z0-9:._/-]+=[A-Za-z0-9:._/@+-]*$ ]] || die "--tag $kv: use K=V with plain characters"; done
for t in jq tar bun; do have "$t" || die "missing $t"; done
[[ $DRY == 1 ]] || have aws || die "missing aws"
if [[ -n "$SIGN_KEY" ]]; then
  have openssl || die "missing openssl (for --sign-key)"
  [[ -r "$SIGN_KEY" ]] || die "cannot read $SIGN_KEY"
fi
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ax-ls.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
NAME="teamax-$TEMPLATE_VERSION"
BUILDER="ax-image-build-$TEMPLATE_VERSION"
MANIFEST="$OUT/$NAME.lightsail.json"
STATE="$OUT/lightsail-build-$TEMPLATE_VERSION.state"
R2_DIR="ci/lightsail-build/$TEMPLATE_VERSION-$(date -u +%Y%m%dT%H%M%S)-$$"
[[ $DRY == 1 || ! -e "$MANIFEST" ]] || die "$MANIFEST exists already: one manifest per template version"
[[ $DRY == 1 || ! -s "$STATE" ]] || die "$STATE names a builder of an earlier run: clean up first (--cleanup $STATE)"
say "template $TEMPLATE_VERSION, $BLUEPRINT on $BUNDLE in $AZ$([[ $DRY == 1 ]] && echo ', DRY RUN')"

# tags as the CLI wants them: key=K,value=V …
TAGS_BUILDER=("key=ax:managed,value=image-build" "key=ax:template,value=$TEMPLATE_VERSION")
TAGS_IMAGE=("key=ax:managed,value=image" "key=ax:template,value=$TEMPLATE_VERSION" "key=ax:built-by,value=release-ci")
for kv in ${EXTRA_TAGS[@]+"${EXTRA_TAGS[@]}"}; do TAGS_BUILDER+=("key=${kv%%=*},value=${kv#*=}"); TAGS_IMAGE+=("key=${kv%%=*},value=${kv#*=}"); done

# ---- 1. read-only checks in AWS
check_account
read -r BP_ACTIVE BP_VERSION <<<"$(r 'True 13.7' lightsail get-blueprints --query "blueprints[?blueprintId=='$BLUEPRINT'] | [0].[isActive,version]" --output text)"
[[ "$BP_ACTIVE" == True ]] || die "blueprint $BLUEPRINT is not active in $REGION"
[[ "$(r 2 lightsail get-bundles --query "bundles[?bundleId=='$BUNDLE'] | [0].cpuCount" --output text)" =~ ^[0-9]+$ ]] || die "no bundle $BUNDLE in $REGION"
say "blueprint $BLUEPRINT $BP_VERSION, bundle $BUNDLE"

# the snapshot of an earlier attempt: reused when it is ours and available, waited for when it is still being made
snap_json() { r '{"state":"none"}' lightsail get-instance-snapshot --instance-snapshot-name "$NAME" --query instanceSnapshot --output json 2>/dev/null || echo '{"state":"none"}'; }
SNAP="$(snap_json)"
REUSE=0
if [[ "$(jq -r .state <<<"$SNAP")" != none ]]; then
  t="$(jq -c '.tags // []' <<<"$SNAP")"
  [[ "$(lstag "$t" ax:managed)" == image && "$(lstag "$t" ax:template)" == "$TEMPLATE_VERSION" ]] || die "snapshot $NAME exists without the tags ax:managed=image, ax:template=$TEMPLATE_VERSION: check it by hand"
  REUSE=1
  say "snapshot $NAME exists (state $(jq -r .state <<<"$SNAP")): reused"
fi
if [[ $REUSE == 0 ]]; then
  if [[ "$(r none lightsail get-instance --instance-name "$BUILDER" --query instance.state.name --output text 2>/dev/null || echo none)" != none ]]; then
    die "a builder $BUILDER exists (an earlier run?): delete it first (it must carry ax:managed=image-build) or use --cleanup"
  fi
fi

if [[ $REUSE == 0 && $DRY != 1 && $YES != 1 ]]; then
  [[ -t 0 ]] || die "no terminal for the confirmation prompt: pass --yes"
  read -r -p "Build Lightsail image $NAME in $REGION now (a $BUNDLE builder for up to $WAIT_MIN min, then a snapshot)? [y/N] " a
  [[ "$a" == y || "$a" == Y ]] || die "aborted"
fi

on_exit() {
  local rc=$?
  if [[ $rc -ne 0 && $DRY != 1 && -s "$STATE" ]]; then
    say "failed (exit $rc): removing the builder of this run (state $STATE)"
    cleanup_state || say "run again later: $0 --cleanup $STATE --account <id>"
  fi
  if [[ $DRY != 1 && -n "${R2_PUT:-}" ]]; then for k in stage.tgz result.txt; do "${FEED[@]}" r2-delete --key "$R2_DIR/$k" >/dev/null 2>&1 || true; done; fi
  rm -rf "$WORK"
}
trap on_exit EXIT

if [[ $REUSE == 0 ]]; then
  # ---- 2. the stage, the same as the AMI's
  extra=()
  [[ -n "$KIT" ]] && extra+=(--kit "$KIT")
  [[ -n "$ENROLL_BIN" ]] && extra+=(--enroll-bin "$ENROLL_BIN")
  [[ -n "$LINK_BIN" ]] && extra+=(--link-bin "$LINK_BIN")
  [[ $ALLOW_MISSING_KIT == 1 ]] && extra+=(--allow-missing-kit)
  bash "$HERE/build-ami.sh" --stage-only "$WORK/stage" ${extra[@]+"${extra[@]}"}
  KIT_VERSION="$(cat "$WORK/stage/kit-version")"
  [[ "$TEMPLATE_VERSION" == "$KIT_VERSION"-d13-* ]] || die "the kit is $KIT_VERSION, the template version $TEMPLATE_VERSION is not one of it"
  cp "$HERE/lightsail-guest.sh" "$WORK/stage/ax-image/lightsail-guest.sh"
  COPYFILE_DISABLE=1 tar -czf "$WORK/stage.tgz" -C "$WORK/stage" ax-image
  STAGE_SHA="$(sha256 "$WORK/stage.tgz")"
  say "stage $(du -h "$WORK/stage.tgz" | cut -f1), sha256 $STAGE_SHA"

  # ---- the build files in R2 and their presigned URLs (6 h: the wait, plus the time to create)
  if [[ $DRY == 1 ]]; then
    GET_URL='https://example.r2.cloudflarestorage.com/b/ci/lightsail-build/x/stage.tgz?X-Amz-Signature=0'
    PUT_URL='https://example.r2.cloudflarestorage.com/b/ci/lightsail-build/x/result.txt?X-Amz-Signature=0'
    echo "+ lightsail-feed.ts r2-put --key $R2_DIR/stage.tgz" >&3
  else
    R2_PUT=1
    echo "r2 $R2_DIR" >> "$STATE"
    "${FEED[@]}" r2-put --key "$R2_DIR/stage.tgz" --file "$WORK/stage.tgz" >/dev/null
    GET_URL="$("${FEED[@]}" r2-presign --key "$R2_DIR/stage.tgz" --method GET --expires 21600)"
    PUT_URL="$("${FEED[@]}" r2-presign --key "$R2_DIR/result.txt" --method PUT --expires 21600)"
    # GitHub hides these in the log from here on
    [[ -n "${GITHUB_ACTIONS:-}" ]] && { echo "::add-mask::$GET_URL"; echo "::add-mask::$PUT_URL"; }
  fi
  URL_RE='^https://[A-Za-z0-9._~:/?=&%-]+$'
  [[ "$GET_URL" =~ $URL_RE && "$PUT_URL" =~ $URL_RE ]] || die "a presigned URL has characters the launch script cannot quote"

  # ---- the launch script: POSIX sh (dash). Lightsail runs its own part first, in the same script (design §7).
  EXTRA_GUEST=""; [[ $ALLOW_MISSING_KIT == 1 ]] && EXTRA_GUEST=" --allow-missing-kit"
  cat > "$WORK/launch.sh" <<EOF
# ---- Team AX image build (scripts/image/build-lightsail.sh): template $TEMPLATE_VERSION
ax_get() {
  python3 -c 'import sys, urllib.request; open(sys.argv[2], "wb").write(urllib.request.urlopen(sys.argv[1], timeout=1800).read())' "\$1" "\$2"
}
ax_fail() {
  mkdir -p /root/ax-build
  printf '{"ok":false,"templateVersion":"%s","step":"launch","error":"%s"}\n' '$TEMPLATE_VERSION' "\$1" > /root/ax-build/result.txt
  python3 -c 'import sys, urllib.request; urllib.request.urlopen(urllib.request.Request(sys.argv[1], data=open(sys.argv[2], "rb").read(), method="PUT"), timeout=60)' '$PUT_URL' /root/ax-build/result.txt
  rm -rf /root/ax-build
  systemctl --no-block poweroff
  exit 0
}
ax_build() {
  umask 077
  rm -rf /root/ax-build && mkdir -p /root/ax-build || return 1
  n=0
  until ax_get '$GET_URL' /root/ax-build/stage.tgz; do
    n=\$((n + 1)); [ \$n -lt 5 ] || { echo "stage download failed"; return 1; }; sleep 15
  done
  echo '$STAGE_SHA  /root/ax-build/stage.tgz' | sha256sum -c --status - || { echo "stage sha256 mismatch"; return 1; }
  tar --no-same-owner -xzf /root/ax-build/stage.tgz -C /root/ax-build || return 1
  rm -f /root/ax-build/stage.tgz
  printf '%s\n' '$PUT_URL' > /root/ax-build/result-url
  # after cloud-final: its own writes to /var/lib/cloud come before the image's clean-up
  systemd-run --no-block --unit=ax-image-build --property=After=cloud-final.service --property=TimeoutStartSec=infinity \\
    /bin/bash /root/ax-build/ax-image/lightsail-guest.sh --stage /root/ax-build/ax-image \\
    --template-version '$TEMPLATE_VERSION' --result-url-file /root/ax-build/result-url$EXTRA_GUEST || return 1
}
ax_build || ax_fail "stage download, check or start failed"
EOF
  if have dash; then dash -n "$WORK/launch.sh" || die "the launch script is not valid POSIX sh"; fi
  [[ $(wc -c < "$WORK/launch.sh") -lt 16000 ]] || die "the launch script is larger than 16 KB"
  [[ $DRY == 1 ]] && cp "$WORK/launch.sh" "$OUT/lightsail-launch-$TEMPLATE_VERSION.dry-run.sh"

  # ---- 3. the builder
  [[ $DRY == 1 ]] || echo "builder $BUILDER" >> "$STATE"
  q - lightsail create-instances --instance-names "$BUILDER" --availability-zone "$AZ" --blueprint-id "$BLUEPRINT" \
    --bundle-id "$BUNDLE" --ip-address-type ipv4 --user-data "file://$WORK/launch.sh" --tags "${TAGS_BUILDER[@]}" >/dev/null
  say "builder $BUILDER created"
  # running, then no public ports and IMDSv2 only (both refused while "pending": design P3/P8)
  if [[ $DRY != 1 ]]; then
    for i in $(seq 1 60); do
      st="$("${AWS[@]}" lightsail get-instance-state --instance-name "$BUILDER" --query state.name --output text)"
      [[ "$st" == running ]] && break
      [[ $i -lt 60 ]] || die "builder not running after 5 minutes (state $st)"
      sleep 5
    done
  fi
  for i in 1 2 3 4 5 6; do
    if q - lightsail put-instance-public-ports --instance-name "$BUILDER" --port-infos '[]' >/dev/null 2>"$WORK/err"; then break; fi
    [[ $i -lt 6 ]] || { cat "$WORK/err" >&2; die "put-instance-public-ports failed"; }; sleep 10
  done
  for i in 1 2 3 4 5 6; do
    if q - lightsail update-instance-metadata-options --instance-name "$BUILDER" --http-tokens required >/dev/null 2>"$WORK/err"; then break; fi
    [[ $i -lt 6 ]] || { cat "$WORK/err" >&2; die "update-instance-metadata-options failed"; }; sleep 10
  done
  say "builder running: no public ports, IMDSv2 only; waiting for its result (up to $WAIT_MIN min)"

  # ---- 4. wait for the result and "stopped"
  RESULT="$WORK/result.txt"
  if [[ $DRY != 1 ]]; then
    deadline=$(( $(date +%s) + WAIT_MIN * 60 )); stopped_since=0; last=0
    while :; do
      st="$("${AWS[@]}" lightsail get-instance-state --instance-name "$BUILDER" --query state.name --output text)"
      have_result=0; rc=0; "${FEED[@]}" r2-get --key "$R2_DIR/result.txt" --out "$RESULT" >/dev/null 2>&1 || rc=$?
      [[ $rc == 0 ]] && have_result=1
      [[ $rc == 0 || $rc == 3 ]] || say "warning: result read failed (exit $rc), trying again"
      if [[ $have_result == 1 ]]; then
        if [[ "$(head -n1 "$RESULT" | jq -r .ok)" != true ]]; then cat "$RESULT" >&2; die "the build on the builder failed: $(head -n1 "$RESULT" | jq -r .error)"; fi
        [[ "$st" == stopped ]] && break
      elif [[ "$st" == stopped ]]; then
        [[ $stopped_since == 0 ]] && stopped_since=$(date +%s)
        # the result upload comes before the power-off; give a slow read one more minute
        (( $(date +%s) - stopped_since < 90 )) || die "the builder stopped without a result (the launch script did not run, or the upload failed)"
      fi
      (( $(date +%s) < deadline )) || die "no result after $WAIT_MIN minutes (builder state $st)"
      if (( $(date +%s) - last >= 600 )); then say "… builder $st, $(( (deadline - $(date +%s)) / 60 )) min left"; last=$(date +%s); fi
      sleep 30
    done
    say "build result: $(head -n1 "$RESULT")"
    if [[ "$(head -n1 "$RESULT" | jq -r '.timeSync169 // ""')" != yes ]]; then
      say "WARNING: Amazon Time Sync did not answer on 169.254.169.123 on the builder: chrony.conf needs fd00:ec2::123 (design P13)"
      [[ -n "${GITHUB_ACTIONS:-}" ]] && echo "::warning::Lightsail builder: no answer from 169.254.169.123 (chrony.conf needs fd00:ec2::123, design P13)"
    fi
    sed -n '2,$p' "$RESULT" | tail -n 15
  else
    printf '{"ok":true,"templateVersion":"%s","kitVersion":"%s","blueprintVersion":"%s"}\n' "$TEMPLATE_VERSION" "$KIT_VERSION" "$BP_VERSION" > "$RESULT"
  fi
  RES_KIT="$(head -n1 "$RESULT" | jq -r .kitVersion)"
  RES_BP="$(head -n1 "$RESULT" | jq -r '.blueprintVersion // ""')"
  [[ "$RES_KIT" == "$KIT_VERSION" ]] || die "the builder reports kit $RES_KIT, the stage has $KIT_VERSION"
  [[ "$(head -n1 "$RESULT" | jq -r .templateVersion)" == "$TEMPLATE_VERSION" ]] || die "the builder reports another template version"

  # ---- 5. no attached disks, then the snapshot
  # shellcheck disable=SC2016 # the backticks are JMESPath, not the shell
  disks="$(q 0 lightsail get-instance --instance-name "$BUILDER" --query 'length(instance.hardware.disks[?isSystemDisk!=`true`])' --output text)"
  [[ "$disks" == 0 ]] || die "the builder has $disks attached disks: an instance snapshot would include them"
  TAGS_IMAGE+=("key=ax:blueprint-version,value=${RES_BP:-$BP_VERSION}")
  q - lightsail create-instance-snapshot --instance-name "$BUILDER" --instance-snapshot-name "$NAME" --tags "${TAGS_IMAGE[@]}" >/dev/null
  say "snapshot $NAME: waiting for available"
fi

if [[ $DRY != 1 ]]; then
  for i in $(seq 1 180); do
    SNAP="$(snap_json)"; st="$(jq -r .state <<<"$SNAP")"
    [[ "$st" == available ]] && break
    [[ "$st" == error ]] && die "snapshot $NAME failed"
    [[ $i -lt 180 ]] || die "snapshot $NAME not available after 90 minutes (state $st)"
    sleep 30
  done
else
  SNAP="$(jq -nc --arg b "$BUNDLE" --arg bp "$BLUEPRINT" --arg tv "$TEMPLATE_VERSION" --arg v "$BP_VERSION" '{state:"available",fromBundleId:$b,fromBlueprintId:$bp,fromAttachedDisks:[],tags:[{key:"ax:managed",value:"image"},{key:"ax:template",value:$tv},{key:"ax:blueprint-version",value:$v}]}')"
fi
# what hostd installTemplate checks
t="$(jq -c '.tags // []' <<<"$SNAP")"
FROM_BUNDLE="$(jq -r '.fromBundleId // ""' <<<"$SNAP")"
FROM_BP="$(jq -r '.fromBlueprintId // ""' <<<"$SNAP")"
[[ "$(lstag "$t" ax:managed)" == image && "$(lstag "$t" ax:template)" == "$TEMPLATE_VERSION" ]] || die "snapshot $NAME: tags $(jq -c . <<<"$t")"
[[ "$(jq '.fromAttachedDisks // [] | length' <<<"$SNAP")" == 0 ]] || die "snapshot $NAME includes attached disks"
[[ "$FROM_BUNDLE" == "$BUNDLE" ]] || die "snapshot $NAME is from bundle $FROM_BUNDLE, not $BUNDLE"
[[ "$FROM_BP" == "$BLUEPRINT" ]] || die "snapshot $NAME is from blueprint $FROM_BP, not $BLUEPRINT"
BP_OF_IMAGE="$(lstag "$t" ax:blueprint-version)"; [[ -n "$BP_OF_IMAGE" ]] || BP_OF_IMAGE="$BP_VERSION"
KIT_VERSION="${KIT_VERSION:-${TEMPLATE_VERSION%-d13-*}}"
say "snapshot $NAME available (from $FROM_BUNDLE, $FROM_BP $BP_OF_IMAGE)"

# ---- 6. the builder goes; the snapshot stays
if [[ $REUSE == 0 ]]; then
  q - lightsail delete-instance --instance-name "$BUILDER" --no-force-delete-add-ons >/dev/null
  [[ $DRY == 1 ]] || rm -f "$STATE"
  say "builder $BUILDER deleted"
fi

# ---- 7. the manifest: written once, then hashed and signed (the signature covers these exact bytes)
if [[ $DRY == 1 ]]; then MANIFEST="$OUT/$NAME.lightsail.json.dry-run"; rm -f "$MANIFEST" "$MANIFEST.sha256"; fi
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq -cn --arg tv "$TEMPLATE_VERSION" --arg r "$REGION" --arg s "$NAME" --arg b "$FROM_BUNDLE" --arg bp "$FROM_BP" \
  --arg bpv "$BP_OF_IMAGE" --arg k "$KIT_VERSION" --arg at "$BUILT_AT" \
  '{v:1,kind:"lightsail",templateVersion:$tv,region:$r,snapshotName:$s,fromBundleId:$b,blueprintId:$bp,blueprintVersion:$bpv,kitVersion:$k,builtAt:$at}' > "$MANIFEST"
chmod 444 "$MANIFEST"
SHA="$(sha256 "$MANIFEST")"
echo "$SHA  $NAME.lightsail.json" > "$MANIFEST.sha256"
if [[ -n "$SIGN_KEY" ]]; then
  printf 'ax-template-v1\n%s\n%s' "$TEMPLATE_VERSION" "$SHA" > "$WORK/sigmsg"
  openssl pkeyutl -sign -inkey "$SIGN_KEY" -rawin -in "$WORK/sigmsg" -out "$WORK/sig.bin"
  openssl pkey -in "$SIGN_KEY" -pubout -out "$WORK/pub.pem"
  openssl pkeyutl -verify -pubin -inkey "$WORK/pub.pem" -rawin -in "$WORK/sigmsg" -sigfile "$WORK/sig.bin" >/dev/null || die "signature self-check failed"
  base64 < "$WORK/sig.bin" | tr -d '\n' > "$MANIFEST.sig"
  say "signed"
else
  say "no --sign-key: the manifest is not signed (hostd installTemplate refuses it unsigned)"
fi
say "done: $NAME in $REGION"
say "  manifest $MANIFEST"
say "  sha256   $SHA"
cat "$MANIFEST"

#!/bin/bash
# Dev environment on srt (docs/research/srt-dev-env.md section 9) for an EXISTING Trina server (Debian 13). Run as root.
# It adds:
#   - the packages that the AI's commands use (python3, ffmpeg, chromium, build tools ...) and that srt needs
#     (bubblewrap, socat, ripgrep), and polkitd;
#   - node 22 in /opt/trina/node (Debian 13 has node 20; srt needs 22.12 or later, and NODE_USE_ENV_PROXY needs 22.21), from a pinned tarball;
#   - srt in /opt/trina/srt/<version> from the pinned package-lock.json (npm ci --ignore-scripts), root-owned;
#   - /opt/trina/devenv/run-wrap, the polkit rule for the job scopes, the <ID>-devenv.slice with the plan caps;
#   - a drop-in of the server unit: MYCEL_DEV_ENV=1, MYCEL_DEV_ENV_RUNNER=srt, ReadWritePaths=<base>/devenv.
# Everything that srt or a run executes is outside <base>: the srt settings hide all of <base>.
# The first run restarts the team server, so it ends the running answers. A re-run changes only what changed.
# uninstall-srt.sh removes it again.
#   scripts/dev-env/srt/install-srt.sh [--id mycel] [--image-mode]
# --image-mode: for a template build (scripts/image/customize.sh, in a chroot or container, no running systemd). It
# installs only what does not depend on the team: the packages, node, srt and run-wrap. No polkit rule, slice or
# drop-in, no check of the server unit, nothing started. The dev environment stays off. A later run without
# --image-mode on the team server turns it on, and then has nothing to download.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ID=mycel
IMAGE_MODE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --id) ID=${2:?}; shift 2 ;;
    --image-mode) IMAGE_MODE=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
cd /
die() { echo "install-srt: STOP: $*" >&2; exit 1; }
say() { echo "install-srt: $*"; }

SRT_VERSION=0.0.81
NODE_VERSION=22.23.4
# sha256 of https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-<arch>.tar.xz (SHASUMS256.txt of that release)
NODE_SHA_x64=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce
NODE_SHA_arm64=6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b
BASE=/var/lib/$ID
SERVER_UNIT=$ID-server.service
OPT=/opt/trina
SRT_DIR=$OPT/srt/$SRT_VERSION
RULE=/etc/polkit-1/rules.d/60-$ID-devenv.rules
SLICE=/etc/systemd/system/$ID-devenv.slice
DROPIN=/etc/systemd/system/$SERVER_UNIT.d/dev-env.conf
ENT=$BASE/root/dev-env.json
# Server files outside $BASE. server/src/devenv/srt/config.ts serverFilesOutsideBase hides the same list from every
# run (a unit test compares them). Add a file to both places.
SERVER_FILES_OUTSIDE_BASE="/etc/default/$ID"

# root runs these paths, so only root may change them
root_only() { [ ! -L "$1" ] && [ "$(stat -c %u "$1")" = 0 ] && [ -z "$(find "$1" -maxdepth 0 -perm /022)" ]; }
# NEW goes to FILE (mode MODE). True if FILE changed. NEW is gone after the call.
put_changed() {
  if cmp -s "$1" "$3"; then rm -f "$1"; return 1; fi
  install -o root -g root -m "$2" "$1" "$3" || die "cannot write $3"
  rm -f "$1"
}

# ---- look first: nothing below changes the system until every check passes ----
[ "$(id -u)" = 0 ] || die "run as root"
OS=$(. /etc/os-release; echo "$ID $VERSION_ID")
case "$OS" in
  "debian 13") ;;
  # Ubuntu restricts user namespaces with AppArmor: srt's apply-seccomp needs a profile like apparmor-bwrap.in (spike S6)
  "ubuntu 24.04") die "Ubuntu 24.04 needs an AppArmor profile for srt's apply-seccomp; not done yet (design spike S6)" ;;
  *) die "this script is for Debian 13 (found $OS)" ;;
esac
case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64) ARCH=arm64 ;; *) die "unknown machine $(uname -m)" ;; esac
for f in "$HERE/package.json" "$HERE/package-lock.json" "$HERE/run-wrap" "$HERE/devenv.rules.in" "$HERE/devenv.slice.in"; do
  [ -f "$f" ] || die "$f is missing"
done
grep -q "\"@anthropic-ai/sandbox-runtime\": \"$SRT_VERSION\"" "$HERE/package.json" || die "package.json does not pin srt $SRT_VERSION"
if [ "$IMAGE_MODE" = 0 ]; then
systemctl cat "$SERVER_UNIT" >/dev/null 2>&1 || die "no $SERVER_UNIT here: this is not a Trina server"
SRV_USER=$(systemctl show -p User --value "$SERVER_UNIT")
[ -n "$SRV_USER" ] && [ "$SRV_USER" != root ] || die "cannot read the server account of $SERVER_UNIT"
[ -d "$BASE/root" ] && root_only "$BASE/root" || die "$BASE/root must belong to root, and only root may write to it"
[ -f "$BASE/root/install.json" ] || die "no $BASE/root/install.json"
command -v jq >/dev/null || die "jq is missing: apt-get install jq, then run this again"

# The plan caps. A hosted team VM must have root/dev-env.json (one team per VM); the server reads the same file.
HOSTED=0
if grep -Eq '"hosted"[[:space:]]*:[[:space:]]*true' "$BASE/root/install.json"; then HOSTED=1; fi
if [ -f "$ENT" ]; then
  root_only "$ENT" || die "$ENT must belong to root, and only root may write to it"
  jq -e '.format == 1 and (.maxRunning|type=="number") and (.cpus|type=="number") and (.memoryMiB|type=="number") and (.pids|type=="number")' "$ENT" >/dev/null \
    || die "$ENT is not a format 1 plan file"
  MEM=$(jq -r .memoryMiB "$ENT"); CPUS=$(jq -r .cpus "$ENT"); PIDS=$(jq -r .pids "$ENT"); MAXRUN=$(jq -r .maxRunning "$ENT")
elif [ "$HOSTED" = 1 ]; then
  die "this team's plan does not include the dev environment (no $ENT)"
else
  # self-hosted: half of the memory and of the CPUs for all runs together
  MEM=$(( $(awk '/^MemTotal:/ {print $2}' /proc/meminfo) / 1024 / 2 )); CPUS=$(( $(nproc) * 50 / 100 )); [ "$CPUS" -ge 1 ] || CPUS=1
  PIDS=1024; MAXRUN=2
fi
CPU_QUOTA=$(awk -v c="$CPUS" 'BEGIN { printf "%d%%", c * 100 }')
TASKS_MAX=$(( PIDS * (2 * MAXRUN + 2) ))
fi

# ---- packages ----
say "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends bubblewrap socat ripgrep polkitd jq git curl ca-certificates xz-utils \
  python3 python3-venv python3-pip ffmpeg chromium build-essential fonts-noto-cjk
dpkg --compare-versions "$(dpkg-query -W -f '${Version}' bubblewrap)" ge 0.8.0 || die "bubblewrap is older than 0.8.0"

# ---- node (pinned tarball) ----
NODE_DIR=$OPT/node-v$NODE_VERSION
if [ ! -x "$NODE_DIR/bin/node" ]; then
  say "node $NODE_VERSION"
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  TAR=node-v$NODE_VERSION-linux-$ARCH.tar.xz
  curl -fsSL -o "$TMP/$TAR" "https://nodejs.org/dist/v$NODE_VERSION/$TAR"
  SHA_VAR=NODE_SHA_$ARCH
  echo "${!SHA_VAR}  $TMP/$TAR" | sha256sum -c - >/dev/null || die "node tarball: wrong sha256"
  install -d -o root -g root -m 755 "$OPT"
  tar -xJf "$TMP/$TAR" -C "$TMP"
  rm -rf "$NODE_DIR"; mv "$TMP/node-v$NODE_VERSION-linux-$ARCH" "$NODE_DIR"
  chown -R root:root "$NODE_DIR"; chmod -R go-w "$NODE_DIR"
fi
ln -sfn "$NODE_DIR" "$OPT/node"
"$OPT/node/bin/node" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||a===22&&b>=21?0:1)' || die "node is older than 22.21"

# ---- srt (pinned lockfile, no install scripts) ----
if [ ! -f "$SRT_DIR/cli.js" ] || ! cmp -s "$HERE/package-lock.json" "$SRT_DIR/package-lock.json"; then
  say "srt $SRT_VERSION"
  NEW=$(mktemp -d "$OPT/srt/.new.XXXXXX" 2>/dev/null || { install -d -m 755 "$OPT/srt"; mktemp -d "$OPT/srt/.new.XXXXXX"; })
  cp "$HERE/package.json" "$HERE/package-lock.json" "$NEW/"
  ( cd "$NEW" && HOME=/root PATH="$OPT/node/bin:/usr/bin:/bin" npm ci --ignore-scripts --omit=dev --no-audit --no-fund --cache "$NEW/.npm" >/dev/null ) || die "npm ci failed"
  rm -rf "$NEW/.npm"
  ln -sfn node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js "$NEW/cli.js"
  chown -R root:root "$NEW"; chmod -R go-w "$NEW"; chmod 755 "$NEW"
  rm -rf "$SRT_DIR"; mv "$NEW" "$SRT_DIR"
fi
[ -x "$SRT_DIR/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/$ARCH/apply-seccomp" ] || die "srt has no apply-seccomp for $ARCH"
[ "$("$OPT/node/bin/node" "$SRT_DIR/cli.js" --version)" = "$SRT_VERSION" ] || die "srt does not answer --version $SRT_VERSION"
# an older srt folder goes only when no scope uses it
for old in "$OPT"/srt/*/; do
  old=${old%/}; [ "$old" = "$SRT_DIR" ] && continue
  if ! grep -qs "$old/" /proc/[0-9]*/cmdline 2>/dev/null; then rm -rf "$old"; else say "kept $old: a run still uses it"; fi
done

# ---- run-wrap, polkit rule, slice ----
install -d -o root -g root -m 755 "$OPT/devenv"
T=$(mktemp); cp "$HERE/run-wrap" "$T"; put_changed "$T" 755 "$OPT/devenv/run-wrap" || true
if [ "$IMAGE_MODE" = 1 ]; then
  say "image mode done: srt $SRT_VERSION, node $NODE_VERSION, run-wrap. The dev environment is not turned on"
  exit 0
fi
install -d -o root -g root -m 755 /etc/polkit-1/rules.d
T=$(mktemp); sed "s/@SRV_USER@/$SRV_USER/g" "$HERE/devenv.rules.in" > "$T"
put_changed "$T" 644 "$RULE" && systemctl try-restart polkit.service || true
T=$(mktemp); sed -e "s/@ID@/$ID/g" -e "s/@MEMORY_MAX@/${MEM}M/" -e "s/@CPU_QUOTA@/$CPU_QUOTA/" -e "s/@TASKS_MAX@/$TASKS_MAX/" "$HERE/devenv.slice.in" > "$T"
SLICE_CHANGED=0; put_changed "$T" 644 "$SLICE" && SLICE_CHANGED=1

# ---- the server unit: flags and the writable devenv folder ----
install -d -o "$SRV_USER" -g "$SRV_USER" -m 700 "$BASE/devenv"
IMDS=
if grep -qs 'Amazon EC2' /sys/class/dmi/id/board_vendor /sys/class/dmi/id/sys_vendor; then IMDS=" MYCEL_DEV_ENV_IMDS=1"; fi
install -d -o root -g root -m 755 "$(dirname "$DROPIN")"
T=$(mktemp)
cat > "$T" <<EOF
# Trina dev environment on srt (scripts/dev-env/srt/install-srt.sh). Remove with uninstall-srt.sh.
[Service]
Environment=MYCEL_DEV_ENV=1 MYCEL_DEV_ENV_RUNNER=srt$IMDS
ReadWritePaths=$BASE/devenv
EOF
DROPIN_CHANGED=0; put_changed "$T" 644 "$DROPIN" && DROPIN_CHANGED=1
systemctl daemon-reload
[ "$SLICE_CHANGED" = 0 ] || say "devenv slice: MemoryMax=${MEM}M CPUQuota=$CPU_QUOTA TasksMax=$TASKS_MAX"

# ---- check: the server account can start a scope in the slice, and nothing else ----
PROBE=$(head -c 64 /dev/urandom | tr -dc 'a-z0-9' | head -c 16)
[ ${#PROBE} = 16 ] || PROBE=0000000000000000
runuser -u "$SRV_USER" -- systemd-run --scope --quiet --no-ask-password --unit="trina-dev-$PROBE.scope" --slice="$ID-devenv.slice" -- /bin/true \
  || die "the server account cannot start a scope: check $RULE and polkitd"
if runuser -u "$SRV_USER" -- systemd-run --quiet --no-ask-password --unit="trina-dev-$PROBE.service" -- /bin/true 2>/dev/null; then
  die "the server account can start a .service: the polkit rule is too wide"
fi

if [ "$DROPIN_CHANGED" = 1 ]; then
  say "restarting $SERVER_UNIT (running answers end)"
  systemctl restart "$SERVER_UNIT"
fi
say "done: srt $SRT_VERSION, node $NODE_VERSION, files outside $BASE that runs cannot read: $SERVER_FILES_OUTSIDE_BASE"

#!/bin/sh
# Prepare a Linux demo host install WITHOUT root (README "Hosting on Linux"): download and check the pinned programs
# into STAGE/tools and build the app in STAGE/app (its source must already be there, e.g. from
# `git archive <sha> | ssh host tar -x -C STAGE/app`). install.sh (root) then puts both in /opt/trina-demo.
#   sh demo-gate/linux/stage.sh /var/tmp/trina-demo-stage
# Caches (bun, Go) stay inside STAGE; nothing is written to the user's home.
set -eu
STAGE=${1:?usage: stage.sh STAGE_DIR}
case "$STAGE" in /*) ;; *) echo "stage.sh: STAGE_DIR must be absolute" >&2; exit 2 ;; esac
[ "$(uname -s)-$(uname -m)" = Linux-x86_64 ] || { echo "stage.sh: amd64 Linux only" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/pins.env"
APP=$STAGE/app
[ -f "$APP/package.json" ] && [ -f "$APP/demo-gate/linux/pins.env" ] || { echo "stage.sh: no app source in $APP" >&2; exit 2; }
umask 022
mkdir -p "$STAGE/dl" "$STAGE/tools" "$STAGE/cache"
chmod 700 "$STAGE"
say() { echo "stage: $*"; }

# fetch NAME URL SHA256: STAGE/dl/NAME, checked (a file already there with the right sum is kept)
fetch() {
  f=$STAGE/dl/$1
  if [ -f "$f" ] && [ "$(sha256sum "$f" | cut -c1-64)" = "$3" ]; then return 0; fi
  curl -fsSL --retry 3 -o "$f.part" "$2"
  got=$(sha256sum "$f.part" | cut -c1-64)
  [ "$got" = "$3" ] || { rm -f "$f.part"; echo "stage.sh: $1: sha256 $got, expected $3" >&2; exit 3; }
  mv "$f.part" "$f"
}
CH_V=$(python3 -I -c 'import json,sys;a=json.load(open(sys.argv[1]))["artifacts"]["chrome-headless-shell"];p=a["platforms"]["linux-amd64"];print(a["version"],p["url"],p["sha256"],p["dir"])' "$APP/scripts/system/packages.json")
set -- $CH_V; CH_VERSION=$1 CH_URL=$2 CH_SHA=$3 CH_DIR=$4

fetch node.tar.xz "$NODE_URL" "$NODE_SHA256"
fetch bun.zip "$BUN_URL" "$BUN_SHA256"
fetch claude "$CLAUDE_URL" "$CLAUDE_SHA256"
fetch cloudflared "$CLOUDFLARED_URL" "$CLOUDFLARED_SHA256"
fetch chrome.zip "$CH_URL" "$CH_SHA"
say "downloads checked"

T=$STAGE/tools
rm -rf "$T" && mkdir -p "$T/bin" "$T/node" "$T/claude/bin" "$T/chrome-headless-shell/$CH_VERSION"
tar -xJf "$STAGE/dl/node.tar.xz" -C "$T/node" --strip-components=1
unzip -q -o "$STAGE/dl/bun.zip" -d "$STAGE/cache/bun" && cp "$STAGE/cache/bun/bun-linux-x64/bun" "$T/bin/bun"
cp "$STAGE/dl/claude" "$T/claude/bin/claude"
cp "$STAGE/dl/cloudflared" "$T/bin/cloudflared"
unzip -q -o "$STAGE/dl/chrome.zip" -d "$T/chrome-headless-shell/$CH_VERSION"
[ -x "$T/chrome-headless-shell/$CH_VERSION/$CH_DIR/chrome-headless-shell" ] || { echo "stage.sh: chrome-headless-shell not where the list says" >&2; exit 3; }
ln -sfn "$CH_VERSION/$CH_DIR" "$T/chrome-headless-shell/current"
chmod 755 "$T/bin/bun" "$T/bin/cloudflared" "$T/claude/bin/claude"
echo "$CH_VERSION" > "$T/chrome-headless-shell/VERSION"
say "node $("$T/node/bin/node" --version), bun $("$T/bin/bun" --version), $("$T/claude/bin/claude" --version | head -1), $("$T/bin/cloudflared" --version | head -1), chrome-headless-shell $CH_VERSION"

# the app: dependencies (frozen), the native helpers for this machine, the web build
cd "$APP"
export BUN_INSTALL_CACHE_DIR="$STAGE/cache/bun-install" GOCACHE="$STAGE/cache/go-build" GOMODCACHE="$STAGE/cache/go-mod" GOPATH="$STAGE/cache/go" GOFLAGS=-modcacherw
PATH="$T/bin:$T/node/bin:$PATH"; export PATH
bun install --frozen-lockfile > "$STAGE/app-build.log" 2>&1 || { echo "stage.sh: bun install failed (see $STAGE/app-build.log)" >&2; exit 4; }
ARCHS=amd64 bun run build >> "$STAGE/app-build.log" 2>&1 || { echo "stage.sh: app build failed (see $STAGE/app-build.log)" >&2; exit 4; }
[ -x native/bin/linux-amd64/mycel-gate ] || { echo "stage.sh: native helpers missing after the build" >&2; exit 4; }
say "app built: $(cat .git-head 2>/dev/null || echo 'unknown commit'), server $(python3 -I -c 'import json;print(json.load(open("server/package.json"))["version"])')"

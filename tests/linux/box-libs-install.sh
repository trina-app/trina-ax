#!/bin/bash
# The dev environment's libraries in the srt test image (tests/linux/Dockerfile.srt), from the one list as install-srt.sh
# installs them (docs/decisions/20261121-box-python-libs.md): the docrun group's python3-* packages (not the devenv group's build tools
# or Debian's chromium: the image stays small), the browser group's pinned chrome-headless-shell (attacks BR1-BR12), the group's Python programs with pk_python_install, and the Node libraries from
# scripts/dev-env/srt/node-libs.package-lock.json with npm ci --ignore-scripts. tests/linux/srt-attack.ts LIB1-LIB3 import
# each library inside srt.
#   box-libs-install.sh <dir with system/ and srt/>
set -euo pipefail
SRC=$1
. "$SRC/system/packages.sh"
PK_BUN=$(command -v bun) pk_load "$SRC/system/packages.json"
D=$(pk_distro); A=$(pk_arch)
mapfile -t PKGS < <(pk_packages "$D" "$A" docrun | grep -E '^python3')
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq --no-install-recommends "${PKGS[@]}" >/dev/null && rm -rf /var/lib/apt/lists/*
mapfile -t BROWSER_PKGS < <(pk_packages "$D" "$A" browser)
apt-get update -qq && apt-get install -y -qq --no-install-recommends "${BROWSER_PKGS[@]}" >/dev/null && rm -rf /var/lib/apt/lists/*
pk_browser_prepare /opt/trina/chrome-headless-shell "$(pk_platform)"
pk_browser_switch /opt/trina/chrome-headless-shell "$(pk_platform)" >/dev/null
for p in $(pk_pythons docrun); do pk_python_install "/opt/trina/python/$p" "$p"; done
D=/opt/trina/node-libs/test
mkdir -p "$D" && cp "$SRC/srt/node-libs.package.json" "$D/package.json" && cp "$SRC/srt/node-libs.package-lock.json" "$D/package-lock.json"
(cd "$D" && PATH=/opt/trina/node/bin:$PATH npm ci --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null && rm -rf /root/.npm)
ln -sfn test /opt/trina/node-libs/current
chmod -R a+rX,go-w /opt/trina/python /opt/trina/node-libs

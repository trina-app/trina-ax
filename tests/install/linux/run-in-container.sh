#!/bin/bash
# Inside the mycel-t2 container (tests/install/linux/Dockerfile): copy the read-only repository mount (/src) to a
# writable folder (/opt/repo), install its packages for this Linux, use freshly built Linux helpers when the caller put them in
# dist/t2-native/ (GOOS=linux builds from the Mac), and run the install test as root.
set -euo pipefail
ARCH=$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')
mkdir -p /opt/repo
# (not under /root: the test runs `install-linux.sh check` as nobody)
rsync -a --delete --exclude node_modules --exclude 'dist/linux*' --exclude tests/.work --exclude .dev /src/ /opt/repo/
chmod -R a+rX /opt/repo
cd /opt/repo
if [ -d /src/dist/t2-native ]; then mkdir -p "native/bin/linux-$ARCH"; cp /src/dist/t2-native/* "native/bin/linux-$ARCH/"; fi
bun install --frozen-lockfile >/dev/null
exec bun tests/install/g-linux-install.ts "$@"

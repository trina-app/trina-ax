#!/bin/bash
# Root-only mycel-ctl tests in a disposable Linux container: real nftables (engine uid -> 127.0.0.1:<proxy> only) and
# `supervise` (accounts, unit arguments, delegated cgroups, restart, stop). --privileged + a private cgroup namespace
# give nft its CAP_NET_ADMIN and supervise a writable cgroup v2 tree, like the Linux attack tests (tests/linux/run.ts).
#   bash native/cmd/mycel-ctl/testdata/run-docker.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
arch=$(docker info --format '{{.Architecture}}' | sed 's/x86_64/amd64/;s/aarch64/arm64/')
mkdir -p bin/ctl-test
CGO_ENABLED=0 GOOS=linux GOARCH=$arch go test -c -o bin/ctl-test/mycel-ctl.test ./cmd/mycel-ctl
docker build -q -t mycel-ctl-test - >/dev/null <<'DOCKER'
FROM oven/bun:1.3.12-debian
RUN apt-get update && apt-get install -y --no-install-recommends nftables procps zstd && rm -rf /var/lib/apt/lists/* \
 && useradd --system -U -s /usr/sbin/nologin axserver && useradd --system -U -s /usr/sbin/nologin axagent
DOCKER
docker run --rm -i --privileged --cgroupns=private -e MYCEL_CTL_ROOT_TESTS=1 -w /src/cmd/mycel-ctl \
  -v "$PWD:/src:ro" mycel-ctl-test /src/bin/ctl-test/mycel-ctl.test -test.v -test.count=1 "$@"

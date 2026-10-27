#!/bin/bash
# mycel-enroll on a real Linux kernel: a privileged debian:trixie container with loop devices (no VM needed).
#   bash tests/cloud/enroll-docker.sh
# Builds mycel-enroll and a fake control plane for the Docker engine's architecture, then runs
# tests/cloud/enroll/in-container.sh. The container and its loop devices are removed even when a check fails.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
case "$(docker info --format '{{.Architecture}}')" in
  aarch64|arm64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=amd64 ;;
  *) echo "unsupported docker architecture" >&2; exit 2 ;;
esac
# under the repo (tests/.work is gitignored): colima and Docker Desktop share the home folder, not $TMPDIR
mkdir -p "$ROOT/tests/.work"
WORK=$(mktemp -d "$ROOT/tests/.work/enroll-docker.XXXXXX")
NAME="axhost-enroll-test-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
(cd native && CGO_ENABLED=0 GOOS=linux GOARCH=$ARCH go build -trimpath -o "$WORK/mycel-enroll" ./cmd/mycel-enroll)
(cd tests/cloud/enroll && CGO_ENABLED=0 GOOS=linux GOARCH=$ARCH GO111MODULE=off go build -o "$WORK/fakecp" fakecp.go)
cp tests/cloud/enroll/in-container.sh "$WORK/"
docker run --name "$NAME" --rm --privileged -v "$WORK:/t:ro" debian:trixie bash /t/in-container.sh

#!/bin/bash
# The hosted service's tenant commands through the REAL mycel-ctl (Linux build) and the real admin.js on a Linux
# kernel (control-plane 3.5.3, CT-1): a container with bun (oven/bun, Debian), the role accounts, an install base like
# the kit's, the team server running as the server account, and every command run as root the way ax-hostd runs it
# (`mycel-ctl <command> --json [--kebab-flags]`, JSON stdin). Outputs are checked against the contract's zod schemas
# (tests/cloud/tenant/check.ts). No systemd: the commands report restarted / stopped false.
#   bash tests/cloud/tenant-commands-docker.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
case "$(docker info --format '{{.Architecture}}')" in
  aarch64|arm64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=amd64 ;;
  *) echo "unsupported docker architecture" >&2; exit 2 ;;
esac
mkdir -p "$ROOT/tests/.work"
WORK=$(mktemp -d "$ROOT/tests/.work/tenant-docker.XXXXXX")
NAME="ax-tenant-commands-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
(cd native && CGO_ENABLED=0 GOOS=linux GOARCH=$ARCH go build -trimpath -o "$WORK/mycel-ctl" ./cmd/mycel-ctl)
cp tests/cloud/tenant/in-container.sh "$WORK/"
# the repository read-only at /src (its node_modules are plain JavaScript for what admin.js and the server load)
docker run --name "$NAME" --rm -v "$WORK:/t:ro" -v "$ROOT:/src:ro" oven/bun:1.3.12-debian bash /t/in-container.sh

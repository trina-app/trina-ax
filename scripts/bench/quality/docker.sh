#!/usr/bin/env bash
# Runs the search quality test (run.ts) inside Docker limited to 2 CPUs and 4 GB of memory, an approximation of a small
# 2-core server (README.md, "A 2-core estimate"). The committed checkout (git archive HEAD) and the downloaded articles
# (.cache/wiki) go into the container on stdin, so no folder needs to be mounted; the results come back the same way
# into scripts/bench/quality/results/.
#
#   scripts/bench/quality/docker.sh <out-name> [run.ts options...]
#   scripts/bench/quality/docker.sh 2026-11-07-keyword-docker-2cpu --modes keyword
#
# Environment:
#   QUALITY_REUSE=<dir>  an earlier run's full index with its vectors (run.ts --keep <k>: <k>/full/knowledge-graph/
#                        documents), piped in as quality-reuse/; pass --reuse-index quality-reuse to use it
#   QUALITY_MODELS=1     pipe .cache/models in too; otherwise combined mode downloads the model inside the container
#
# Commit first: uncommitted changes are not in the archive. Needs docker (colima works) with at least 2 CPUs and 4 GB.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
OUT=${1:?usage: docker.sh <out-name> [run.ts options...]}
shift
IMAGE=${QUALITY_IMAGE:-oven/bun:1.3.12}   # the bun of CI and the release bundles (.github/workflows/ci.yml)
Q=scripts/bench/quality
[ -f "$Q/.cache/wiki/index.json" ] || { echo "no articles in $Q/.cache/wiki: run bun $Q/fetch.ts first" >&2; exit 1; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git archive --format=tar HEAD > "$TMP/in.tar"
# no extended attributes (macOS adds com.apple.provenance, which the container's tar warns about for every file)
export COPYFILE_DISABLE=1
tar --no-xattrs -rf "$TMP/in.tar" "$Q/.cache/wiki"
if [ "${QUALITY_MODELS:-}" = 1 ] && [ -d "$Q/.cache/models" ]; then tar --no-xattrs -rf "$TMP/in.tar" "$Q/.cache/models"; fi
if [ -n "${QUALITY_REUSE:-}" ]; then
  mkdir "$TMP/reuse" && cp -R "$QUALITY_REUSE" "$TMP/reuse/quality-reuse"
  tar --no-xattrs -rf "$TMP/in.tar" -C "$TMP/reuse" quality-reuse
  rm -rf "$TMP/reuse"
fi
mkdir "$TMP/out"
docker run --rm -i --cpus=2 --memory=4g -e QUALITY_COMMIT="$(git rev-parse --short HEAD)" "$IMAGE" sh -c '
  set -e
  mkdir -p /w && cd /w && tar -x
  bun install --frozen-lockfile --ignore-scripts >/dev/null 2>&1 || bun install --ignore-scripts >&2
  bun scripts/bench/quality/run.ts --out "$@" >&2
  tar -c -C scripts/bench/quality results
' sh "$OUT" "$@" < "$TMP/in.tar" | tar -x -C "$TMP/out"
mkdir -p "$Q/results"
cp "$TMP/out/results/$OUT.json" "$TMP/out/results/$OUT.md" "$Q/results/"
echo "wrote $Q/results/$OUT.json and .md" >&2

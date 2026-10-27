#!/bin/bash
# Build whisper-cli statically for the Linux bundle (linux-runtime spec 3.6.1, D10): the whisper.cpp stable tags ship
# no Linux binary. The source tarball and its sha256 are pinned in scripts/linux/downloads.ts. amd64 gets two builds,
# whisper-cli (AVX2+FMA+F16C) and whisper-cli-v2 (SSE4.2 only), and the server picks by /proc/cpuinfo; arm64 gets one.
# Run it in a Debian 12 container for a portable (glibc 2.36) binary; on a newer host it still builds but links against
# that host's glibc. Statically links libstdc++/libgcc and turns OpenMP off so there is no libgomp dependency.
#
#   scripts/linux/build-whisper.sh --arch amd64|arm64 --out DIR
set -euo pipefail
cd "$(dirname "$0")/../.."
ARCH=""
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "build-whisper.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$ARCH" ] && [ -n "$OUT" ] || { echo "usage: build-whisper.sh --arch amd64|arm64 --out DIR" >&2; exit 2; }
case "$ARCH" in amd64|arm64) ;; *) echo "build-whisper.sh: --arch takes amd64 or arm64" >&2; exit 2 ;; esac

VER=1.9.5
WANT=$(grep -oE "whisper\.cpp[^']*'[^)]*'[0-9a-f]{64}'" scripts/linux/downloads.ts | grep -oE '[0-9a-f]{64}' | head -1)
command -v cmake >/dev/null || { apt-get update && apt-get install -y --no-install-recommends build-essential cmake ca-certificates curl; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/w.tgz" "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${VER}.tar.gz"
if [ -n "$WANT" ]; then echo "$WANT  $work/w.tgz" | sha256sum -c -; else echo "build-whisper.sh: no pinned sha256 found in downloads.ts (building anyway)" >&2; fi
mkdir -p "$work/src"; tar -xzf "$work/w.tgz" -C "$work/src" --strip-components=1
mkdir -p "$OUT"

build() { # <build dir> <extra cmake flags...>
  local d="$1"; shift
  cmake -S "$work/src" -B "$work/$d" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF \
    -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DCMAKE_EXE_LINKER_FLAGS="-static-libgcc -static-libstdc++" "$@" >/dev/null
  cmake --build "$work/$d" -j"$(nproc)" --target whisper-cli >/dev/null
}

if [ "$ARCH" = amd64 ]; then
  build v3 -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON
  cp "$work/v3/bin/whisper-cli" "$OUT/whisper-cli"
  build v2 -DGGML_AVX=OFF -DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_F16C=OFF -DGGML_SSE42=ON
  cp "$work/v2/bin/whisper-cli" "$OUT/whisper-cli-v2"
else
  build a64
  cp "$work/a64/bin/whisper-cli" "$OUT/whisper-cli"
fi
strip "$OUT"/whisper-cli* 2>/dev/null || true
chmod 755 "$OUT"/whisper-cli*
echo "build-whisper.sh: built $(ls "$OUT" | tr '\n' ' ')in $OUT"

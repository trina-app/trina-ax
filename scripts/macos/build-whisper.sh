#!/bin/bash
# Build whisper-cli for Apple silicon Macs (the office zip, docs/DECISIONS.md "Voice input and recordings on an Office
# Mac"): the pinned whisper.cpp source (the same tag and sha256 as the Linux build, scripts/linux/downloads.ts), one
# static program with Metal on and the Metal shaders inside it (GGML_METAL_EMBED_LIBRARY: no .metal or .metallib file
# next to it), no OpenMP (as on Linux), no BLAS and nothing from Homebrew. Intel Macs get none.
#
#   scripts/macos/build-whisper.sh --out DIR
#
# Signing and notarization are separate steps (.github/workflows/mac-whisper.yml): a release signs DIR/whisper-cli with
# the Developer ID identity of the Mac app (hardened runtime) and has Apple notarize it.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    *) echo "build-whisper.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$OUT" ] || { echo "usage: scripts/macos/build-whisper.sh --out DIR" >&2; exit 2; }
[ "$(uname -s)" = Darwin ] || { echo "build-whisper.sh: build on a Mac (Xcode's Metal compiler)" >&2; exit 2; }
command -v cmake >/dev/null || { echo "build-whisper.sh: cmake is missing" >&2; exit 2; }

VER=1.9.5
WANT=$(grep -oE "whisper\.cpp[^']*'[^)]*'[0-9a-f]{64}'" scripts/linux/downloads.ts | grep -oE '[0-9a-f]{64}' | head -1)
[ -n "$WANT" ] || { echo "build-whisper.sh: no pinned sha256 in scripts/linux/downloads.ts" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/w.tgz" "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${VER}.tar.gz"
echo "$WANT  $work/w.tgz" | shasum -a 256 -c -
mkdir -p "$work/src"; tar -xzf "$work/w.tgz" -C "$work/src" --strip-components=1

# macOS 13 and later (Metal 3 on every Apple silicon Mac); arm64 only, also when the runner is an Intel Mac
cmake -S "$work/src" -B "$work/b" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF \
  -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_BLAS=OFF -DGGML_ACCELERATE=ON \
  -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_SDL2=OFF -DWHISPER_CURL=OFF >/dev/null
cmake --build "$work/b" -j"$(sysctl -n hw.ncpu)" --target whisper-cli >/dev/null

mkdir -p "$OUT"
cp "$work/b/bin/whisper-cli" "$OUT/whisper-cli"
strip -x "$OUT/whisper-cli"
chmod 755 "$OUT/whisper-cli"
# one program: only the system's own libraries and frameworks (no Homebrew path, no @rpath to a ggml dylib)
if otool -L "$OUT/whisper-cli" | tail -n +2 | awk '{print $1}' | grep -vE '^(/usr/lib/|/System/Library/)'; then
  echo "build-whisper.sh: whisper-cli links a library outside the system (above)" >&2; exit 1
fi
lipo -archs "$OUT/whisper-cli" | grep -qx arm64 || { echo "build-whisper.sh: whisper-cli is not arm64 only" >&2; exit 1; }
echo "build-whisper.sh: built $OUT/whisper-cli ($(shasum -a 256 "$OUT/whisper-cli" | cut -d' ' -f1))"

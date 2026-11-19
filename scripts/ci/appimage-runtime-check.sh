#!/usr/bin/env bash
# The AppImage's runtime (the program at the start of the file that mounts it) on a stock Linux (.github/workflows/
# desktop.yml, docs/decisions/20261119-linux-desktop-app.md "CI"). QA TC-5356: the arm64 AppImage of 0.5.18 stopped on
# a stock Fedora with "error while loading shared libraries: libz.so": electron-builder's legacy runtime for arm64 was
# linked against the unversioned libz.so, which only zlib's -devel package installs. A normal system has only the
# versioned names (libz.so.1), so any unversioned library the runtime names is refused here.
#
#   appimage-runtime-check.sh <the.AppImage> [fedora]
#
# 1. readelf -d: every library the runtime needs (NEEDED) has a version number (lib*.so.<n>); the runtime built with
#    electron-builder's static type2 toolset (electron-builder.config.ts `toolsets.appimage`) needs none at all.
# 2. `fedora`: the AppImage, on a processor like this runner's, prints its runtime version inside a stock Fedora
#    container (no -devel packages, no FUSE): the runtime loads there, which the 0.5.18 arm64 one did not.
set -euo pipefail

appimage=${1:?the AppImage}
fail() { echo "::error::$*"; exit 1; }
[ -f "$appimage" ] || fail "no file $appimage"
command -v readelf > /dev/null || fail "readelf is missing (binutils)"

echo "::group::the runtime of $(basename "$appimage")"
header=$(readelf -h "$appimage")
echo "$header" | grep -E 'Class:|Machine:'
dynamic=$(readelf -d "$appimage" 2>&1 || true)
needed=$(echo "$dynamic" | sed -n 's/.*(NEEDED).*Shared library: \[\(.*\)\]/\1/p')
if [ -z "$needed" ]; then
  echo "needs no shared library (static runtime)"
else
  echo "needs: $(echo "$needed" | tr '\n' ' ')"
fi
bad=$(echo "$needed" | grep -vE '\.so\.[0-9]+(\.[0-9]+)*$' | grep -v '^$' || true)
[ -z "$bad" ] || fail "the AppImage runtime of $(basename "$appimage") needs unversioned libraries that only -devel packages provide: $(echo "$bad" | tr '\n' ' ')"
echo "::endgroup::"

if [ "${2:-}" = fedora ]; then
  echo "::group::$(basename "$appimage") in a stock Fedora"
  chmod +x "$appimage"
  dir=$(cd "$(dirname "$appimage")" && pwd)
  # the AppImage's file only, read-only; no FUSE device: --appimage-version prints before anything is mounted
  out=$(docker run --rm -v "$dir/$(basename "$appimage"):/app.AppImage:ro" registry.fedoraproject.org/fedora:42 /app.AppImage --appimage-version 2>&1) \
    || { echo "$out"; fail "$(basename "$appimage") did not start in a stock Fedora 42"; }
  echo "$out"
  echo "$out" | grep -qi 'runtime version' || fail "$(basename "$appimage") printed no runtime version in Fedora 42"
  echo "::endgroup::"
fi
echo "$(basename "$appimage"): the runtime needs no unversioned library"

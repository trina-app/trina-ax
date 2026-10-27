#!/usr/bin/env bash
# Node for the relay (versions.json "node-relay"): the official tarball, sha256 pinned here, into /opt/node-<version>
# with /opt/node-26 pointing at it. Run as root on the relay VM (Ubuntu 24.04, x64 or arm64).
# To move to a newer 26.x: change VERSION and the two hashes from https://nodejs.org/dist/v<version>/SHASUMS256.txt.
set -euo pipefail
VERSION=26.12.1
SHA_X64=6170b2d474e1c626f43cff3adc118df9fe3b573258a4fc3d850c8dbc6b079bbd
SHA_ARM64=42aa04922591ee5d4dbc7740d452621acf28508239daa512f5ee8c47ee224fdb
case "$(uname -m)" in
  x86_64) arch=x64; sha=$SHA_X64 ;;
  aarch64|arm64) arch=arm64; sha=$SHA_ARM64 ;;
  *) echo "unsupported machine $(uname -m)" >&2; exit 1 ;;
esac
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
dest=/opt/node-$VERSION
if [ ! -x "$dest/bin/node" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  file=node-v$VERSION-linux-$arch.tar.xz
  curl -fsSLo "$tmp/$file" "https://nodejs.org/dist/v$VERSION/$file"
  echo "$sha  $tmp/$file" | sha256sum -c --quiet
  mkdir -p "$dest"
  tar -xJf "$tmp/$file" -C "$dest" --strip-components=1 --no-same-owner
fi
ln -sfn "$dest" /opt/node-26.new && mv -Tf /opt/node-26.new /opt/node-26
/opt/node-26/bin/node --version

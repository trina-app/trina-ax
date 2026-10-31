#!/bin/bash
# Build the box image and the seccomp profile (dev environment EXPERIMENT). Run as root on the test VM:
#   scripts/dev-env/build-image.sh [box account]
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
U=${1:-mycel-devbox}
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 2; }
install -d -m 0755 /etc/mycel-boxd
python3 -I "$HERE/make-seccomp.py" /usr/share/containers/seccomp.json > /etc/mycel-boxd/box-seccomp.json
chmod 0644 /etc/mycel-boxd/box-seccomp.json
install -d -o "$U" -g "$U" -m 0700 "/home/$U/build"
cp "$HERE/Containerfile" "/home/$U/build/Containerfile"; chown "$U:$U" "/home/$U/build/Containerfile"
runuser -u "$U" -- env XDG_RUNTIME_DIR="/run/user/$(id -u "$U")" sh -c "cd /home/$U/build && podman build -q -t localhost/mycel-devbox:1 -f Containerfile ."
runuser -u "$U" -- env XDG_RUNTIME_DIR="/run/user/$(id -u "$U")" podman image ls localhost/mycel-devbox:1

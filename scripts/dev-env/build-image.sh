#!/bin/bash
# Build the box image and the seccomp profile (dev environment EXPERIMENT). Run as root, on the test VM or from
# install-trial.sh:
#   scripts/dev-env/build-image.sh [box account]
# A running box does not stop: it keeps the image and the profile it started with.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
U=${1:-mycel-devbox}
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 2; }
# Rootless podman goes back to the caller's folder, and the box account cannot enter a home folder ("cannot chdir").
cd /
install -d -m 0755 /etc/mycel-boxd
# A new file and a move: a box that starts now must not read half a profile, and a failed run keeps the old profile.
python3 -I "$HERE/make-seccomp.py" /usr/share/containers/seccomp.json > /etc/mycel-boxd/box-seccomp.json.new
chmod 0644 /etc/mycel-boxd/box-seccomp.json.new
mv -f /etc/mycel-boxd/box-seccomp.json.new /etc/mycel-boxd/box-seccomp.json
# As the box account: root must not write through a link in the box account's home folder.
runuser -u "$U" -- mkdir -p -m 0700 "/home/$U/build"
runuser -u "$U" -- sh -c "cat > /home/$U/build/Containerfile" < "$HERE/Containerfile"
runuser -u "$U" -- env XDG_RUNTIME_DIR="/run/user/$(id -u "$U")" sh -c "cd /home/$U/build && podman build -q -t localhost/mycel-devbox:1 -f Containerfile ."
runuser -u "$U" -- env XDG_RUNTIME_DIR="/run/user/$(id -u "$U")" podman image ls localhost/mycel-devbox:1
echo "build-image: a running box takes a new image or seccomp profile at its next start"

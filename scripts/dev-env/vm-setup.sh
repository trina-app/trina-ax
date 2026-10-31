#!/bin/bash
# Root setup of the dev-env-test VM (Debian 13). NEVER run this on a shared server or a team server: it adds
# accounts, a dummy network interface with stand-in targets, and starts boxd. Idempotent.
#   scripts/dev-env/vm-setup.sh /path/to/mycel-boxd
#   mycel        = stand-in team server account (owns the team folders, talks to boxd)
#   mycel-devbox = account that owns every rootless podman box
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
BOXD=${1:?path of the mycel-boxd binary}
case "$HERE" in /root/*) echo "clone the repo under /opt (the server stand-in account must read it), not under /root" >&2; exit 2;; esac
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq podman crun passt uidmap nftables conntrack curl jq ca-certificates dbus-user-session \
  systemd-container python3 xfsprogs util-linux iproute2 time jq bc >/dev/null
id mycel >/dev/null 2>&1 || useradd -m -s /bin/bash mycel
id mycel-devbox >/dev/null 2>&1 || useradd -m -s /bin/bash mycel-devbox
loginctl enable-linger mycel-devbox
for _ in $(seq 1 30); do [ -d /run/user/$(id -u mycel-devbox) ] && break; sleep 0.5; done
install -d -o mycel -g mycel -m 0750 /srv/mycel /srv/mycel/team /srv/mycel/team/projects
for f in projects/web projects/other; do [ -d /srv/mycel/team/$f ] || install -d -o mycel -g mycel -m 0750 /srv/mycel/team/$f; done
echo "TOP SECRET other folder" > /srv/mycel/team/projects/other/secret.txt
install -d -o mycel -g mycel -m 0700 /srv/mycel/secrets
echo "sk-ant-oat01-FAKE-SERVER-SECRET" > /srv/mycel/secrets/token; chown -R mycel:mycel /srv/mycel; chmod 0600 /srv/mycel/secrets/token
# stand-in targets that a box must NOT reach: "LAN" 10.99.0.1, "metadata" 169.254.169.254, "team server" on 0.0.0.0:8080
ip link show mycellab >/dev/null 2>&1 || ip link add mycellab type dummy
ip link set mycellab up; ip addr replace 10.99.0.1/32 dev mycellab; ip addr replace 169.254.169.254/32 dev mycellab
for t in "10.99.0.1 80 lan" "169.254.169.254 80 metadata" "0.0.0.0 8080 team-server"; do
  set -- $t
  systemctl is-active -q fake-$3 || systemd-run -q --unit fake-$3 -p User=nobody -p AmbientCapabilities=CAP_NET_BIND_SERVICE \
    python3 -I -m http.server --bind "$1" "$2" --directory /var/empty
done
"$HERE/build-image.sh" mycel-devbox
install -m 0755 "$BOXD" /usr/local/sbin/mycel-boxd
systemctl stop mycel-boxd 2>/dev/null || true; systemctl reset-failed mycel-boxd 2>/dev/null || true
systemd-run -q --unit mycel-boxd /usr/local/sbin/mycel-boxd --server-uid "$(id -u mycel)" --server-gid "$(id -g mycel)" --team-root /srv/mycel/team
sleep 1
runuser -u mycel -- python3 -I "$HERE/boxctl.py" /run/mycel-boxd/boxd.sock '{"op":"status"}'
echo "vm-setup: ok"

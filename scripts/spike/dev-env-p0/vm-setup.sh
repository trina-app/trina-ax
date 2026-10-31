#!/bin/bash
# Root part of the spike host: packages, accounts, team folders, stand-in secrets and stand-in network targets.
# Run as root on a Debian 13 host (a throwaway VM). Idempotent.
#   mycel   = stand-in Trina server account (owns team folders, secrets, the stand-in proxy)
#   devbox  = account that owns every rootless podman box (never the server account)
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq podman crun passt uidmap nftables fuse-overlayfs curl jq ca-certificates dbus-user-session \
  systemd-container python3 acl xfsprogs >/dev/null

id mycel >/dev/null 2>&1 || useradd -m -s /bin/bash mycel
id devbox >/dev/null 2>&1 || useradd -m -s /bin/bash devbox
loginctl enable-linger devbox

# team folders: owned by the server account; the box account gets rw on ONE folder through an ACL (box.sh grant)
install -d -o mycel -g mycel -m 0750 /srv/trina /srv/trina/teams /srv/trina/secrets /srv/trina/proxy /srv/trina/proxy-log
for f in proj-web proj-py other-team-folder; do [ -d /srv/trina/teams/$f ] || install -d -o mycel -g mycel -m 0750 /srv/trina/teams/$f; done
echo "TOP SECRET other folder" > /srv/trina/teams/other-team-folder/secret.txt
echo "sk-ant-oat01-FAKE-SERVER-SECRET" > /srv/trina/secrets/claude-oauth-token
chown -R mycel:mycel /srv/trina/teams /srv/trina/secrets; chmod 0600 /srv/trina/secrets/claude-oauth-token
# devbox may traverse to the folders it is granted, nothing else
setfacl -m u:devbox:x /srv/trina /srv/trina/teams
# per-box proxy sockets: /srv/trina/proxy/<box>/ (mycel creates the socket, devbox may connect)
setfacl -m u:devbox:x /srv/trina/proxy

# box-private volumes: one size-limited xfs loop file system per box (box.sh mkvol), under /srv/devbox/vol
install -d -m 0755 /srv/devbox /srv/devbox/vol /srv/devbox/img

# stand-in network targets on the host, reachable from a box through pasta unless the box rules drop them:
#   10.99.0.1   "LAN host"      169.254.169.254 "cloud metadata"     <eth0 ip> "team server"  127.0.0.1:9999 "local admin"
ip link show trinalab >/dev/null 2>&1 || ip link add trinalab type dummy
ip link set trinalab up
ip addr replace 10.99.0.1/32 dev trinalab
ip addr replace 169.254.169.254/32 dev trinalab
install -m 0755 "$(dirname "$0")/fake-target.py" /usr/local/bin/trina-fake-target
for t in "10.99.0.1 80 lan" "169.254.169.254 80 metadata" "0.0.0.0 8080 team-server" "127.0.0.1 9999 local-admin"; do
  set -- $t
  systemctl reset-failed fake-$3 2>/dev/null; systemctl is-active -q fake-$3 || systemd-run -q --unit fake-$3 -p User=nobody -p AmbientCapabilities=CAP_NET_BIND_SERVICE /usr/local/bin/trina-fake-target "$1" "$2" "$3"
done
echo "vm-setup: ok"

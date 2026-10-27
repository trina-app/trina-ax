#!/usr/bin/env bash
# One-time setup of a relay VM (Ubuntu 24.04, Lightsail Seoul 4 GB; control-plane 3.6.1). Run as root from an unpacked
# relay bundle: `sudo ./deploy/setup-host.sh`. Idempotent. It does NOT create secrets: see README.md "Owner steps".
#   packages (nftables, zstd, age, curl), Node 26 (install-node.sh), Litestream (pinned .deb), the mycel-relay account,
#   /etc/mycel-relay, /var/lib/mycel-relay, /opt/mycel-relay, the systemd units and timers, the firewall.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
LITESTREAM_VERSION=0.5.17

apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nftables zstd age curl ca-certificates >/dev/null
"$here/install-node.sh"

if ! command -v litestream >/dev/null; then
  arch=$(dpkg --print-architecture)
  deb=litestream-v$LITESTREAM_VERSION-linux-$arch.deb
  tmp=$(mktemp -d)
  curl -fsSLo "$tmp/$deb" "https://github.com/benbjohnson/litestream/releases/download/v$LITESTREAM_VERSION/$deb"
  echo "check $deb against the release's checksums before continuing:"; sha256sum "$tmp/$deb"
  dpkg -i "$tmp/$deb"
  rm -rf "$tmp"
fi

id mycel-relay >/dev/null 2>&1 || useradd --system --home-dir /var/lib/mycel-relay --shell /usr/sbin/nologin mycel-relay
install -d -o mycel-relay -g mycel-relay -m 0700 /var/lib/mycel-relay
install -d -o root -g root -m 0755 /etc/mycel-relay /opt/mycel-relay /opt/mycel-relay/releases
install -d -o root -g root -m 0700 /etc/mycel-relay/credentials
[ -f /etc/mycel-relay/relay.env ] || install -m 0644 "$here/relay.env.example" /etc/mycel-relay/relay.env
for i in a b; do [ -f "/etc/mycel-relay/instance-$i.env" ] || install -m 0644 "$here/instance-$i.env" "/etc/mycel-relay/instance-$i.env"; done
[ -f /etc/mycel-relay/operator-keys.json ] || install -o root -g mycel-relay -m 0640 "$here/operator-keys.example.json" /etc/mycel-relay/operator-keys.json
[ -f /etc/litestream.yml ] || install -m 0644 "$here/litestream.yml" /etc/litestream.yml

install -m 0644 "$here/mycel-relay@.service" /etc/systemd/system/mycel-relay@.service
install -m 0644 "$here/cf-ips-refresh.service" "$here/cf-ips-refresh.timer" "$here/registry-backup.service" "$here/registry-backup.timer" /etc/systemd/system/
install -m 0755 "$here/mycel-relay-cli" /usr/local/sbin/mycel-relay-cli
install -m 0755 "$here/relay-deploy.sh" /usr/local/sbin/relay-deploy
install -m 0644 "$here/nftables.conf" /etc/nftables.conf
# the private listener binds the Tailscale address, which may come up after the relay at boot
printf 'net.ipv4.ip_nonlocal_bind = 1\nnet.ipv6.ip_nonlocal_bind = 1\n' > /etc/sysctl.d/60-mycel-relay.conf
sysctl -q --system
systemctl daemon-reload
systemctl enable --now nftables >/dev/null
nft -f /etc/nftables.conf
systemctl enable --now cf-ips-refresh.timer registry-backup.timer >/dev/null
echo "host ready. Next: credentials, relay.env (tailnet IP), operator-keys.json, then relay-deploy <bundle> (README.md)"

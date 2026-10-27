#!/usr/bin/env bash
# Keep the relay firewall's Cloudflare sets (nftables.conf: inet mycel_relay cf_v4 / cf_v6) equal to Cloudflare's
# published ranges. Weekly (cf-ips-refresh.timer). A change is applied and logged at warning level (journald ->
# Grafana alert); a download that does not look like a list of ranges changes nothing.
set -euo pipefail
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsS --max-time 20 https://www.cloudflare.com/ips-v4 -o "$tmp/v4"
curl -fsS --max-time 20 https://www.cloudflare.com/ips-v6 -o "$tmp/v6"
grep -Eqv '^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$' <(grep . "$tmp/v4") && { echo "unexpected ips-v4 content" >&2; exit 1; }
grep -Eqv '^[0-9a-f:]+/[0-9]{1,3}$' <(grep . "$tmp/v6") && { echo "unexpected ips-v6 content" >&2; exit 1; }
[ "$(grep -c . "$tmp/v4")" -ge 5 ] && [ "$(grep -c . "$tmp/v6")" -ge 3 ] || { echo "too few ranges, refusing" >&2; exit 1; }
v4=$(grep . "$tmp/v4" | sort | paste -sd, -)
v6=$(grep . "$tmp/v6" | sort | paste -sd, -)
cur4=$(nft list set inet mycel_relay cf_v4 | grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}' | sort | paste -sd, -)
cur6=$(nft list set inet mycel_relay cf_v6 | grep -oE '[0-9a-f]{0,4}(:[0-9a-f]{0,4})+/[0-9]{1,3}' | sort | paste -sd, -)
if [ "$v4" = "$cur4" ] && [ "$v6" = "$cur6" ]; then echo "Cloudflare ranges unchanged"; exit 0; fi
cat > "$tmp/apply.nft" <<NFT
flush set inet mycel_relay cf_v4
flush set inet mycel_relay cf_v6
add element inet mycel_relay cf_v4 { $v4 }
add element inet mycel_relay cf_v6 { $v6 }
NFT
nft -f "$tmp/apply.nft"
logger -p daemon.warning -t cf-ips-refresh "Cloudflare ranges changed and were applied: v4 [$v4] v6 [$v6]; update nftables.conf and relay/src/proxies.ts CLOUDFLARE_RANGES"

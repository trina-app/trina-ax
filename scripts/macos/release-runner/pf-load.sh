#!/bin/sh
# Loads the pf rules of the self-hosted release Mac runner (docs/RELEASE-CI.md 13). Installed root-owned as
# /Library/TrinaCI/pf-load.sh, run by the root LaunchDaemon app.trina.ci.pf at boot and every minute (`self` and the IPv6 LAN table follow
# address changes).
# - rules: /Library/TrinaCI/pf.anchor, into anchor com.apple/260.trina-ci (the stock /etc/pf.conf evaluates com.apple/*;
#   /etc/pf.conf is never edited; when the main ruleset was flushed, the stock file is loaded again)
# - pf is enabled with a reference (pfctl -E) only when it is off; the token goes to run/pf.token so remove.sh can
#   release exactly our reference (pfctl -X)
# - run/pf.ok holds this boot's time only when the rules are loaded and pf is on; /Library/TrinaCI/run.sh does not
#   start the runner without it
set -u
PATH=/usr/bin:/bin:/usr/sbin:/sbin
D=/Library/TrinaCI
ANCHOR=com.apple/260.trina-ci
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) pf-load: $*" >&2; }

[ "$(id -u)" = 0 ] || { log "must run as root"; exit 1; }
for d in "$D" "$D/run"; do
  [ -d "$d" ] && [ ! -L "$d" ] && [ "$(stat -f %u "$d")" = 0 ] && [ -z "$(find "$d" -maxdepth 0 -perm +022)" ] || { log "$d is not a root-only folder"; exit 1; }
done

ok=1
pfctl -s rules 2>/dev/null | grep -q 'anchor "com.apple/\*"' || { log "no com.apple/* anchor: loading /etc/pf.conf"; pfctl -q -f /etc/pf.conf 2>/dev/null; }
pfctl -q -a "$ANCHOR" -f "$D/pf.anchor" || { log "loading $D/pf.anchor failed"; ok=0; }
[ "$(pfctl -a "$ANCHOR" -s rules 2>/dev/null | grep -c 'block drop out quick')" -ge 3 ] || { log "rules not in $ANCHOR"; ok=0; }
# the /64 of every global IPv6 address of this Mac (the LAN's neighbours; pf masks the host bits)
LAN6=$(ifconfig 2>/dev/null | awk '$1 == "inet6" && $2 !~ /^fe80/ && $2 != "::1" && $2 !~ /^f[cd]/ {sub(/%.*/, "", $2); print $2 "/64"}' | sort -u)
if [ -n "$LAN6" ]; then
  # shellcheck disable=SC2086
  pfctl -q -a "$ANCHOR" -t trina_ci_lan6 -T replace $LAN6 2>/dev/null || { log "IPv6 LAN table failed"; ok=0; }
else
  pfctl -q -a "$ANCHOR" -t trina_ci_lan6 -T flush 2>/dev/null
fi

if ! pfctl -s info 2>/dev/null | grep -q 'Status: Enabled'; then
  TOKEN=$(pfctl -E 2>&1 | sed -n 's/^Token : //p')
  if [ -n "$TOKEN" ]; then
    umask 077
    printf 'token=%s\n' "$TOKEN" >> "$D/run/pf.token"
    log "pf enabled (reference $TOKEN)"
  fi
fi
pfctl -s info 2>/dev/null | grep -q 'Status: Enabled' || { log "pf is not enabled"; ok=0; }

BOOT=$(sysctl -n kern.boottime | sed 's/.*sec = \([0-9]*\).*/\1/')
if [ "$ok" = 1 ]; then
  umask 022
  T=$(mktemp "$D/run/.pf.ok.XXXXXX") && printf 'boot=%s\n' "$BOOT" > "$T" && chmod 644 "$T" && mv -f "$T" "$D/run/pf.ok"
else
  rm -f "$D/run/pf.ok"
  exit 1
fi

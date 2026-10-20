#!/bin/sh
# Team AX: load the engine firewall (design tab 2 "기본 ① 방화벽", tab 6). Installed as <base>/root/pf-load
# (root:wheel 755) and run by the root LaunchDaemon <label>.pf at boot and every 5 minutes:
#
#   pf-load <base> <anchor>        e.g. pf-load "/Library/Application Support/mycel" com.apple/250.mycel
#
# - rules: <base>/root/pf.anchor (root-owned; the server cannot change them)
# - the anchor lives under com.apple/ so the stock /etc/pf.conf ("anchor com.apple/*") evaluates it; /etc/pf.conf is
#   never edited. If the main ruleset has been flushed (no com.apple/* reference), the stock file is loaded again.
# - pf is enabled with a reference (pfctl -E); the token is kept in <base>/run/pf.token with the boot time so the
#   uninstaller can release exactly our reference (pfctl -X). A new boot takes a new reference.
# - the result goes to <base>/run/pf.json for the server's diagnostics (the server cannot read /dev/pf). run/ is
#   root:wheel 755: this root job never writes into a folder the server account owns (status/, logs), where a
#   planted symlink would turn the write into a root write anywhere.
# Fixed commands only: no sockets, no IPC, no arguments from the server.
set -u
PATH=/usr/bin:/bin:/usr/sbin:/sbin
BASE=${1:?base folder}
ANCHOR=${2:?anchor name}
RULES="$BASE/root/pf.anchor"
TOKEN_FILE="$BASE/run/pf.token"
STATUS="$BASE/run/pf.json"
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) pf-load: $*" >&2; }

[ "$(id -u)" = 0 ] || { log "must run as root"; exit 1; }
[ -f "$RULES" ] || { log "missing $RULES"; exit 1; }
# every folder this script writes into must be root's own (not a symlink, not writable by anyone else)
for d in "$BASE" "$BASE/run"; do
  [ -d "$d" ] && [ ! -L "$d" ] && [ "$(stat -f %u "$d")" = 0 ] && [ -z "$(find "$d" -maxdepth 0 -perm +022)" ] || { log "$d is not a root-only folder"; exit 1; }
done

referenced() { pfctl -s rules 2>/dev/null | grep -q 'anchor "com.apple/\*"'; }
if ! referenced; then
  log "main ruleset has no com.apple/* anchor: loading /etc/pf.conf"
  pfctl -q -f /etc/pf.conf 2>/dev/null || log "loading /etc/pf.conf failed"
fi

if ! pfctl -q -a "$ANCHOR" -f "$RULES"; then
  log "loading $RULES into $ANCHOR failed"
fi

BOOT=$(sysctl -n kern.boottime | sed 's/.*sec = \([0-9]*\).*/\1/')
SAVED_BOOT=""
[ -f "$TOKEN_FILE" ] && SAVED_BOOT=$(sed -n 's/^boot=//p' "$TOKEN_FILE")
ENABLED=no
pfctl -s info 2>/dev/null | grep -q 'Status: Enabled' && ENABLED=yes
if [ "$SAVED_BOOT" != "$BOOT" ] || [ "$ENABLED" = no ]; then
  TOKEN=$(pfctl -E 2>&1 | sed -n 's/^Token : //p')
  if [ -n "$TOKEN" ]; then
    umask 077
    T=$(mktemp "$BASE/run/.pf.token.XXXXXX") && printf 'token=%s\nboot=%s\n' "$TOKEN" "$BOOT" > "$T" && mv -f -h "$T" "$TOKEN_FILE"
    log "pf enabled (reference $TOKEN)"
  else
    log "pfctl -E gave no token"
  fi
fi

ENABLED=false
pfctl -s info 2>/dev/null | grep -q 'Status: Enabled' && ENABLED=true
REF=false
referenced && REF=true
RULE_COUNT=$(pfctl -a "$ANCHOR" -s rules 2>/dev/null | grep -c .)
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP=$(mktemp "$BASE/run/.pf.json.XXXXXX") && \
printf '{"format":1,"at":"%s","enabled":%s,"anchor":"%s","rules":%s,"referenced":%s}\n' "$NOW" "$ENABLED" "$ANCHOR" "${RULE_COUNT:-0}" "$REF" > "$TMP" && chmod 644 "$TMP" && mv -f -h "$TMP" "$STATUS"
[ "$ENABLED" = true ] && [ "$REF" = true ] && [ "${RULE_COUNT:-0}" -gt 0 ]

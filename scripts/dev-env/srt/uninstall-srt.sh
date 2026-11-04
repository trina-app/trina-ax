#!/bin/bash
# Removes what install-srt.sh added: the server drop-in (restarts the server), the polkit rule, the devenv slice,
# run-wrap, srt and node in /opt/trina. Running jobs and dev servers stop. The packages stay. <base>/devenv (homes,
# caches, logs of the runs) stays unless --purge is given.
#   scripts/dev-env/srt/uninstall-srt.sh [--id mycel] [--purge]
set -euo pipefail
ID=mycel; PURGE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --id) ID=${2:?}; shift 2 ;;
    --purge) PURGE=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "uninstall-srt: run as root" >&2; exit 1; }
BASE=/var/lib/$ID
DROPIN=/etc/systemd/system/$ID-server.service.d/dev-env.conf
if grep -qs MYCEL_DEV_ENV_RUNNER=srt "$DROPIN"; then rm -f "$DROPIN"; fi
for u in $(systemctl list-units --all --plain --no-legend 'trina-dev-*.scope' | awk '{print $1}'); do systemctl stop "$u" || true; done
rm -f "/etc/polkit-1/rules.d/60-$ID-devenv.rules" "/etc/systemd/system/$ID-devenv.slice"
rm -rf /opt/trina/devenv /opt/trina/srt /opt/trina/node /opt/trina/node-v*
rmdir /opt/trina 2>/dev/null || true
systemctl daemon-reload
systemctl restart "$ID-server.service" || true
[ "$PURGE" = 0 ] || rm -rf --one-file-system "$BASE/devenv"
echo "uninstall-srt: done"

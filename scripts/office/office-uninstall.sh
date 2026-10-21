#!/bin/bash
# Remove Team AX office mode (docs/OFFICE.md). No sudo.
#
#   bash office-uninstall.sh [--prefix DIR] [--delete-data [--yes]]
#
# Stops and removes the LaunchAgents (the server, the nightly updater and, with an internet address, cloudflared) and
# deletes the program (app/, app.previous/, app.failed/, update/, the teamax link, ADDRESSES.txt, config/server.json). Keeps data/ (database, backups), team/ (the team folder), tls/ (the office CA the desks
# trust), config/office.env and logs/ unless --delete-data, which deletes the whole install folder after you type
# "delete" (or with --yes).
set -euo pipefail
PREFIX="$HOME/TeamAX" DELETE=0 YES=0
die() { echo "office-uninstall: $*" >&2; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX=$2; shift 2 ;;
    --delete-data) DELETE=1; shift ;;
    --yes) YES=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done
[ "$(id -u)" != 0 ] || die "do not use sudo"
case "$PREFIX" in /*) ;; *) PREFIX="$PWD/$PREFIX" ;; esac
[ -f "$PREFIX/config/office.env" ] || [ -d "$PREFIX/app" ] || die "$PREFIX is not a Team AX office installation"
[ "$PREFIX" != "$HOME" ] && [ "$PREFIX" != / ] || die "refusing to remove $PREFIX"

LABEL=$(sed -n 's/^TEAMAX_LABEL=//p' "$PREFIX/config/office.env" 2>/dev/null || true)
LABEL=${LABEL:-app.team-ax.office}
AGENTS=${TEAMAX_AGENTS_DIR:-$HOME/Library/LaunchAgents}
if [ -x "$PREFIX/app/bin/bun" ] && [ -f "$PREFIX/app/server/src/office.js" ]; then
  "$PREFIX/app/bin/bun" "$PREFIX/app/server/src/office.js" uninstall-agent --home "$PREFIX" || true
fi
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootout "gui/$(id -u)/$LABEL.tunnel" >/dev/null 2>&1 || true
launchctl bootout "gui/$(id -u)/$LABEL.update" >/dev/null 2>&1 || true
rm -f "$AGENTS/$LABEL.plist" "$AGENTS/$LABEL.tunnel.plist" "$AGENTS/$LABEL.update.plist"

if [ "$DELETE" = 1 ]; then
  if [ "$YES" != 1 ]; then
    echo "This deletes $PREFIX: the database, every backup in it, the team folder and the office certificate."
    read -r -p 'Type "delete" to continue: ' a
    [ "$a" = delete ] || die "nothing deleted (the program was removed, the data kept)"
  fi
  rm -rf "$PREFIX"
  echo "office-uninstall: removed $LABEL and $PREFIX"
else
  rm -rf "$PREFIX/app" "$PREFIX/app.previous" "$PREFIX/app.new" "$PREFIX/app.failed" "$PREFIX/update" "$PREFIX/teamax" "$PREFIX/ADDRESSES.txt" "$PREFIX/config/server.json"
  echo "office-uninstall: removed $LABEL and the program; kept $PREFIX/{data,team,tls,config,logs} (--delete-data removes them)"
fi

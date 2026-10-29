#!/bin/bash
# Account tool for the Linux server's administrator (the Linux port of scripts/macos/account.sh; no email: whoever can
# administer the server may recover the owner, and sudo is that proof). Installed by scripts/install-linux.sh as
# <base>/root/mycel-account (root:root 755). The control plane uses create-owner for hosted teams (spec 6.1).
#
#   sudo /var/lib/mycel/root/mycel-account status
#   sudo /var/lib/mycel/root/mycel-account list-owners
#   sudo /var/lib/mycel/root/mycel-account reset-link [--username U]
#                                       one-time password reset link (24 h; a new link cancels the previous one)
#   sudo /var/lib/mycel/root/mycel-account create-owner --username U --name N --team T [--locale en|ko|id|ja|es]
#                                       only while the team has no account; asks for the password (or reads stdin)
#
# It runs the bundled account CLI (server/src/account.js of app/current) as the server account, never as root: root
# does not run what the server account can change (app/ is the server's), it only drops to that account (runuser:
# root only, no PAM session, no password prompt).
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
die() { echo "account: $*" >&2; exit 2; }
case "${1:-}" in
  ""|-h|--help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
esac
[ "$(id -u)" = 0 ] || die "run it with sudo (an administrator of this server)"
ROOTDIR=$(cd "$(dirname "$0")" && pwd -P)
BASE=$(dirname "$ROOTDIR")
[ -f "$BASE/config/server.json" ] || die "no installed server next to $ROOTDIR"
# the server account is the owner of data/ (only root can change an owner)
SRV=$(stat -c %U "$BASE/data")
[[ "$SRV" =~ ^[a-z][a-z0-9-]{1,30}$ ]] && [ "$SRV" != root ] || die "data/ is not owned by a role account ($SRV): is the server installed?"
SRV_UID=$(id -u "$SRV")
[ "$SRV_UID" -ge 100 ] && [ "$SRV_UID" -le 999 ] || die "data/ is owned by $SRV (uid $SRV_UID), not a system account"
BUN="$BASE/app/current/bin/bun"
CLI="$BASE/app/current/server/src/account.js"
[ -f "$CLI" ] || die "$CLI missing (run the installer again)"
run() {
  cd /
  exec runuser -u "$SRV" -- /usr/bin/env -i PATH=/usr/bin:/bin HOME="$BASE/data" MYCEL_MODE=prod \
    MYCEL_CONFIG="$BASE/config/server.json" MYCEL_INSTALL_BASE="$BASE" "$BUN" "$CLI" "$@"
}
if [ "$1" = create-owner ] && [ -t 0 ]; then
  read -rs -p "New owner password: " PW1; echo >&2
  read -rs -p "Again: " PW2; echo >&2
  [ "$PW1" = "$PW2" ] || die "the passwords differ"
  # the password goes over a pipe, never into argv or the environment
  printf '%s\n' "$PW1" | run "$@"
  exit 0
fi
run "$@"

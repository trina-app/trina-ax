#!/bin/bash
# Removes what install-trial.sh added and restores the state before it. Run as root. The project folders stay: only the
# box volumes go (node_modules, caches). It restarts the team server. It does not change the installed version:
# scripts/dev-env/TRIAL.md says how to go back to the release. <base>/root/mycel-boxd stays: the kit owns that file, the
# next update writes it again, and it does nothing without the service and MYCEL_DEV_ENV=1.
#   scripts/dev-env/uninstall-trial.sh [--id mycel] [--keep-packages]
set -euo pipefail
ID=mycel; KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --id) ID=${2:?}; shift 2 ;;
    --keep-packages) KEEP=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
# Rootless podman goes back to the caller's folder, and the box account cannot enter a home folder ("cannot chdir").
cd /
die() { echo "uninstall-trial: STOP: $*" >&2; exit 1; }
say() { echo "uninstall-trial: $*"; }
BOX_USER=mycel-devbox
SERVER_UNIT=$ID-server.service
TIMER=$ID-update.timer
STATE=/var/lib/mycel-boxd-trial
BOXD_STATE=/var/lib/mycel-boxd
UNIT=/etc/systemd/system/mycel-boxd.service
DROPIN=/etc/systemd/system/$SERVER_UNIT.d/dev-env.conf

[ "$(id -u)" = 0 ] || die "run as root"
[ -d "$STATE" ] || die "no $STATE: install-trial.sh did not run here"

say "team server without the dev environment (restart)"
rm -f "$DROPIN"
rmdir "$(dirname "$DROPIN")" 2>/dev/null || true
systemctl daemon-reload
systemctl restart "$SERVER_UNIT"

say "boxes and mycel-boxd"
if id "$BOX_USER" >/dev/null 2>&1; then
  U=$(id -u "$BOX_USER")
  runuser -u "$BOX_USER" -- env XDG_RUNTIME_DIR="/run/user/$U" podman rm -af -t 5 >/dev/null 2>&1 || true
fi
systemctl disable --now mycel-boxd.service >/dev/null 2>&1 || true
# /usr/local/sbin: only an older run of install-trial.sh put the program there.
rm -f "$UNIT" /usr/local/sbin/mycel-boxd
systemctl daemon-reload
systemctl reset-failed mycel-boxd.service 2>/dev/null || true

# A box folder is a mount of a real project folder. Removing through a mount would delete team files, so every mount
# goes first, and rm stays on one file system.
mounts() { findmnt -rn -o TARGET | grep -E "^($BOXD_STATE|/run/mycel-boxd)(/|$)" | sort -r || true; }
for m in $(mounts); do umount "$m" || umount -l "$m" || true; done
[ -z "$(mounts)" ] || die "mounts are still there, nothing was deleted: $(mounts | tr '\n' ' ')"
rm -rf --one-file-system "$BOXD_STATE" /run/mycel-boxd /etc/mycel-boxd

if id "$BOX_USER" >/dev/null 2>&1; then
  say "account $BOX_USER"
  U=$(id -u "$BOX_USER")
  loginctl disable-linger "$BOX_USER" 2>/dev/null || true
  systemctl stop "user@$U.service" 2>/dev/null || true
  pkill -9 -u "$U" 2>/dev/null || true
  sleep 1
  userdel -r "$BOX_USER" 2>/dev/null || die "could not remove $BOX_USER"
fi

if [ "$KEEP" = 0 ] && [ -s "$STATE/packages-new" ]; then
  say "packages this trial added: $(wc -l < "$STATE/packages-new")"
  xargs -r apt-get purge -y -qq < "$STATE/packages-new" >/dev/null
fi

# update-timer-free: install-trial.sh does not hold the timer off, so it stays as the administrator left it.
if [ ! -e "$STATE/update-timer-free" ] && [ "$(cat "$STATE/update-timer" 2>/dev/null)" = enabled ]; then
  systemctl enable --now "$TIMER" >/dev/null
fi
rm -rf --one-file-system "$STATE"

say "check"
id "$BOX_USER" >/dev/null 2>&1 && die "$BOX_USER is still there"
[ ! -e "$UNIT" ] && [ ! -e "$DROPIN" ] && [ ! -e "$BOXD_STATE" ] || die "files are still there"
systemctl is-active -q "$SERVER_UNIT" || die "$SERVER_UNIT does not run"
say "ok"

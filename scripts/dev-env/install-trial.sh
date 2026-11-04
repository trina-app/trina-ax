#!/bin/bash
# Dev environment trial on an EXISTING Trina server (Debian 13). Run as root, on a version that has the dev environment
# (scripts/dev-env/TRIAL.md). Adds podman, the box image, the mycel-devbox account, mycel-boxd as a service, and a
# drop-in that turns on MYCEL_DEV_ENV. The first run restarts the team server, so it ends the running answers. A re-run
# moves an older install to the paths below. It restarts the team server only if its drop-in changed, and boxd only if its
# unit changed or the program in memory is not the file on the disk. It stops on a hosted server.
# Box state goes on the disk of <base> (the team data disk on a VM with one): box volumes in <base>/boxd, podman's storage
# in <base>/boxd-storage. A re-run moves them from /var/lib/mycel-boxd and the box account's home: it stops boxd and
# every box, copies the volumes and builds the image again.
# uninstall-trial.sh removes all of it.
#   scripts/dev-env/install-trial.sh [--boxd /path/to/mycel-boxd] [--id mycel]
# The service runs <base>/root/mycel-boxd, which the kit ships. --boxd copies a program to that path, for a build
# without boxd in the kit.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ID=mycel; BOXD=
while [ $# -gt 0 ]; do
  case "$1" in
    --boxd) BOXD=${2:?}; shift 2 ;;
    --id) ID=${2:?}; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
# Rootless podman goes back to the caller's folder, and the box account cannot enter a home folder ("cannot chdir"). So
# no command below runs from that folder. HERE is already absolute, and a relative --boxd needs the caller's folder.
case "$BOXD" in ""|/*) ;; *) BOXD=$PWD/$BOXD ;; esac
cd /
die() { echo "install-trial: STOP: $*" >&2; exit 1; }
say() { echo "install-trial: $*"; }
BOX_USER=mycel-devbox
BASE=/var/lib/$ID
SERVER_UNIT=$ID-server.service
TIMER=$ID-update.timer
STATE=/var/lib/mycel-boxd-trial
UNIT=/etc/systemd/system/mycel-boxd.service
DROPIN=/etc/systemd/system/$SERVER_UNIT.d/dev-env.conf
SOCK=/run/mycel-boxd/boxd.sock
ROOT_BOXD=$BASE/root/mycel-boxd
OLD_BOXD=/usr/local/sbin/mycel-boxd
# Box volumes (boxd --state-dir) and podman's storage, on the disk of BASE. Older runs used the OLD_ paths, on /.
BOXD_STATE=$BASE/boxd
BOX_STORE=$BASE/boxd-storage
OLD_BOXD_STATE=/var/lib/mycel-boxd
OLD_STORE=/home/$BOX_USER/.local/share/containers/storage
STORE_CONF=/home/$BOX_USER/.config/containers/storage.conf
TIMER_FREE=$STATE/update-timer-free
# root runs this path, so only root may change it. A version folder belongs to the server account: never run from there.
root_only() { [ ! -L "$1" ] && [ "$(stat -c %u "$1")" = 0 ] && [ -z "$(find "$1" -maxdepth 0 -perm /022)" ]; }
# NEW goes to FILE. True if FILE changed. NEW is gone after the call.
put_changed() {
  if cmp -s "$1" "$2"; then rm -f "$1"; return 1; fi
  install -o root -g root -m 0644 "$1" "$2" || die "cannot write $2"
  rm -f "$1"
}
# Mounts under the given folders, deepest first.
mounts_under() { local re; re=$(printf '%s|' "$@"); findmnt -rn -o TARGET | grep -E "^(${re%|})(/|$)" | sort -r || true; }
# A box folder is a mount of a real project folder, on the same disk as BASE: removing through a mount deletes team
# files, and rm --one-file-system does not stop that. So every mount goes first, or the script stops.
unmount_under() {
  local m
  for m in $(mounts_under "$@"); do umount "$m" || umount -l "$m" || true; done
  [ -z "$(mounts_under "$@")" ] || die "mounts are still there, nothing was deleted: $(mounts_under "$@" | tr '\n' ' ')"
}
# Bytes on the disk (a sparse image counts what it holds). A path that is not there counts 0.
bytes_used() { { du -s -B1 "$@" 2>/dev/null || true; } | awk '{n+=$1} END {print n+0}'; }
note_timer() { if systemctl is-enabled -q "$TIMER" 2>/dev/null; then echo enabled > "$STATE/update-timer"; else echo disabled > "$STATE/update-timer"; fi; }

# ---- look first: nothing below changes the system until every check passes ----
[ "$(id -u)" = 0 ] || die "run as root"
OS=$(. /etc/os-release; echo "$ID $VERSION_ID"); [ "$OS" = "debian 13" ] || die "this script is for Debian 13 (found $OS)"
systemctl cat "$SERVER_UNIT" >/dev/null 2>&1 || die "no $SERVER_UNIT here: this is not a Trina server"
[ -f "$BASE/config/server.json" ] || die "no $BASE/config/server.json"
[ -f "$BASE/root/install.json" ] || die "no $BASE/root/install.json"
# A hosted server is a shared host: its kit has root/mycel-boxd too, but this service must not go there.
! grep -Eq '"hosted"[[:space:]]*:[[:space:]]*true' "$BASE/root/install.json" || die "this is a hosted server: the dev environment is for a team VM only"
command -v jq >/dev/null || die "jq is missing, and the script cannot read $BASE/config/server.json without it: apt-get install jq, then run this again"
[ -d "$BASE/root" ] && root_only "$BASE/root" || die "$BASE/root must belong to root, and only root may write to it"
root_only "$BASE" || die "$BASE must belong to root, and only root may write to it: box state goes there"
[ ! -e "$BOXD_STATE" ] || { [ -d "$BOXD_STATE" ] && root_only "$BOXD_STATE"; } || die "$BOXD_STATE must be a folder of root, and only root may write to it"
[ ! -L "$BOX_STORE" ] && { [ ! -e "$BOX_STORE" ] || [ -d "$BOX_STORE" ]; } || die "$BOX_STORE must be a folder"
# The move copies the box volumes to the disk of BASE and builds the image there again. That disk keeps 3 GiB more.
MOVE=0
if [ -d "$OLD_BOXD_STATE" ] || [ -d "$OLD_STORE" ]; then
  MOVE=1
  NEED=$(( $(bytes_used "$OLD_BOXD_STATE"/boxes/*/volume.img "$OLD_STORE") + (3 << 30) ))
  FREE=$(df -P -B1 "$BASE" | awk 'NR==2 {print $4}')
  [ "$FREE" -ge "$NEED" ] || die "the box state moves to $BASE, which needs $((NEED >> 20)) MiB free and has $((FREE >> 20)) MiB"
fi
if [ -n "$BOXD" ]; then
  [ -f "$BOXD" ] && [ -x "$BOXD" ] || die "--boxd must name the built mycel-boxd program"
else
  [ -f "$ROOT_BOXD" ] && [ -x "$ROOT_BOXD" ] || die "no $ROOT_BOXD: the running kit has no mycel-boxd. Update the server (sudo mycel-ctl update), or give --boxd"
  root_only "$ROOT_BOXD" || die "$ROOT_BOXD must be a file that belongs to root, and only root may write to it"
fi
SRV=$(systemctl show -p User --value "$SERVER_UNIT"); [ -n "$SRV" ] || die "$SERVER_UNIT has no User="
SRV_UID=$(id -u "$SRV"); SRV_GID=$(id -g "$SRV")
TEAM=$(jq -r '.teamRoot // empty' "$BASE/config/server.json" 2>/dev/null || true); TEAM=${TEAM:-$BASE/team}
# The server account can change config/server.json, and root runs the unit below with this value. So the path has only
# plain characters: a space in it adds a flag, a newline adds a line. A link goes first: stat does not follow one.
REAL=$(realpath -e -- "$TEAM") || die "no team folder at $TEAM"
TEAM=$REAL
[[ $TEAM =~ ^/[A-Za-z0-9._/-]+$ ]] || die "the team folder path can have only letters, digits and . _ / -"
[ -d "$TEAM" ] || die "no team folder at $TEAM"
[ "$(stat -c %U "$TEAM")" = "$SRV" ] || die "$TEAM does not belong to $SRV"
PORT=$(jq -r '.listen.port // empty' "$BASE/config/server.json" 2>/dev/null || true); PORT=${PORT:-47820}
case "$PORT" in *[!0-9]*) die "listen.port in $BASE/config/server.json is not a number" ;; esac
MEM=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo)
[ "$MEM" -ge 3584 ] || die "the dev environment needs a team VM with at least 4 GB of memory; this one has $MEM MiB"
grep -rqs MYCEL_BOXD_SOCK "$BASE/app/current/server/" || die "the running version has no dev environment: update the server first (sudo mycel-ctl update)"
case "$HERE" in /root/*|/home/*) die "put the repo under /opt: the account $SRV must read $HERE" ;; esac
runuser -u "$SRV" -- test -r "$HERE/boxctl.py" || die "$SRV cannot read $HERE (use /opt)"
if [ ! -d "$STATE" ]; then
  id "$BOX_USER" >/dev/null 2>&1 && die "account $BOX_USER exists, but this script did not make it"
  [ ! -e "$UNIT" ] || die "$UNIT exists, but this script did not make it"
  [ ! -e "$DROPIN" ] || die "$DROPIN exists, but this script did not make it"
fi
# Unsigned: the reason, or empty for a signed release.
UNSIGNED=
[ -f "$BASE/app/current/manifest.sig" ] || UNSIGNED="the running version has no manifest.sig"
if grep -Eq '"allowUnsigned"[[:space:]]*:[[:space:]]*true' "$BASE/root/install.json"; then UNSIGNED="root/install.json has allowUnsigned true"; fi
PUBLIC=$(ip -o addr show scope global | awk '{split($4,a,"/"); print a[1]}' | paste -sd, -)
[ -n "$PUBLIC" ] || die "no global address found for MYCEL_DEV_ENV_DENY_ADDRS"

# ---- what must be undone later ----
RERUN=1
if [ ! -d "$STATE" ]; then
  RERUN=0
  install -d -o root -g root -m 0700 "$STATE"
  dpkg-query -W -f '${Package}\n' | sort > "$STATE/packages-before"
  note_timer
  [ -n "$UNSIGNED" ] || touch "$TIMER_FREE"
fi

# ---- the daily update must not replace an unsigned build; a signed release keeps its timer as it is ----
# update-timer-free: this script does not hold the timer off, so the timer stays the administrator's. An older version of
# this script always turned the timer off and did not write this file. The end of this script gives that timer back.
if [ -n "$UNSIGNED" ]; then
  if [ -e "$TIMER_FREE" ]; then note_timer; rm -f "$TIMER_FREE"; fi
  systemctl disable --now "$TIMER" >/dev/null 2>&1 || true
  say "$TIMER stays off: $UNSIGNED. To turn it on: run a signed release, sudo mycel-ctl allow-unsigned off, then this script again."
fi

say "packages"
export DEBIAN_FRONTEND=noninteractive
# The first run compares with the record from before it. A later run compares only around its own apt-get: a package
# added since then (a kernel, nginx) is not this trial's, and uninstall-trial.sh purges this list.
if [ -e "$STATE/packages-new" ]; then dpkg-query -W -f '${Package}\n' | sort > "$STATE/packages-before"; fi
apt-get update -qq
apt-get install -y -qq --no-upgrade podman crun passt uidmap nftables conntrack dbus-user-session systemd-container python3 xfsprogs \
  util-linux iproute2 >/dev/null
dpkg-query -W -f '${Package}\n' | sort > "$STATE/packages-after"
comm -13 "$STATE/packages-before" "$STATE/packages-after" > "$STATE/packages-added"
if [ -e "$STATE/packages-new" ]; then cat "$STATE/packages-new" >> "$STATE/packages-added"; fi
sort -u "$STATE/packages-added" > "$STATE/packages-new"
rm -f "$STATE/packages-added"

say "account $BOX_USER"
id "$BOX_USER" >/dev/null 2>&1 || useradd -m -s /usr/sbin/nologin "$BOX_USER"
BOX_UID=$(id -u "$BOX_USER")
grep -q "^$BOX_USER:" /etc/subuid || die "$BOX_USER has no range in /etc/subuid"
loginctl enable-linger "$BOX_USER"
for _ in $(seq 1 30); do [ -d "/run/user/$BOX_UID" ] && break; sleep 0.5; done
[ -d "/run/user/$BOX_UID" ] || die "no /run/user/$BOX_UID"

say "box state on the disk of $BASE"
BOX_GID=$(id -g "$BOX_USER")
# A new OS disk can give the box account another uid. The storage and the volumes of the old uid are of no use to it.
if [ -d "$BOX_STORE" ] && [ "$(stat -c %u "$BOX_STORE")" != "$BOX_UID" ]; then
  say "$BOX_STORE belongs to another uid: storage and box volumes start empty"
  systemctl stop mycel-boxd.service 2>/dev/null || true
  unmount_under "$BOX_STORE" "$BOXD_STATE" /run/mycel-boxd
  rm -rf --one-file-system "$BOX_STORE" "$BOXD_STATE/boxes"
fi
if [ "$MOVE" = 1 ]; then
  say "move from $OLD_BOXD_STATE and $OLD_STORE: boxd and every box stop"
  systemctl stop mycel-boxd.service 2>/dev/null || true
  # Before storage.conf changes: podman finds the old containers only in the old storage. boxd makes them again.
  runuser -u "$BOX_USER" -- env XDG_RUNTIME_DIR="/run/user/$BOX_UID" podman rm -af -t 5 >/dev/null 2>&1 || true
  unmount_under "$OLD_BOXD_STATE" "$BOXD_STATE" /run/mycel-boxd
  install -d -o root -g root -m 0711 "$BOXD_STATE" "$BOXD_STATE/boxes"
  # Only volume.img: volume and work are mount points, and boxd makes them again. --sparse: the image stays sparse.
  for img in "$OLD_BOXD_STATE"/boxes/*/volume.img; do
    [ -f "$img" ] && [ ! -L "$img" ] || continue
    d=$(basename "$(dirname "$img")")
    [[ $d =~ ^[A-Za-z0-9._-]+$ ]] || die "box folder with an unusual name: $img"
    # A run that stopped half way copied it already, and the box can have written to it since: that copy stays.
    if [ -e "$BOXD_STATE/boxes/$d/volume.img" ]; then say "box $d: the volume is already in $BOXD_STATE"; continue; fi
    install -d -o root -g "$BOX_GID" -m 0710 "$BOXD_STATE/boxes/$d"
    cp -a --sparse=always "$img" "$BOXD_STATE/boxes/$d/volume.img.new" || die "cannot copy $img. The old state stays."
    cmp -s "$img" "$BOXD_STATE/boxes/$d/volume.img.new" || die "the copy of $img is not the same. The old state stays."
    mv -f "$BOXD_STATE/boxes/$d/volume.img.new" "$BOXD_STATE/boxes/$d/volume.img"
  done
fi
install -d -o root -g root -m 0711 "$BOXD_STATE"
install -d -o "$BOX_USER" -g "$BOX_GID" -m 0700 "$BOX_STORE"
# One file for every podman of the box account (boxd, build-image.sh, vm-tests.sh, a prune by hand): they all have its
# HOME. runroot stays at its default, /run/user/<uid>/containers. As the box account: root must not write through a
# link in that home.
runuser -u "$BOX_USER" -- mkdir -p -m 0700 "/home/$BOX_USER/.config/containers"
printf '[storage]\ndriver = "overlay"\ngraphroot = "%s"\n' "$BOX_STORE" | runuser -u "$BOX_USER" -- sh -c "cat > '$STORE_CONF.new' && chmod 0644 '$STORE_CONF.new' && mv -f '$STORE_CONF.new' '$STORE_CONF'"
GRAPH=$(runuser -u "$BOX_USER" -- env XDG_RUNTIME_DIR="/run/user/$BOX_UID" podman info --format '{{.Store.GraphRoot}}')
[ "$GRAPH" = "$BOX_STORE" ] || die "podman of $BOX_USER uses $GRAPH, not $BOX_STORE"

say "box image (a few minutes)"
"$HERE/build-image.sh" "$BOX_USER"

say "mycel-boxd service"
# A boxd restart stops every running box (setup() fails closed), so it restarts only if the program or the unit changed.
# The program counts as changed if the service runs other bytes than the file: an older mycel-ctl and install-linux.sh
# replace the file and do not restart. cmp, not the text of the link: a file with the same bytes is no change.
BOXD_RESTART=0
if [ -n "$BOXD" ] && ! cmp -s "$BOXD" "$ROOT_BOXD"; then
  install -o root -g root -m 0755 "$BOXD" "$ROOT_BOXD"
  BOXD_RESTART=1
fi
BOXD_PID=$(systemctl show -p MainPID --value mycel-boxd.service 2>/dev/null || true)
if [ "${BOXD_PID:-0}" != 0 ] && ! cmp -s "/proc/$BOXD_PID/exe" "$ROOT_BOXD"; then BOXD_RESTART=1; fi
cat > "$STATE/unit.new" <<UNIT_EOF
# Dev environment trial: scripts/dev-env/install-trial.sh. Root helper, the only program that runs podman.
[Unit]
Description=Trina dev environment box helper (trial)
After=network-online.target user@$BOX_UID.service
Wants=network-online.target
RequiresMountsFor=$BASE
Before=$SERVER_UNIT

[Service]
Type=simple
ExecStart=$ROOT_BOXD --server-uid $SRV_UID --server-gid $SRV_GID --team-root $TEAM --state-dir $BOXD_STATE
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT_EOF
if put_changed "$STATE/unit.new" "$UNIT"; then BOXD_RESTART=1; fi
systemctl daemon-reload
systemctl enable mycel-boxd.service
if [ "$BOXD_RESTART" = 1 ]; then
  say "mycel-boxd changed: restart (a running box stops; its next use starts it)"
  systemctl restart mycel-boxd.service
else
  systemctl start mycel-boxd.service
fi
# The socket of the old process stays until boxd ends its checks, so the socket file proves nothing: ask boxd.
ST=
for _ in $(seq 1 60); do
  ST=$(runuser -u "$SRV" -- python3 -I "$HERE/boxctl.py" "$SOCK" '{"op":"status"}' 2>/dev/null) && break
  ST=; sleep 0.5
done
[ -n "$ST" ] || die "no answer on $SOCK (journalctl -u mycel-boxd -n 50). The team server was not changed."
echo "$ST"
[ "$(jq -r .available <<<"$ST")" = true ] || die "boxd says boxes are not available: $(jq -r .reason <<<"$ST"). The team server was not changed."
# An older run of this script put the program there. Remove it only now: the service runs from the new path.
if [ "$RERUN" = 1 ]; then rm -f "$OLD_BOXD"; fi
# The old box state goes only now too: boxd runs on the new paths. The files of the old storage belong to subuids, so
# the box account removes them in its user namespace: root must not delete through a link in that home.
if [ "$MOVE" = 1 ]; then
  unmount_under "$OLD_BOXD_STATE"
  rm -rf --one-file-system "$OLD_BOXD_STATE"
  runuser -u "$BOX_USER" -- env XDG_RUNTIME_DIR="/run/user/$BOX_UID" podman unshare rm -rf --one-file-system "$OLD_STORE" \
    || die "cannot remove $OLD_STORE. boxd runs on the new paths: run this script again"
  say "the old box state is gone: $OLD_BOXD_STATE, $OLD_STORE"
fi

install -d -m 0755 "$(dirname "$DROPIN")"
cat > "$STATE/dropin.new" <<DROPIN_EOF
# Dev environment trial: scripts/dev-env/install-trial.sh. uninstall-trial.sh removes this file.
[Unit]
Wants=mycel-boxd.service
After=mycel-boxd.service

[Service]
Environment=MYCEL_DEV_ENV=1
Environment=MYCEL_BOXD_SOCK=$SOCK
Environment=MYCEL_DEV_ENV_DENY_ADDRS=$PUBLIC
DROPIN_EOF
if put_changed "$STATE/dropin.new" "$DROPIN"; then
  say "team server: MYCEL_DEV_ENV=1 (restart)"
  systemctl daemon-reload
  systemctl restart "$SERVER_UNIT"
else
  say "team server: no change, no restart"
fi
for _ in $(seq 1 90); do curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/health" && break; sleep 1; done
curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/health" || die "the team server does not answer on port $PORT. Run uninstall-trial.sh."

# A run of the older script turned off the timer of this signed release: give back what the record says. This step comes
# last, so a run that stops above changes nothing here, and the next run comes to it again.
if [ -z "$UNSIGNED" ] && [ ! -e "$TIMER_FREE" ]; then
  if [ "$(cat "$STATE/update-timer" 2>/dev/null)" = enabled ]; then
    systemctl enable --now "$TIMER" >/dev/null
    say "$TIMER is on again, as it was before the first run"
  fi
  touch "$TIMER_FREE"
fi
say "$TIMER: $(systemctl is-enabled "$TIMER" 2>/dev/null || true)"
say "box state: $BOXD_STATE, $BOX_STORE"
say "ok: box limit 1 CPU, 2.5 GB. Turn on dev mode in a project page. No preview domain: the Preview button stays off."

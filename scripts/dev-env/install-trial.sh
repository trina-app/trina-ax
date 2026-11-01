#!/bin/bash
# Dev environment trial on an EXISTING Trina server (Debian 13). Run as root, after the server runs a build of
# feat/dev-env (scripts/dev-env/TRIAL.md). Adds podman, the box image, the mycel-devbox account, mycel-boxd as a service,
# and a drop-in that turns on MYCEL_DEV_ENV. It restarts the team server, so it ends the running answers.
# uninstall-trial.sh removes all of it.
#   scripts/dev-env/install-trial.sh --boxd /path/to/mycel-boxd [--id mycel]
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

# ---- look first: nothing below changes the system until every check passes ----
[ "$(id -u)" = 0 ] || die "run as root"
[ -n "$BOXD" ] && [ -x "$BOXD" ] || die "--boxd must name the built mycel-boxd program"
OS=$(. /etc/os-release; echo "$ID $VERSION_ID"); [ "$OS" = "debian 13" ] || die "this script is for Debian 13 (found $OS)"
systemctl cat "$SERVER_UNIT" >/dev/null 2>&1 || die "no $SERVER_UNIT here: this is not a Trina server"
[ -f "$BASE/config/server.json" ] || die "no $BASE/config/server.json"
SRV=$(systemctl show -p User --value "$SERVER_UNIT"); [ -n "$SRV" ] || die "$SERVER_UNIT has no User="
SRV_UID=$(id -u "$SRV"); SRV_GID=$(id -g "$SRV")
TEAM=$(jq -r '.teamRoot // empty' "$BASE/config/server.json" 2>/dev/null || true); TEAM=${TEAM:-$BASE/team}
[ -d "$TEAM" ] || die "no team folder at $TEAM"
[ "$(stat -c %U "$TEAM")" = "$SRV" ] || die "$TEAM does not belong to $SRV"
PORT=$(jq -r '.listen.port // empty' "$BASE/config/server.json" 2>/dev/null || true); PORT=${PORT:-47820}
MEM=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo)
[ "$MEM" -ge 3584 ] || die "the dev environment needs a team VM with at least 4 GB of memory; this one has $MEM MiB"
grep -rqs MYCEL_BOXD_SOCK "$BASE/app/current/server/" || die "the running version has no dev environment: install the build of feat/dev-env first"
case "$HERE" in /root/*|/home/*) die "put the repo under /opt: the account $SRV must read $HERE" ;; esac
runuser -u "$SRV" -- test -r "$HERE/boxctl.py" || die "$SRV cannot read $HERE (use /opt)"
if [ ! -d "$STATE" ]; then
  id "$BOX_USER" >/dev/null 2>&1 && die "account $BOX_USER exists, but this script did not make it"
  [ ! -e "$UNIT" ] || die "$UNIT exists, but this script did not make it"
  [ ! -e "$DROPIN" ] || die "$DROPIN exists, but this script did not make it"
fi
PUBLIC=$(ip -o addr show scope global | awk '{split($4,a,"/"); print a[1]}' | paste -sd, -)
[ -n "$PUBLIC" ] || die "no global address found for MYCEL_DEV_ENV_DENY_ADDRS"

# ---- what must be undone later ----
if [ ! -d "$STATE" ]; then
  install -d -o root -g root -m 0700 "$STATE"
  dpkg-query -W -f '${Package}\n' | sort > "$STATE/packages-before"
  if systemctl is-enabled -q "$TIMER" 2>/dev/null; then echo enabled > "$STATE/update-timer"; else echo disabled > "$STATE/update-timer"; fi
fi

# ---- the unsigned trial build must not be replaced by the daily update ----
systemctl disable --now "$TIMER" >/dev/null 2>&1 || true

say "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq podman crun passt uidmap nftables conntrack dbus-user-session systemd-container python3 xfsprogs \
  util-linux iproute2 jq >/dev/null
dpkg-query -W -f '${Package}\n' | sort > "$STATE/packages-after"
comm -13 "$STATE/packages-before" "$STATE/packages-after" > "$STATE/packages-new"

say "account $BOX_USER"
id "$BOX_USER" >/dev/null 2>&1 || useradd -m -s /usr/sbin/nologin "$BOX_USER"
BOX_UID=$(id -u "$BOX_USER")
grep -q "^$BOX_USER:" /etc/subuid || die "$BOX_USER has no range in /etc/subuid"
loginctl enable-linger "$BOX_USER"
for _ in $(seq 1 30); do [ -d "/run/user/$BOX_UID" ] && break; sleep 0.5; done
[ -d "/run/user/$BOX_UID" ] || die "no /run/user/$BOX_UID"

say "box image (a few minutes)"
"$HERE/build-image.sh" "$BOX_USER"

say "mycel-boxd service"
install -o root -g root -m 0755 "$BOXD" /usr/local/sbin/mycel-boxd
cat > "$UNIT" <<UNIT_EOF
# Dev environment trial: scripts/dev-env/install-trial.sh. Root helper, the only program that runs podman.
[Unit]
Description=Trina dev environment box helper (trial)
After=network-online.target user@$BOX_UID.service
Wants=network-online.target
Before=$SERVER_UNIT

[Service]
Type=simple
ExecStart=/usr/local/sbin/mycel-boxd --server-uid $SRV_UID --server-gid $SRV_GID --team-root $TEAM
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT_EOF
systemctl daemon-reload
systemctl enable --now mycel-boxd.service
for _ in $(seq 1 20); do [ -S "$SOCK" ] && break; sleep 0.5; done
[ -S "$SOCK" ] || die "no socket at $SOCK (journalctl -u mycel-boxd -n 50). The team server was not changed."
ST=$(runuser -u "$SRV" -- python3 -I "$HERE/boxctl.py" "$SOCK" '{"op":"status"}')
echo "$ST"
[ "$(jq -r .available <<<"$ST")" = true ] || die "boxd says boxes are not available: $(jq -r .reason <<<"$ST"). The team server was not changed."

say "team server: MYCEL_DEV_ENV=1 (restart)"
install -d -m 0755 "$(dirname "$DROPIN")"
cat > "$DROPIN" <<DROPIN_EOF
# Dev environment trial: scripts/dev-env/install-trial.sh. uninstall-trial.sh removes this file.
[Unit]
Wants=mycel-boxd.service
After=mycel-boxd.service

[Service]
Environment=MYCEL_DEV_ENV=1
Environment=MYCEL_BOXD_SOCK=$SOCK
Environment=MYCEL_DEV_ENV_DENY_ADDRS=$PUBLIC
DROPIN_EOF
systemctl daemon-reload
systemctl restart "$SERVER_UNIT"
for _ in $(seq 1 90); do curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/health" && break; sleep 1; done
curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/health" || die "the team server does not answer on port $PORT. Run uninstall-trial.sh."
say "ok: box limit 1 CPU, 2.5 GB. Turn on dev mode in a project page. No preview domain: the Preview button stays off."

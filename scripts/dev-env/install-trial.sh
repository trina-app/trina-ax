#!/bin/bash
# Dev environment trial on an EXISTING Trina server (Debian 13). Run as root, on a version that has the dev environment
# (scripts/dev-env/TRIAL.md). Adds podman, the box image, the mycel-devbox account, mycel-boxd as a service, and a
# drop-in that turns on MYCEL_DEV_ENV. The first run restarts the team server, so it ends the running answers. A re-run
# moves an older install to the paths below. It restarts the team server only if its drop-in changed, and boxd only if its
# unit changed or the program in memory is not the file on the disk. On a hosted team VM it runs only if the team's plan
# includes the dev environment: root/dev-env.json, which boxd also reads (--limits-file) to cap each box.
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
TIMER_FREE=$STATE/update-timer-free
# root runs this path, so only root may change it. A version folder belongs to the server account: never run from there.
root_only() { [ ! -L "$1" ] && [ "$(stat -c %u "$1")" = 0 ] && [ -z "$(find "$1" -maxdepth 0 -perm /022)" ]; }
# NEW goes to FILE. True if FILE changed. NEW is gone after the call.
put_changed() {
  if cmp -s "$1" "$2"; then rm -f "$1"; return 1; fi
  install -o root -g root -m 0644 "$1" "$2" || die "cannot write $2"
  rm -f "$1"
}
note_timer() { if systemctl is-enabled -q "$TIMER" 2>/dev/null; then echo enabled > "$STATE/update-timer"; else echo disabled > "$STATE/update-timer"; fi; }

# ---- look first: nothing below changes the system until every check passes ----
[ "$(id -u)" = 0 ] || die "run as root"
OS=$(. /etc/os-release; echo "$ID $VERSION_ID"); [ "$OS" = "debian 13" ] || die "this script is for Debian 13 (found $OS)"
systemctl cat "$SERVER_UNIT" >/dev/null 2>&1 || die "no $SERVER_UNIT here: this is not a Trina server"
[ -f "$BASE/config/server.json" ] || die "no $BASE/config/server.json"
[ -f "$BASE/root/install.json" ] || die "no $BASE/root/install.json"
command -v jq >/dev/null || die "jq is missing, and the script cannot read $BASE/config/server.json without it: apt-get install jq, then run this again"
[ -d "$BASE/root" ] && root_only "$BASE/root" || die "$BASE/root must belong to root, and only root may write to it"
# A hosted server is a Trina Cloud team VM: one team on its own VM. The plan says if it has a box and its caps, in a
# root-owned file. boxd refuses a box over these caps, so the server account cannot raise them.
HOSTED=0; ENT=$BASE/root/dev-env.json; BOXD_FLAGS=; BOX_SAY="1 CPU, 2.5 GB"
if grep -Eq '"hosted"[[:space:]]*:[[:space:]]*true' "$BASE/root/install.json"; then
  HOSTED=1
  [ -e "$ENT" ] || die "this team's plan does not include the dev environment (no $ENT)"
  [ -f "$ENT" ] && root_only "$ENT" || die "$ENT must be a file that belongs to root, and only root may write to it"
  [ -f "$BASE/root/plan.json" ] && root_only "$BASE/root/plan.json" || die "no root-owned $BASE/root/plan.json"
  # the same rules as boxd (native/cmd/mycel-boxd/plan.go parseEntitlement): a file that boxd refuses stops here, before
  # the steps below change the system
  jq -e 'def whole($lo; $hi): type == "number" and . == floor and . >= $lo and . <= $hi;
    type == "object" and (keys - ["format","plan","maxRunning","cpus","memoryMiB","pids","diskGiB","network"] == [])
    and .format == 1 and (.plan | type == "string" and length >= 1 and length <= 32)
    and (.maxRunning | whole(1; 4)) and (.cpus | type == "number" and . >= 0.25 and . <= 4)
    and (.memoryMiB | whole(256; 8192)) and (.pids | whole(64; 4096)) and (.diskGiB | whole(1; 32))
    and (.network == null or .network == "open" or .network == "offline")' "$ENT" >/dev/null 2>&1 \
    || die "$ENT is not a good plan file (format 1, plan, maxRunning 1-4, cpus 0.25-4, memoryMiB 256-8192, pids 64-4096, diskGiB 1-32, network open or offline, no other keys)"
  ENT_RUN=$(jq -r .maxRunning "$ENT"); ENT_MEM=$(jq -r .memoryMiB "$ENT"); ENT_DISK=$(jq -r .diskGiB "$ENT")
  ENT_CPUS=$(jq -r .cpus "$ENT"); ENT_NET=$(jq -r '.network // "offline"' "$ENT")
  PLAN_MEM=$(jq -er '.memoryMiB | select(type == "number" and . == floor and . > 0)' "$BASE/root/plan.json" 2>/dev/null) \
    || die "$BASE/root/plan.json has no memoryMiB"
  # the box comes on top of the plan's memory (the launcher and the server units keep their limits)
  HMEM=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo)
  [ "$HMEM" -ge $((PLAN_MEM + ENT_MEM)) ] || die "this VM has $HMEM MiB; the plan ($PLAN_MEM MiB) and its box ($ENT_MEM MiB) need $((PLAN_MEM + ENT_MEM)) MiB"
  BOXD_FLAGS=" --max-running $ENT_RUN --limits-file $ENT"
  BOX_SAY="$ENT_CPUS CPU, $ENT_MEM MiB, $ENT_DISK GiB disk, network $ENT_NET (from $ENT)"
fi
if [ -n "$BOXD" ]; then
  [ -f "$BOXD" ] && [ -x "$BOXD" ] || die "--boxd must name the built mycel-boxd program"
else
  [ -f "$ROOT_BOXD" ] && [ -x "$ROOT_BOXD" ] || die "no $ROOT_BOXD: the running kit has no mycel-boxd. Update the server (sudo mycel-ctl update), or give --boxd"
  root_only "$ROOT_BOXD" || die "$ROOT_BOXD must be a file that belongs to root, and only root may write to it"
fi
# An older boxd does not know --limits-file: its unit would restart again and again after the slow steps below.
if [ "$HOSTED" = 1 ]; then
  HELP=$("${BOXD:-$ROOT_BOXD}" -h 2>&1 || true)
  grep -q -- -limits-file <<<"$HELP" || die "this mycel-boxd has no --limits-file: update the server (sudo mycel-ctl update), or give --boxd"
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
Before=$SERVER_UNIT

[Service]
Type=simple
ExecStart=$ROOT_BOXD --server-uid $SRV_UID --server-gid $SRV_GID --team-root $TEAM$BOXD_FLAGS
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT_EOF
if put_changed "$STATE/unit.new" "$UNIT"; then BOXD_RESTART=1; fi
# boxd reads the plan's caps only when it starts: a changed file needs a restart. The copy in STATE is what it last read.
if [ "$HOSTED" = 1 ]; then
  cp "$ENT" "$STATE/dev-env.new"
  if put_changed "$STATE/dev-env.new" "$STATE/dev-env.json"; then BOXD_RESTART=1; fi
fi
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
say "ok: box limit $BOX_SAY. Turn on dev mode in a project page. No preview domain: the Preview button stays off."

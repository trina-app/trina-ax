#!/bin/bash
# Dev box prototype (P0 spike): one long-lived rootless podman box per project folder.
#
# Root commands (host setup per box):
#   box.sh fetch-claude LOCKFILE        download Claude Code for this arch, check size + SHA-256, keep it in
#                                       /srv/devbox/claude/<version>/claude (never in the image)
#   box.sh mkvol BOX [SIZE]             box-private volume: an xfs loop file system (default 4G), owned by devbox
#   box.sh grant BOX FOLDER             give the box account rw on ONE team folder (ACL); start the stand-in proxies
# devbox commands (run as the box account):
#   box.sh build                        build the image and the seccomp profile
#   box.sh create BOX FOLDER open|allow make the box (open: pasta + nft blocks; allow: no network, egress proxy only)
#   box.sh start BOX | stop BOX | rm BOX | pause BOX | unpause BOX
#   box.sh exec BOX CMD...              run a command in the box (as the box user, in /work)
#   box.sh cgroup BOX                   the box's cgroup directory (for measure.sh)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
IMG=localhost/trina-devbox:p0
VOLS=/srv/devbox/vol
TEAMS=/srv/trina/teams
PROXY=/srv/trina/proxy
MEM=${BOX_MEM:-1536m}
CPUS=${BOX_CPUS:-1}
PIDS=${BOX_PIDS:-512}
TMP_SIZE=${BOX_TMP:-256m}

need_root() { [ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 2; }; }
need_box_user() { [ "$(id -un)" = devbox ] || { echo "run as the devbox account" >&2; exit 2; }; }
claude_dir() { ls -d /srv/devbox/claude/*/ 2>/dev/null | sort -V | tail -1; }

cmd=${1:-}; shift || true
case "$cmd" in
fetch-claude)
  need_root
  arch=$(uname -m); case $arch in aarch64) k=linux-arm64;; x86_64) k=linux-amd64;; esac
  ver=$(jq -r .claude.version "$1"); url=$(jq -r ".claude[\"$k\"].url" "$1")
  sha=$(jq -r ".claude[\"$k\"].sha256" "$1"); size=$(jq -r ".claude[\"$k\"].size" "$1")
  d=/srv/devbox/claude/$ver; install -d -m 0755 "$d"
  if [ ! -x "$d/claude" ]; then
    curl -fsSL -o "$d/claude.part" "$url"
    [ "$(stat -c %s "$d/claude.part")" = "$size" ] || { echo "size mismatch" >&2; rm -f "$d/claude.part"; exit 1; }
    echo "$sha  $d/claude.part" | sha256sum -c --quiet || { rm -f "$d/claude.part"; exit 1; }
    chmod 0755 "$d/claude.part"; mv "$d/claude.part" "$d/claude"
  fi
  echo "claude $ver ok: $d/claude";;
mkvol)
  need_root
  b=$1; size=${2:-4G}; img=$VOLS/$b.img; mnt=$VOLS/$b
  [ -f "$img" ] || { truncate -s "$size" "$img"; mkfs.xfs -q "$img"; }
  install -d -m 0700 "$mnt"; mountpoint -q "$mnt" || mount -o loop,nosuid,nodev "$img" "$mnt"
  install -d -o devbox -g devbox -m 0700 "$mnt/cache" "$mnt/cache/home" "$mnt/node_modules" "$mnt/venv"
  chown devbox:devbox "$mnt"; echo "volume $mnt ($(df -h --output=size "$mnt" | tail -1 | tr -d ' '))";;
grant)
  need_root
  b=$1; f=$TEAMS/$2; [ -d "$f" ] || { echo "no folder $f" >&2; exit 1; }
  setfacl -R -m u:devbox:rwX,u:mycel:rwX "$f"; setfacl -R -d -m u:devbox:rwX,u:mycel:rwX "$f"
  install -d -o mycel -g mycel -m 0750 "$PROXY/$b"; setfacl -m u:devbox:rx "$PROXY/$b"
  echo "$2" > "$PROXY/$b/folder"; chown mycel:mycel "$PROXY/$b/folder"
  for p in model egress; do
    systemctl is-active -q "trina-$p-$b" && continue
    systemd-run -q --unit "trina-$p-$b" -p User=mycel -p UMask=0007 \
      /usr/bin/python3 -I "$HERE/$p-proxy.py" "$PROXY/$b/$p.sock" "$b"
  done
  sleep 0.5; setfacl -m u:devbox:rw "$PROXY/$b/model.sock" "$PROXY/$b/egress.sock"
  echo "granted $f to box $b";;
build)
  need_box_user
  python3 -I "$HERE/make-seccomp.py" /usr/share/containers/seccomp.json > "$HOME/box-seccomp.json"
  podman build -q -t "$IMG" -f "$HERE/Containerfile" "$HERE" >/dev/null && podman image ls "$IMG";;
create)
  need_box_user
  b=$1; f=$TEAMS/$2; mode=$3; vol=$VOLS/$b; cl=$(claude_dir)
  case $mode in
    open)  net=(--network "pasta:--no-map-gw,--map-guest-addr,none") ;;
    allow) net=(--network none) ;;
    *) echo "mode: open|allow" >&2; exit 2;;
  esac
  podman create -q --name "box-$b" --hostname "box-$b" "${net[@]}" \
    --read-only --tmpfs "/tmp:rw,nosuid,nodev,size=$TMP_SIZE,mode=1777" \
    --cap-drop=ALL --security-opt no-new-privileges --security-opt "seccomp=$HOME/box-seccomp.json" \
    --pids-limit "$PIDS" --memory "$MEM" --memory-swap "$MEM" --cpus "$CPUS" \
    --userns keep-id --user "$(id -u):$(id -g)" \
    -v "$f:/work:rw" -v "$vol/cache:/cache:rw" -v "$vol/node_modules:/work/node_modules:rw" -v "$vol/venv:/work/.venv:rw" \
    -v "${cl%/}:/opt/claude:ro" -v "$HERE/in-box:/opt/trina:ro" -v "$PROXY/$b:/run/trina:ro" \
    -e TRINA_NET_MODE="$mode" \
    "$IMG" /opt/trina/box-init.sh
  echo "created box-$b ($mode) on $f";;
start)
  need_box_user
  b=$1; podman start "box-$b" >/dev/null
  # network rules go into the box's network namespace before any workload runs (the init only starts forwarders)
  if [ "$(podman inspect -f '{{.HostConfig.NetworkMode}}' "box-$b")" != none ]; then
    pid=$(podman inspect -f '{{.State.Pid}}' "box-$b")
    podman unshare nsenter -t "$pid" -n nft -f "$HERE/box-open.nft"
  fi
  echo "started box-$b";;
stop)    need_box_user; podman stop -t 5 "box-$1" >/dev/null; echo "stopped box-$1";;
rm)      need_box_user; podman rm -f "box-$1" >/dev/null; echo "removed box-$1";;
pause)   need_box_user; podman pause "box-$1" >/dev/null;;
unpause) need_box_user; podman unpause "box-$1" >/dev/null;;
exec)    need_box_user; b=$1; shift; podman exec -i -w /work "box-$b" "$@";;
cgroup)  need_box_user; echo "/sys/fs/cgroup$(podman inspect -f '{{.State.CgroupPath}}' "box-$1")";;
*) sed -n '2,16p' "$0"; exit 2;;
esac

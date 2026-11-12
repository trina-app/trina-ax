#!/bin/bash
# Container start for the Trina AX image (docs/INSTALL-DOCKER.md). Runs as root, as PID 1.
#
#  1. Write /etc/default/mycel: the server listens on all container addresses (MYCEL_HOST), so Docker can publish it.
#  2. Run scripts/install-linux.sh from the image's kit, into the volume on /var/lib/mycel, when the volume is new or
#     when the kit version or the install settings changed: `install` the first time, `update` after that. The
#     installer is the same one a Linux server uses, with --no-systemd --skip-apt --no-auto-update.
#  3. exec `mycel-ctl supervise`: the engine firewall, the launcher as axagent and the server as axserver.
#
# Settings (environment):
#   TRINA_AX_ENGINES         engines to install: "claude", "codex" or "claude codex" (default claude). The installer
#                            downloads the pinned release and checks its SHA-256.
#   TRINA_AX_ENGINE_FILE_CLAUDE / TRINA_AX_ENGINE_FILE_CODEX
#                            use this executable (mounted read-only) instead of a download
#   TRINA_AX_PUBLIC_HOST     public https name (server.json tunnel.host), "none" to remove it
#   TRINA_AX_TIMEZONE        team time zone for the first run (IANA name, for example Asia/Seoul)
#   TRINA_AX_ALLOW_UNSIGNED  1: accept an unsigned kit (development builds only)
#   TRINA_AX_REINSTALL       1: run the installer even when nothing changed (a repair)
# Any other command (for example `bash`) runs instead of the server.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
umask 022

ID=mycel
BASE=/var/lib/$ID
KIT=/opt/trina-ax/kit
say() { echo "trina-ax: $*" >&2; }
die() { echo "trina-ax: error: $*" >&2; exit 1; }
# A host or compose setting that a restart cannot fix: say it once and wait, instead of exiting into the restart
# policy's loop (the same message again and again). Fix it, then `docker compose up -d` (or restart) starts again.
host_stop() {
  echo "trina-ax: error: $*" >&2
  echo "trina-ax: the server does not start until this is fixed; then run \`docker compose up -d --force-recreate\`" >&2
  trap 'exit 1' TERM INT
  sleep infinity & wait $!
  exit 1
}

if [ $# -gt 0 ] && [ "$1" != run ]; then exec "$@"; fi
[ "$(id -u)" = 0 ] || die "the container must start as root (the server and the engines run as axserver and axagent)"
KV=$(tr -d '[:space:]' < "$KIT/VERSION")

# ---- checks that give a clear message before the installer's own checks ----
if ! nft list tables >/dev/null 2>&1; then
  host_stop "nftables does not work here: add the capability NET_ADMIN (cap_add: [NET_ADMIN]); the engine firewall needs it"
fi
if ! runuser -u nobody -- bwrap --unshare-all --ro-bind / / --proc /proc --dev /dev true >/dev/null 2>&1; then
  host_stop "the engine sandbox (bubblewrap) cannot start here. The container needs the security_opt lines of docker-compose.yml (seccomp=./seccomp.json, apparmor=unconfined, systempaths=unconfined) (see docs/INSTALL-DOCKER.md); on an Ubuntu 24.04 host also see \"Ubuntu 24.04 hosts\" there"
fi
if [ "$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo 0)" -lt 1 ]; then
  say "warning: kernel.yama.ptrace_scope is 0 on this host; set it to 1 on the host (sysctl -w kernel.yama.ptrace_scope=1)"
fi

# ---- 1) /etc/default/mycel (read by mycel-ctl supervise for the server's environment) ----
{
  echo "# written by trina-ax-entrypoint at each container start"
  echo "MYCEL_HOST=0.0.0.0"
  if [ -n "${TRINA_AX_TIMEZONE:-}" ]; then
    [[ "$TRINA_AX_TIMEZONE" =~ ^[A-Za-z0-9_+/-]{1,64}$ ]] || die "TRINA_AX_TIMEZONE is not an IANA zone name"
    echo "MYCEL_TEAM_TZ=$TRINA_AX_TIMEZONE"
  fi
} > "/etc/default/$ID.tmp"
mv -f "/etc/default/$ID.tmp" "/etc/default/$ID"

# ---- 2) install or update from the image's kit ----
# --minimal: the image carries the always groups of the one list (scripts/system/packages.json), not the dev
# environment's tools or the headless browser (docker/Dockerfile). Kits before 0.5.0-beta.1 have no root/packages.json
# and their installer does not know --minimal (it checks only its fixed list, which the image has).
ARGS=(--from "$KIT" --no-systemd --skip-apt --no-auto-update)
if compgen -G "$KIT/app/*/root/packages.json" >/dev/null; then ARGS+=(--minimal); fi
ENGINES=${TRINA_AX_ENGINES:-claude}
for e in $ENGINES; do
  case "$e" in
    claude) f=${TRINA_AX_ENGINE_FILE_CLAUDE:-} ;;
    codex) f=${TRINA_AX_ENGINE_FILE_CODEX:-} ;;
    *) die "TRINA_AX_ENGINES: unknown engine $e (claude, codex)" ;;
  esac
  if [ -n "$f" ]; then ARGS+=(--engine "$e=$f"); else ARGS+=(--engine "$e"); fi
done
[ -z "${TRINA_AX_PUBLIC_HOST:-}" ] || ARGS+=(--public-host "$TRINA_AX_PUBLIC_HOST")
if [ "${TRINA_AX_ALLOW_UNSIGNED:-0}" = 1 ]; then ARGS+=(--allow-unsigned); else ARGS+=(--require-signed); fi

# what the last install used; a change runs the installer again (root-owned file in root/, which only root writes)
STAMP="$BASE/root/docker-install"
WANT="kit=$KV engines=$ENGINES public-host=${TRINA_AX_PUBLIC_HOST:-} unsigned=${TRINA_AX_ALLOW_UNSIGNED:-0} engine-files=${TRINA_AX_ENGINE_FILE_CLAUDE:-}:${TRINA_AX_ENGINE_FILE_CODEX:-}"
HAVE=""
if [ -f "$STAMP" ] && [ ! -L "$STAMP" ] && [ ! -L "$BASE/root" ]; then HAVE=$(cat "$STAMP"); fi
if [ -f "$BASE/root/install.json" ]; then CMD=update; else CMD=install; fi
if [ "$CMD" = install ] || [ "$WANT" != "$HAVE" ] || [ "${TRINA_AX_REINSTALL:-0}" = 1 ]; then
  say "$CMD from kit $KV"
  "$KIT/install-linux.sh" "$CMD" "${ARGS[@]}"
  printf '%s\n' "$WANT" > "$STAMP.tmp" && chmod 644 "$STAMP.tmp" && mv -f "$STAMP.tmp" "$STAMP"
else
  say "kit $KV is installed; starting"
fi
[ -x "$BASE/root/mycel-ctl" ] || die "$BASE/root/mycel-ctl missing after the install"
# Without CAP_FSETID the installer's chmod 2750 silently loses the setgid bit: the sockets then get the wrong group
# and the engine cannot reach the server's tools socket. Fail loudly instead.
for d in "$BASE/run/tools" "$BASE/run-launcher"; do
  case "$(stat -c %A "$d")" in ??????s*) ;; *) die "$d has no setgid bit: add the capability FSETID (cap_add) and set TRINA_AX_REINSTALL=1 once" ;; esac
done
# the admin command (the installer makes this link; a new container from the same image has not run the installer)
ln -sfn "$BASE/root/mycel-ctl" /usr/local/sbin/mycel-ctl

if [ -e "$BASE/data/setup-token" ]; then
  say "first-run setup is open: run \`docker compose exec trina-ax trina-ax-setup-link\` for the setup link"
fi

# ---- 3) the firewall, the launcher and the server ----
exec "$BASE/root/mycel-ctl" supervise --base "$BASE"

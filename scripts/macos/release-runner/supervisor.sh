#!/bin/bash
# Supervisor of the self-hosted release Mac runner (docs/RELEASE-CI.md 13). Installed root-owned as
# /Library/TrinaCI/supervisor.sh and run as root by the LaunchDaemon app.trina.ci.runner (KeepAlive).
# One loop = one job on a fresh one-time (just-in-time) runner:
#   1. clean: kill every process of _trinaci, remove its launchd jobs, crontab (cron.deny lists it too), files in /tmp and its Apple
#      temp/cache folders, then delete its HOME, TMPDIR and the whole runner folder on /Volumes/TrinaCI; if anything is
#      left, stop (a "tainted" runner never takes another job)
#   2. checks: pf rules loaded in this boot (run/pf.ok), enough free space on the volume
#   3. a fresh runner folder from the root-owned copy /Library/TrinaCI/runner-dist (programs root-owned and immutable,
#      .env with the job hooks, .path), fresh HOME and TMPDIR
#   4. a just-in-time runner configuration from GitHub (POST .../actions/runners/generate-jitconfig, label
#      trina-mac-release only), with the fine-grained token in /Library/TrinaCI/secrets (root 600, sent by curl from
#      the file, never in argv); the configuration goes to the runner through stdin -> ACTIONS_RUNNER_INPUT_JITCONFIG
#   5. the runner runs as _trinaci inside the sandbox runner.sb, takes ONE job and exits; GitHub deletes the
#      registration, so its credentials are worthless afterwards
# Every folder root writes into is root's own; _trinaci-owned trees are only deleted (rm/chflags/chmod never follow
# symbolic links with -R and no -H/-L).
set -u
PATH=/usr/bin:/bin:/usr/sbin:/sbin
U=_trinaci
V=/Volumes/TrinaCI
D=/Library/TrinaCI
LOG=/private/var/log/trina-ci/runner.log
API=https://api.github.com/repos/trina-app/trina-ax/actions/runners/generate-jitconfig
LABEL=trina-mac-release
MIN_FREE_GB=25
JOB_PATH=/usr/bin:/bin:/usr/sbin:/sbin:$D/node/bin

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) supervisor: $*"; }
[ "$(id -u)" = 0 ] || { log "must run as root"; exit 1; }
UID_=$(id -u "$U" 2>/dev/null) || { log "no account $U"; sleep 60; exit 1; }

kill_all() {
  local pids
  for _ in 1 2 3 4 5; do
    pids=$(ps -axo pid=,uid= | awk -v u="$UID_" '$2 == u {print $1}')
    [ -z "$pids" ] && return 0
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null
    sleep 1
  done
  [ -z "$(ps -axo pid=,uid= | awk -v u="$UID_" '$2 == u {print $1}')" ]
}

wipe_tree() { # delete a tree _trinaci could write into, whatever flags or modes a job set on it
  local p=$1
  [ -e "$p" ] || [ -L "$p" ] || return 0
  if [ -d "$p" ] && [ ! -L "$p" ]; then
    chflags -R nouchg,nouappnd "$p" 2>/dev/null
    chmod -R u+rwX "$p" 2>/dev/null
  fi
  rm -rf "$p" 2>/dev/null
}

clean() {
  kill_all || { log "processes of $U survive kill -9"; return 1; }
  launchctl bootout "user/$UID_" 2>/dev/null
  launchctl bootout "gui/$UID_" 2>/dev/null
  crontab -u "$U" -r 2>/dev/null
  local d
  for d in DARWIN_USER_TEMP_DIR DARWIN_USER_CACHE_DIR; do
    p=$(sudo -u "$U" /usr/bin/getconf "$d" 2>/dev/null)
    case "$p" in
      /var/folders/*/[TC]/ | /private/var/folders/*/[TC]/)
        find "$p" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null ;;
    esac
  done
  kill_all
  find /private/tmp /private/var/tmp -xdev -user "$U" -delete 2>/dev/null
  wipe_tree "$V/runner"; wipe_tree "$V/home"; wipe_tree "$V/tmp"
  # the volume root is root:wheel 755, so nothing else of _trinaci can be there; check anyway
  if [ -n "$(find "$V" -mindepth 1 -maxdepth 1 -user "$U" 2>/dev/null | head -1)" ] || [ -e "$V/runner" ] || [ -e "$V/home" ]; then
    log "files of $U are left on $V after cleaning"
    return 1
  fi
}

prepare() {
  install -d -o "$U" -g "$U" -m 700 "$V/home" "$V/tmp" || return 1
  mkdir -m 755 "$V/runner" || return 1
  cp -Rp "$D/runner-dist/." "$V/runner/" || return 1
  chown -R root:wheel "$V/runner"
  install -d -o "$U" -g "$U" -m 700 "$V/runner/_work" "$V/runner/_diag"
  printf 'LANG=en_US.UTF-8\nACTIONS_RUNNER_HOOK_JOB_STARTED=%s\nACTIONS_RUNNER_HOOK_JOB_COMPLETED=%s\n' \
    "$D/job-started.sh" "$D/job-completed.sh" > "$V/runner/.env"
  printf '%s\n' "$JOB_PATH" > "$V/runner/.path"
  chmod 644 "$V/runner/.env" "$V/runner/.path"
  chflags -R uchg "$V/runner/bin" "$V/runner/externals"
  local f
  for f in .env .path config.sh env.sh run.sh run-helper.sh.template run-helper.cmd.template safe_sleep.sh; do
    [ -e "$V/runner/$f" ] && chflags uchg "$V/runner/$f"
  done
  # the runner writes its one-time registration (.runner, .credentials*) and run-helper.sh into its own folder
  chown "$U:$U" "$V/runner"
}

rotate_log() {
  [ -f "$LOG" ] && [ "$(stat -f %z "$LOG")" -gt 52428800 ] && mv -f "$LOG" "$LOG.1"
  return 0
}

while :; do
  rotate_log
  if ! clean; then
    log "not taking jobs until an admin checks $V (docs/RELEASE-CI.md 13)"
    sleep 600
    continue
  fi
  BOOT=$(sysctl -n kern.boottime | sed 's/.*sec = \([0-9]*\).*/\1/')
  if ! grep -qx "boot=$BOOT" "$D/run/pf.ok" 2>/dev/null; then
    log "pf rules not loaded in this boot (app.trina.ci.pf); waiting"
    sleep 30
    continue
  fi
  FREE=$(df -g "$V" 2>/dev/null | awk 'NR == 2 {print $4}')
  if [ -z "$FREE" ] || [ "$FREE" -lt "$MIN_FREE_GB" ]; then
    log "only ${FREE:-?} GB free on $V (needs $MIN_FREE_GB); waiting"
    sleep 300
    continue
  fi
  if ! prepare; then
    log "preparing the runner folder failed"
    sleep 120
    continue
  fi
  NAME="trina-mac-$(date -u +%Y%m%d-%H%M%S)"
  BODY=$(printf '{"name":"%s","runner_group_id":1,"labels":["%s"],"work_folder":"_work"}' "$NAME" "$LABEL")
  JIT=$(curl -fsS -m 30 -X POST -H @"$D/secrets/github-auth.header" -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' -d "$BODY" "$API" 2>>"$LOG" | /usr/bin/jq -r '.encoded_jit_config // empty')
  if [ -z "$JIT" ]; then
    log "no just-in-time configuration from GitHub (token expired or lacks Administration: write?); retrying in 5 min"
    sleep 300
    continue
  fi
  log "runner $NAME waiting for a job"
  ( cd "$V/runner" && printf '%s\n' "$JIT" | sudo -u "$U" /usr/bin/env -i HOME="$V/home" TMPDIR="$V/tmp/" USER="$U" \
      LOGNAME="$U" LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 PATH="$JOB_PATH" \
      /bin/bash -c 'IFS= read -r ACTIONS_RUNNER_INPUT_JITCONFIG; export ACTIONS_RUNNER_INPUT_JITCONFIG; umask 022; exec /usr/bin/sandbox-exec -f /Library/TrinaCI/runner.sb ./run.sh' ) >> "$LOG" 2>&1
  RC=$?
  JIT=""
  log "runner $NAME exited ($RC)"
  sleep 5
done

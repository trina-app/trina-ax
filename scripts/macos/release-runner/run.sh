#!/bin/bash
# Starts the self-hosted release Mac runner (docs/RELEASE-CI.md 13). Installed root-owned as /Library/TrinaCI/run.sh and
# run as _trinaci by the LaunchDaemon app.trina.ci.runner (KeepAlive: started again when it stops).
# - waits for the runner volume /Volumes/TrinaCI (a separate APFS volume with a quota, mounted at boot)
# - refuses to start until pf-load.sh has loaded the network rules in this boot (run/pf.ok)
# - HOME and TMPDIR are on the volume (the job-completed hook empties them); the runner and every job step it starts
#   run inside the sandbox runner.sb
set -u
PATH=/usr/bin:/bin:/usr/sbin:/sbin
V=/Volumes/TrinaCI
D=/Library/TrinaCI
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) run.sh: $*"; }

[ "$(id -un)" = _trinaci ] || { log "must run as _trinaci"; sleep 60; exit 1; }
for _ in $(seq 1 60); do [ -x "$V/runner/run.sh" ] && break; sleep 5; done
[ -x "$V/runner/run.sh" ] || { log "$V/runner/run.sh missing (volume not mounted?)"; exit 1; }
BOOT=$(sysctl -n kern.boottime | sed 's/.*sec = \([0-9]*\).*/\1/')
grep -qx "boot=$BOOT" "$D/run/pf.ok" 2>/dev/null || { log "pf rules not loaded in this boot (app.trina.ci.pf); not starting"; sleep 30; exit 1; }

export HOME="$V/home" TMPDIR="$V/tmp/" USER=_trinaci LOGNAME=_trinaci LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
umask 022
cd "$V/runner" || exit 1
exec /usr/bin/sandbox-exec -f "$D/runner.sb" ./run.sh

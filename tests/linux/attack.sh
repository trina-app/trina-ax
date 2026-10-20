#!/bin/bash
# Runs INSIDE a turn as the engine account (= the engine is assumed compromised and runs code).
# Every line prints what was reachable; the driver looks for canary strings and successes.
try() { local label="$1"; shift; local out; out=$("$@" 2>&1 | head -c 300 | tr '\n' ' '); echo "[$label] rc=$? $out"; }
try team-dir           ls /srv/mycel
try team-file          cat /srv/mycel/linux/team/groups/finance/budget.md
try find-canary        grep -r CANARY /srv/mycel
try db                 cat /srv/mycel/linux/data/app.db
try server-home        ls /home/axserver
try mallory-home       ls /home/mallory
try private-sock-dir   ls /run/mycel/private
SRVPID=$(pgrep -u axserver -f linux/driver.ts | head -1)
try server-environ     cat /proc/$SRVPID/environ
try server-root        ls /proc/$SRVPID/root/srv/mycel
try server-cwd         ls /proc/$SRVPID/cwd
try server-fds         ls -l /proc/$SRVPID/fd
for p in $(pgrep -u axagent); do e=$(tr '\0' '\n' </proc/$p/environ 2>/dev/null | grep -iE 'token|secret' | head -c 200); [ -n "$e" ] && echo "[peer-environ $p] $e"; done
for p in $(pgrep -u axagent); do c=$(tr '\0' ' ' </proc/$p/cmdline 2>/dev/null | grep -oE 'token[^ ]* [^ ]+' | head -c 200); [ -n "$c" ] && echo "[peer-cmdline $p] $c"; done
try other-turn-files   ls -la /srv/agent/*/.turn
# use a stolen token (handed in by the driver to simulate a successful theft) from this turn's process ...
[ -n "${STOLEN:-}" ] && try stolen-same-session /usr/local/bin/bun /opt/mycel/tests/linux/usetoken.ts "$STOLEN"
# ... and from a process that escaped into its own session
[ -n "${STOLEN:-}" ] && try stolen-setsid setsid -w /usr/local/bin/bun /opt/mycel/tests/linux/usetoken.ts "$STOLEN"
# try the server's private socket directly (bypassing the gate)
try private-sock       /usr/local/bin/bun -e 'const c=require("net").createConnection("/run/mycel/private/server.sock");c.on("connect",()=>{console.log("CONNECTED");c.end()});c.on("error",e=>console.log("error",e.code))'
# leave an escapee behind; the launcher's reaper must kill it after the turn
setsid sleep 600 </dev/null >/dev/null 2>&1 &
echo "[escapee] started"

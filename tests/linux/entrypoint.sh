#!/bin/bash
# Runs as root only to set up folders and drop to the two service accounts.
set -euo pipefail
cd /
SRV_UID=$(id -u axserver); AG_UID=$(id -u axagent)
install -d -o axserver -g axserver -m 700 /srv/mycel            # team folder, DB, sessions: server only
install -d -o axagent  -g axagent  -m 700 /srv/agent            # chat folders: engine only
install -d -o axserver -g axserver -m 755 /run/mycel            # tools.sock lives here (gate checks the peer)
install -d -o axagent  -g axagent  -m 755 /run/mycel-launcher   # launcher.sock (launcher checks peer uid = axserver)
AS_AGENT="setpriv --reuid axagent --regid axagent --init-groups --inh-caps=-all env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/srv/agent"
AS_SERVER="setpriv --reuid axserver --regid axserver --init-groups --inh-caps=-all env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/axserver"
echo "ptrace_scope=$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo n/a)"
# the launcher: engine account, dedicated -> kills leftovers at start and reaps orphans between turns
$AS_AGENT $MYCEL_NATIVE_BIN/mycel-launcher --dedicated-account --server-uid "$SRV_UID" \
  --listen /run/mycel-launcher/launcher.sock --mode 0666 --agent-root /srv/agent \
  --bridge $MYCEL_NATIVE_BIN/mycel-bridge --tools-sock /run/mycel/tools.sock \
  --allow-cmd /usr/local/bin/bun >/tmp/launcher.log 2>&1 &
for i in $(seq 1 50); do [ -S /run/mycel-launcher/launcher.sock ] && break; sleep 0.1; done
# mallory (a person on the machine) must not reach the launcher either
MALLORY=$(setpriv --reuid mallory --regid mallory --init-groups env -i PATH=/usr/local/bin:/usr/bin:/bin bun -e '
const c=require("net").createConnection("/run/mycel-launcher/launcher.sock",()=>c.write(JSON.stringify({op:"tcp-peer",clientPort:1,serverPort:2})+"\n"));let b="";c.on("data",d=>b+=d);c.on("close",()=>console.log(b.trim()));c.on("error",e=>console.log("error "+e.code))')
echo "mallory->launcher: $MALLORY"; echo "launcher log: $(cat /tmp/launcher.log)"
$AS_SERVER MYCEL_WORK=/srv/mycel MYCEL_NATIVE_BIN=$MYCEL_NATIVE_BIN SERVER_SECRET=CANARY-SRVENV-5521 \
  AGENT_UID="$AG_UID" MALLORY_SAYS="$MALLORY" bun /opt/mycel/tests/linux/driver.ts

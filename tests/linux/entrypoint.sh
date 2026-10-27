#!/bin/bash
# Runs as root only to set up what the installer and systemd do in production, then drops to the two service accounts
# (linux-runtime spec 3.9.1, T1): a root-owned BASE with mycel-sandbox, mycel-ctl, sandbox-etc, firewall.conf.json and
# plan.json; the nftables table for the engine account; a cgroup delegated to the engine account by hand (what
# systemd's Delegate= does); the launcher in --sandbox bwrap mode; the driver (server account) in its own delegated
# cgroup for the converter cgroup check. Needs `docker run --privileged --cgroupns=private` (tests/linux/run.ts).
set -euo pipefail
cd /
SRV_UID=$(id -u axserver); AG_UID=$(id -u axagent); AG_GID=$(id -g axagent)
BIN=$MYCEL_NATIVE_BIN
BASE=/opt/mycel-test
PROXY_PORT=19176
install -d -o axserver -g axserver -m 700 /srv/mycel            # team folder, DB, sessions: server only
install -d -o axagent  -g axagent  -m 700 /srv/agent            # chat folders: engine only
install -d -o axagent  -g axagent  -m 700 /srv/agent/codex-auth # the engine account's Codex login (a stand-in)
install -d -o axserver -g axserver -m 755 /run/mycel            # tools.sock lives here (gate checks the peer)
install -d -o axagent  -g axagent  -m 755 /run/mycel-launcher   # launcher.sock (launcher checks peer uid = axserver)
echo '{"tokens":{"account_id":"acct-test","refresh_token":"CANARY-CODEXAUTH-REFRESH"}}' > /srv/agent/codex-auth/auth.json
chown axagent:axagent /srv/agent/codex-auth/auth.json; chmod 600 /srv/agent/codex-auth/auth.json
echo "ptrace_scope=$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo n/a)"

# Ubuntu 24.04 hosts (GitHub runners, the colima VM) restrict unprivileged user namespaces through AppArmor: allow
# them for bwrap only, the way install-linux.sh does (spec 3.5.1 step 4), and remove the profile again at exit
AA_PROFILE=""
# Only when bwrap really cannot make a user namespace as an unprivileged account: AppArmor policy is global to the
# kernel, and two profiles attached to /usr/bin/bwrap (another test container's, or an installed tenant's on the same
# host) make the attachment ambiguous so neither applies. Same rule as install-linux.sh step 4.
bwrap_ok() { setpriv --reuid nobody --regid nogroup --clear-groups bwrap --unshare-user --ro-bind / / /bin/true >/dev/null 2>&1; }
if ! bwrap_ok && [[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" == 1 ]]; then
  mountpoint -q /sys/kernel/security || mount -t securityfs securityfs /sys/kernel/security
  AA_PROFILE=/tmp/mycel-t1-bwrap
  printf 'abi <abi/4.0>,\ninclude <tunables/global>\nprofile mycel-t1-bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n}\n' > $AA_PROFILE
  apparmor_parser -r $AA_PROFILE
  trap 'apparmor_parser -R $AA_PROFILE 2>/dev/null || true' EXIT
fi
bwrap_ok || { echo "bwrap cannot create a user namespace for an unprivileged account (AppArmor / sysctl); T1 needs it"; exit 1; }

# BASE/root and BASE/run as the installer leaves them (root-owned, spec 3.1.1)
install -d -o root -g root -m 755 $BASE $BASE/root $BASE/run $BASE/root/sandbox-etc
install -o root -g root -m 755 $BIN/mycel-sandbox $BIN/mycel-ctl $BASE/root/
E=$BASE/root/sandbox-etc
printf 'root:x:0:0::/:/usr/sbin/nologin\naxagent:x:%s:%s::/nonexistent:/usr/sbin/nologin\n' "$AG_UID" "$AG_GID" > $E/passwd
printf 'root:x:0:\naxagent:x:%s:\n' "$AG_GID" > $E/group
printf '127.0.0.1 localhost\n::1 localhost\n' > $E/hosts
printf 'passwd: files\ngroup: files\nhosts: files\n' > $E/nsswitch.conf
: > $E/empty; install -d -m 555 $E/empty.d; chmod 644 $E/passwd $E/group $E/hosts $E/nsswitch.conf $E/empty
cat > $BASE/root/firewall.conf.json <<EOF
{"format":1,"id":"mycel-test","engineUid":$AG_UID,"serverUid":$SRV_UID,"proxyPort":$PROXY_PORT,"serverPort":19174,"deployment":"self","serverAllowPrivate":[]}
EOF
# a small plan: 2 turns at once, 2 GiB -> turn memory.max 800 MiB (spec 3.8.5 Basic row)
cat > $BASE/root/plan.json <<'EOF'
{"format":1,"plan":"basic","maxConcurrency":2,"memoryMiB":2048,"cpuCores":2,"diskGiB":20,"reserveMiB":768,"turnMemoryMaxMiB":null,"turnPidsMax":256,"turnDiskMaxMiB":1024,"readMaxMiB":64,"convMemoryMaxMiB":null,"localBackupRetentionDays":3,"updatedAt":"2026-10-22T00:00:00Z"}
EOF
chmod 644 $BASE/root/*.json
FW_OUT=$($BASE/root/mycel-ctl firewall apply --base $BASE 2>&1) || { echo "firewall apply failed: $FW_OUT"; exit 1; }
echo "firewall: $(cat $BASE/run/firewall.json | tr -d '\n ')"

# root-owned loopback listeners so the firewall checks tell "blocked by nft" apart from "nothing listening": 19174
# (server API) and 19190 (another tenant service) have a listener but nft rejects the engine account's connection to
# them. 19176 (the model proxy's place, the only port the engine account may reach) is the driver's: a stand-in
# listener first, then the real model proxy of the managed turns.
for port in 19174 19190; do
  bun -e 'Bun.listen({hostname:"127.0.0.1",port:'"$port"',socket:{open(s){s.write("ok");s.end()},data(){},error(){}}})' >/dev/null 2>&1 &
done
sleep 0.3

# cgroups by hand (what systemd's Delegate= gives the two units): the container's processes move to init/, then
# launcher/ belongs to the engine account and server/ to the server account
CG=/sys/fs/cgroup
mkdir -p $CG/init
for p in $(cat $CG/cgroup.procs); do echo "$p" > $CG/init/cgroup.procs 2>/dev/null || true; done
echo "+memory +pids +cpu" > $CG/cgroup.subtree_control
for d in launcher:axagent server:axserver; do
  dir=$CG/${d%%:*}; mkdir -p "$dir"
  chown "${d#*:}:${d#*:}" "$dir" "$dir/cgroup.procs" "$dir/cgroup.subtree_control" "$dir/cgroup.threads"
done

# test control: the driver (server account) asks root to take the firewall status away and back (fail-closed check)
install -d -o axserver -g axserver -m 755 /run/test-ctl
( while true; do
    if [[ -e /run/test-ctl/fw-off ]]; then mv $BASE/run/firewall.json $BASE/run/firewall.json.off; rm -f /run/test-ctl/fw-off; touch /run/test-ctl/fw-off.done; fi
    if [[ -e /run/test-ctl/fw-on ]]; then $BASE/root/mycel-ctl firewall apply --base $BASE >/dev/null 2>&1; rm -f /run/test-ctl/fw-on; touch /run/test-ctl/fw-on.done; fi
    sleep 0.2
  done ) &

AS_AGENT="setpriv --reuid axagent --regid axagent --init-groups --inh-caps=-all env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/srv/agent"
AS_SERVER="setpriv --reuid axserver --regid axserver --init-groups --inh-caps=-all env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/axserver"
# the launcher: engine account, dedicated (kills leftovers at start, reaps orphans), every turn in bwrap
( echo $BASHPID > $CG/launcher/cgroup.procs
  exec $AS_AGENT $BIN/mycel-launcher --dedicated-account --server-uid "$SRV_UID" \
    --listen /run/mycel-launcher/launcher.sock --mode 0666 --agent-root /srv/agent \
    --bridge $BIN/mycel-bridge --tools-sock /run/mycel/tools.sock \
    --sandbox bwrap --bwrap /usr/bin/bwrap --sandbox-helper $BASE/root/mycel-sandbox --sandbox-etc $BASE/root/sandbox-etc \
    --ca-bundle /etc/ssl/certs/ca-certificates.crt --landlock best-effort --proxy-port $PROXY_PORT \
    --codex-auth-dir /srv/agent/codex-auth --firewall-status $BASE/run/firewall.json --plan-file $BASE/root/plan.json \
    --cgroup required --turn-disk-max 67108864 \
    --allow-cmd /opt/fake-engine/bun --allow-cmd /opt/fake-engine/claude --allow-cmd /opt/fake-engine/codex ) >/tmp/launcher.log 2>&1 &
for i in $(seq 1 100); do grep -q ready /tmp/launcher.log 2>/dev/null && break; sleep 0.1; done  # listening, not just bound
# mallory (a person on the machine) must not reach the launcher either
MALLORY=$(setpriv --reuid mallory --regid mallory --init-groups env -i PATH=/usr/local/bin:/usr/bin:/bin bun -e '
const c=require("net").createConnection("/run/mycel-launcher/launcher.sock",()=>c.write(JSON.stringify({op:"tcp-peer",clientPort:1,serverPort:2})+"\n"));let b="";c.on("data",d=>b+=d);c.on("close",()=>console.log(b.trim()));c.on("error",e=>console.log("error "+e.code))')
echo "mallory->launcher: $MALLORY"; echo "launcher log: $(cat /tmp/launcher.log)"
( echo $BASHPID > $CG/server/cgroup.procs
  exec $AS_SERVER MYCEL_WORK=/srv/mycel MYCEL_NATIVE_BIN=$BIN SERVER_SECRET=CANARY-SRVENV-5521 \
    AGENT_UID="$AG_UID" MALLORY_SAYS="$MALLORY" MYCEL_FAKE_ENGINE_DIR=/opt/fake-engine MYCEL_SANDBOX_HELPER=$BASE/root/mycel-sandbox \
    MYCEL_T1_BASE=$BASE MYCEL_T1_CGROUP=$CG PROBE_PROXY_PORT=$PROXY_PORT bun /opt/mycel/tests/linux/driver.ts )

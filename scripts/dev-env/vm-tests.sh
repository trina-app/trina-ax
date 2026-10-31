#!/bin/bash
# Isolation and limit tests of mycel-boxd on the dev-env-test VM (after vm-setup.sh). Run as root ON THE TEST VM ONLY.
#   scripts/dev-env/vm-tests.sh            (LONG=1 also waits for the idle stop, about 6 minutes)
# Output: PASS/FAIL lines and numbers; save it as results/vm-<date>.txt.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
S=/run/mycel-boxd/boxd.sock
T=/srv/mycel/team
ctl() { runuser -u mycel -- python3 -I "$HERE/boxctl.py" "$S" "$@"; }
export -f ctl; export HERE S
x() { ctl exec web "$@"; }                     # exec in the web box
pass() { echo "PASS $*"; }; fail() { echo "FAIL $*"; }
ok() { if "$@" >/dev/null 2>&1; then pass "$D"; else fail "$D"; fi; }
no() { if "$@" >/dev/null 2>&1; then fail "$D"; else pass "$D"; fi; }
LIM='{"cpus":1,"memoryMiB":1536,"pids":512,"diskGiB":4,"idleStopMin":5}'
VMIP=$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')
ens() { ctl "{\"op\":\"ensure\",\"box\":\"$1\",\"folder\":\"$2\",\"network\":\"$3\",\"limits\":$LIM,\"denyAddrs\":[\"$VMIP\"]}"; }

# preflight (run 1 of 2026-10-31 failed here): the server stand-in must read the repo (clone it under /opt, not
# /root), and /usr/bin/time must exist (Debian package "time")
runuser -u mycel -- test -r "$HERE/boxctl.py" || { echo "STOP: mycel cannot read $HERE (clone the repo under /opt, not /root)"; exit 2; }
[ -x /usr/bin/time ] || { echo "STOP: /usr/bin/time is missing (apt-get install time)"; exit 2; }
[ -S "$S" ] || { echo "STOP: no boxd socket at $S (run vm-setup.sh)"; exit 2; }

echo "== status"; ctl '{"op":"status"}'
echo "== start"
t0=$(date +%s.%N); D="ensure web (open)"; ok ens web projects/web open; echo "start s: $(echo "$(date +%s.%N) - $t0" | bc)"
D="a second box while one runs (max-running 1)"; no ens other projects/other open
ln -sfn web $T/projects/weblink; D="folder through a link"; no ens web2 projects/weblink open; rm -f $T/projects/weblink
D="folder outside the team root"; no ens web3 ../../etc open

echo "== isolation probe (inside)"; x "$(cat "$HERE/in-box/isolation.sh")" 120

echo "== files"
x 'echo hi > /work/from-box.txt && sed -i s/hi/hello/ /work/from-box.txt && cp -p /work/from-box.txt /work/copy.txt' >/dev/null
D="box file stored as the server account"; ok test "$(stat -c %U $T/projects/web/from-box.txt)" = mycel
D="sed -i and cp -p work"; ok grep -q hello $T/projects/web/copy.txt
x 'mkdir -p /work/node_modules/x && echo 1 > /work/node_modules/x/f' >/dev/null
D="node_modules stays in the box volume"; ok test ! -e $T/projects/web/node_modules/x/f
# a bind mount always shows its source path inside its file system in mountinfo (field 4); it cannot be hidden.
# The box state paths must not show; the folder's own path is a known, documented leak (put the team root on its own
# file system to shorten it to the path below the team root).
D="box state paths not in mountinfo"; no x 'grep -q mycel-boxd /proc/self/mountinfo'
echo "KNOWN folder path seen in the box: $(x "awk '\$5==\"/work\" {print \$4}' /proc/self/mountinfo" 2>/dev/null)"

echo "== network (open)"
D="internet https"; ok x 'curl -fsS -m 10 -o /dev/null https://example.com' 20
D="LAN 10.99.0.1"; no x 'curl -fsS -m 4 http://10.99.0.1/' 10
D="metadata 169.254.169.254"; no x 'curl -fsS -m 4 http://169.254.169.254/' 10
D="team server on the VM address :8080"; no x "curl -fsS -m 4 http://$VMIP:8080/" 10
D="SMTP 25"; no x 'timeout 5 bash -c "echo > /dev/tcp/smtp.gmail.com/25"' 10
D="change the box rules"; no x 'nft flush ruleset' 10
D="destination log (netlog) has example.com's address"; ok sh -c "runuser -u mycel -- python3 -I $HERE/boxctl.py $S '{\"op\":\"netlog\",\"box\":\"web\"}' | grep -q ':443'"

echo "== exec control"
D="time limit"; ok sh -c "runuser -u mycel -- python3 -I $HERE/boxctl.py $S exec web 'sleep 30' 2 2>&1 | grep -q 'timeout'"
runuser -u mycel -- timeout 3 python3 -I "$HERE/boxctl.py" "$S" exec web 'sleep 300' 600 >/dev/null 2>&1
sleep 2; D="a stopped command is killed in the box"; no bash -c "ctl '{\"op\":\"ps\",\"box\":\"web\"}' | grep -q 'sleep 300'"
ctl "{\"op\":\"exec\",\"box\":\"web\",\"command\":\"python3 -m http.server 8000 --bind 127.0.0.1\",\"timeoutMs\":10000,\"background\":true,\"logName\":\"web\",\"actor\":\"vm\"}" >/dev/null
sleep 1; D="background dev server listed"; ok bash -c "ctl '{\"op\":\"ps\",\"box\":\"web\"}' | grep -q http.server"
P=$(ctl '{"op":"preview","box":"web","port":8000}' | jq -r .socket)
D="preview socket owned by the server account, 0600"; ok test "$(stat -c '%U %a' "$P")" = "mycel 600"
D="preview through the socket"; ok runuser -u mycel -- curl -fsS --unix-socket "$P" -H 'Host: localhost' http://localhost/
D="preview socket refused to another account"; no runuser -u nobody -- curl -fsS --unix-socket "$P" http://localhost/

echo "== limits"
r=$(x 'python3 -c "b=[]
while True: b.append(bytearray(64<<20))"' 60 2>&1 | tail -1); echo "memory bomb: $r"; D="memory bomb ends as oom"; ok sh -c "echo '$r' | grep -q oom"
r=$(x 'n=0; for i in $(seq 1 2000); do sleep 30 2>/dev/null & [ $? -ne 0 ] && n=$((n+1)); done 2>/dev/null; echo "procs $(ls /proc | grep -c "^[0-9]")"; pkill -f "^sleep 30$"; true' 60 2>&1 | head -1); echo "fork flood: $r"
D="box survives the process flood"; ok x 'true' 10
D="pids limit holds (at most 512 processes)"; ok bash -c "[ \"\$(echo '$r' | grep -o '[0-9]*\$')\" -le 512 ]"
# a command that ends the box's main process stops the box; the next exec says box_stopped and ensure starts it again
x 'pkill -f "^sleep infinity$"; true' 10 >/dev/null 2>&1; sleep 2
D="exec after the main process was killed says box_stopped"; ok bash -c "runuser -u mycel -- python3 -I $HERE/boxctl.py $S exec web 'true' 10 2>&1 | grep -q box_stopped"
D="ensure starts the stopped box again"; ok ens web projects/web open
D="exec works again"; ok x 'true' 10
x 'timeout 10 sh -c "while :; do :; done & while :; do :; done & wait"; true' 20 >/dev/null 2>&1 &
sleep 5; echo "host while CPU burn: $( { /usr/bin/time -f %e sh -c 'ls / >/dev/null'; } 2>&1 )"; wait
r=$(x 'dd if=/dev/zero of=/cache/fill bs=1M 2>&1 | tail -1; rm -f /cache/fill' 300 2>&1); echo "volume fill: $r"; D="volume full stops at its size"; ok sh -c "echo '$r' | grep -q 'No space'"

echo "== offline"
D="network change restarts the box offline"; ok ctl "{\"op\":\"ensure\",\"box\":\"web\",\"folder\":\"projects/web\",\"network\":\"offline\",\"limits\":$LIM,\"denyAddrs\":[]}"
D="offline: no internet"; no x 'curl -fsS -m 5 -o /dev/null https://example.com' 10

if [ "${LONG:-0}" = 1 ]; then echo "== idle stop (6 min)"; sleep 370; D="idle box stopped"; ok bash -c "ctl '{\"op\":\"status\"}' | jq -e '.boxes[] | select(.box==\"web\") | .state==\"stopped\"'"; fi
echo "== teardown"; ctl '{"op":"destroy","box":"web"}'
D="no mounts left"; no grep -q mycel-boxd /proc/self/mountinfo

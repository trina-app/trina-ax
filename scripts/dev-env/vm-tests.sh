#!/bin/bash
# Isolation and limit tests of mycel-boxd on the dev-env-test VM (after vm-setup.sh). Run as root ON THE TEST VM ONLY.
#   scripts/dev-env/vm-tests.sh            (LONG=1 also waits for the idle stop, about 6 minutes;
#                                           REMOTION=1 also installs Remotion and renders a video, about 2 minutes;
#                                           JOBS=1 also tests jobs, planted links and the disk floor, about 3 minutes;
#                                           JOBS=1 LONG=1 also tests CPU as activity, about 20 minutes more)
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
LIM='{"cpus":1,"memoryMiB":2560,"pids":512,"diskGiB":4,"idleStopMin":5}'
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
# the flood forks until the kernel says no and ends its own children. A bash loop cannot do this test: bash gives up on
# fork errors after 15 s (exit 254) and leaves its children, so nothing can enter the box until they end (2026-11-01).
r=$(x "$(cat "$HERE/in-box/flood.sh")" 60 2>&1); echo "fork flood: $r"
n=$(sed -n 's/^forked \([0-9]*\).*/\1/p' <<<"$r"); D="pids limit stops the flood (at most 512 processes)"; ok test "${n:-0}" -gt 100 -a "${n:-0}" -le 512
D="box survives the process flood"; ok x 'true' 10
# keep the box at its limit: nothing can enter it, so boxd stops it after 5 s and says why
ctl "$(jq -nc --arg c "HOLD=30"$'\n'"$(cat "$HERE/in-box/flood.sh")" '{op:"exec",box:"web",command:$c,timeoutMs:10000,background:true,logName:"flood",actor:"vm"}')" >/dev/null
sleep 3
D="exec at the process limit: the box stops and says why"; ok bash -c "runuser -u mycel -- python3 -I $HERE/boxctl.py $S exec web 'true' 10 2>&1 | grep -q 'box_stopped: the box stopped because it stayed at its process limit'"
D="ensure starts the box after the process limit"; ok ens web projects/web open
D="exec works after the process limit"; ok x 'true' 10
# a command that ends the box's main process stops the box; the next exec says box_stopped and ensure starts it again
x 'pkill -f "^sleep infinity$"; true' 10 >/dev/null 2>&1; sleep 2
D="exec after the main process was killed says box_stopped"; ok bash -c "runuser -u mycel -- python3 -I $HERE/boxctl.py $S exec web 'true' 10 2>&1 | grep -q box_stopped"
D="ensure starts the stopped box again"; ok ens web projects/web open
D="exec works again"; ok x 'true' 10
x 'timeout 10 sh -c "while :; do :; done & while :; do :; done & wait"; true' 20 >/dev/null 2>&1 &
sleep 5; echo "host while CPU burn: $( { /usr/bin/time -f %e sh -c 'ls / >/dev/null'; } 2>&1 )"; wait
r=$(x 'dd if=/dev/zero of=/cache/fill bs=1M 2>&1; rm -f /cache/fill' 300 2>&1); echo "volume fill: $r"
D="volume full stops with No space left"; ok grep -q 'No space left on device' <<<"$r"
n=$(sed -n 's/^\([0-9]*\) bytes.*/\1/p' <<<"$r"); D="volume full stops at its size (at most 4 GiB)"; ok test "${n:-0}" -gt 3000000000 -a "${n:-0}" -le 4294967296

# Video render in the limits above (open network: npm and Chrome downloads). in-box/remotion.sh also prints its numbers.
if [ "${REMOTION:-0}" = 1 ]; then
  echo "== remotion (5 s, 720p)"
  r=$(x "$(cat "$HERE/in-box/remotion.sh")" 1500 2>&1); echo "$r"
  D="remotion: Chrome finds its libraries"; ok grep -q 'chrome_missing_libraries none' <<<"$r"
  D="remotion: a font with Hangul in the image"; no grep -q 'fonts_with_hangul 0 ' <<<"$r"
  D="remotion: no OOM kill during the render"; ok grep -q 'oom_kills 0$' <<<"$r"
  D="remotion: 1280x720, 150 frames"; ok grep -q 'video h264,1280,720,150' <<<"$r"
  D="remotion: render ended well"; ok grep -q 'result ok$' <<<"$r"
  D="box survives the render"; ok x 'true' 10
fi

# A rebuild keeps the name and changes the ID. The commit does the same in a second. A running box keeps its image; at
# its next start it takes the new one (the labels in mycel-boxd, not the name, decide this).
echo "== new image under the same name"
pod() { (cd / && runuser -u mycel-devbox -- env XDG_RUNTIME_DIR="/run/user/$(id -u mycel-devbox)" podman "$@"); }
img0=$(pod image inspect -f '{{.Id}}' localhost/mycel-devbox:1)
pod commit -q -c "LABEL mycel.test=$(date +%s)" mycel-box-web localhost/mycel-devbox:1 >/dev/null
img1=$(pod image inspect -f '{{.Id}}' localhost/mycel-devbox:1)
D="the commit gave the image a new ID"; no test "$img0" = "$img1"
ens web projects/web open >/dev/null
D="a new image does not stop a running box"; ok test "$(pod inspect -f '{{.Image}}' mycel-box-web)" = "$img0"
ctl '{"op":"stop","box":"web"}' >/dev/null
ens web projects/web open >/dev/null
D="a box takes the new image at its next start"; ok test "$(pod inspect -f '{{.Image}}' mycel-box-web)" = "$img1"
pod tag "$img0" localhost/mycel-devbox:1 # the built image goes back: the commit holds the state of this box

# NOT YET RUN (written 2026-11-02, with no VM): every step in this block. The Go and bun tests cover the pure decisions
# and the server with a fake boxd; only these steps show the real box, the real cgroup and the real disk.
if [ "${JOBS:-0}" = 1 ]; then
  job() { ctl "$(jq -nc --arg n "$1" --arg c "$2" '{op:"exec",box:"web",command:$c,timeoutMs:20000,background:true,job:true,logName:$n,actor:"vm"}')"; }
  jobsj() { ctl '{"op":"jobs","box":"web"}'; }
  jobq() { jobsj | jq -e --arg n "$1" ".jobs[] | select(.name==\$n) | $2" >/dev/null; }
  statusq() { ctl '{"op":"status"}' | jq -e ".boxes[] | select(.box==\"web\") | $1" >/dev/null; }
  export -f job jobsj jobq statusq
  ens web projects/web open >/dev/null

  echo "== jobs (NOT YET RUN)"
  job exit7 'echo start; sleep 2; echo last-line; exit 7'
  D="a job that runs shows as running"; ok jobq exit7 '.state=="running" and .code==null'
  sleep 4
  # the VM has no server, only boxctl as its stand-in: tests/unit/dev-env-jobs.test.ts covers the server after this answer
  D="a job's exit reaches the server (stand-in)"; ok jobq exit7 '.state=="ended" and .code==7'
  D="the jobs answer has the log tail and the last line"; ok jobq exit7 '.lastLine=="last-line" and (.tail | contains("start"))'
  D="a job of a name that still runs is refused"; job twin 'sleep 20' >/dev/null; no job twin 'sleep 20'
  x 'pkill -9 -f "/cache/run/twin.sh"; pkill -9 -f "^sleep 20$"; true' 10 >/dev/null 2>&1; sleep 1
  D="a killed job ends with no exit code"; ok jobq twin '.state=="ended" and .code==null'
  D="ffmpeg-style progress with carriage returns gives a last line"; job progress 'printf "frame=1\\rframe=2\\rframe=3\\r"' >/dev/null; sleep 2; ok jobq progress '.lastLine=="frame=3"'
  a0=$(ctl '{"op":"status"}' | jq -r '.boxes[] | select(.box=="web") | .lastActiveAt'); sleep 2; jobsj >/dev/null
  D="the jobs op is not activity"; ok statusq ".lastActiveAt == \"$a0\""

  # boxd is root, the box writes the volume: a link must not make root read a host file. The canary is root's.
  # after the existing `pkill sleep infinity` step boxd stops such a box by itself; here with no exec after it
  x 'pkill -f "^sleep infinity$"; true' 10 >/dev/null 2>&1; sleep 3
  D="status keeps working for a box that stopped by itself"; ok statusq '.state=="stopped" and .stopCode=="exited"'
  ens web projects/web open >/dev/null

  echo "== planted links (NOT YET RUN)"
  C=/root/boxd-canary-$$; mkdir -p "$C"; echo "CANARY-$$" > "$C/planted.log"; echo 7 > "$C/planted.exit"; chmod 700 "$C"
  job planted "HOST=$C"$'\n'"$(cat "$HERE/in-box/plant-links.sh")" >/dev/null
  sleep 3 # phase 1: links at x.exit and x.log, to files of the host
  r=$(jobsj); D="a link at x.exit and x.log does not reach a host file"; no grep -q "CANARY-$$" <<<"$r"
  D="the job with a linked exit file still runs (no exit code read through the link)"; ok jobq planted '.state=="running"'
  sleep 6 # phase 2: /cache/logs itself is a link to a host folder
  r=$(jobsj); D="a linked logs folder does not reach a host file"; no grep -q "CANARY-$$" <<<"$r"
  D="a linked logs folder gives no exit code"; ok jobq planted '.state=="running"'
  sleep 6 # phase 3: a FIFO at x.exit
  D="a FIFO at x.exit does not stop boxd"; ok timeout 5 runuser -u mycel -- python3 -I "$HERE/boxctl.py" "$S" '{"op":"jobs","box":"web"}'
  D="boxd still answers after the FIFO"; ok timeout 5 runuser -u mycel -- python3 -I "$HERE/boxctl.py" "$S" '{"op":"status"}'
  sleep 8; rm -rf "$C"

  # Fill the team disk from a background job, not /cache: the box volume has its own limit. The box has no fallocate, so
  # the host gets near the floor at once, and dd in the box then writes at disk speed, so the time from the floor to the
  # stop is the real one.
  echo "== disk floor (NOT YET RUN)"
  F=$T/projects/web/fill.bin; P=$T/projects/web/fill-host.bin; trap 'rm -f "$F" "$P"' EXIT
  D="fallocate is refused in the box (it takes space faster than the disk watchdog)"; no x 'fallocate -l 1M /work/fa.bin' 10
  D="FS_IOC_RESVSP64 is refused in the box (it does what fallocate does)"; no x 'python3 -c "import fcntl, struct; f = open(\"/work/fa.bin\", \"wb\"); fcntl.ioctl(f, 0x4030582a, struct.pack(\"hhqqiI4i\", 0, 0, 0, 1 << 20, 0, 0, 0, 0, 0, 0))"' 10
  D="other ioctls work in the box"; ok x 'python3 -c "import fcntl, os, termios; r, w = os.pipe(); fcntl.ioctl(r, termios.FIONREAD, bytes(4))"' 10
  D="posix_fallocate in the box falls back to writes"; ok x 'python3 -c "import os; f = open(\"/work/fa.bin\", \"wb\"); os.posix_fallocate(f.fileno(), 0, 1 << 20)"; rm -f /work/fa.bin' 20
  read -r avail size <<<"$(df -B1 --output=avail,size "$T" | tail -1)"
  G=$((1<<30)); floor=$((size / 100 * 5)); [ "$floor" -lt $((2*G)) ] && floor=$((2*G))
  fill=$((avail - floor - G)); echo "avail $avail size $size floor $floor fill first $fill"
  if [ "$fill" -gt 0 ]; then
    fallocate -l "$fill" "$P"
    job fill "$(cat "$HERE/in-box/disk-fill.sh")" >/dev/null
    t0=$(date +%s); for i in $(seq 1 180); do statusq '.state=="stopped"' && break; sleep 1; done; echo "stopped after $(( $(date +%s) - t0 )) s"
    D="the box stops at the disk floor"; ok statusq '.state=="stopped" and .stopCode=="disk"'
    D="status says how to free space"; ok statusq '.stopReason | contains("Free space")'
    left=$(df -B1 --output=avail "$T" | tail -1 | tr -d ' '); echo "free after the stop: $left, floor $floor, past the floor: $((floor - left)) bytes"
    D="the stop comes at most 500 MB past the floor"; ok test $((floor - left)) -le $((500 * 1024 * 1024))
    D="the job of a stopped box shows why it ended"; ok jobq fill '.state=="ended" and .code==null and (.why | contains("server disk"))'
    D="exec after the stop says box_stopped with the reason"; ok bash -c "runuser -u mycel -- python3 -I $HERE/boxctl.py $S exec web 'true' 10 2>&1 | grep -q 'box_stopped: the server disk'"
    r=$(ens web projects/web open 2>&1); D="ensure refuses under the floor plus the margin, with the reason"; ok grep -q 'server disk' <<<"$r"
    rm -f "$F" "$P"
    D="ensure starts the box after the space is free"; ok ens web projects/web open
  else
    echo "SKIP disk floor: the disk is already near the floor"
  fi
  trap - EXIT

  if [ "${LONG:-0}" = 1 ]; then
    cgof() { echo "/sys/fs/cgroup$(pod inspect -f '{{.State.CgroupPath}}' mycel-box-web)"; }
    echo "== CPU as activity (NOT YET RUN; idle time 5 minutes)"
    ctl '{"op":"stop","box":"web"}' >/dev/null; ens web projects/web open >/dev/null
    job render 'timeout 420 sh -c "while :; do :; done"; echo rendered' >/dev/null
    sleep 400
    D="a render longer than the idle time survives (no command for 6.5 minutes)"; ok statusq '.state=="running"'
    sleep 40
    D="its job ended by itself"; ok jobq render '.state=="ended" and .code==0'
    sleep 460 # the idle check runs once a minute, so the last busy reading can come a minute after the render
    D="after the render the box stops after its idle time"; ok statusq '.state=="stopped" and .stopCode=="idle"'
    ens web projects/web open >/dev/null
    ctl '{"op":"exec","box":"web","command":"python3 -m http.server 8000 --bind 127.0.0.1","timeoutMs":10000,"background":true,"logName":"idle-dev","actor":"vm"}' >/dev/null
    sleep 30; cg=$(cgof); u0=$(awk '/^usage_usec/ {print $2}' "$cg/cpu.stat"); sleep 60; u1=$(awk '/^usage_usec/ {print $2}' "$cg/cpu.stat")
    echo "idle dev server CPU: $(( (u1 - u0) / 600000 ))% of a core (the threshold is 10%)"
    sleep 370
    D="an idle dev server still stops"; ok statusq '.state=="stopped" and .stopCode=="idle"'
    ens web projects/web open >/dev/null
  fi
fi

echo "== offline"
D="network change restarts the box offline"; ok ctl "{\"op\":\"ensure\",\"box\":\"web\",\"folder\":\"projects/web\",\"network\":\"offline\",\"limits\":$LIM,\"denyAddrs\":[]}"
D="offline: no internet"; no x 'curl -fsS -m 5 -o /dev/null https://example.com' 10

if [ "${LONG:-0}" = 1 ]; then echo "== idle stop (6 min)"; sleep 370; D="idle box stopped"; ok bash -c "ctl '{\"op\":\"status\"}' | jq -e '.boxes[] | select(.box==\"web\") | .state==\"stopped\"'"; fi
echo "== teardown"; ctl '{"op":"destroy","box":"web"}'
D="no mounts left"; no grep -q mycel-boxd /proc/self/mountinfo

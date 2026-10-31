#!/bin/bash
# Resource abuse in a box, watched from the host (run as the devbox account): fork bomb, memory bomb, CPU burn,
# disk fills. Each step reports what the box reached and how the host answered meanwhile (host_ms = time of a small
# host command during the attack). The box is killed and started again after the fork bomb.
#   bombs.sh BOX
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
B="$HERE/box.sh"; b=$1
cg=$("$B" cgroup "$b")
host_ms() { local t0=$(date +%s%N); ls / >/dev/null; python3 -c 'pass'; echo $(( ($(date +%s%N) - t0) / 1000000 )); }
echo "{\"step\": \"host-baseline\", \"host_ms\": $(host_ms), \"load\": \"$(cut -d' ' -f1-3 /proc/loadavg)\"}"

# fork bomb
podman exec -d "box-$b" bash -c ':(){ :|:& };:' >/dev/null
mx=0; worst=0
for i in $(seq 1 15); do
  sleep 1; p=$(cat "$cg/pids.current"); [ "$p" -gt "$mx" ] && mx=$p
  h=$(host_ms); [ "$h" -gt "$worst" ] && worst=$h
done
ev=$(grep max "$cg/pids.events" | cut -d' ' -f2)
echo "{\"step\": \"fork-bomb-15s\", \"pids_max_seen\": $mx, \"pids_limit\": $(cat "$cg/pids.max"), \"pids_max_events\": $ev, \"host_ms_worst\": $worst, \"load\": \"$(cut -d' ' -f1-3 /proc/loadavg)\"}"
t0=$(date +%s%N); podman kill "box-$b" >/dev/null 2>&1; podman wait "box-$b" >/dev/null 2>&1
echo "{\"step\": \"fork-bomb-kill-box\", \"ms\": $(( ($(date +%s%N) - t0) / 1000000 ))}"
"$B" start "$b" >/dev/null; cg=$("$B" cgroup "$b")

# memory bomb: grow by 64 MB until killed
o0=$(grep oom_kill "$cg/memory.events" | cut -d' ' -f2)
podman exec "box-$b" python3 -c '
import time
a = []
while True:
    a.append(bytearray(64 << 20)); time.sleep(0.05)' >/dev/null 2>&1; rc=$?
o1=$(grep oom_kill "$cg/memory.events" | cut -d' ' -f2)
echo "{\"step\": \"memory-bomb\", \"rc\": $rc, \"oom_kills\": $((o1 - o0)), \"memory_max_mb\": $(( $(cat "$cg/memory.max") / 1048576 )), \"swap_max\": \"$(cat "$cg/memory.swap.max")\", \"host_ms\": $(host_ms)}"

# CPU burn: 4 busy loops for 10 s, limit is cpu.max
read -r _ u0 < <(grep usage_usec "$cg/cpu.stat"); t0=$(date +%s%N)
podman exec "box-$b" sh -c 'for i in 1 2 3 4; do timeout 10 sh -c "while :; do :; done" & done; wait' >/dev/null 2>&1
read -r _ u1 < <(grep usage_usec "$cg/cpu.stat"); w=$(( ($(date +%s%N) - t0) / 1000 ))
echo "{\"step\": \"cpu-burn-4x10s\", \"cpus_used\": $(echo "scale=2; ($u1 - $u0) / $w" | bc), \"cpu_max\": \"$(cat "$cg/cpu.max")\", \"nr_throttled\": $(grep nr_throttled "$cg/cpu.stat" | cut -d' ' -f2), \"host_ms\": $(host_ms)}"

# disk: box volume (xfs loop file system), /tmp (tmpfs), the team folder (bind mount)
podman exec "box-$b" sh -c '
fallocate -l 20G /cache/big 2>&1 | tail -1 | sed "s/^/fallocate 20G: /"; rm -f /cache/big
dd if=/dev/zero of=/cache/fill bs=1M 2>&1 | tail -1 | sed "s/^/cache fill: /"; df -h /cache | tail -1 | sed "s/^/cache df: /"; rm -f /cache/fill
dd if=/dev/zero of=/tmp/fill bs=1M 2>&1 | tail -1 | sed "s/^/tmp fill: /"; rm -f /tmp/fill
dd if=/dev/zero of=/work/fill bs=1M count=512 2>&1 | tail -1 | sed "s/^/work 512 MB (not filled on purpose): /"
df -h /work | tail -1 | sed "s/^/work df: /"; rm -f /work/fill' 2>&1 | sed 's/^/disk: /'
echo "{\"step\": \"after\", \"host_ms\": $(host_ms), \"load\": \"$(cut -d' ' -f1-3 /proc/loadavg)\"}"

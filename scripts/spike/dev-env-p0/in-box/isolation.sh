#!/bin/sh
# Isolation probe, run inside a box (directly, or as the Bash command of an AI turn). PASS = the box cannot do it.
# The fork bomb, memory bomb and disk fills run from bombs.sh (they need the host side to watch and clean up).
p() { echo "PASS $1"; }; f() { echo "FAIL $1"; }
chk() { if sh -c "$2" >/dev/null 2>&1; then f "$1"; else p "$1"; fi; }   # PASS when the command fails

echo "-- what is mounted (sources other than overlay/tmpfs/proc/sys/dev)"
awk '{print $5, $4}' /proc/self/mountinfo | grep -vE '^/(proc|sys|dev)' | sort
echo "-- files"
chk "other team folder by host path" "ls /srv/trina/teams/other-team-folder"
chk "server secrets by host path" "cat /srv/trina/secrets/claude-oauth-token"
chk "Mac home mount (/Users, /mnt/mac)" "ls /Users/* || ls /mnt/mac/*"
chk "podman socket / storage of the box account" "ls /run/user/*/podman /home/devbox/.local/share/containers"
chk "host root through /proc/1/root" "ls /proc/1/root/srv/trina"
chk "write the image (/usr/bin)" "touch /usr/bin/x"
chk "write /etc" "touch /etc/x"
chk "other team folder in the box's own folder tree" "ls /work/../other-team-folder"
timeout 60 grep -qs 'TOP SECRET' -r / --include=secret.txt --exclude-dir=proc --exclude-dir=sys && f "find other folder's file anywhere" || p "find other folder's file anywhere"
echo "-- kernel surface"
grep -E '^(CapEff|CapPrm|CapBnd|NoNewPrivs|Seccomp):' /proc/self/status
chk "new user namespace (unshare -Ur)" "unshare -Ur true"
chk "new mount namespace (unshare -m)" "unshare -m true"
chk "mount tmpfs" "mount -t tmpfs x /tmp"
chk "read the kernel log" "dmesg"
python3 - <<'EOF'
import ctypes, os
libc = ctypes.CDLL(None, use_errno=True)
def sc(name, nr, *a):
    r = libc.syscall(nr, *a); e = ctypes.get_errno()
    print(("PASS" if r < 0 else "FAIL"), f"{name} syscall -> {os.strerror(e) if r < 0 else 'allowed'}")
import platform
nr = {'aarch64': {'io_uring_setup': 425, 'bpf': 280, 'keyctl': 219, 'perf_event_open': 241, 'userfaultfd': 282, 'ptrace': 117},
      'x86_64': {'io_uring_setup': 425, 'bpf': 321, 'keyctl': 250, 'perf_event_open': 298, 'userfaultfd': 323, 'ptrace': 101}}[platform.machine()]
sc('io_uring_setup', nr['io_uring_setup'], 8, ctypes.create_string_buffer(120))
sc('bpf', nr['bpf'], 0, 0, 0)
sc('keyctl', nr['keyctl'], 0, 0)
sc('perf_event_open', nr['perf_event_open'], 0, 0, -1, -1, 0)
sc('userfaultfd', nr['userfaultfd'], 0)
sc('ptrace(PTRACE_ATTACH, 1)', nr['ptrace'], 16, 1, 0, 0)
import socket
for fam, name in ((socket.AF_PACKET, 'AF_PACKET'), (getattr(socket, 'AF_VSOCK', 40), 'AF_VSOCK'), (getattr(socket, 'AF_ALG', 38), 'AF_ALG')):
    try:
        socket.socket(fam, socket.SOCK_RAW if fam == socket.AF_PACKET else socket.SOCK_STREAM if fam != 38 else socket.SOCK_SEQPACKET).close(); print('FAIL socket', name, 'allowed')
    except OSError as e:
        print('PASS socket', name, '->', e.strerror)
EOF
echo "-- limits seen from inside"
echo "pids.max=$(cat /sys/fs/cgroup/pids.max 2>/dev/null) memory.max=$(cat /sys/fs/cgroup/memory.max 2>/dev/null) cpu.max=$(cat /sys/fs/cgroup/cpu.max 2>/dev/null)"
df -h /work /cache /tmp | sed 's/^/df: /'
echo "-- model proxy"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 4 -X POST http://127.0.0.1:4000/v1/messages -H 'x-api-key: mpx_guess' -d '{}')
[ "$code" = 401 ] && p "proxy refuses an unknown token ($code)" || f "proxy answered $code to an unknown token"
[ -n "$OTHER_BOX_TOKEN" ] && { code=$(curl -s -o /dev/null -w '%{http_code}' -m 4 -X POST http://127.0.0.1:4000/v1/messages -H "x-api-key: $OTHER_BOX_TOKEN" -d '{}')
  [ "$code" = 401 ] && p "proxy refuses another box's valid token ($code)" || f "another box's token: $code"; }
env | grep -iE 'token|key|secret|anthropic' | sed 's/=.*/=<set>/;s/^/env: /'
true

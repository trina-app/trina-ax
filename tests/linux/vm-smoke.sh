#!/bin/bash
# Team AX tenant template smoke test (isolation.md H-05 done-when). Run as root INSIDE a VM booted from the template
# (before or after mycel-enroll), e.g. through the guest agent:
#   qm guest exec <vmid> -- bash /root/vm-smoke.sh          (copy it in first: qm guest file-write / virt-copy-in)
#   tests/linux/vm-smoke.sh --container                       inside a privileged container (scripts/image/test-customize.sh):
#                                                             skips what only a booted VM has (running services,
#                                                             live sysctls, zram, mounts)
# Prints PASS / FAIL / SKIP per item; exit 1 when anything FAILs.
set -uo pipefail
export LC_ALL=C

MODE=vm
while [[ $# -gt 0 ]]; do
  case "$1" in
    --container) MODE=container; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "vm-smoke: unknown argument $1" >&2; exit 2 ;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "vm-smoke: run as root" >&2; exit 2; }

BASE=/var/lib/mycel
SEED=/usr/lib/mycel/seed-base
PASSN=0 FAILN=0 SKIPN=0
pass() { echo "PASS $1"; PASSN=$((PASSN + 1)); }
fail() { echo "FAIL $1: $2"; FAILN=$((FAILN + 1)); }
skip() { echo "SKIP $1: $2"; SKIPN=$((SKIPN + 1)); }
check() { local name="$1"; shift; local out; if out="$("$@" 2>&1)"; then pass "$name"; else fail "$name" "$(echo "$out" | tail -n 3 | tr '\n' ' ')"; fi; }
vm() { [[ $MODE == vm ]]; }

KIT_STATE="$(sed -n 's/.*"kit":"\([a-z]*\)".*/\1/p' /etc/ax-template.json 2>/dev/null)"
ENROLLED=0
grep -q '"state":"ok"' /run/ax/enroll-status.json 2>/dev/null && ENROLLED=1
echo "vm-smoke: mode=$MODE kit=${KIT_STATE:-unknown} enrolled=$ENROLLED template=$(sed -n 's/.*"templateVersion":"\([^"]*\)".*/\1/p' /etc/ax-template.json 2>/dev/null)"

# ---- accounts (fixed uids, < 1000 so checkDedicated accepts the engine account, main.go:65-77)
acct() {
  local name="$1" id="$2" e
  e="$(getent passwd "$name")" || { echo "no account $name"; return 1; }
  [[ "$(cut -d: -f3 <<<"$e")" == "$id" && "$(cut -d: -f4 <<<"$e")" == "$id" ]] || { echo "$name is $(cut -d: -f3,4 <<<"$e"), want $id:$id"; return 1; }
  [[ "$(cut -d: -f7 <<<"$e")" == /usr/sbin/nologin ]] || { echo "$name shell $(cut -d: -f7 <<<"$e")"; return 1; }
  [[ "$(passwd -S "$name" | awk '{print $2}')" == L ]] || { echo "$name password not locked"; return 1; }
}
check "account axserver uid 990" acct axserver 990
check "account axagent uid 991" acct axagent 991
check "root locked" bash -c '[[ "$(passwd -S root | awk "{print \$2}")" == L ]]'

# ---- kernel features the per-turn sandbox needs (unprivileged user)
# Ubuntu kernels (24.04+) restrict unprivileged userns through AppArmor; the Debian template kernel does not. In a
# container that restriction belongs to the HOST (e.g. colima's Ubuntu VM), so it is a SKIP there and a FAIL in a VM.
AA_USERNS="$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)"
if [[ $MODE == container && "$AA_USERNS" == 1 ]]; then
  skip "unshare -Ur true (unprivileged userns)" "container host kernel restricts unprivileged userns (apparmor_restrict_unprivileged_userns=1)"
  skip "bwrap --unshare-all (unprivileged)" "same host restriction"
else
  [[ "$AA_USERNS" == 1 ]] && fail "AppArmor userns restriction" "kernel.apparmor_restrict_unprivileged_userns=1 in the VM"
  check "unshare -Ur true (unprivileged userns)" runuser -u nobody -- unshare -Ur true
  check "bwrap --unshare-all (unprivileged)" runuser -u nobody -- bwrap --unshare-all --ro-bind / / true
fi
nft_probe() {
  local f; f="$(mktemp)"
  cat > "$f" <<'EOF'
table inet ax_vm_smoke {
  chain output {
    type filter hook output priority 0; policy accept;
    meta skuid "axagent" ip daddr 127.0.0.1 tcp dport 47821 accept
    meta skuid "axagent" counter reject
  }
}
EOF
  nft -f "$f" && nft list table inet ax_vm_smoke | grep -q 'skuid' && nft delete table inet ax_vm_smoke
  local rc=$?; rm -f "$f"; return $rc
}
# a foreign-arch container under qemu-user (e.g. amd64 on Apple silicon) has no netlink emulation: SKIP there only
EMULATED=0
[[ $MODE == container && "$(uname -m)" == x86_64 ]] && grep -q '^CPU implementer' /proc/cpuinfo 2>/dev/null && EMULATED=1
if out="$(nft_probe 2>&1)"; then pass 'nft -f with meta skuid "axagent"'
elif [[ $EMULATED == 1 && "$out" == *"Protocol not supported"* ]]; then skip 'nft -f with meta skuid "axagent"' "qemu-user emulation has no netlink"
else fail 'nft -f with meta skuid "axagent"' "$(echo "$out" | tail -n 3 | tr '\n' ' ')"; fi

# ---- the engine launcher under the dedicated engine account + tcp-peer probe
LAUNCHER=""
for c in "$BASE/root/mycel-launcher" "$SEED/root/mycel-launcher"; do [[ -x "$c" ]] && { LAUNCHER="$c"; break; }; done
LPID="" T=""
if [[ -z "$LAUNCHER" ]]; then
  skip "mycel-launcher --dedicated-account" "no kit launcher in $BASE/root or $SEED/root (kit ${KIT_STATE:-missing})"
  skip "tcp-peer probe" "no launcher"
else
  T="$(mktemp -d /tmp/ax-smoke.XXXXXX)"; chmod 755 "$T"
  mkdir -p "$T/sock" "$T/agent" "$T/c"; chown axagent:axagent "$T/sock" "$T/agent" "$T/c"
  # minimal flags; a kit that needs more (W1 Linux flags) can be driven with AX_SMOKE_LAUNCHER_ARGS
  # shellcheck disable=SC2086
  runuser -u axagent -- "$LAUNCHER" --listen "$T/sock/launcher.sock" --mode 0666 --agent-root "$T/agent" \
    --bridge /bin/true --tools-sock "$T/tools.sock" --allow-cmd /bin/true --server-uid 0 --dedicated-account \
    ${AX_SMOKE_LAUNCHER_ARGS:-} > "$T/launcher.log" 2>&1 &
  for _ in $(seq 1 50); do grep -q ready "$T/launcher.log" 2>/dev/null && break; sleep 0.1; done
  LPID="$(pgrep -u axagent -f -- "--listen $T/sock/launcher.sock" | head -n1)"
  if grep -q ready "$T/launcher.log" && [[ -n "$LPID" ]] && [[ "$(stat -c %u "/proc/$LPID")" == 991 ]]; then
    pass "mycel-launcher --dedicated-account runs as uid 991 (< 1000)"
    # tcp-peer: an axagent process connects to a root listener; the launcher must name that process
    if perl -MIO::Socket::INET -MIO::Socket::UNIX -e1 2>/dev/null; then
      perl -MIO::Socket::INET -e '$s=IO::Socket::INET->new(LocalAddr=>"127.0.0.1",LocalPort=>0,Listen=>5,ReuseAddr=>1) or die;
        open F,">",$ARGV[0]; print F $s->sockport,"\n"; close F; $c=$s->accept; open F,">",$ARGV[1]; print F $c->peerport,"\n"; close F; sleep 20' \
        "$T/sport" "$T/cport" >/dev/null 2>&1 & SRV=$!
      for _ in $(seq 1 30); do [[ -s "$T/sport" ]] && break; sleep 0.1; done
      SPORT="$(cat "$T/sport" 2>/dev/null)"
      runuser -u axagent -- perl -MIO::Socket::INET -e '$c=IO::Socket::INET->new(PeerAddr=>"127.0.0.1",PeerPort=>$ARGV[0]) or die;
        open F,">",$ARGV[1]; print F "$$\n"; close F; sleep 20' "$SPORT" "$T/c/pid" >/dev/null 2>&1 & CLI=$!
      for _ in $(seq 1 30); do [[ -s "$T/cport" && -s "$T/c/pid" ]] && break; sleep 0.1; done
      CPORT="$(cat "$T/cport" 2>/dev/null)"; CPID="$(cat "$T/c/pid" 2>/dev/null)"
      ANS="$(perl -MIO::Socket::UNIX -e '$s=IO::Socket::UNIX->new(Peer=>$ARGV[0]) or die "connect: $!";
        print $s qq({"op":"tcp-peer","clientPort":$ARGV[1],"serverPort":$ARGV[2]}\n); $l=<$s>; print $l' \
        "$T/sock/launcher.sock" "$CPORT" "$SPORT" 2>&1)"
      if [[ -n "$CPID" && "$ANS" == *"\"pid\":$CPID"* ]]; then pass "tcp-peer probe returns the engine-account pid ($CPID)"
      else fail "tcp-peer probe" "want pid ${CPID:-?}, launcher said: $ANS"; fi
      kill "$SRV" "$CLI" 2>/dev/null
    else
      skip "tcp-peer probe" "perl IO::Socket not available"
    fi
  else
    fail "mycel-launcher --dedicated-account" "not ready as uid 991: $(tail -n 3 "$T/launcher.log" | tr '\n' ' ')"
    skip "tcp-peer probe" "launcher did not start"
  fi
  [[ -n "$LPID" ]] && kill "$LPID" 2>/dev/null
  wait 2>/dev/null
  rm -rf "$T"
fi
skip "W1 engine lockdown test (pinned engine versions)" "real-engine test: tests/linux T1/T3 (linux-runtime.md §3.9), not part of the template smoke"

# ---- sysctls
SYSCTLS="kernel.yama.ptrace_scope=2 kernel.unprivileged_bpf_disabled=1 kernel.kptr_restrict=2 kernel.dmesg_restrict=1"
if vm; then
  for kv in $SYSCTLS; do
    k="${kv%=*}" want="${kv#*=}" got="$(sysctl -n "$k" 2>/dev/null)"
    if [[ "$k" == kernel.unprivileged_bpf_disabled && ( "$got" == 1 || "$got" == 2 ) ]] || [[ "$got" == "$want" ]]; then pass "sysctl $k=$got"
    else fail "sysctl $k" "got '${got}', want $want"; fi
  done
  u="$(sysctl -n kernel.unprivileged_userns_clone 2>/dev/null || echo 1)"
  [[ "$u" == 1 ]] && pass "unprivileged userns enabled" || fail "unprivileged userns" "kernel.unprivileged_userns_clone=$u"
else
  # the files decide what a VM gets: ours must be the last word (sysctl.d applies files in name order)
  last_word() {
    local k="$1" want="$2" v=""
    for f in $(ls /usr/lib/sysctl.d/*.conf /etc/sysctl.d/*.conf 2>/dev/null | xargs -n1 basename | sort -u); do
      for d in /etc/sysctl.d /usr/lib/sysctl.d; do [[ -f "$d/$f" ]] && { x="$(sed -n "s/^[[:space:]]*$k[[:space:]]*=[[:space:]]*\([0-9]*\).*/\1/p" "$d/$f" | tail -n1)"; [[ -n "$x" ]] && v="$x"; break; }; done
    done
    [[ "$v" == "$want" ]] || { echo "effective value from sysctl.d files: '${v}'"; return 1; }
  }
  for kv in $SYSCTLS; do check "sysctl.d ${kv}" last_word "${kv%=*}" "${kv#*=}"; done
fi

# ---- no SSH server (D15)
no_sshd() {
  [[ ! -e /usr/sbin/sshd ]] || { echo "/usr/sbin/sshd exists"; return 1; }
  for u in ssh.service ssh.socket sshd.service; do
    s="$(systemctl is-enabled "$u" 2>/dev/null || true)"
    [[ -z "$s" || "$s" == masked || "$s" == not-found ]] || { echo "$u is $s"; return 1; }
  done
  # nothing listens on TCP 22 (state 0A = LISTEN, port 0x0016)
  if awk 'NR>1 && $4=="0A" {split($2,a,":"); if (a[2]=="0016") f=1} END {exit !f}' /proc/net/tcp /proc/net/tcp6 2>/dev/null; then echo "a process listens on :22"; return 1; fi
}
check "no sshd (binary, units, listener)" no_sshd

# ---- guest agent, chrony, zram, fstrim
check "qemu-guest-agent installed" test -x /usr/sbin/qemu-ga
if vm; then
  check "qemu-guest-agent active" systemctl is-active --quiet qemu-guest-agent
  check "chrony active" systemctl is-active --quiet chrony
  check "zram swap active" bash -c 'grep -q "^/dev/zram" /proc/swaps'
  check "fstrim.timer enabled" bash -c '[[ "$(systemctl is-enabled fstrim.timer)" == enabled ]]'
else
  skip "qemu-guest-agent active" "container"
  skip "chrony active" "container"
  check "zram-generator config (ram / 2, zstd)" bash -c 'grep -q "^zram-size = ram / 2" /etc/systemd/zram-generator.conf && grep -q "^compression-algorithm = zstd" /etc/systemd/zram-generator.conf'
  check "fstrim.timer enabled" bash -c '[[ -L /etc/systemd/system/timers.target.wants/fstrim.timer ]] || [[ "$(systemctl is-enabled fstrim.timer 2>/dev/null)" == enabled ]]'
fi
check "chrony uses only 10.200.0.1" bash -c '[[ "$(grep -E "^[[:space:]]*(server|pool|peer|sourcedir|confdir)[[:space:]]" /etc/chrony/chrony.conf)" == "server 10.200.0.1 iburst" ]]'
check "time zone Etc/UTC" bash -c '[[ "$(readlink /etc/localtime)" == /usr/share/zoneinfo/Etc/UTC ]]'

# ---- cloud-init lock, first boot pieces, data disk
check "cloud-init datasource lock (NoCloud, None)" grep -q '^datasource_list: \[ NoCloud, None \]' /etc/cloud/cloud.cfg.d/99-ax.cfg
check "mycel-enroll binary" test -x /usr/local/sbin/mycel-enroll
check "mycel-enroll.service unit" grep -q '^ExecStart=/usr/local/sbin/mycel-enroll' /etc/systemd/system/mycel-enroll.service
check "var-lib-mycel.mount unit (label axdata)" grep -q '^What=/dev/disk/by-label/axdata' /etc/systemd/system/var-lib-mycel.mount
check "mycel units require the data disk" grep -q '^RequiresMountsFor=/var/lib/mycel' /etc/systemd/system/mycel-server.service.d/10-ax-data.conf
check "data-disk resize udev rule" grep -q 'ID_FS_LABEL}=="axdata"' /etc/udev/rules.d/90-axdata-resize.rules
check "unattended-upgrades: Debian-Security only" grep -q '^#clear Unattended-Upgrade::Origins-Pattern;' /etc/apt/apt.conf.d/52unattended-upgrades-ax
if [[ $ENROLLED == 1 ]]; then
  if vm; then check "data disk mounted at $BASE" findmnt -n -S LABEL=axdata "$BASE"; else skip "data disk mounted" "container"; fi
  check "kit installed on the data disk" test -f "$BASE/root/VERSION"
else
  empty_base() { [[ -d "$BASE" ]] && { [[ -z "$(ls -A "$BASE")" ]] || mountpoint -q "$BASE"; }; }
  check "$BASE is an empty mount point (not enrolled yet)" empty_base
  if [[ "$KIT_STATE" == present ]]; then check "kit seed present" test -f "$SEED/root/VERSION"
  else skip "kit seed present" "template built with --allow-missing-kit (not for production)"; fi
fi
check "mycel units not enabled in the template" bash -c '[[ '"$ENROLLED"' == 1 ]] || ! ls /etc/systemd/system/*.wants/mycel-* >/dev/null 2>&1'

echo "vm-smoke: $PASSN passed, $FAILN failed, $SKIPN skipped"
[[ $FAILN -eq 0 ]]

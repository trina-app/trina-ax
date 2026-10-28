#!/bin/bash
# A throwaway macOS virtual machine for "fresh install on a new Mac mini" tests of office mode.
# Runs on the developer's Apple silicon Mac with tart (Apple's Virtualization framework); no sudo anywhere.
#
#   scripts/vm/macos-vm.sh base                  pull the pinned Cirrus Labs image and (re)make the pristine base VM
#   scripts/vm/macos-vm.sh fresh [NAME]          delete the working VM and clone a new one from the base: a brand-new Mac
#   scripts/vm/macos-vm.sh up [NAME]             boot it headless, wait for its address and for ssh
#   scripts/vm/macos-vm.sh ssh [NAME] [cmd…]     shell (or one command) in the VM as its admin user
#   scripts/vm/macos-vm.sh ip [NAME]             the VM's address (reachable from this Mac only)
#   scripts/vm/macos-vm.sh copy [NAME] FILE…     copy files into the VM user's ~/Downloads
#   scripts/vm/macos-vm.sh office-install [NAME] ZIP [--claude-token-file F] [--no-lan-flow]
#                                                install an office zip (TeamAX-office-<v>-mac.zip) the way the office
#                                                does (README 설치-먼저-읽기.txt: ditto, office-install.sh --no-open,
#                                                never --public-host) and check it from this Mac over the VM network:
#                                                LaunchAgent, health, LAN https on 8443 with the office CA, the
#                                                certificate page on 8442, the teamax command, teamax update status,
#                                                and the desk flow of tests/install/office-lan.mjs. PASS/FAIL summary,
#                                                exit 1 on a failure.
#   scripts/vm/macos-vm.sh down [NAME]           shut it down (the disk is kept)
#   scripts/vm/macos-vm.sh rm [NAME]             delete it
#   scripts/vm/macos-vm.sh status                the VMs, which are running, disk use
#
# NAME defaults to teamax-vm. The base (teamax-base) is only cloned from, never booted for tests. A clone is an APFS
# copy-on-write copy, so a fresh VM takes seconds and only its changes use disk. Each VM gets $VM_CPU CPUs and
# $VM_MEM_MB MB (Apple allows two macOS VMs running at once). Logs: ~/Library/Logs/teamax-vm/; files fetched from the
# VM (office CA, install output): dist/vm/<NAME>/ in this repository (gitignored).
#
# Claude Code inside the VM: office-install.sh needs it installed, so it is installed there with the README's command
# (curl https://claude.ai/install.sh). The VM never gets this Mac's Claude or Codex login: without --claude-token-file
# the install uses a placeholder setup-token, so everything but a real AI answer is tested (the chat-turn checks are
# reported as EXPECTED). --claude-token-file passes a real `claude setup-token` token instead (deleted from the VM's
# ~/Downloads afterwards, as the README says). The VM is on tart's private NAT network (192.168.64.x): nothing outside
# this Mac reaches it, and no public address or tunnel is ever set up for it.
set -euo pipefail

# pinned image: macOS 26 (Tahoe), Cirrus Labs' "base" variant (admin/admin, ssh on, auto-login, no Xcode), the digest
# of ghcr.io/cirruslabs/macos-tahoe-base:latest on 2026-10-22. A newer one: TEAMAX_VM_IMAGE=…:latest, or change it here.
IMAGE=${TEAMAX_VM_IMAGE:-ghcr.io/cirruslabs/macos-tahoe-base@sha256:4aaa751fa7538902d73c767f27a066fc87e83f183069da4e4b5022863abd4c77}
BASE=${TEAMAX_VM_BASE:-teamax-base}
DEFAULT_NAME=teamax-vm
VM_CPU=4
VM_MEM_MB=6144
# the image's documented default login (not a secret of ours; the VM is reachable from this Mac only)
VM_USER=admin
VM_PASS=admin

REPO=$(cd "$(dirname "$0")/../.." && pwd)
LOGS="$HOME/Library/Logs/teamax-vm"
mkdir -p "$LOGS"

die() { echo "macos-vm: $*" >&2; exit 1; }
say() { echo "macos-vm: $*"; }
command -v tart >/dev/null || die "tart is not installed (brew install cirruslabs/cli/tart, or the notarized release from github.com/cirruslabs/tart into ~/.local/bin)"

exists() { tart list --quiet 2>/dev/null | grep -qx "$1"; }
running() { tart list --format json 2>/dev/null | /usr/bin/python3 -c 'import json,sys; n=sys.argv[1]; sys.exit(0 if any(v.get("Name")==n and (v.get("Running") or v.get("State")=="running") for v in json.load(sys.stdin)) else 1)' "$1"; }
vm_ip() { tart ip "$1" --wait "${2:-5}" 2>/dev/null; }

# password only: keys from an ssh agent would be tried first and use up the server's MaxAuthTries
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5 -o ServerAliveInterval=15
  -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive -o IdentitiesOnly=yes -o IdentityAgent=none)
need_sshpass() { command -v sshpass >/dev/null || die "sshpass is not installed (brew install sshpass)"; }
# sshpass -e reads the password from the environment, so it never shows in ps
vssh() { local ip; ip=$(vm_ip "$1") || die "$1 has no address (is it up? $0 up $1)"; shift; need_sshpass; SSHPASS=$VM_PASS sshpass -e ssh "${SSH_OPTS[@]}" "$VM_USER@$ip" "$@"; }
vscp_to() { local ip; ip=$(vm_ip "$1") || die "$1 has no address"; local dest=$2; shift 2; need_sshpass; SSHPASS=$VM_PASS sshpass -e scp -q "${SSH_OPTS[@]}" "$@" "$VM_USER@$ip:$dest"; }
vscp_from() { local ip; ip=$(vm_ip "$1") || die "$1 has no address"; need_sshpass; SSHPASS=$VM_PASS sshpass -e scp -q "${SSH_OPTS[@]}" "$VM_USER@$ip:$2" "$3"; }

# NAME is optional before other arguments: the first argument is the VM when a VM of that name exists
pick_name() { if [ $# -gt 0 ] && exists "$1"; then echo "$1"; else echo "$DEFAULT_NAME"; fi; }

cmd_base() {
  if exists "$BASE" && running "$BASE"; then die "$BASE is running; stop it first ($0 down $BASE)"; fi
  say "pulling $IMAGE (tens of GB the first time; cached in ~/.tart/cache afterwards)"
  tart pull "$IMAGE"
  if exists "$BASE"; then say "replacing $BASE"; tart delete "$BASE"; fi
  tart clone "$IMAGE" "$BASE"
  tart set "$BASE" --cpu "$VM_CPU" --memory "$VM_MEM_MB"
  say "$BASE ready ($IMAGE, $VM_CPU CPUs, $VM_MEM_MB MB). Next: $0 fresh && $0 up"
}

cmd_fresh() {
  local name=${1:-$DEFAULT_NAME}
  [ "$name" != "$BASE" ] || die "the base is never used directly; pick another name"
  exists "$BASE" || die "no $BASE yet: $0 base"
  if exists "$name"; then
    if running "$name"; then say "stopping $name"; tart stop "$name" --timeout 30 >/dev/null 2>&1 || true; fi
    tart delete "$name"
  fi
  tart clone "$BASE" "$name"
  tart set "$name" --cpu "$VM_CPU" --memory "$VM_MEM_MB" --random-mac --random-serial
  rm -rf "$REPO/dist/vm/$name"
  say "$name is a brand-new Mac (cloned from $BASE). Next: $0 up $name"
}

cmd_up() {
  local name=${1:-$DEFAULT_NAME}
  exists "$name" || die "no VM $name ($0 fresh $name)"
  if running "$name"; then say "$name is already running"
  else
    local log="$LOGS/$name.log"
    say "booting $name headless (log: $log)"
    nohup tart run "$name" --no-graphics >> "$log" 2>&1 < /dev/null &
    disown || true
  fi
  local ip
  ip=$(vm_ip "$name" 180) || die "$name got no address in 3 minutes (see $LOGS/$name.log)"
  need_sshpass
  local i
  for i in $(seq 1 90); do
    if vssh "$name" true 2>/dev/null; then say "$name is up: $ip (ssh $VM_USER@$ip; $0 ssh $name)"; return 0; fi
    sleep 2
  done
  die "$name ($ip) does not answer ssh after 3 minutes"
}

cmd_ssh() {
  local name; name=$(pick_name "$@"); [ $# -gt 0 ] && [ "$1" = "$name" ] && shift
  if [ $# -eq 0 ]; then vssh "$name"; else vssh "$name" "$@"; fi
}

cmd_ip() { local name=${1:-$DEFAULT_NAME}; vm_ip "$name" || die "$name has no address (is it up?)"; }

cmd_copy() {
  local name; name=$(pick_name "$@"); [ $# -gt 0 ] && [ "$1" = "$name" ] && shift
  [ $# -gt 0 ] || die "usage: copy [NAME] FILE…"
  local f; for f in "$@"; do [ -e "$f" ] || die "$f: no such file"; done
  vscp_to "$name" "Downloads/" -r "$@"
  say "copied to $name:~/Downloads: $*"
}

cmd_down() {
  local name=${1:-$DEFAULT_NAME}
  if exists "$name" && running "$name"; then tart stop "$name" --timeout 60; say "$name stopped"; else say "$name is not running"; fi
}

cmd_rm() {
  local name=${1:-$DEFAULT_NAME}
  exists "$name" || { say "no VM $name"; return 0; }
  if running "$name"; then tart stop "$name" --timeout 30 >/dev/null 2>&1 || true; fi
  tart delete "$name"
  rm -rf "$REPO/dist/vm/$name"
  say "$name deleted"
}

cmd_status() {
  echo "image: $IMAGE   base: $BASE   default VM: $DEFAULT_NAME   ($VM_CPU CPUs, $VM_MEM_MB MB each)"
  tart list
  echo
  # clones share blocks with their source (APFS copy-on-write): du counts them once per VM, so the disk's free space
  # is the number to watch
  echo "free on this disk: $(df -h "$HOME" | awk 'NR==2 {print $4}')   (image cache + VMs in ~/.tart; logs in $LOGS)"
  local n; for n in $(tart list --quiet 2>/dev/null); do running "$n" && echo "running: $n  $(vm_ip "$n" 1 || echo '(no address yet)')"; done
  return 0
}

# ---------------------------------------------------------------- office-install ----------------------------------
cmd_office_install() {
  local name; name=$(pick_name "$@"); [ $# -gt 0 ] && [ "$1" = "$name" ] && shift
  local zip="" token_file="" lan_flow=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --claude-token-file) token_file=$2; shift 2 ;;
      --no-lan-flow) lan_flow=0; shift ;;
      -*) die "unknown option $1" ;;
      *) zip=$1; shift ;;
    esac
  done
  [ -n "$zip" ] && [ -f "$zip" ] || die "usage: office-install [NAME] TeamAX-office-<version>-mac.zip [--claude-token-file F] [--no-lan-flow]"
  [ -z "$token_file" ] || [ -f "$token_file" ] || die "$token_file: no such file"
  case "$(basename "$zip")" in *-office-*-mac.zip) ;; *) die "$zip is not an office zip (<name>-office-<version>-mac.zip)" ;; esac
  local bundle; bundle=$(basename "$zip" -mac.zip)
  running "$name" || die "$name is not running ($0 up $name)"
  local ip; ip=$(vm_ip "$name") || die "$name has no address"
  local out="$REPO/dist/vm/$name"; mkdir -p "$out"
  local log="$out/office-install.log"; : > "$log"

  set +e  # every check below records PASS/FAIL instead of stopping the run
  local results=()  # "STATUS|name|detail"
  rec() { results+=("$1|$2|${3:-}"); printf '%-8s %s%s\n' "$1" "$2" "${3:+  ($3)}"; }
  ok_if() { if [ "$1" = 0 ]; then rec PASS "$2" "${3:-}"; else rec FAIL "$2" "${3:-}"; fi; }

  say "copying $(basename "$zip") into $name:~/Downloads (marked as downloaded by a browser, like a real download)"
  vscp_to "$name" "Downloads/" "$zip"
  # a browser download carries com.apple.quarantine, and ditto passes it on to the unpacked files: the installer must cope
  vssh "$name" "set -e; cd ~/Downloads; xattr -w com.apple.quarantine \"0083;\$(printf %x \$(date +%s));Safari;\$(uuidgen)\" '$(basename "$zip")'; rm -rf '$bundle'; ditto -x -k '$(basename "$zip")' .; test -f '$bundle/office-install.sh'" >> "$log" 2>&1
  ok_if $? "unzip with ditto into ~/Downloads/$bundle"

  # 1. without Claude Code the installer stops with a clear instruction (and changes nothing)
  if vssh "$name" 'test -x ~/.local/bin/claude || command -v claude' >/dev/null 2>&1; then
    rec SKIP "installer refuses without Claude Code" "Claude Code already in this VM"
  else
    local pre rc=0
    pre=$(vssh "$name" "bash ~/Downloads/$bundle/office-install.sh --check-only --no-open 2>&1") || rc=$?
    echo "== check-only without Claude Code (exit $rc)"$'\n'"$pre" >> "$log"
    [ "$rc" != 0 ] && grep -q "Claude Code is not installed" <<< "$pre"; ok_if $? "installer refuses without Claude Code, says how to install it" "exit $rc"
    say "installing Claude Code in the VM (curl -fsSL https://claude.ai/install.sh | bash)"
    vssh "$name" 'curl -fsSL https://claude.ai/install.sh | bash' >> "$log" 2>&1
    ok_if $? "Claude Code installs in the VM (claude.ai/install.sh)" "$(vssh "$name" '~/.local/bin/claude --version' 2>/dev/null || echo '?')"
  fi

  # 2. installed but not logged in: refused again, unless a setup-token is given
  local pre rc=0
  pre=$(vssh "$name" "PATH=\$HOME/.local/bin:\$PATH bash ~/Downloads/$bundle/office-install.sh --check-only --no-open 2>&1") || rc=$?
  echo "== check-only, Claude Code not logged in (exit $rc)"$'\n'"$pre" >> "$log"
  [ "$rc" != 0 ] && grep -q "not logged in" <<< "$pre"; ok_if $? "installer refuses when Claude Code is not logged in" "exit $rc"

  # 3. the install: subscription mode (setup-token file), as recommended by office-install.sh --help
  local real_token=0
  if [ -n "$token_file" ]; then
    real_token=1
    vscp_to "$name" "Downloads/vm-test.claude-token" "$token_file"
  else
    # placeholder in the shape of a `claude setup-token` token: the install works, an AI answer cannot
    vssh "$name" "umask 077; printf '%s\n' sk-ant-oat01-VMTEST_placeholder_not_a_real_token_000000 > ~/Downloads/vm-test.claude-token"
  fi
  say "running office-install.sh --no-open --claude-token-file … in $name (output: $log)"
  rc=0
  vssh "$name" "PATH=\$HOME/.local/bin:\$PATH bash ~/Downloads/$bundle/office-install.sh --no-open --claude-token-file ~/Downloads/vm-test.claude-token" >> "$log" 2>&1 || rc=$?
  vssh "$name" 'rm -f ~/Downloads/vm-test.claude-token'
  ok_if $rc "office-install.sh finished" "exit $rc"
  tail -n 30 "$log" | sed 's/^/    | /'

  # 4. inside the VM
  local st; st=$(vssh "$name" '~/TeamAX/teamax status 2>&1' || true)
  echo "== teamax status"$'\n'"$st" >> "$log"
  grep -q '^running' <<< "$st" && grep -q 'this Mac .*answers' <<< "$st"; ok_if $? "teamax status: running, answers on this Mac" "$(head -n 1 <<< "$st")"
  vssh "$name" 'launchctl print gui/$(id -u)/$(sed -n "s/^TEAMAX_LABEL=//p" ~/TeamAX/config/office.env) | grep -q "state = running"' 2>/dev/null; ok_if $? "LaunchAgent loaded and running"
  local h; h=$(vssh "$name" 'curl -fsS --max-time 5 http://127.0.0.1:$(sed -n "s/^TEAMAX_APP_PORT=//p" ~/TeamAX/config/office.env)/api/health' 2>/dev/null || true)
  grep -q '"ok"' <<< "$h"; ok_if $? "health on the app port (127.0.0.1)" "$h"
  vssh "$name" 'test -x ~/TeamAX/app/bin/bun && ! xattr -p com.apple.quarantine ~/TeamAX/app/bin/bun >/dev/null 2>&1'; ok_if $? "quarantine removed from the installed programs"
  vssh "$name" 'test "$(stat -f %Lp ~/TeamAX/config/claude-oauth-token)" = 600 && test ! -e ~/Downloads/vm-test.claude-token'; ok_if $? "setup-token copied to config (600), the downloaded copy gone"
  local u rc2=0; u=$(vssh "$name" '~/TeamAX/teamax update status 2>&1') || rc2=$?
  echo "== teamax update status (exit $rc2)"$'\n'"$u" >> "$log"
  ok_if $rc2 "teamax update status" "$(tr '\n' ' ' <<< "$u" | cut -c1-140)"
  local info rc3=0; info=$(vssh "$name" '~/TeamAX/teamax info 2>&1') || rc3=$?
  echo "== teamax info (exit $rc3)"$'\n'"$info" >> "$log"
  [ "$rc3" = 0 ] && ! grep -q 'not prepared' <<< "$info"; ok_if $? "teamax info"
  local eng; eng=$(vssh "$name" 'grep -h -i -E "claude|engine" ~/TeamAX/logs/office.log 2>/dev/null | tail -n 3' || true)
  echo "== engine lines in office.log"$'\n'"$eng" >> "$log"

  # 5. from this Mac over the VM network, the way a desk PC reaches the office Mac
  local ca="$out/ca.crt"
  vscp_from "$name" "TeamAX/tls/ca.crt" "$ca" 2>/dev/null; ok_if $? "office CA fetched (~/TeamAX/tls/ca.crt)"
  local lan helper
  lan=$(sed -n 's/^TEAMAX_LAN_PORT=//p' <<< "$(vssh "$name" 'cat ~/TeamAX/config/office.env')"); lan=${lan:-8443}
  helper=$(sed -n 's/^TEAMAX_HELPER_PORT=//p' <<< "$(vssh "$name" 'cat ~/TeamAX/config/office.env')"); helper=${helper:-$((lan - 1))}
  local code
  code=$(curl -sS -o "$out/lan-health.json" -w '%{http_code}' --max-time 10 --cacert "$ca" "https://$ip:$lan/api/health" 2>>"$log" || true)
  local https_ok=0; [ "$code" = 200 ] && https_ok=1
  [ "$code" = 200 ]; ok_if $? "LAN https://$ip:$lan/api/health with the office CA" "HTTP $code $(head -c 120 "$out/lan-health.json" 2>/dev/null)"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$ip:$lan/api/health" || true)
  # (only meaningful while the https check above passed: a server that is down answers nothing either way)
  [ "$code" != 200 ] && [ "$https_ok" = 1 ]; ok_if $? "plain http on the LAN port is not served" "HTTP $code"
  code=$(curl -s -o "$out/helper.html" -w '%{http_code}' --max-time 5 "http://$ip:$helper/" || true)
  [ "$code" = 200 ] && grep -q '/ca.cer' "$out/helper.html"; ok_if $? "certificate page http://$ip:$helper/" "HTTP $code"
  code=$(curl -s -o "$out/ca.cer" -w '%{http_code}' --max-time 5 "http://$ip:$helper/ca.cer" || true)
  [ "$code" = 200 ] && [ "$(shasum -a 256 < "$out/ca.cer")" = "$(openssl x509 -in "$ca" -outform der 2>/dev/null | shasum -a 256)" ]
  ok_if $? "ca.cer from the certificate page is the office CA" "HTTP $code"

  # 6. the desk flow (first-run setup, invite, sign-in, upload, wss, one chat turn): tests/install/office-lan.mjs
  if [ "$lan_flow" = 1 ]; then
    local link token
    link=$(vssh "$name" '~/TeamAX/teamax setup-link 2>&1' || true)
    token=$(grep -o 'token=[A-Za-z0-9_-]*' <<< "$link" | head -n 1 | cut -d= -f2)
    if [ -z "$token" ]; then rec FAIL "setup link for the desk flow" "$(head -n 1 <<< "$link")"
    else
      say "desk flow: node tests/install/office-lan.mjs --base https://$ip:$lan (the chat turn needs a real Claude login)"
      local flow rc4=0
      flow=$(cd "$REPO" && NODE_EXTRA_CA_CERTS="$ca" node tests/install/office-lan.mjs --base "https://$ip:$lan" --token "$token" --helper "http://$ip:$helper" 2>&1) || rc4=$?
      echo "== office-lan.mjs (exit $rc4)"$'\n'"$flow" >> "$log"
      local line
      while IFS= read -r line; do
        case "$line" in
          PASS\ *) rec PASS "desk flow: ${line#PASS }" ;;
          FAIL\ *)
            local n=${line#FAIL }; n=${n%% — *}
            case "$n" in
              "real Claude turn finished"|"answer has the code word from the uploaded file"|"answer streamed over the WebSocket (message.delta frames)")
                if [ "$real_token" = 1 ]; then rec FAIL "desk flow: $n" "${line#* — }"; else rec EXPECTED "desk flow: $n" "no Claude login in the VM"; fi ;;
              *) rec FAIL "desk flow: $n" "${line#* — }" ;;
            esac ;;
        esac
      done <<< "$flow"
    fi
  fi

  # summary
  local pass=0 fail=0 other=0 r
  for r in "${results[@]}"; do case "${r%%|*}" in PASS) pass=$((pass + 1)) ;; FAIL) fail=$((fail + 1)) ;; *) other=$((other + 1)) ;; esac; done
  printf '%s\n' "${results[@]}" > "$out/results.txt"
  echo
  echo "================ office-install on $name ($ip): $(basename "$zip") ================"
  for r in "${results[@]}"; do IFS='|' read -r s n d <<< "$r"; printf '  %-8s %s\n' "$s" "$n"; done
  echo "  -- $pass passed, $fail failed, $other expected/skipped. Log: $log"
  if [ "$fail" = 0 ]; then echo "  RESULT: PASS"; else echo "  RESULT: FAIL"; return 1; fi
}

cmd=${1:-help}; [ $# -gt 0 ] && shift
case "$cmd" in
  base) cmd_base ;;
  fresh) cmd_fresh "$@" ;;
  up) cmd_up "$@" ;;
  ssh) cmd_ssh "$@" ;;
  ip) cmd_ip "$@" ;;
  copy) cmd_copy "$@" ;;
  office-install) cmd_office_install "$@" ;;
  down) cmd_down "$@" ;;
  rm) cmd_rm "$@" ;;
  status) cmd_status ;;
  -h|--help|help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0" ;;
  *) die "unknown command $cmd (see $0 help)" ;;
esac

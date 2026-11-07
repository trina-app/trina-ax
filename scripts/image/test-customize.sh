#!/bin/bash
# Local proof of the template customization without KVM (H-05 pipeline test): run scripts/image/customize.sh twice in
# a privileged Debian 13 container with a FAKE Team AX kit (honours only the --image-mode contract) and the real Linux
# mycel-launcher (built here with Go), check the second run changes nothing, then run tests/linux/vm-smoke.sh --container.
#
#   bash scripts/image/test-customize.sh [--platform linux/amd64|linux/arm64] [--image debian:trixie] [--keep] [--no-srt]
#
# Needs: docker (privileged containers), go (optional: without it the launcher / tcp-peer checks are skipped).
# Work folder: .tmp/image-test (git-ignored). The container is removed unless --keep.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLATFORM=""
IMAGE="debian:trixie"
KEEP=0
SRT=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) PLATFORM="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --no-srt) SRT=0; shift ;;
    *) echo "test-customize: unknown argument $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$PLATFORM" ]]; then
  case "$(docker info --format '{{.Architecture}}')" in aarch64|arm64) PLATFORM=linux/arm64 ;; *) PLATFORM=linux/amd64 ;; esac
fi
ARCH="${PLATFORM#linux/}"
WORK="$REPO/.tmp/image-test"
NAME="ax-image-test-$$"
rm -rf "$WORK"; mkdir -p "$WORK/src/kit/root" "$WORK/src/bin"
cp -a "$REPO/scripts/image/customize.sh" "$REPO/scripts/image/files" "$WORK/src/"
# the one list of packages and its reader (what build.sh and build-ami.sh stage as system/)
mkdir -p "$WORK/src/system"
cp -p "$REPO/scripts/system/packages.sh" "$REPO/scripts/system/packages.json" "$WORK/src/system/"
# the dev environment on srt, image part (the same files build-ami.sh stages). --no-srt skips it (faster)
if [[ $SRT == 1 ]]; then
  mkdir -p "$WORK/src/dev-env-srt"
  for f in install-srt.sh uninstall-srt.sh package.json package-lock.json run-wrap srt-full.mjs devenv.rules.in devenv.slice.in README.md; do
    cp -p "$REPO/scripts/dev-env/srt/$f" "$WORK/src/dev-env-srt/"
  done
  mkdir -p "$WORK/src/dev-env-srt/system"
  cp -p "$REPO/scripts/system/packages.sh" "$REPO/scripts/system/packages.json" "$WORK/src/dev-env-srt/system/"
fi
cp "$REPO/tests/linux/vm-smoke.sh" "$WORK/vm-smoke.sh"

# ---- fake kit: VERSION + install-linux.sh honouring the --image-mode contract + the real launcher
echo "0.3.0-fake" > "$WORK/src/kit/VERSION"
cat > "$WORK/src/kit/install-linux.sh" <<'EOF'
#!/bin/bash
# FAKE W1 kit installer (scripts/image/test-customize.sh): implements only `install --image-mode` as the template
# needs it: BASE populated on the OS disk, accounts only checked, units written but NOT enabled, nothing started.
set -euo pipefail
[[ "${1:-}" == install ]] || { echo "fake kit: only 'install'" >&2; exit 2; }
shift
FROM="" IMAGE=0 HOSTED=0
while [[ $# -gt 0 ]]; do
  case "$1" in --from) FROM="$2"; shift 2 ;; --image-mode) IMAGE=1; shift ;; --hosted) HOSTED=1; shift ;; --engine) shift 2 ;; *) shift ;; esac
done
[[ $IMAGE == 1 && $HOSTED == 1 && -n "$FROM" ]] || { echo "fake kit: needs --from, --hosted and --image-mode" >&2; exit 2; }
getent passwd axserver >/dev/null && getent passwd axagent >/dev/null || { echo "fake kit: accounts missing" >&2; exit 1; }
B=/var/lib/mycel
install -d -o root -g root -m 755 "$B" "$B/root" "$B/run"
install -d -o axserver -g axserver -m 755 "$B/app"
install -d -o axserver -g axserver -m 700 "$B/data" "$B/team" "$B/config" "$B/secrets"
install -d -o axagent -g axagent -m 700 "$B/agent"
install -o root -g root -m 644 "$FROM/VERSION" "$B/root/VERSION"
[[ -f "$FROM/root/mycel-launcher" ]] && install -o root -g root -m 755 "$FROM/root/mycel-launcher" "$B/root/mycel-launcher"
# the real kit writes the self-host default (linux-runtime.md §3.1.1); the template's 99-ax-guest.conf must win
echo 'kernel.yama.ptrace_scope = 1' > /etc/sysctl.d/60-mycel.conf
printf '{"mode":"prod","deployment":"hosted","logDir":null}\n' > "$B/config/server.json"
chown axserver:axserver "$B/config/server.json"; chmod 600 "$B/config/server.json"
for u in server launcher; do
  printf '[Unit]\nDescription=fake mycel-%s\n[Service]\nExecStart=/bin/sleep infinity\n[Install]\nWantedBy=multi-user.target\n' "$u" > "/etc/systemd/system/mycel-$u.service"
done
echo "installed (image mode) $(cat "$FROM/VERSION")"
EOF
chmod 755 "$WORK/src/kit/install-linux.sh"

if command -v go >/dev/null 2>&1; then
  (cd "$REPO/native" && CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" go build -trimpath -o "$WORK/src/kit/root/mycel-launcher" ./cmd/mycel-launcher)
  echo "test-customize: built linux/$ARCH mycel-launcher"
else
  echo "test-customize: no go: the launcher and tcp-peer checks will be skipped"
fi
ENROLL="$REPO/native/bin/linux-$ARCH/mycel-enroll"
if [[ -x "$ENROLL" ]]; then cp "$ENROLL" "$WORK/src/bin/mycel-enroll"
else printf '#!/bin/sh\necho "fake mycel-enroll (test-customize)"\n' > "$WORK/src/bin/mycel-enroll"; chmod 755 "$WORK/src/bin/mycel-enroll"; fi
LINK="$REPO/native/bin/linux-$ARCH/mycel-link"
if [[ -x "$LINK" ]]; then cp "$LINK" "$WORK/src/bin/mycel-link"
else printf '#!/bin/sh\necho "fake mycel-link (test-customize)"\n' > "$WORK/src/bin/mycel-link"; chmod 755 "$WORK/src/bin/mycel-link"; fi

cleanup() { [[ $KEEP == 1 ]] || docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "test-customize: $IMAGE ($PLATFORM), container $NAME"
docker run -d --name "$NAME" --privileged --platform "$PLATFORM" -v "$WORK:/w" "$IMAGE" sleep infinity >/dev/null

run1="$(docker exec "$NAME" bash /w/src/customize.sh --src /w/src --template-version 0.3.0-fake-d13-test 2>&1)" || { echo "$run1"; echo "test-customize: FIRST RUN FAILED"; exit 1; }
echo "$run1" | tail -n 25
run2="$(docker exec "$NAME" bash /w/src/customize.sh --src /w/src --template-version 0.3.0-fake-d13-test 2>&1)" || { echo "$run2"; echo "test-customize: SECOND RUN FAILED"; exit 1; }
echo "--- second run:"; echo "$run2" | tail -n 5
echo "$run2" | grep -q 'changed=0$' || { echo "test-customize: FAIL: second run changed something (not idempotent)"; exit 1; }

echo "--- seed / mount point:"
docker exec "$NAME" bash -c 'ls -ln /usr/lib/mycel/seed-base /usr/lib/mycel/seed-base/root; echo "BASE entries: $(ls -A /var/lib/mycel | wc -l)"; cat /etc/ax-template.json'
if [[ $SRT == 1 ]]; then
  echo "--- dev environment on srt (image part): installed, and NOT turned on:"
  docker exec "$NAME" bash -c 'set -e
    L=/usr/lib/mycel/dev-env/srt/system; . $L/packages.sh; pk_load $L/packages.json
    v=$(pk_art srt any version)
    [ "$(/opt/trina/node/bin/node /opt/trina/srt/$v/cli.js --version)" = "$v" ] || { echo "srt $v does not answer"; exit 1; }
    /opt/trina/node/bin/node /opt/trina/srt/$v/full.mjs --self-test >/dev/null || { echo "srt $v full.mjs missing or allows an address"; exit 1; }
    [ "$(stat -c "%U %a" /opt/trina/devenv/run-wrap)" = "root 755" ] || { echo "run-wrap owner/mode"; exit 1; }
    for p in $(pk_packages "$(pk_distro)" "$(pk_arch)" core media fonts devenv); do dpkg-query -W -f "\${db:Status-Status}" $p | grep -qx installed || { echo "package $p missing"; exit 1; }; done
    [ -z "$(find /opt/trina -perm /022 ! -type l)" ] || { echo "a file in /opt/trina is group/world writable"; exit 1; }
    for f in /etc/polkit-1/rules.d/60-mycel-devenv.rules /etc/systemd/system/mycel-devenv.slice /etc/systemd/system/mycel-server.service.d/dev-env.conf; do
      [ ! -e "$f" ] || { echo "image mode wrote $f (the dev environment must stay off)"; exit 1; }; done
    grep -q "\"srt\":\"present\"" /etc/ax-template.json || { echo "ax-template.json has no srt present"; exit 1; }
    echo "srt $v, node $(/opt/trina/node/bin/node --version), run-wrap, packages: ok; no polkit rule, slice or drop-in"'
fi
echo "--- vm-smoke --container:"
docker exec "$NAME" bash /w/vm-smoke.sh --container
echo "--- negative: no kit must fail with the contract message"
if out="$(docker exec "$NAME" bash /w/src/customize.sh --src /w/src --kit /nonexistent 2>&1)"; then
  echo "$out"; echo "test-customize: FAIL: customize.sh accepted a missing kit"; exit 1
fi
echo "$out" | grep -q 'linux-runtime.md §3.5.1' || { echo "$out"; echo "test-customize: FAIL: missing-kit message"; exit 1; }
echo "missing kit refused: $(echo "$out" | grep ERROR | head -n1)"
echo "--- negative: vm-smoke must catch an sshd"
docker exec "$NAME" bash -c 'printf "#!/bin/sh\n" > /usr/sbin/sshd; chmod 755 /usr/sbin/sshd'
if docker exec "$NAME" bash /w/vm-smoke.sh --container >/dev/null 2>&1; then echo "test-customize: FAIL: vm-smoke missed /usr/sbin/sshd"; exit 1; fi
docker exec "$NAME" rm -f /usr/sbin/sshd
echo "sshd detected"
if [[ $SRT == 1 ]]; then
  echo "--- hosted boot (mycel-devenv-boot, install-srt.sh --boot) with plan.json samples:"
  # no systemd runs in the container: systemctl, runuser and systemd-run are stubs that log their arguments, and apt-get
  # fails (--boot must not run it). The units are checked with systemd-analyze verify.
  docker exec "$NAME" bash -c 'set -euo pipefail
    fail() { echo "FAIL: $*"; exit 1; }
    for f in /usr/local/sbin/mycel-devenv-boot:755 /etc/systemd/system/mycel-devenv-boot.service:644 \
             /etc/systemd/system/mycel-devenv-plan.path:644 /etc/systemd/system/mycel-server.service.d/20-devenv-boot.conf:644; do
      [ "$(stat -c "%U %a" "${f%:*}")" = "root ${f##*:}" ] || fail "${f%:*} owner/mode"; done
    out=$(systemd-analyze verify --man=no /etc/systemd/system/mycel-devenv-boot.service /etc/systemd/system/mycel-devenv-plan.path 2>&1 \
      | grep -E "mycel-devenv" | grep -v -E "Failed to (connect|create|set up)|bus|Command .* is not executable" || true)
    [ -z "$out" ] || { echo "$out"; fail "systemd-analyze verify"; }
    echo "units: installed, systemd-analyze verify has no finding on them"

    S=/tmp/stubs; mkdir -p $S; LOG=/tmp/stub.log; : > $LOG
    cat > $S/systemctl <<"X"
#!/bin/bash
echo "systemctl $*" >> /tmp/stub.log
case "$1" in
  cat) exit 0 ;;
  show) echo axserver ;;
  is-active) [ -f /tmp/server-active ] ;;
  *) exit 0 ;;
esac
X
    printf "#!/bin/bash\necho \"runuser \$*\" >> /tmp/stub.log\nwhile [ \"\$1\" != -- ]; do shift; done; shift; exec \"\$@\"\n" > $S/runuser
    printf "#!/bin/bash\necho \"systemd-run \$*\" >> /tmp/stub.log\ncase \" \$* \" in *\" --scope \"*) exit 0 ;; esac; exit 1\n" > $S/systemd-run
    printf "#!/bin/bash\necho \"apt-get \$*\" >> /tmp/stub.log\nexit 1\n" > $S/apt-get
    chmod 755 $S/*
    cp $S/systemctl $S/systemctl.good
    export PATH=$S:$PATH

    # the mapping, for the plans of the control plane (trina-cloud src/teams/plans.ts)
    m() { echo "$1" > /tmp/p.json; mycel-devenv-boot --map /tmp/p.json; }
    want_basic="{\"format\":1,\"plan\":\"basic\",\"maxRunning\":1,\"cpus\":1.5,\"memoryMiB\":1536,\"pids\":512,\"diskGiB\":8,\"network\":\"open\"}"
    BASIC="{\"format\":1,\"plan\":\"basic\",\"updatedAt\":\"2026-11-05T00:00:00Z\",\"maxConcurrency\":2,\"memoryMiB\":4096,\"cpuCores\":2,\"diskGiB\":80,\"localBackupRetentionDays\":3,\"maxActiveMembers\":5,\"display\":{\"name\":{\"en\":\"Starter\"}},\"links\":null}"
    [ "$(m "$BASIC")" = "$want_basic" ] || fail "Starter mapping: $(m "$BASIC")"
    [ "$(m "{\"format\":1,\"plan\":\"team\",\"maxConcurrency\":3,\"memoryMiB\":8192,\"cpuCores\":2,\"diskGiB\":160}" | jq -c "[.maxRunning,.cpus,.memoryMiB,.pids,.diskGiB]")" = "[2,1.5,3072,1024,16]" ] || fail "Team mapping"
    [ "$(m "{\"format\":1,\"plan\":\"pro\",\"maxConcurrency\":6,\"memoryMiB\":16384,\"cpuCores\":4,\"diskGiB\":320}" | jq -c "[.maxRunning,.cpus,.memoryMiB,.pids,.diskGiB]")" = "[3,3,6144,2048,32]" ] || fail "Business mapping"
    if m "{\"format\":1,\"plan\":\"free\",\"maxConcurrency\":1,\"memoryMiB\":2048,\"cpuCores\":2,\"diskGiB\":5}" >/dev/null 2>&1; then fail "Free got a dev environment"; fi
    echo "mapping: Starter $want_basic; Team [2,1.5,3072,1024,16]; Business [3,3,6144,2048,32]; Free none"

    # a t3a.medium (4 GiB VM, MemTotal about 3.8 GiB): the Docker VM size of the test machine does not count
    export MYCEL_DEVENV_MACHINE_MIB=3890 MYCEL_DEVENV_MACHINE_CORES=2
    # a hosted server after enrollment: the data disk holds root/install.json and root/plan.json
    B=/var/lib/mycel; DROPIN=/etc/systemd/system/mycel-server.service.d/dev-env.conf
    install -d -o root -g root -m 755 $B $B/root
    echo "{\"hosted\":true}" > $B/root/install.json
    echo "$BASIC" > $B/root/plan.json
    out=$(mycel-devenv-boot 2>&1) || fail "exit code not 0"
    echo "$out" | sed "s/^/  /"
    [ "$(cat $B/root/dev-env.json)" = "$want_basic" ] || fail "dev-env.json content"
    [ "$(stat -c "%U %a" $B/root/dev-env.json)" = "root 644" ] || fail "dev-env.json owner/mode"
    ! grep -q "^apt-get" $LOG || fail "--boot ran apt-get"
    grep -q "ReadWritePaths=-/var/lib/mycel/devenv" $DROPIN || fail "drop-in ReadWritePaths"
    grep -qx "ExecStartPre=+/usr/bin/install -d -o axserver -g axserver -m 700 /var/lib/mycel/devenv" $DROPIN || fail "drop-in ExecStartPre"
    grep -q "MYCEL_DEV_ENV=1 MYCEL_DEV_ENV_RUNNER=srt" $DROPIN || fail "drop-in flags"
    grep -q "^MemoryMax=1536M" /etc/systemd/system/mycel-devenv.slice && grep -q "^CPUQuota=150%" /etc/systemd/system/mycel-devenv.slice \
      && grep -q "^TasksMax=2048" /etc/systemd/system/mycel-devenv.slice || fail "slice values"
    [ -f /etc/polkit-1/rules.d/60-mycel-devenv.rules ] || fail "polkit rule"
    grep -q "systemd-run --scope" $LOG || fail "no scope probe"
    ! grep -q "^systemctl restart" $LOG || fail "restarted a server that does not run"
    echo "first boot: dev-env.json, drop-in, slice, polkit rule; no apt-get, no restart (server not running)"

    : > $LOG; t=$(stat -c %Y.%i $B/root/dev-env.json)
    mycel-devenv-boot >/dev/null 2>&1 || fail "second run exit"
    [ "$(stat -c %Y.%i $B/root/dev-env.json)" = "$t" ] || fail "second run rewrote dev-env.json"
    ! grep -q "^systemctl restart" $LOG || fail "second run restarted the server"
    echo "second run: nothing changed"

    # the drop-in changes while the server runs: restart with --no-block only
    rm -f $DROPIN; touch /tmp/server-active; : > $LOG
    mycel-devenv-boot >/dev/null 2>&1 || fail "exit code"
    grep -qx "systemctl restart --no-block mycel-server.service" $LOG || fail "no --no-block restart: $(grep restart $LOG || true)"
    rm -f /tmp/server-active
    echo "running server: restart --no-block"

    # a damaged plan.json: logged, exit 0, the last good file stays
    echo "{not json" > $B/root/plan.json
    mycel-devenv-boot >/dev/null 2>&1 || fail "damaged plan: exit code"
    [ "$(cat $B/root/dev-env.json)" = "$want_basic" ] || fail "damaged plan changed dev-env.json"
    # install-srt.sh fails (the server unit is missing): logged, exit 0
    echo "$BASIC" > $B/root/plan.json
    printf "#!/bin/bash\n[ \"\$1\" = cat ] && exit 1; exit 0\n" > $S/systemctl
    out=$(mycel-devenv-boot 2>&1) || fail "failing install-srt: exit code"
    echo "$out" | grep -q "install-srt.sh --boot failed" || fail "failing install-srt not logged"
    echo "damaged plan.json and a failing install-srt.sh: logged, exit 0"
    cp $S/systemctl.good $S/systemctl

    # a move up before the VM has the new size (the control plane writes plan.json at once, the VM grows at its next
    # reboot): the machine size counts. Team on a 4 GiB VM keeps the Starter numbers, nothing restarts.
    mycel-devenv-boot >/dev/null 2>&1; touch /tmp/server-active; : > $LOG
    echo "{\"format\":1,\"plan\":\"team\",\"maxConcurrency\":3,\"memoryMiB\":8192,\"cpuCores\":2,\"diskGiB\":160}" > $B/root/plan.json
    mycel-devenv-boot >/dev/null 2>&1 || fail "Team on 4 GiB: exit code"
    [ "$(jq -c "[.plan,.maxRunning,.memoryMiB]" $B/root/dev-env.json)" = "[\"team\",1,1536]" ] || fail "Team on 4 GiB: $(cat $B/root/dev-env.json)"
    ! grep -q "^systemctl restart" $LOG || fail "Team on 4 GiB restarted the server"
    MYCEL_DEVENV_MACHINE_MIB=7900 mycel-devenv-boot >/dev/null 2>&1 || fail "Team on 8 GiB: exit code"
    [ "$(jq -c "[.maxRunning,.memoryMiB]" $B/root/dev-env.json)" = "[2,3072]" ] || fail "Team on 8 GiB: $(cat $B/root/dev-env.json)"
    rm -f /tmp/server-active
    echo "move up: Team on a 4 GiB VM keeps the Starter numbers (no restart); on an 8 GiB VM it gets the Team numbers"


    # a move down to Free: dev-env.json and the server switch go, the image files stay
    echo "{\"format\":1,\"plan\":\"free\",\"maxConcurrency\":1,\"memoryMiB\":2048,\"cpuCores\":2,\"diskGiB\":5}" > $B/root/plan.json
    mycel-devenv-boot >/dev/null 2>&1 || fail "Free: exit code"
    [ ! -e $B/root/dev-env.json ] && [ ! -e $DROPIN ] || fail "Free kept dev-env.json or the drop-in"
    [ -x /opt/trina/node/bin/node ] || fail "Free removed node"
    # Starter on the 2 GiB VM of Free (a move up from Free before the reboot): stays off, nothing restarts
    touch /tmp/server-active; : > $LOG
    echo "$BASIC" > $B/root/plan.json
    MYCEL_DEVENV_MACHINE_MIB=1942 mycel-devenv-boot >/dev/null 2>&1 || fail "Starter on 2 GiB: exit code"
    [ ! -e $B/root/dev-env.json ] && [ ! -e $DROPIN ] || fail "Starter on 2 GiB turned the dev environment on"
    ! grep -q "^systemctl restart" $LOG || fail "Starter on 2 GiB restarted the server"
    # a move down to Free while the server runs: off, and one restart with --no-block
    mycel-devenv-boot >/dev/null 2>&1; [ -e $DROPIN ] || fail "Starter on 4 GiB: no drop-in"; : > $LOG
    echo "{\"format\":1,\"plan\":\"free\",\"maxConcurrency\":1,\"memoryMiB\":2048,\"cpuCores\":2,\"diskGiB\":5}" > $B/root/plan.json
    mycel-devenv-boot >/dev/null 2>&1 || fail "Free (running): exit code"
    [ ! -e $DROPIN ] || fail "Free (running) kept the drop-in"
    grep -qx "systemctl restart --no-block mycel-server.service" $LOG || fail "Free (running): no --no-block restart"
    rm -f /tmp/server-active
    # not hosted: nothing
    echo "$BASIC" > $B/root/plan.json; echo "{\"hosted\":false}" > $B/root/install.json
    mycel-devenv-boot >/dev/null 2>&1 || fail "self-hosted: exit code"
    [ ! -e $B/root/dev-env.json ] || fail "self-hosted got dev-env.json"
    if bash /usr/lib/mycel/dev-env/srt/install-srt.sh --image-mode --boot >/dev/null 2>&1; then fail "--image-mode --boot accepted"; fi
    echo "Free: switched off (a running server restarts once, --no-block); Starter on the 2 GiB VM of Free: off, no restart; self-hosted: nothing done; --image-mode --boot refused"'
fi
echo "test-customize: OK"

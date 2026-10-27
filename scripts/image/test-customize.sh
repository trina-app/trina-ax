#!/bin/bash
# Local proof of the template customization without KVM (H-05 pipeline test): run scripts/image/customize.sh twice in
# a privileged Debian 13 container with a FAKE Team AX kit (honours only the --image-mode contract) and the real Linux
# mycel-launcher (built here with Go), check the second run changes nothing, then run tests/linux/vm-smoke.sh --container.
#
#   bash scripts/image/test-customize.sh [--platform linux/amd64|linux/arm64] [--image debian:trixie] [--keep]
#
# Needs: docker (privileged containers), go (optional: without it the launcher / tcp-peer checks are skipped).
# Work folder: .tmp/image-test (git-ignored). The container is removed unless --keep.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLATFORM=""
IMAGE="debian:trixie"
KEEP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) PLATFORM="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
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
echo "test-customize: OK"

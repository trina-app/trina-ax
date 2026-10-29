#!/bin/bash
set -euo pipefail
cd /opt/mycel
install -m 755 /test-native/mycel-safeops /test-native/mycel-sandbox "$MYCEL_NATIVE_BIN/"
install -d /opt/safe1a-probe /opt/safe1a-fix
install -m 755 /test-native/safe-ops-probe /opt/safe1a-probe/mycel-safeops
cp /usr/bin/bwrap /opt/safe1a-fix/bwrap
ln -sf /opt/safe1a-fix/bwrap /usr/local/bin/bwrap
profile=0
cleanup() {
 umount /tmp/safe-fix-mount/root/nested || true
 if [[ "$profile" == 1 ]]; then apparmor_parser -R /tmp/safe1a-fix.apparmor; fi
}
trap cleanup EXIT
if [[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" == 1 ]]; then
 mountpoint -q /sys/kernel/security || mount -t securityfs securityfs /sys/kernel/security
 printf 'abi <abi/4.0>,\ninclude <tunables/global>\nprofile trina-safe1a-fix /opt/safe1a-fix/bwrap flags=(unconfined) {\n userns,\n}\n' > /tmp/safe1a-fix.apparmor
 apparmor_parser -r /tmp/safe1a-fix.apparmor
 profile=1
fi
mkdir -p /tmp/safe-fix-mount/root/nested /tmp/safe-fix-mount/source
printf synthetic > /tmp/safe-fix-mount/source/source
mount --bind /tmp/safe-fix-mount/source /tmp/safe-fix-mount/root/nested
mkdir -p /sys/fs/cgroup/init /sys/fs/cgroup/server
for p in $(cat /sys/fs/cgroup/cgroup.procs); do echo "$p" > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true; done
echo '+memory +pids +cpu' > /sys/fs/cgroup/cgroup.subtree_control
chown axserver:axserver /sys/fs/cgroup/server /sys/fs/cgroup/server/cgroup.procs /sys/fs/cgroup/server/cgroup.subtree_control /sys/fs/cgroup/server/cgroup.threads
echo $$ > /sys/fs/cgroup/server/cgroup.procs
setpriv --reuid axserver --regid axserver --init-groups env MYCEL_SAFE_OPS_BWRAP=/opt/safe1a-fix/bwrap MYCEL_SAFE_OPS_1A=1 MYCEL_WORK=/tmp/s1a-fix MYCEL_SANDBOX_HELPER="$MYCEL_NATIVE_BIN/mycel-sandbox" bun tests/linux/safe-ops.ts
setpriv --reuid axserver --regid axserver --init-groups env MYCEL_SAFE_OPS_BWRAP=/opt/safe1a-fix/bwrap MYCEL_SANDBOX_HELPER="$MYCEL_NATIVE_BIN/mycel-sandbox" MYCEL_WORK=/tmp/s1a-fix-review bun tests/linux/safe-ops-review.ts
setpriv --reuid axserver --regid axserver --init-groups /test-native/safebroker-tests -test.v
setpriv --reuid axserver --regid axserver --init-groups /test-native/safeops-tests -test.v
setpriv --reuid axserver --regid axserver --init-groups env MYCEL_WORK=/tmp/s1a-fix-units bun test tests/unit/safe-ops-review.test.ts
setpriv --reuid axserver --regid axserver --init-groups env PATH=/opt/safe1a-fix:/usr/local/bin:/usr/bin:/bin MYCEL_WORK=/tmp/s1a-fix-converters MYCEL_SANDBOX_HELPER="$MYCEL_NATIVE_BIN/mycel-sandbox" bun test --preload tests/linux/safe-ops-cgroups.ts tests/unit/c-tools.test.ts --test-name-pattern isolation

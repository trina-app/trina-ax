#!/bin/bash
set -euo pipefail
cd /opt/mycel
if [[ -d /test-native ]]; then install -m 755 /test-native/mycel-safeops /test-native/mycel-sandbox "$MYCEL_NATIVE_BIN/"; fi
if [[ -f /test-native/safe-ops-probe ]]; then install -d /opt/safe1a-probe; install -m 755 /test-native/safe-ops-probe /opt/safe1a-probe/mycel-safeops; fi
# Distinct test-only executable/profile: never change the host's installed bwrap policy.
install -d /opt/safe1a
cp /usr/bin/bwrap /opt/safe1a/bwrap
if [[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" == 1 ]]; then
  mountpoint -q /sys/kernel/security || mount -t securityfs securityfs /sys/kernel/security
  printf 'abi <abi/4.0>,\ninclude <tunables/global>\nprofile trina-safe1a-test /opt/safe1a/bwrap flags=(unconfined) {\n userns,\n}\n' > /tmp/safe1a.apparmor
  apparmor_parser -r /tmp/safe1a.apparmor
  trap 'apparmor_parser -R /tmp/safe1a.apparmor' EXIT
fi
mkdir -p /sys/fs/cgroup/init /sys/fs/cgroup/server
for p in $(cat /sys/fs/cgroup/cgroup.procs); do echo "$p" > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true; done
echo '+memory +pids +cpu' > /sys/fs/cgroup/cgroup.subtree_control
chown axserver:axserver /sys/fs/cgroup/server /sys/fs/cgroup/server/cgroup.procs /sys/fs/cgroup/server/cgroup.subtree_control /sys/fs/cgroup/server/cgroup.threads
echo $$ > /sys/fs/cgroup/server/cgroup.procs
setpriv --reuid axserver --regid axserver --init-groups env MYCEL_SAFE_OPS_BWRAP=/opt/safe1a/bwrap MYCEL_SAFE_OPS_1A=1 MYCEL_WORK=/tmp/s1a MYCEL_SANDBOX_HELPER="$MYCEL_NATIVE_BIN/mycel-sandbox" bun tests/linux/safe-ops.ts

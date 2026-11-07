#!/bin/sh
# HTML to PDF on Linux, in the container of tests/linux/Dockerfile.html-pdf (privileged, its own cgroup namespace),
# with each Debian browser:
#   1. tests/unit/html-pdf.test.ts under bwrap;
#   2. tests/linux/html-pdf-cgroup.ts: the server's own cgroup setup (S/main, S/conv, S/print) and the real
#      mycel-sandbox cgexec, prints in S/print leaves, their peaks, nothing left behind.
# Runs as root: in some VMs (colima's Ubuntu kernel restricts unprivileged user namespaces with AppArmor) bwrap cannot
# set up its network namespace as a plain account. The server refuses root unless NODE_ENV=test (bun test, and set
# below for the cgroup script) with MYCEL_HTML_PDF_TEST_AS_ROOT=1.
set -e
cd /sys/fs/cgroup
# a delegated "server cgroup" S like the unit's, this shell in it (the setup moves itself on to S/main)
mkdir -p init
echo $$ > init/cgroup.procs
echo "+memory +pids +cpu" > cgroup.subtree_control
mkdir -p S
echo $$ > S/cgroup.procs
cd /w
mkdir -p /tmp/w
status=0
for b in /usr/lib/chromium/chromium /usr/lib/chromium/chromium-headless-shell; do
  echo "== $b"
  MYCEL_WORK=/tmp/w MYCEL_HTML_PDF_TEST_AS_ROOT=1 MYCEL_HTML_PDF_BROWSER=$b MYCEL_FONT_DIR=/w/resources/fonts/pretendard \
    bun test tests/unit/html-pdf.test.ts > /tmp/unit.log 2>&1 || status=1
  grep -E '^\(fail\)| pass$| fail$' /tmp/unit.log
  NODE_ENV=test MYCEL_HTML_PDF_TEST_AS_ROOT=1 MYCEL_HTML_PDF_BROWSER=$b MYCEL_FONT_DIR=/w/resources/fonts/pretendard \
    bun tests/linux/html-pdf-cgroup.ts || status=1
done
exit $status

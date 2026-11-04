package main

import (
	"slices"
	"strings"
)

// The allow-list of design §6.3: the only argv hostd sends (hostd ec2.ts GUEST and MYCEL_CTL). Any other argv gives
// exit code 126 and does not run.
const mycelCtl = "/var/lib/mycel/root/mycel-ctl"

var exactArgv = [][]string{
	{"/usr/bin/cat", "/run/ax/enroll-status.json"},
	{"/usr/bin/rm", "-f", "/run/ax/enroll.json"},
	{"/usr/bin/df", "-B1", "/var/lib/mycel"},
	{"/usr/bin/systemctl", "is-system-running"},
}

// allowed: mycel-ctl with any args (hostd builds them with tenantCommandArgv; mycel-ctl checks them), or one exact argv
func allowed(argv []string) bool {
	if len(argv) == 0 {
		return false
	}
	for _, s := range argv {
		if strings.IndexByte(s, 0) >= 0 {
			return false
		}
	}
	if argv[0] == mycelCtl {
		return true
	}
	for _, x := range exactArgv {
		if slices.Equal(argv, x) {
			return true
		}
	}
	return false
}

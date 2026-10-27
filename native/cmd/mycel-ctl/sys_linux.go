//go:build linux

package main

import (
	"golang.org/x/sys/unix"
)

// landlockABI asks the kernel which Landlock ABI it offers (landlock_create_ruleset(NULL, 0, VERSION)); 0 = none.
func landlockABI() int {
	r, _, errno := unix.Syscall(unix.SYS_LANDLOCK_CREATE_RULESET, 0, 0, unix.LANDLOCK_CREATE_RULESET_VERSION)
	if errno != 0 {
		return 0
	}
	return int(r)
}

// diskUsage is statfs of a path (bytes).
func diskUsage(p string) (total, free, used uint64, err error) {
	var st unix.Statfs_t
	if err = unix.Statfs(p, &st); err != nil {
		return
	}
	bs := uint64(st.Bsize)
	return st.Blocks * bs, st.Bavail * bs, (st.Blocks - st.Bfree) * bs, nil
}

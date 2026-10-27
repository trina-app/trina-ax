//go:build !linux

package main

import "golang.org/x/sys/unix"

func landlockABI() int { return 0 }

func diskUsage(p string) (total, free, used uint64, err error) {
	var st unix.Statfs_t
	if err = unix.Statfs(p, &st); err != nil {
		return
	}
	bs := uint64(st.Bsize)
	return st.Blocks * bs, st.Bavail * bs, (st.Blocks - st.Bfree) * bs, nil
}

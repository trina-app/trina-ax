package main

import (
	"errors"
	"sync"

	"golang.org/x/sys/unix"
)

// openBeneath opens parts below dirfd with openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS): the
// kernel refuses any link on the way, the last component included (Linux 5.6+). Kernels or seccomp profiles without
// openat2 (ENOSYS / EPERM from an old container profile) fall back to the per-component O_NOFOLLOW walk.
func openBeneath(dirfd int, parts []string, flags int, mode uint32) (int, error) {
	rel := "."
	if len(parts) > 0 {
		rel = parts[0]
		for _, p := range parts[1:] {
			rel += "/" + p
		}
	}
	how := &unix.OpenHow{
		Flags:   uint64(flags | unix.O_CLOEXEC),
		Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS,
	}
	if flags&(unix.O_CREAT|unix.O_TMPFILE) != 0 {
		how.Mode = uint64(mode)
	}
	fd, err := unix.Openat2(dirfd, rel, how)
	if err == nil {
		return fd, nil
	}
	if errors.Is(err, unix.ENOSYS) || (errors.Is(err, unix.EPERM) && !openat2Works()) {
		return walkOpen(dirfd, parts, flags, mode)
	}
	return -1, err
}

var (
	openat2Once sync.Once
	openat2OK   bool
)

// openat2Works: an EPERM from openat2 is a seccomp filter only if openat2 fails on a plain "/" too.
func openat2Works() bool {
	openat2Once.Do(func() {
		fd, err := unix.Openat2(unix.AT_FDCWD, "/", &unix.OpenHow{Flags: unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC})
		if err == nil {
			_ = unix.Close(fd)
			openat2OK = true
		}
	})
	return openat2OK
}

package main

import (
	"errors"
	"fmt"

	"golang.org/x/sys/unix"
)

// readBoxFile reads a file that a box wrote, from the mounted box volume. boxd is root and the box writes this volume,
// so a box must not be able to make root read a host file, or wait for ever on a FIFO:
//   - openat2 with RESOLVE_NO_SYMLINKS refuses a link at any level, also a logs folder that is a link. RESOLVE_BENEATH
//     keeps the path below the volume, and RESOLVE_NO_XDEV keeps it on the volume's file system.
//   - O_NONBLOCK: an open of a FIFO does not wait.
//   - fstat of the open file, not of the path: only a regular file is read.
//   - at most max bytes, with pread. tail: the last max bytes, so a large log costs the same as a small one.
//
// A hard link cannot come from outside: a hard link stays on its file system, and the volume is a file system of its own.
func readBoxFile(vol, rel string, max int64, tail bool) ([]byte, error) {
	root, err := unix.Open(vol, unix.O_PATH|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	defer unix.Close(root)
	how := &unix.OpenHow{
		Flags:   unix.O_RDONLY | unix.O_NONBLOCK | unix.O_NOCTTY | unix.O_NOFOLLOW | unix.O_CLOEXEC,
		Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_NO_XDEV,
	}
	var fd int
	for i := 0; i < 3; i++ {
		fd, err = unix.Openat2(root, rel, how)
		// EAGAIN: a rename during the walk (the box can do that); the next poll reads again
		if !errors.Is(err, unix.EAGAIN) && !errors.Is(err, unix.EINTR) {
			break
		}
	}
	if err != nil {
		return nil, err
	}
	defer unix.Close(fd)
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return nil, err
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		return nil, fmt.Errorf("%s is not a regular file", rel)
	}
	n, off := st.Size, int64(0)
	if n > max {
		n = max
		if tail {
			off = st.Size - max
		}
	}
	buf := make([]byte, n)
	done := 0
	for done < len(buf) {
		k, err := unix.Pread(fd, buf[done:], off+int64(done))
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if k == 0 { // the box made the file shorter
			break
		}
		done += k
	}
	return buf[:done], nil
}

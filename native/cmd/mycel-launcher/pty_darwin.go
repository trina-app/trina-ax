package main

import (
	"bytes"
	"unsafe"

	"golang.org/x/sys/unix"
)

// unlockPT: grantpt + unlockpt + ptsname of macOS (TIOCPTYGRANT, TIOCPTYUNLK, TIOCPTYGNAME into a 128-byte buffer).
// x/sys/unix exports no pointer ioctl that fits TIOCPTYGNAME's buffer, so that one goes through Syscall.
func unlockPT(fd int) (string, error) {
	if err := unix.IoctlSetInt(fd, unix.TIOCPTYGRANT, 0); err != nil {
		return "", err
	}
	if err := unix.IoctlSetInt(fd, unix.TIOCPTYUNLK, 0); err != nil {
		return "", err
	}
	var buf [128]byte
	if _, _, e := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), uintptr(unix.TIOCPTYGNAME), uintptr(unsafe.Pointer(&buf[0]))); e != 0 {
		return "", e
	}
	return string(buf[:bytes.IndexByte(buf[:], 0)]), nil
}

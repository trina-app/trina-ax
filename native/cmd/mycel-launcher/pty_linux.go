package main

import (
	"strconv"

	"golang.org/x/sys/unix"
)

// unlockPT: unlockpt + ptsname of Linux (TIOCSPTLCK 0, TIOCGPTN). devpts gives the new terminal to the opener
// (the engine account), so there is no grantpt step.
func unlockPT(fd int) (string, error) {
	if err := unix.IoctlSetPointerInt(fd, unix.TIOCSPTLCK, 0); err != nil {
		return "", err
	}
	n, err := unix.IoctlGetUint32(fd, unix.TIOCGPTN)
	if err != nil {
		return "", err
	}
	return "/dev/pts/" + strconv.FormatUint(uint64(n), 10), nil
}

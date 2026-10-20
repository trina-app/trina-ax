package peer

import "golang.org/x/sys/unix"

func fromFd(fd int) (Cred, error) {
	pid, err := unix.GetsockoptInt(fd, unix.SOL_LOCAL, unix.LOCAL_PEERPID)
	if err != nil {
		return Cred{}, err
	}
	x, err := unix.GetsockoptXucred(fd, unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
	if err != nil {
		return Cred{}, err
	}
	gid := -1
	if x.Ngroups > 0 {
		gid = int(x.Groups[0])
	}
	return Cred{Pid: pid, Uid: int(x.Uid), Gid: gid}, nil
}

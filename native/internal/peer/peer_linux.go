package peer

import "golang.org/x/sys/unix"

func fromFd(fd int) (Cred, error) {
	u, err := unix.GetsockoptUcred(fd, unix.SOL_SOCKET, unix.SO_PEERCRED)
	if err != nil {
		return Cred{}, err
	}
	return Cred{Pid: int(u.Pid), Uid: int(u.Uid), Gid: int(u.Gid)}, nil
}

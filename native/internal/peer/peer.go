// Package peer reads the credentials of the process on the other end of a Unix socket
// (macOS LOCAL_PEERPID/LOCAL_PEERCRED, Linux SO_PEERCRED) plus its process group and session.
package peer

import (
	"fmt"
	"net"

	"golang.org/x/sys/unix"
)

type Cred struct {
	Pid  int `json:"pid"`
	Uid  int `json:"uid"`
	Gid  int `json:"gid"`
	Pgid int `json:"pgid"`
	Sid  int `json:"sid"`
}

// Of returns the peer credentials of a connected Unix socket.
func Of(c *net.UnixConn) (Cred, error) {
	raw, err := c.SyscallConn()
	if err != nil {
		return Cred{}, err
	}
	var cr Cred
	var inner error
	if err := raw.Control(func(fd uintptr) { cr, inner = fromFd(int(fd)) }); err != nil {
		return Cred{}, err
	}
	if inner != nil {
		return Cred{}, inner
	}
	if cr.Pid <= 0 {
		return Cred{}, fmt.Errorf("no peer pid")
	}
	// process group and session of the peer, read right away (the peer is still connected)
	if cr.Pgid, err = unix.Getpgid(cr.Pid); err != nil {
		return Cred{}, fmt.Errorf("getpgid(%d): %w", cr.Pid, err)
	}
	if cr.Sid, err = unix.Getsid(cr.Pid); err != nil {
		return Cred{}, fmt.Errorf("getsid(%d): %w", cr.Pid, err)
	}
	return cr, nil
}

// Pseudo-terminals for the Claude sign-in (claudelogin.go): `claude setup-token` is a full-screen program that refuses to
// run without a terminal, so the launcher opens one itself (golang.org/x/sys/unix only; the platform halves are
// pty_darwin.go and pty_linux.go). The engine side (the slave) becomes the program's stdin, stdout, stderr and
// controlling terminal; the launcher keeps the master and is the only reader and writer of the screen.
//
// The master stays a plain descriptor read with poll(2) and a short timeout, not an *os.File: a blocking read cannot be
// interrupted, and a process that kept the terminal open (it would have to escape the process group kill) must not
// keep a launcher thread waiting forever.
package main

import (
	"errors"
	"os"
	"sync"

	"golang.org/x/sys/unix"
)

// ptyPair is one pseudo-terminal: master (the launcher's end, a descriptor) and slave (the program's end, path name).
type ptyPair struct {
	mu     sync.Mutex
	master int
	slave  *os.File
	name   string
}

// openPTY opens a new pseudo-terminal of cols x rows. Both ends are close-on-exec: exec.Cmd hands the slave to the
// child as fds 0-2 itself.
func openPTY(cols, rows uint16) (*ptyPair, error) {
	mfd, err := unix.Open("/dev/ptmx", unix.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	name, err := unlockPT(mfd)
	if err != nil {
		unix.Close(mfd)
		return nil, err
	}
	sfd, err := unix.Open(name, unix.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if err != nil {
		unix.Close(mfd)
		return nil, err
	}
	if err := unix.IoctlSetWinsize(sfd, unix.TIOCSWINSZ, &unix.Winsize{Row: rows, Col: cols}); err != nil {
		unix.Close(sfd)
		unix.Close(mfd)
		return nil, err
	}
	return &ptyPair{master: mfd, slave: os.NewFile(uintptr(sfd), name), name: name}, nil
}

// errPTYClosed: read after close (or every process closed the terminal: EIO on Linux, end of file on macOS)
var errPTYClosed = errors.New("terminal closed")

// read waits up to waitMs for output and reads it; (0, nil) = nothing yet.
func (p *ptyPair) read(buf []byte, waitMs int) (int, error) {
	p.mu.Lock()
	fd := p.master
	p.mu.Unlock()
	if fd < 0 {
		return 0, errPTYClosed
	}
	fds := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
	n, err := unix.Poll(fds, waitMs)
	if err == unix.EINTR || (err == nil && n == 0) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if fds[0].Revents&(unix.POLLIN|unix.POLLHUP|unix.POLLERR|unix.POLLNVAL) == 0 {
		return 0, nil
	}
	r, err := unix.Read(fd, buf)
	if err == unix.EAGAIN || err == unix.EINTR {
		return 0, nil
	}
	if err != nil || r == 0 {
		return 0, errPTYClosed
	}
	return r, nil
}

// write sends keystrokes (the whole slice).
func (p *ptyPair) write(b []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.master < 0 {
		return errPTYClosed
	}
	for len(b) > 0 {
		n, err := unix.Write(p.master, b)
		if err == unix.EINTR || err == unix.EAGAIN {
			continue
		}
		if err != nil {
			return err
		}
		b = b[n:]
	}
	return nil
}

// closeSlave drops the launcher's copy of the slave once the program has it (end of file on the master then means
// every process of the program closed the terminal).
func (p *ptyPair) closeSlave() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.slave != nil {
		_ = p.slave.Close()
		p.slave = nil
	}
}

func (p *ptyPair) close() {
	p.closeSlave()
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.master >= 0 {
		_ = unix.Close(p.master)
		p.master = -1
	}
}

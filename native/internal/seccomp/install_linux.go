//go:build linux

package seccomp

import (
	"fmt"
	"runtime"
	"unsafe"

	"golang.org/x/sys/unix"
)

const (
	setModeFilter   = 1 // SECCOMP_SET_MODE_FILTER
	getActionAvail  = 2 // SECCOMP_GET_ACTION_AVAIL
	filterFlagTsync = 1 // SECCOMP_FILTER_FLAG_TSYNC
)

// Program is the filter for this architecture.
func Program(allowListen bool) ([]Insn, error) { return Build(NativeTable(), allowListen) }

// Install sets no_new_privs and loads the filter on every thread of the process (TSYNC: the Go runtime has several
// threads, and the one that later calls execve must carry the filter). The filter survives execve.
func Install(allowListen bool) error {
	prog, err := Program(allowListen)
	if err != nil {
		return err
	}
	filter := make([]unix.SockFilter, len(prog))
	for i, in := range prog {
		filter[i] = unix.SockFilter{Code: in.Code, Jt: in.Jt, Jf: in.Jf, K: in.K}
	}
	fprog := unix.SockFprog{Len: uint16(len(filter)), Filter: &filter[0]}
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		return fmt.Errorf("no_new_privs: %v", err)
	}
	r, _, e := unix.Syscall(unix.SYS_SECCOMP, setModeFilter, filterFlagTsync, uintptr(unsafe.Pointer(&fprog)))
	runtime.KeepAlive(filter)
	if e != 0 {
		return fmt.Errorf("seccomp: %v", e)
	}
	if r != 0 {
		return fmt.Errorf("seccomp: thread %d could not be synchronized", r)
	}
	return nil
}

// Available reports whether the kernel takes filters with the kill-process action (Linux 4.14+).
func Available() bool {
	action := RetKillProcess
	_, _, e := unix.Syscall(unix.SYS_SECCOMP, getActionAvail, 0, uintptr(unsafe.Pointer(&action)))
	return e == 0
}

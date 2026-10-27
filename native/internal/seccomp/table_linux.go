//go:build linux

package seccomp

import "golang.org/x/sys/unix"

// commonDeny: syscalls the engine never needs, answered with EPERM (spec 3.3.4 table). The numbers come from x/sys
// for the architecture being built; table_linux_<arch>.go adds what only that architecture has.
var commonDeny = []uint32{
	// new namespaces (bwrap --disable-userns already blocks user namespaces; this is the second layer)
	unix.SYS_UNSHARE, unix.SYS_SETNS,
	// file system structure
	unix.SYS_MOUNT, unix.SYS_UMOUNT2, unix.SYS_PIVOT_ROOT, unix.SYS_CHROOT, unix.SYS_MOVE_MOUNT, unix.SYS_OPEN_TREE,
	unix.SYS_OPEN_TREE_ATTR, unix.SYS_FSOPEN, unix.SYS_FSCONFIG, unix.SYS_FSMOUNT, unix.SYS_FSPICK, unix.SYS_MOUNT_SETATTR,
	// other processes' memory and descriptors, also inside the same turn
	unix.SYS_PTRACE, unix.SYS_PROCESS_VM_READV, unix.SYS_PROCESS_VM_WRITEV, unix.SYS_KCMP, unix.SYS_PIDFD_GETFD,
	// kernel attack surface; io_uring submissions would not pass through seccomp at all
	unix.SYS_PERF_EVENT_OPEN, unix.SYS_BPF, unix.SYS_USERFAULTFD,
	unix.SYS_IO_URING_SETUP, unix.SYS_IO_URING_ENTER, unix.SYS_IO_URING_REGISTER,
	// the kernel keyring is shared per uid: a channel between turns
	unix.SYS_KEYCTL, unix.SYS_ADD_KEY, unix.SYS_REQUEST_KEY,
	// administration an engine never does
	unix.SYS_INIT_MODULE, unix.SYS_FINIT_MODULE, unix.SYS_DELETE_MODULE, unix.SYS_KEXEC_LOAD, unix.SYS_KEXEC_FILE_LOAD,
	unix.SYS_REBOOT, unix.SYS_SWAPON, unix.SYS_SWAPOFF, unix.SYS_SYSLOG, unix.SYS_ACCT, unix.SYS_QUOTACTL,
	unix.SYS_QUOTACTL_FD, unix.SYS_SETTIMEOFDAY, unix.SYS_CLOCK_SETTIME, unix.SYS_CLOCK_ADJTIME, unix.SYS_ADJTIMEX,
	unix.SYS_OPEN_BY_HANDLE_AT, unix.SYS_NAME_TO_HANDLE_AT, unix.SYS_FANOTIFY_INIT, unix.SYS_VHANGUP,
	unix.SYS_LOOKUP_DCOOKIE,
}

func table(arch uint32, x32 bool, extra ...uint32) Table {
	return Table{
		AuditArch: arch, X32: x32,
		Clone: unix.SYS_CLONE, Clone3: unix.SYS_CLONE3, Ioctl: unix.SYS_IOCTL, Socket: unix.SYS_SOCKET,
		Personality: unix.SYS_PERSONALITY, Listen: unix.SYS_LISTEN,
		Deny: append(append([]uint32{}, commonDeny...), extra...),
	}
}

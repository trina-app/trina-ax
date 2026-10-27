//go:build linux && amd64

package seccomp

import "golang.org/x/sys/unix"

// NativeTable is the policy table of the architecture this binary runs on.
func NativeTable() Table {
	return table(unix.AUDIT_ARCH_X86_64, true,
		// x86-64 only: port I/O and long-obsolete calls
		unix.SYS_IOPL, unix.SYS_IOPERM, unix.SYS_USELIB, unix.SYS_USTAT, unix.SYS_SYSFS, unix.SYS__SYSCTL,
		unix.SYS_NFSSERVCTL, unix.SYS_CREATE_MODULE, unix.SYS_GET_KERNEL_SYMS, unix.SYS_QUERY_MODULE)
}

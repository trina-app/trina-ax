//go:build linux && arm64

package seccomp

import "golang.org/x/sys/unix"

// NativeTable is the policy table of the architecture this binary runs on (arm64 has none of the x86-64-only calls
// and no x32 ABI; nfsservctl still has a number there).
func NativeTable() Table {
	return table(unix.AUDIT_ARCH_AARCH64, false, unix.SYS_NFSSERVCTL)
}

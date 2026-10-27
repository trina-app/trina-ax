//go:build linux

// Package landlock restricts what the engine may execute (linux-runtime spec 3.3.4, table 3.3.5): only the engine's
// own folder, the bridge and the dynamic loader. bwrap already hides system programs (nothing of /usr/bin is mounted),
// but the engine can write an ELF into its chat folder, and bind mounts are never noexec; Landlock's
// LANDLOCK_ACCESS_FS_EXECUTE closes that. On kernels with ABI 6 (Linux 6.12+) the same domain also scopes abstract
// unix sockets and signals to this turn (another turn's @socket or processes outside the sandbox are out of reach).
//
// The ruleset handles only EXECUTE: reading and writing stay governed by what bwrap mounts. A domain is attached to
// the calling thread, so the caller must hold runtime.LockOSThread from here until its execve; it survives execve.
// Structures are written by hand (sizes per ABI) instead of x/sys types, whose layout follows the newest kernel.
package landlock

import (
	"encoding/binary"
	"fmt"
	"os"
	"runtime"
	"unsafe"

	"golang.org/x/sys/unix"
)

const (
	createRulesetVersion = 1 // LANDLOCK_CREATE_RULESET_VERSION
	rulePathBeneath      = 1 // LANDLOCK_RULE_PATH_BENEATH

	// AccessFSExecute is LANDLOCK_ACCESS_FS_EXECUTE (ABI 1).
	AccessFSExecute = 1
	// ScopeAbstractUnixSocket and ScopeSignal are the ABI 6 scopes.
	ScopeAbstractUnixSocket = 1
	ScopeSignal             = 2
)

// Mode is the launcher's --landlock value.
type Mode string

const (
	Off            Mode = "off"
	BestEffort     Mode = "best-effort"
	Required       Mode = "required"
	RequiredScoped Mode = "required-scoped"
)

// ParseMode checks a --landlock value.
func ParseMode(s string) (Mode, error) {
	switch m := Mode(s); m {
	case Off, BestEffort, Required, RequiredScoped:
		return m, nil
	}
	return "", fmt.Errorf("--landlock takes off, best-effort, required or required-scoped, not %q", s)
}

// ABI returns the kernel's Landlock ABI version, 0 when Landlock is missing or disabled at boot.
func ABI() int {
	r, _, e := unix.Syscall(unix.SYS_LANDLOCK_CREATE_RULESET, 0, 0, createRulesetVersion)
	if e != 0 {
		return 0
	}
	return int(r)
}

// Result says what was applied.
type Result struct {
	ABI     int
	Applied bool
	Scoped  bool
	Skipped []string // best-effort: allow-list paths that could not be added
}

// rulesetAttr encodes struct landlock_ruleset_attr in the size the ABI knows: handled_access_fs (ABI 1-3, 8 bytes),
// + handled_access_net (ABI 4-5, 16 bytes), + scoped (ABI 6+, 24 bytes).
func rulesetAttr(abi int, scoped bool) []byte {
	size := 8
	switch {
	case abi >= 6:
		size = 24
	case abi >= 4:
		size = 16
	}
	b := make([]byte, size)
	binary.LittleEndian.PutUint64(b[0:], AccessFSExecute)
	if size >= 24 && scoped {
		binary.LittleEndian.PutUint64(b[16:], ScopeAbstractUnixSocket|ScopeSignal)
	}
	return b
}

// pathBeneathAttr encodes the packed struct landlock_path_beneath_attr (u64 allowed_access, s32 parent_fd; 12 bytes).
func pathBeneathAttr(access uint64, fd int) []byte {
	b := make([]byte, 12)
	binary.LittleEndian.PutUint64(b[0:], access)
	binary.LittleEndian.PutUint32(b[8:], uint32(int32(fd)))
	return b
}

// RestrictExec limits execution to the given paths (a folder allows everything below it, a file only itself) for the
// calling thread and everything it executes. Mode semantics (spec 3.3.4): off does nothing; best-effort applies what
// the kernel supports and skips missing paths; required needs ABI >= 1; required-scoped needs ABI >= 6. Whenever the
// ABI is >= 6 the abstract-socket and signal scopes are applied too. The caller holds runtime.LockOSThread.
func RestrictExec(mode Mode, allow []string) (Result, error) {
	res := Result{}
	if mode == Off {
		return res, nil
	}
	res.ABI = ABI()
	switch {
	case mode == Required && res.ABI < 1:
		return res, fmt.Errorf("landlock required but the kernel has none (ABI 0)")
	case mode == RequiredScoped && res.ABI < 6:
		return res, fmt.Errorf("landlock required-scoped needs ABI 6 (Linux 6.12+), the kernel has ABI %d", res.ABI)
	case res.ABI < 1:
		return res, nil // best-effort without Landlock
	}
	res.Scoped = res.ABI >= 6
	attr := rulesetAttr(res.ABI, res.Scoped)
	rfd, _, e := unix.Syscall(unix.SYS_LANDLOCK_CREATE_RULESET, uintptr(unsafe.Pointer(&attr[0])), uintptr(len(attr)), 0)
	runtime.KeepAlive(attr)
	if e != 0 {
		if mode == BestEffort {
			return Result{ABI: res.ABI}, nil
		}
		return res, fmt.Errorf("landlock_create_ruleset: %v", e)
	}
	ruleset := int(rfd)
	defer unix.Close(ruleset)
	for _, p := range allow {
		if err := addRule(ruleset, p); err != nil {
			if mode == BestEffort {
				res.Skipped = append(res.Skipped, p)
				continue
			}
			return res, err
		}
	}
	// no_new_privs is the condition for an unprivileged landlock_restrict_self (it also covers the seccomp filter)
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		return res, fmt.Errorf("no_new_privs: %v", err)
	}
	if _, _, e := unix.Syscall(unix.SYS_LANDLOCK_RESTRICT_SELF, uintptr(ruleset), 0, 0); e != 0 {
		return res, fmt.Errorf("landlock_restrict_self: %v", e)
	}
	res.Applied = true
	return res, nil
}

func addRule(ruleset int, p string) error {
	fd, err := unix.Open(p, unix.O_PATH|unix.O_CLOEXEC, 0)
	if err != nil {
		return &os.PathError{Op: "landlock allow", Path: p, Err: err}
	}
	defer unix.Close(fd)
	attr := pathBeneathAttr(AccessFSExecute, fd)
	_, _, e := unix.Syscall6(unix.SYS_LANDLOCK_ADD_RULE, uintptr(ruleset), rulePathBeneath, uintptr(unsafe.Pointer(&attr[0])), 0, 0, 0)
	runtime.KeepAlive(attr)
	if e != 0 {
		return &os.PathError{Op: "landlock_add_rule", Path: p, Err: e}
	}
	return nil
}

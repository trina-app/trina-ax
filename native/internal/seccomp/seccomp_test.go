//go:build linux

package seccomp

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"testing"
	"unsafe"

	"golang.org/x/sys/unix"
)

// ---------- the program itself, through the cBPF interpreter (no kernel needed; runs under emulation too) ----------

func mustProg(t *testing.T, allowListen bool) []Insn {
	t.Helper()
	p, err := Program(allowListen)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func act(t *testing.T, p []Insn, nr uint32, args ...uint64) uint32 {
	t.Helper()
	d := Data{Nr: nr, Arch: NativeTable().AuditArch}
	copy(d.Args[:], args)
	r, err := Run(p, d)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

const (
	eperm  = RetErrno | errEPERM
	enosys = RetErrno | errENOSYS
	eafno  = RetErrno | errEAFNOSUPPORT
)

func TestPolicyTable(t *testing.T) {
	p := mustProg(t, false)
	tb := NativeTable()
	for _, nr := range tb.Deny {
		if a := act(t, p, nr); a != eperm {
			t.Errorf("syscall %d: action %#x, want EPERM", nr, a)
		}
	}
	if len(tb.Deny) < 40 {
		t.Errorf("deny list too short: %d", len(tb.Deny))
	}
	for _, nr := range []uint32{unix.SYS_READ, unix.SYS_WRITE, unix.SYS_OPENAT, unix.SYS_EXECVE, unix.SYS_EXECVEAT, unix.SYS_MMAP,
		unix.SYS_CONNECT, unix.SYS_BIND, unix.SYS_ACCEPT4, unix.SYS_LANDLOCK_CREATE_RULESET, unix.SYS_MEMFD_CREATE, unix.SYS_KILL, unix.SYS_WAIT4} {
		if a := act(t, p, nr); a != RetAllow {
			t.Errorf("syscall %d: action %#x, want ALLOW", nr, a)
		}
	}
	if act(t, p, unix.SYS_CLONE3) != enosys {
		t.Error("clone3 not ENOSYS")
	}
	if act(t, p, unix.SYS_LISTEN) != eperm || act(t, mustProg(t, true), unix.SYS_LISTEN) != RetAllow {
		t.Error("listen rule")
	}
	// clone: namespace flags refused, ordinary thread / fork flags allowed, upper half ignored like the kernel does
	for _, f := range []uint64{unix.CLONE_NEWNS, unix.CLONE_NEWCGROUP, unix.CLONE_NEWUTS, unix.CLONE_NEWIPC, unix.CLONE_NEWUSER, unix.CLONE_NEWPID, unix.CLONE_NEWNET} {
		if act(t, p, unix.SYS_CLONE, f|uint64(unix.SIGCHLD)) != eperm {
			t.Errorf("clone %#x allowed", f)
		}
		if act(t, p, unix.SYS_CLONE, 0xffffffff00000000|f) != eperm {
			t.Errorf("clone %#x with upper bits allowed", f)
		}
	}
	thread := uint64(unix.CLONE_VM | unix.CLONE_FS | unix.CLONE_FILES | unix.CLONE_SIGHAND | unix.CLONE_THREAD | unix.CLONE_SYSVSEM | unix.CLONE_SETTLS | unix.CLONE_PARENT_SETTID | unix.CLONE_CHILD_CLEARTID)
	for _, f := range []uint64{uint64(unix.SIGCHLD), thread, unix.CLONE_VM | unix.CLONE_VFORK | uint64(unix.SIGCHLD), 0xffffffff00000000 | uint64(unix.SIGCHLD)} {
		if act(t, p, unix.SYS_CLONE, f) != RetAllow {
			t.Errorf("clone %#x refused", f)
		}
	}
	// ioctl: TIOCSTI / TIOCLINUX by the low 32 bits of the request
	for _, req := range []uint64{unix.TIOCSTI, unix.TIOCLINUX, 0xdead00000000 | unix.TIOCSTI} {
		if act(t, p, unix.SYS_IOCTL, 0, req) != eperm {
			t.Errorf("ioctl %#x allowed", req)
		}
	}
	for _, req := range []uint64{unix.TCGETS, 0x541b /* FIONREAD */, unix.TIOCGWINSZ} {
		if act(t, p, unix.SYS_IOCTL, 0, req) != RetAllow {
			t.Errorf("ioctl %#x refused", req)
		}
	}
	// socket families
	for _, fam := range []uint64{unix.AF_UNIX, unix.AF_INET, unix.AF_INET6} {
		if act(t, p, unix.SYS_SOCKET, fam, unix.SOCK_STREAM) != RetAllow {
			t.Errorf("socket family %d refused", fam)
		}
	}
	if act(t, p, unix.SYS_SOCKET, unix.AF_NETLINK, unix.SOCK_RAW, unix.NETLINK_ROUTE) != RetAllow {
		t.Error("netlink route refused")
	}
	for _, proto := range []uint64{unix.NETLINK_AUDIT, unix.NETLINK_KOBJECT_UEVENT, unix.NETLINK_SOCK_DIAG, unix.NETLINK_NETFILTER} {
		if act(t, p, unix.SYS_SOCKET, unix.AF_NETLINK, unix.SOCK_RAW, proto) != eafno {
			t.Errorf("netlink proto %d allowed", proto)
		}
	}
	for _, fam := range []uint64{unix.AF_PACKET, unix.AF_VSOCK, unix.AF_ALG, unix.AF_BLUETOOTH, unix.AF_KEY, 0x100000000 | unix.AF_PACKET} {
		if act(t, p, unix.SYS_SOCKET, fam, unix.SOCK_RAW) != eafno {
			t.Errorf("socket family %#x allowed", fam)
		}
	}
	// personality
	for _, v := range []uint64{0, 8, 0x20000, 0x20008, 0xffffffff} {
		if act(t, p, unix.SYS_PERSONALITY, v) != RetAllow {
			t.Errorf("personality %#x refused", v)
		}
	}
	for _, v := range []uint64{0x0040000 /* ADDR_NO_RANDOMIZE */, 0x0400000 /* READ_IMPLIES_EXEC */, 0x1} {
		if act(t, p, unix.SYS_PERSONALITY, v) != eperm {
			t.Errorf("personality %#x allowed", v)
		}
	}
	// another architecture's ABI is killed
	if r, _ := Run(p, Data{Nr: unix.SYS_READ, Arch: 0x40000003 /* i386 */}); r != RetKillProcess {
		t.Errorf("foreign arch: %#x", r)
	}
	if tb.X32 {
		if r, _ := Run(p, Data{Nr: 0x40000000 | unix.SYS_READ, Arch: tb.AuditArch}); r != RetKillProcess {
			t.Errorf("x32 syscall: %#x", r)
		}
	}
}

// ---------- the real kernel: a child installs the filter and reports errnos ----------

const childEnv = "MYCEL_SECCOMP_TEST_CHILD"

func TestMain(m *testing.M) {
	switch os.Getenv(childEnv) {
	case "":
		os.Exit(m.Run())
	case "exit":
		os.Exit(0)
	default:
		child(os.Getenv(childEnv))
	}
}

func errName(err error) string {
	if err == nil {
		return "ok"
	}
	var e unix.Errno
	if errors.As(err, &e) {
		return unix.ErrnoName(e)
	}
	return err.Error()
}

func raw(nr uintptr, a ...uintptr) error {
	var x [6]uintptr
	copy(x[:], a)
	_, _, e := unix.Syscall6(nr, x[0], x[1], x[2], x[3], x[4], x[5])
	if e != 0 {
		return e
	}
	return nil
}

func sock(fam, typ, proto int) error {
	fd, err := unix.Socket(fam, typ|unix.SOCK_CLOEXEC, proto)
	if err == nil {
		unix.Close(fd)
	}
	return err
}

func child(mode string) {
	runtime.LockOSThread()
	if mode == "filter" || mode == "filter-listen" {
		if err := Install(mode == "filter-listen"); err != nil {
			os.Stdout.WriteString(`{"install":"` + err.Error() + `"}`)
			os.Exit(1)
		}
	}
	devnull, _ := unix.Open("/dev/null", unix.O_RDWR|unix.O_CLOEXEC, 0)
	c := byte('x')
	thread := uintptr(unix.CLONE_THREAD) // invalid without CLONE_SIGHAND: the kernel answers EINVAL, the filter EPERM
	probes := []struct {
		name string
		f    func() error
	}{
		{"read", func() error { _, err := os.ReadFile("/proc/self/status"); return err }},
		{"socket_inet", func() error { return sock(unix.AF_INET, unix.SOCK_STREAM, 0) }},
		{"socket_inet6", func() error { return sock(unix.AF_INET6, unix.SOCK_STREAM, 0) }},
		{"socket_unix", func() error { return sock(unix.AF_UNIX, unix.SOCK_STREAM, 0) }},
		{"socket_netlink_route", func() error { return sock(unix.AF_NETLINK, unix.SOCK_RAW, unix.NETLINK_ROUTE) }},
		{"socket_netlink_audit", func() error { return sock(unix.AF_NETLINK, unix.SOCK_RAW, unix.NETLINK_AUDIT) }},
		{"socket_packet", func() error { return sock(unix.AF_PACKET, unix.SOCK_RAW, 0) }},
		{"socket_vsock", func() error { return sock(unix.AF_VSOCK, unix.SOCK_STREAM, 0) }},
		{"socket_alg", func() error { return sock(unix.AF_ALG, unix.SOCK_SEQPACKET, 0) }},
		{"clone3", func() error { return raw(unix.SYS_CLONE3, 0, 0) }},
		{"clone_newuser", func() error { return raw(unix.SYS_CLONE, unix.CLONE_NEWUSER|thread) }},
		{"clone_newns", func() error { return raw(unix.SYS_CLONE, unix.CLONE_NEWNS|thread) }},
		{"clone_newpid", func() error { return raw(unix.SYS_CLONE, unix.CLONE_NEWPID|thread) }},
		{"clone_newnet", func() error { return raw(unix.SYS_CLONE, unix.CLONE_NEWNET|thread) }},
		{"fork_exec", func() error {
			cmd := exec.Command(os.Args[0])
			cmd.Env = append(os.Environ(), childEnv+"=exit")
			return cmd.Run()
		}},
		{"unshare", func() error { return raw(unix.SYS_UNSHARE, unix.CLONE_NEWUSER) }},
		{"setns", func() error { return raw(unix.SYS_SETNS, ^uintptr(0), 0) }},
		{"mount", func() error { return raw(unix.SYS_MOUNT) }},
		{"umount2", func() error { return raw(unix.SYS_UMOUNT2) }},
		{"chroot", func() error { return raw(unix.SYS_CHROOT) }},
		{"open_tree", func() error { return raw(unix.SYS_OPEN_TREE, ^uintptr(0)) }},
		{"fsopen", func() error { return raw(unix.SYS_FSOPEN) }},
		{"ptrace", func() error { return raw(unix.SYS_PTRACE, 0xffff) }},
		{"process_vm_readv", func() error { return raw(unix.SYS_PROCESS_VM_READV) }},
		{"process_vm_writev", func() error { return raw(unix.SYS_PROCESS_VM_WRITEV) }},
		{"kcmp", func() error { return raw(unix.SYS_KCMP, 0, 0, ^uintptr(0)) }},
		{"pidfd_getfd", func() error { return raw(unix.SYS_PIDFD_GETFD, ^uintptr(0)) }},
		{"perf_event_open", func() error { return raw(unix.SYS_PERF_EVENT_OPEN, 0, 0, ^uintptr(0), ^uintptr(0)) }},
		{"bpf", func() error { return raw(unix.SYS_BPF, ^uintptr(0)) }},
		{"userfaultfd", func() error { return raw(unix.SYS_USERFAULTFD, 0xffff) }},
		{"io_uring_setup", func() error { return raw(unix.SYS_IO_URING_SETUP) }},
		{"io_uring_enter", func() error { return raw(unix.SYS_IO_URING_ENTER, ^uintptr(0)) }},
		{"keyctl", func() error { return raw(unix.SYS_KEYCTL, ^uintptr(0)) }},
		{"add_key", func() error { return raw(unix.SYS_ADD_KEY) }},
		{"request_key", func() error { return raw(unix.SYS_REQUEST_KEY) }},
		{"delete_module", func() error { return raw(unix.SYS_DELETE_MODULE) }},
		{"adjtimex", func() error { return raw(unix.SYS_ADJTIMEX) }},
		{"clock_settime", func() error { return raw(unix.SYS_CLOCK_SETTIME) }},
		{"name_to_handle_at", func() error { return raw(unix.SYS_NAME_TO_HANDLE_AT, ^uintptr(0)) }},
		{"tiocsti", func() error { return raw(unix.SYS_IOCTL, uintptr(devnull), unix.TIOCSTI, uintptr(unsafe.Pointer(&c))) }},
		{"tiocsti_upper", func() error {
			return raw(unix.SYS_IOCTL, uintptr(devnull), uintptr(0xdead00000000|unix.TIOCSTI), uintptr(unsafe.Pointer(&c)))
		}},
		{"tcgets", func() error { _, err := unix.IoctlGetTermios(devnull, unix.TCGETS); return err }},
		{"personality_query", func() error { return raw(unix.SYS_PERSONALITY, 0xffffffff) }},
		{"personality_norandom", func() error { return raw(unix.SYS_PERSONALITY, 0x0040000) }},
		{"listen", func() error {
			fd, err := unix.Socket(unix.AF_INET, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
			if err != nil {
				return err
			}
			defer unix.Close(fd)
			if err := unix.Bind(fd, &unix.SockaddrInet4{Addr: [4]byte{127, 0, 0, 1}}); err != nil {
				return err
			}
			return unix.Listen(fd, 1)
		}},
	}
	out := map[string]string{}
	for _, p := range probes {
		out[p.name] = errName(p.f())
	}
	b, _ := json.Marshal(out)
	os.Stdout.Write(b)
	os.Exit(0)
}

func runChild(t *testing.T, mode string) map[string]string {
	t.Helper()
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), childEnv+"="+mode)
	b, err := cmd.Output()
	if err != nil {
		t.Fatalf("child %s: %v %s", mode, err, b)
	}
	var m map[string]string
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("child %s: %v %s", mode, err, b)
	}
	return m
}

func TestKernel(t *testing.T) {
	if os.Getenv("MYCEL_SECCOMP_EMULATED") == "1" || !Available() {
		t.Skip("no seccomp here (CPU emulation or old kernel)")
	}
	f := runChild(t, "filter")
	ctl := runChild(t, "control")
	want := map[string]string{
		"read": "ok", "socket_inet": "ok", "socket_inet6": "ok", "socket_unix": "ok", "socket_netlink_route": "ok",
		"socket_netlink_audit": "EAFNOSUPPORT", "socket_packet": "EAFNOSUPPORT", "socket_vsock": "EAFNOSUPPORT", "socket_alg": "EAFNOSUPPORT",
		"clone3": "ENOSYS", "fork_exec": "ok", "tcgets": "ENOTTY", "personality_query": "ok", "personality_norandom": "EPERM",
		"tiocsti": "EPERM", "tiocsti_upper": "EPERM", "listen": "EPERM",
	}
	for _, k := range []string{"clone_newuser", "clone_newns", "clone_newpid", "clone_newnet", "unshare", "setns", "mount", "umount2",
		"chroot", "open_tree", "fsopen", "ptrace", "process_vm_readv", "process_vm_writev", "kcmp", "pidfd_getfd", "perf_event_open",
		"bpf", "userfaultfd", "io_uring_setup", "io_uring_enter", "keyctl", "add_key", "request_key", "delete_module", "adjtimex",
		"clock_settime", "name_to_handle_at"} {
		want[k] = "EPERM"
	}
	for k, v := range want {
		if f[k] != v {
			t.Errorf("%s under the filter: %s, want %s (without the filter: %s)", k, f[k], v, ctl[k])
		}
	}
	// the control run proves the kernel would have answered differently: the result above is the filter's
	differs := 0
	for k, v := range want {
		if ctl[k] != v {
			differs++
		}
	}
	if differs < 25 {
		t.Errorf("only %d probes differ without the filter: %v", differs, ctl)
	}
	t.Logf("%d/%d probes answer differently without the filter", differs, len(want))
	if l := runChild(t, "filter-listen"); l["listen"] != "ok" || l["ptrace"] != "EPERM" {
		t.Errorf("--allow-listen: listen %s ptrace %s", l["listen"], l["ptrace"])
	}
}

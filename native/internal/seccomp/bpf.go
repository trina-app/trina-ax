// Package seccomp builds and installs the engine's seccomp filter (linux-runtime spec 3.3.4): default ALLOW plus a
// deny list that answers with an errno, so a program that probes for a feature fails normally instead of dying. What
// runs is still limited by Landlock (execute) and bwrap (what exists); this filter removes kernel surface the engine
// never needs: new namespaces, mounts, ptrace and cross-process memory, io_uring/bpf/perf/userfaultfd, the kernel
// keyring (shared per uid = a channel between turns), terminal input injection (TIOCSTI), socket families other than
// unix/inet/netlink-route, and listening sockets (a turn must not wait for another turn's connections).
//
// The BPF program is assembled here with labels (no libseccomp, no new dependency). This file is portable so the
// assembler and the small cBPF interpreter used by the tests compile everywhere; the per-architecture syscall tables
// and the installation are Linux only.
package seccomp

import "fmt"

// Insn is one classic BPF instruction (struct sock_filter).
type Insn struct {
	Code   uint16
	Jt, Jf uint8
	K      uint32
}

// classic BPF opcodes used here
const (
	ldWAbs  = 0x00 | 0x00 | 0x20 // BPF_LD | BPF_W | BPF_ABS
	jmpJeqK = 0x05 | 0x10 | 0x00 // BPF_JMP | BPF_JEQ | BPF_K
	jmpJgeK = 0x05 | 0x30 | 0x00 // BPF_JMP | BPF_JGE | BPF_K
	jmpJset = 0x05 | 0x40 | 0x00 // BPF_JMP | BPF_JSET | BPF_K
	retK    = 0x06 | 0x00        // BPF_RET | BPF_K
)

// seccomp return actions (linux/seccomp.h)
const (
	RetKillProcess uint32 = 0x80000000
	RetErrno       uint32 = 0x00050000
	RetAllow       uint32 = 0x7fff0000
)

// struct seccomp_data offsets. Both supported architectures are little-endian, so the low 32 bits of argument i are
// at 16 + 8*i.
const (
	offNr   = 0
	offArch = 4
)

func argLo(i int) uint32 { return uint32(16 + 8*i) }

// errno values (identical on amd64 and arm64; kept here so this file stays portable)
const (
	errEPERM        = 1
	errENOSYS       = 38
	errEAFNOSUPPORT = 97
)

// ABI constants the policy compares arguments with (identical on amd64 and arm64)
const (
	afUnix       = 1
	afInet       = 2
	afInet6      = 10
	afNetlink    = 16
	netlinkRoute = 0
	tiocsti      = 0x5412
	tioclinux    = 0x541c
	// clone flags that create namespaces (CLONE_NEWNS|NEWCGROUP|NEWUTS|NEWIPC|NEWUSER|NEWPID|NEWNET). The kernel uses
	// only the low 32 bits of clone()'s flags, so testing those is exact.
	cloneNSMask = 0x00020000 | 0x02000000 | 0x04000000 | 0x08000000 | 0x10000000 | 0x20000000 | 0x40000000
	x32Bit      = 0x40000000
)

// personality values programs legitimately ask for (Docker's default profile allows the same): PER_LINUX,
// PER_LINUX|UNAME26 (0x0020008), PER_LINUX32 (0x8), UNAME26 (0x20000), and 0xffffffff (query only).
var allowedPersonality = []uint32{0x0, 0x8, 0x20000, 0x20008, 0xffffffff}

// Table is one architecture's numbers for the policy.
type Table struct {
	AuditArch uint32
	// X32 kills syscalls with the x32 bit (amd64 only: x32 numbers would bypass a filter keyed on 64-bit numbers)
	X32                                       bool
	Clone, Clone3, Ioctl, Socket, Personality uint32
	Listen                                    uint32
	Deny                                      []uint32 // answered with EPERM
}

// assembler with symbolic jump targets
type asm struct {
	ins    []pend
	labels map[string]int
}

type pend struct {
	Insn
	jt, jf string // "" = fall through
}

func (a *asm) label(n string) { a.labels[n] = len(a.ins) }
func (a *asm) ld(off uint32)  { a.ins = append(a.ins, pend{Insn: Insn{Code: ldWAbs, K: off}}) }
func (a *asm) ret(k uint32)   { a.ins = append(a.ins, pend{Insn: Insn{Code: retK, K: k}}) }
func (a *asm) jeq(k uint32, t, f string) {
	a.ins = append(a.ins, pend{Insn: Insn{Code: jmpJeqK, K: k}, jt: t, jf: f})
}
func (a *asm) jge(k uint32, t, f string) {
	a.ins = append(a.ins, pend{Insn: Insn{Code: jmpJgeK, K: k}, jt: t, jf: f})
}
func (a *asm) jset(k uint32, t, f string) {
	a.ins = append(a.ins, pend{Insn: Insn{Code: jmpJset, K: k}, jt: t, jf: f})
}

func (a *asm) assemble() ([]Insn, error) {
	out := make([]Insn, len(a.ins))
	rel := func(i int, l string) (uint8, error) {
		if l == "" {
			return 0, nil
		}
		t, ok := a.labels[l]
		if !ok {
			return 0, fmt.Errorf("seccomp: unknown label %q", l)
		}
		d := t - (i + 1)
		if d < 0 || d > 255 {
			return 0, fmt.Errorf("seccomp: jump to %q out of range (%d)", l, d)
		}
		return uint8(d), nil
	}
	for i, p := range a.ins {
		var err error
		out[i] = p.Insn
		if out[i].Jt, err = rel(i, p.jt); err != nil {
			return nil, err
		}
		if out[i].Jf, err = rel(i, p.jf); err != nil {
			return nil, err
		}
	}
	if len(out) > 4096 {
		return nil, fmt.Errorf("seccomp: program too long")
	}
	return out, nil
}

// Build assembles the policy for one architecture table.
func Build(t Table, allowListen bool) ([]Insn, error) {
	a := &asm{labels: map[string]int{}}
	a.ld(offArch)
	a.jeq(t.AuditArch, "", "kill") // another ABI (32-bit compat) would see a different syscall table
	a.ld(offNr)
	if t.X32 {
		a.jge(x32Bit, "kill", "")
	}
	a.jeq(t.Clone3, "enosys", "") // clone3 hides its flags in memory: make libc fall back to clone()
	a.jeq(t.Clone, "clone", "")
	a.jeq(t.Ioctl, "ioctl", "")
	a.jeq(t.Socket, "socket", "")
	a.jeq(t.Personality, "personality", "")
	if !allowListen {
		a.jeq(t.Listen, "eperm", "")
	}
	for _, nr := range t.Deny {
		a.jeq(nr, "eperm", "")
	}
	a.ret(RetAllow)

	a.label("clone")
	a.ld(argLo(0))
	a.jset(cloneNSMask, "eperm", "allow")

	a.label("ioctl")
	a.ld(argLo(1)) // the request is an unsigned int: the kernel ignores the upper half
	a.jeq(tiocsti, "eperm", "")
	a.jeq(tioclinux, "eperm", "allow")

	a.label("socket")
	a.ld(argLo(0))
	a.jeq(afUnix, "allow", "")
	a.jeq(afInet, "allow", "")
	a.jeq(afInet6, "allow", "")
	a.jeq(afNetlink, "", "eafnosupport")
	a.ld(argLo(2)) // netlink: only ROUTE (interface lists); audit, uevent, sock_diag ... are refused
	a.jeq(netlinkRoute, "allow", "eafnosupport")

	a.label("personality")
	a.ld(argLo(0))
	for i, v := range allowedPersonality {
		f := ""
		if i == len(allowedPersonality)-1 {
			f = "eperm"
		}
		a.jeq(v, "allow", f)
	}

	a.label("allow")
	a.ret(RetAllow)
	a.label("eperm")
	a.ret(RetErrno | errEPERM)
	a.label("enosys")
	a.ret(RetErrno | errENOSYS)
	a.label("eafnosupport")
	a.ret(RetErrno | errEAFNOSUPPORT)
	a.label("kill")
	a.ret(RetKillProcess)
	return a.assemble()
}

// Data is the part of struct seccomp_data the policy looks at.
type Data struct {
	Nr   uint32
	Arch uint32
	Args [6]uint64
}

// Run interprets prog for d (only the opcodes Build emits) and returns the action. For tests: the same program the
// kernel gets, checked without installing it.
func Run(prog []Insn, d Data) (uint32, error) {
	var acc uint32
	load := func(off uint32) (uint32, error) {
		switch {
		case off == offNr:
			return d.Nr, nil
		case off == offArch:
			return d.Arch, nil
		case off >= 16 && off < 64 && (off-16)%4 == 0:
			i := (off - 16) / 8
			if (off-16)%8 == 0 {
				return uint32(d.Args[i]), nil
			}
			return uint32(d.Args[i] >> 32), nil
		}
		return 0, fmt.Errorf("load at %d", off)
	}
	for pc := 0; pc < len(prog); {
		in := prog[pc]
		switch in.Code {
		case ldWAbs:
			v, err := load(in.K)
			if err != nil {
				return 0, err
			}
			acc = v
			pc++
		case jmpJeqK, jmpJgeK, jmpJset:
			var ok bool
			switch in.Code {
			case jmpJeqK:
				ok = acc == in.K
			case jmpJgeK:
				ok = acc >= in.K
			default:
				ok = acc&in.K != 0
			}
			if ok {
				pc += 1 + int(in.Jt)
			} else {
				pc += 1 + int(in.Jf)
			}
		case retK:
			return in.K, nil
		default:
			return 0, fmt.Errorf("opcode %#x", in.Code)
		}
	}
	return 0, fmt.Errorf("fell off the end")
}

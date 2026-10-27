//go:build linux

// mycel-sandbox: the last step before an engine (or a converter) runs (linux-runtime spec 3.3.4, 3.8.2).
//
//	mycel-sandbox exec   [--landlock MODE] [--exec-allow PATH]... [--allow-listen] -- PROG ARGS...
//	mycel-sandbox cgexec [--cgroup DIR] [--oom-score-adj N] [--rlimit-cpu SEC] [--rlimit-fsize BYTES] [--rlimit-nofile N] -- PROG ARGS...
//	mycel-sandbox probe
//
// exec runs INSIDE bwrap (bind-mounted at /.sbx/mycel-sandbox, read-only): Landlock and seccomp must come after bwrap
// has built its mounts (a Landlock domain that handles file access forbids mount, and our seccomp filter refuses it),
// so bwrap starts this helper and the helper restricts itself and execve()s the engine. The pid stays the same, so
// the engine keeps the session and process group the launcher reports (D7). The helper itself is not in the Landlock
// execute list: the engine cannot run it again.
//
// cgexec runs OUTSIDE bwrap for converters started by the server: it moves itself into the converter cgroup and sets
// rlimits, then execs bwrap; every converter process is born inside the limits.
//
// probe prints what this kernel offers (launcher status, diagnostics).
//
// Every failure before the final execve exits 70 with "mycel-sandbox: <reason>" on stderr; the launcher reports it as
// sandbox_failed (fail closed: the engine never runs with less isolation than asked for).
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
	"mycel/native/internal/landlock"
	"mycel/native/internal/seccomp"
)

// ExitFailed is the exit code of every refusal (spec 3.3.4).
const ExitFailed = 70

// Landlock domains belong to the thread that creates them: keep main on one OS thread from start to execve.
func init() { runtime.LockOSThread() }

func fail(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "mycel-sandbox: "+format+"\n", a...)
	os.Exit(ExitFailed)
}

type multi []string

func (m *multi) String() string     { return strings.Join(*m, ",") }
func (m *multi) Set(v string) error { *m = append(*m, v); return nil }

func main() {
	if len(os.Args) < 2 {
		fail("usage: mycel-sandbox exec|cgexec|probe ...")
	}
	switch os.Args[1] {
	case "exec":
		cmdExec(os.Args[2:])
	case "cgexec":
		cmdCgexec(os.Args[2:])
	case "probe":
		cmdProbe()
	default:
		fail("unknown command %q (exec, cgexec, probe)", os.Args[1])
	}
}

// splitDashDash separates the helper's flags from the program: "--" is required, so nothing of the engine's
// arguments can ever be read as a helper flag.
func splitDashDash(args []string) (flags, prog []string) {
	for i, a := range args {
		if a == "--" {
			return args[:i], args[i+1:]
		}
	}
	fail("missing -- before the program")
	return nil, nil
}

func parse(fs *flag.FlagSet, args []string) []string {
	fs.SetOutput(io.Discard)
	flags, prog := splitDashDash(args)
	if err := fs.Parse(flags); err != nil {
		fail("%s: %v", fs.Name(), err)
	}
	if fs.NArg() != 0 {
		fail("%s: unexpected argument %q before --", fs.Name(), fs.Arg(0))
	}
	if len(prog) == 0 || !filepath.IsAbs(prog[0]) {
		fail("%s: the program must be an absolute path", fs.Name())
	}
	return prog
}

func cmdExec(args []string) {
	fs := flag.NewFlagSet("exec", flag.ContinueOnError)
	mode := fs.String("landlock", string(landlock.Required), "off | best-effort | required | required-scoped")
	var allow multi
	fs.Var(&allow, "exec-allow", "folder or file the engine may execute (repeatable)")
	allowListen := fs.Bool("allow-listen", false, "do not refuse listen() (spike S4 fallback)")
	prog := parse(fs, args)
	m, err := landlock.ParseMode(*mode)
	if err != nil {
		fail("%v", err)
	}
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		fail("no_new_privs: %v", err)
	}
	if m != landlock.BestEffort && m != landlock.Off {
		for _, p := range allow {
			if _, err := os.Stat(p); err != nil {
				fail("exec-allow %s: %v", p, err)
			}
		}
	}
	if _, err := landlock.RestrictExec(m, allow); err != nil {
		fail("landlock: %v", err)
	}
	if err := seccomp.Install(*allowListen); err != nil {
		fail("%v", err)
	}
	err = unix.Exec(prog[0], prog, os.Environ())
	fail("exec %s: %v", prog[0], err)
}

// cgroupDir checks a --cgroup value: an absolute, clean path below /sys/fs/cgroup.
func cgroupDir(d string) (string, error) {
	if !filepath.IsAbs(d) || filepath.Clean(d) != d || strings.Contains(d, "/../") || !strings.HasPrefix(d, "/sys/fs/cgroup/") {
		return "", fmt.Errorf("--cgroup must be a clean absolute path below /sys/fs/cgroup, not %q", d)
	}
	return d, nil
}

func cmdCgexec(args []string) {
	fs := flag.NewFlagSet("cgexec", flag.ContinueOnError)
	cg := fs.String("cgroup", "", "cgroup v2 folder to move into (its cgroup.procs)")
	oom := fs.String("oom-score-adj", "", "value for /proc/self/oom_score_adj (-1000..1000)")
	cpu := fs.Int64("rlimit-cpu", 0, "RLIMIT_CPU seconds (0 = unchanged)")
	fsize := fs.Int64("rlimit-fsize", 0, "RLIMIT_FSIZE bytes (0 = unchanged)")
	nofile := fs.Int64("rlimit-nofile", 0, "RLIMIT_NOFILE (0 = unchanged)")
	prog := parse(fs, args)
	if *cg != "" {
		d, err := cgroupDir(*cg)
		if err != nil {
			fail("%v", err)
		}
		// cgroup.procs moves the whole process (all Go threads); every child is born there
		if err := writeFile(filepath.Join(d, "cgroup.procs"), strconv.Itoa(os.Getpid())); err != nil {
			fail("cgroup %s: %v", d, err)
		}
	}
	if *oom != "" {
		v, err := strconv.Atoi(*oom)
		if err != nil || v < -1000 || v > 1000 {
			fail("--oom-score-adj takes -1000..1000")
		}
		if err := writeFile("/proc/self/oom_score_adj", strconv.Itoa(v)); err != nil {
			fail("oom_score_adj: %v", err)
		}
	}
	for _, l := range []struct {
		name string
		res  int
		v    int64
	}{{"cpu", unix.RLIMIT_CPU, *cpu}, {"fsize", unix.RLIMIT_FSIZE, *fsize}, {"nofile", unix.RLIMIT_NOFILE, *nofile}} {
		if l.v < 0 {
			fail("--rlimit-%s must not be negative", l.name)
		}
		if l.v == 0 {
			continue
		}
		// soft = hard: the converter cannot raise it again
		if err := unix.Setrlimit(l.res, &unix.Rlimit{Cur: uint64(l.v), Max: uint64(l.v)}); err != nil {
			fail("rlimit %s: %v", l.name, err)
		}
	}
	err := unix.Exec(prog[0], prog, os.Environ())
	fail("exec %s: %v", prog[0], err)
}

func writeFile(p, s string) error {
	f, err := os.OpenFile(p, os.O_WRONLY|unix.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	_, werr := f.WriteString(s)
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	return werr
}

func cmdProbe() {
	var u unix.Utsname
	_ = unix.Uname(&u)
	b, _ := json.Marshal(map[string]any{
		"landlockAbi": landlock.ABI(),
		"seccomp":     seccomp.Available(),
		"kernel":      unix.ByteSliceToString(u.Release[:]),
	})
	fmt.Println(string(b))
}

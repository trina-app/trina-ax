//go:build linux

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"net"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
	"mycel/native/internal/landlock"
)

// The test binary plays three parts, chosen by its file name: "mycel-sandbox" (the real main), "helper" (the program
// started under the sandbox, reporting what it may do), anything else (the tests).
func TestMain(m *testing.M) {
	switch filepath.Base(os.Args[0]) {
	case "mycel-sandbox":
		main()
	case "helper":
		helper(os.Args[1:])
	default:
		os.Exit(m.Run())
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

func helper(args []string) {
	out := map[string]any{}
	switch args[0] {
	case "exit":
		os.Exit(0)
	case "report": // report <program to try to run>
		cmd := exec.Command(args[1], "exit")
		err := cmd.Run()
		var pe *os.PathError
		if errors.As(err, &pe) {
			err = pe.Err
		}
		out["exec"] = errName(err)
		fd, err := unix.Socket(unix.AF_PACKET, unix.SOCK_RAW, 0)
		if err == nil {
			unix.Close(fd)
		}
		out["packet"] = errName(err)
		fd, _ = unix.Socket(unix.AF_INET, unix.SOCK_STREAM, 0)
		_ = unix.Bind(fd, &unix.SockaddrInet4{Addr: [4]byte{127, 0, 0, 1}})
		out["listen"] = errName(unix.Listen(fd, 1))
		out["unshare"] = errName(unix.Unshare(unix.CLONE_NEWUSER))
		_, _, e := unix.Syscall6(unix.SYS_PTRACE, unix.PTRACE_ATTACH, 1, 0, 0, 0, 0)
		out["ptrace"] = errName(errOrNil(e))
		nnp, _ := unix.PrctlRetInt(unix.PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0)
		out["noNewPrivs"] = nnp
		out["env"] = os.Getenv("SANDBOX_TEST_ENV")
	case "net": // net <proxy port> <other loopback port> <abstract name>
		conn := func(sa unix.Sockaddr, fam int) string {
			fd, err := unix.Socket(fam, unix.SOCK_STREAM, 0)
			if err != nil {
				return errName(err)
			}
			defer unix.Close(fd)
			if err := unix.Connect(fd, sa); err != nil {
				return errName(err)
			}
			b := make([]byte, 16)
			n, _ := unix.Read(fd, b)
			return "ok:" + string(b[:max(n, 0)])
		}
		pp, _ := strconv.Atoi(args[1])
		op, _ := strconv.Atoi(args[2])
		out["proxy"] = conn(&unix.SockaddrInet4{Port: pp, Addr: [4]byte{127, 0, 0, 1}}, unix.AF_INET)
		out["other"] = conn(&unix.SockaddrInet4{Port: op, Addr: [4]byte{127, 0, 0, 1}}, unix.AF_INET)
		out["abstract"] = conn(&unix.SockaddrUnix{Name: args[3]}, unix.AF_UNIX)
		// the forwarder is this process's child: its memory must stay out of reach (Landlock's ptrace rule)
		out["forwarderMem"] = "no forwarder"
		if b, err := os.ReadFile(fmt.Sprintf("/proc/self/task/%d/children", os.Getpid())); err == nil && len(strings.Fields(string(b))) > 0 {
			f, err := os.OpenFile("/proc/"+strings.Fields(string(b))[0]+"/mem", os.O_RDWR, 0)
			if err == nil {
				f.Close()
			}
			var pe *os.PathError
			if errors.As(err, &pe) {
				err = pe.Err
			}
			out["forwarderMem"] = errName(err)
		}
		b, _ := os.ReadFile("/proc/self/status")
		for _, l := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(l, "CapEff:") || strings.HasPrefix(l, "CapPrm:") || strings.HasPrefix(l, "CapAmb:") {
				out[l[:6]] = strings.TrimSpace(l[7:])
			}
		}
	case "limits":
		for name, res := range map[string]int{"cpu": unix.RLIMIT_CPU, "fsize": unix.RLIMIT_FSIZE, "nofile": unix.RLIMIT_NOFILE} {
			var r unix.Rlimit
			_ = unix.Getrlimit(res, &r)
			out[name] = fmt.Sprintf("%d/%d", r.Cur, r.Max)
		}
		b, _ := os.ReadFile("/proc/self/oom_score_adj")
		out["oom"] = strings.TrimSpace(string(b))
		b, _ = os.ReadFile("/proc/self/cgroup")
		out["cgroup"] = strings.TrimSpace(string(b))
	}
	b, _ := json.Marshal(out)
	os.Stdout.Write(b)
	os.Exit(0)
}

func errOrNil(e unix.Errno) error {
	if e == 0 {
		return nil
	}
	return e
}

func cp(t *testing.T, dst string) {
	t.Helper()
	in, err := os.Open(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	os.MkdirAll(filepath.Dir(dst), 0o755)
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o755)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(out, in)
	out.Close()
}

type layout struct{ w, sbx, a, b string }

func setup(t *testing.T) layout {
	w := t.TempDir()
	os.Chmod(w, 0o755) // a non-root run of the helpers must reach them
	l := layout{w: w, sbx: filepath.Join(w, "sbx", "mycel-sandbox"), a: filepath.Join(w, "A"), b: filepath.Join(w, "B")}
	cp(t, l.sbx)
	cp(t, filepath.Join(l.a, "helper"))
	cp(t, filepath.Join(l.b, "helper"))
	return l
}

func run(t *testing.T, bin string, args ...string) (int, string, string) {
	t.Helper()
	cmd := exec.Command(bin, args...)
	cmd.Env = append(os.Environ(), "SANDBOX_TEST_ENV=kept")
	var so, se bytes.Buffer
	cmd.Stdout, cmd.Stderr = &so, &se
	err := cmd.Run()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	return code, so.String(), se.String()
}

func TestExecAppliesEverything(t *testing.T) {
	l := setup(t)
	abi := landlock.ABI()
	code, out, se := run(t, l.sbx, "exec", "--landlock", "best-effort", "--exec-allow", l.a, "--",
		filepath.Join(l.a, "helper"), "report", filepath.Join(l.b, "helper"))
	if code != 0 {
		t.Fatalf("exit %d: %s %s", code, out, se)
	}
	var r map[string]any
	if err := json.Unmarshal([]byte(out), &r); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	wantExec := "EACCES"
	if abi < 1 {
		wantExec = "ok"
	}
	want := map[string]any{"exec": wantExec, "packet": "EAFNOSUPPORT", "listen": "EPERM", "unshare": "EPERM", "ptrace": "EPERM", "noNewPrivs": float64(1), "env": "kept"}
	for k, v := range want {
		if r[k] != v {
			t.Errorf("%s: %v, want %v (all: %v)", k, r[k], v, r)
		}
	}
	// the allowed folder can still run its own programs (a bridge started by the engine)
	_, out, _ = run(t, l.sbx, "exec", "--landlock", "best-effort", "--exec-allow", l.a, "--", filepath.Join(l.a, "helper"), "report", filepath.Join(l.a, "helper"))
	if !strings.Contains(out, `"exec":"ok"`) {
		t.Errorf("own folder: %s", out)
	}
	// --allow-listen (spike S4 fallback)
	_, out, _ = run(t, l.sbx, "exec", "--landlock", "off", "--allow-listen", "--", filepath.Join(l.a, "helper"), "report", filepath.Join(l.a, "helper"))
	if !strings.Contains(out, `"listen":"ok"`) || !strings.Contains(out, `"ptrace":"EPERM"`) {
		t.Errorf("--allow-listen: %s", out)
	}
}

func TestExecRefusals(t *testing.T) {
	l := setup(t)
	abi := landlock.ABI()
	cases := [][]string{
		{"exec", "--landlock", "required", "--exec-allow", l.a, filepath.Join(l.a, "helper")},                  // no --
		{"exec", "--landlock", "required", "--exec-allow", l.a, "--", "helper", "exit"},                        // relative program
		{"exec", "--landlock", "sometimes", "--", filepath.Join(l.a, "helper"), "exit"},                        // bad mode
		{"exec", "--landlock", "required", "--exec-allow", "/nonexistent", "--", filepath.Join(l.a, "helper")}, // missing allow path
		{"exec", "--bogus", "--", filepath.Join(l.a, "helper"), "exit"},                                        // unknown flag
		{"cgexec", "--cgroup", "/tmp/x", "--", filepath.Join(l.a, "helper"), "exit"},
		{"cgexec", "--cgroup", "/sys/fs/cgroup/a/../../etc", "--", filepath.Join(l.a, "helper"), "exit"},
		{"cgexec", "--oom-score-adj", "5000", "--", filepath.Join(l.a, "helper"), "exit"},
		{"cgexec", "--rlimit-nofile", "-1", "--", filepath.Join(l.a, "helper"), "exit"},
		{"nothing"},
	}
	if abi >= 1 { // the program itself is outside the allow list
		cases = append(cases, []string{"exec", "--landlock", "required", "--exec-allow", l.a, "--", filepath.Join(l.b, "helper"), "exit"})
	}
	if abi < 6 {
		cases = append(cases, []string{"exec", "--landlock", "required-scoped", "--exec-allow", l.a, "--", filepath.Join(l.a, "helper"), "exit"})
	}
	if abi < 1 {
		cases = append(cases, []string{"exec", "--landlock", "required", "--exec-allow", l.a, "--", filepath.Join(l.a, "helper"), "exit"})
	}
	for _, c := range cases {
		code, _, se := run(t, l.sbx, c...)
		if code != ExitFailed || !strings.HasPrefix(se, "mycel-sandbox: ") {
			t.Errorf("%v: exit %d stderr %q, want 70 and a mycel-sandbox: reason", c, code, se)
		}
	}
	// the default mode is required: no Landlock flag still restricts execution
	if abi >= 1 {
		_, out, _ := run(t, l.sbx, "exec", "--exec-allow", l.a, "--", filepath.Join(l.a, "helper"), "report", filepath.Join(l.b, "helper"))
		if !strings.Contains(out, `"exec":"EACCES"`) {
			t.Errorf("default mode: %s", out)
		}
	}
}

func TestCgexec(t *testing.T) {
	l := setup(t)
	code, out, se := run(t, l.sbx, "cgexec", "--oom-score-adj", "500", "--rlimit-cpu", "30", "--rlimit-fsize", "1048576", "--rlimit-nofile", "64", "--",
		filepath.Join(l.a, "helper"), "limits")
	if code != 0 {
		t.Fatalf("exit %d %s %s", code, out, se)
	}
	var r map[string]any
	json.Unmarshal([]byte(out), &r)
	if r["cpu"] != "30/30" || r["fsize"] != "1048576/1048576" || r["nofile"] != "64/64" || r["oom"] != "500" {
		t.Errorf("limits: %v", r)
	}
	// moving into a cgroup: only where this test may create one (root in a container with its own cgroup namespace)
	dir := fmt.Sprintf("/sys/fs/cgroup/mycel-sandbox-test-%d", os.Getpid())
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Logf("cgroup part skipped: %v", err)
		return
	}
	defer os.Remove(dir)
	code, out, se = run(t, l.sbx, "cgexec", "--cgroup", dir, "--", filepath.Join(l.a, "helper"), "limits")
	if code != 0 || !strings.Contains(out, "/mycel-sandbox-test-") {
		t.Fatalf("cgroup: exit %d %s %s", code, out, se)
	}
}

func TestProbe(t *testing.T) {
	l := setup(t)
	code, out, _ := run(t, l.sbx, "probe")
	var p struct {
		LandlockAbi *int   `json:"landlockAbi"`
		Seccomp     *bool  `json:"seccomp"`
		Kernel      string `json:"kernel"`
	}
	if code != 0 || json.Unmarshal([]byte(out), &p) != nil || p.LandlockAbi == nil || p.Seccomp == nil || p.Kernel == "" {
		t.Fatalf("probe: %d %q", code, out)
	}
	t.Logf("probe: %s", strings.TrimSpace(out))
}

// QA TC-309: with --net-proxy the program runs in its own network namespace. The host's abstract unix sockets and its
// other loopback ports are out of reach, the model proxy port still answers (through the forwarder), and no
// capability is left. Started through bwrap the way the launcher does (a user namespace with only CAP_SYS_ADMIN and
// CAP_NET_ADMIN); skipped where this machine cannot run bwrap.
func TestExecNetProxy(t *testing.T) {
	bw, err := exec.LookPath("bwrap")
	if err != nil {
		t.Skip("no bwrap")
	}
	l := setup(t)
	listen := func(network, addr, reply string) net.Listener {
		ln, err := net.Listen(network, addr)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { ln.Close() })
		go func() {
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				c.Write([]byte(reply))
				c.Close()
			}
		}()
		return ln
	}
	proxy := listen("tcp4", "127.0.0.1:0", "proxy")
	other := listen("tcp4", "127.0.0.1:0", "other")
	name := fmt.Sprintf("@mycel-sbx-test-%d", os.Getpid())
	listen("unix", name, "abstract")
	pp, op := proxy.Addr().(*net.TCPAddr).Port, other.Addr().(*net.TCPAddr).Port
	bwrap := []string{"--unshare-user", "--unshare-pid", "--disable-userns", "--die-with-parent", "--cap-drop", "ALL",
		"--cap-add", "CAP_SYS_ADMIN", "--cap-add", "CAP_NET_ADMIN", "--dev-bind", "/", "/", "--proc", "/proc", "--", l.sbx}
	if c, out, se := run(t, bw, append(bwrap[:len(bwrap)-2:len(bwrap)-2], "--", "/bin/true")...); c != 0 {
		t.Skipf("bwrap cannot start here (%d): %s %s", c, out, se)
	}
	report := func(extra ...string) map[string]any {
		args := append(append([]string{}, bwrap...), "exec", "--landlock", "best-effort", "--exec-allow", l.a)
		args = append(append(args, extra...), "--", filepath.Join(l.a, "helper"), "net", strconv.Itoa(pp), strconv.Itoa(op), name)
		code, out, se := run(t, bw, args...)
		if code != 0 {
			t.Fatalf("exit %d: %s %s", code, out, se)
		}
		var r map[string]any
		if err := json.Unmarshal([]byte(out), &r); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
		return r
	}
	// control: without the flag the same sandbox reaches all three (and keeps bwrap's capabilities)
	r := report()
	if r["proxy"] != "ok:proxy" || r["other"] != "ok:other" || r["abstract"] != "ok:abstract" {
		t.Fatalf("control run: %v", r)
	}
	r = report("--net-proxy", strconv.Itoa(pp))
	want := map[string]any{"proxy": "ok:proxy", "other": "ECONNREFUSED", "abstract": "ECONNREFUSED",
		"CapEff": "0000000000000000", "CapPrm": "0000000000000000", "CapAmb": "0000000000000000"}
	for k, v := range want {
		if r[k] != v {
			t.Errorf("%s: %v, want %v (all: %v)", k, r[k], v, r)
		}
	}
	if m := r["forwarderMem"]; m == "ok" || m == "no forwarder" {
		t.Errorf("the program could open the forwarder's memory (or found none): %v", m)
	}
	// without a Landlock domain: refused unless Yama's ptrace_scope >= 1 (bwrap's pid 1 is in the host namespace too);
	// with it the forwarder is not dumpable instead, still out of reach
	args := append(append([]string{}, bwrap...), "exec", "--landlock", "off", "--net-proxy", strconv.Itoa(pp), "--", filepath.Join(l.a, "helper"), "net", strconv.Itoa(pp), strconv.Itoa(op), name)
	code, out, se := run(t, bw, args...)
	if yamaScope() < 1 {
		if code != ExitFailed || !strings.Contains(se, "ptrace_scope") {
			t.Errorf("landlock off, ptrace_scope %d: exit %d %q, want 70 and the Yama reason", yamaScope(), code, se)
		}
	} else {
		var off map[string]any
		if code != 0 || json.Unmarshal([]byte(out), &off) != nil {
			t.Fatalf("landlock off: exit %d %s %s", code, out, se)
		}
		if m := off["forwarderMem"]; m == "ok" || m == "no forwarder" || off["abstract"] != "ECONNREFUSED" {
			t.Errorf("landlock off: %v", off)
		}
	}
	// a port that is not one, and no capabilities to make the namespace with: refused before the program runs
	for _, c := range [][]string{
		{"exec", "--net-proxy", "70000", "--", filepath.Join(l.a, "helper"), "exit"},
		{"exec", "--net-proxy", "-1", "--", filepath.Join(l.a, "helper"), "exit"},
	} {
		if code, _, se := run(t, l.sbx, c...); code != ExitFailed || !strings.HasPrefix(se, "mycel-sandbox: ") {
			t.Errorf("%v: exit %d %q", c, code, se)
		}
	}
	noCaps := append(append([]string{}, bwrap[:6]...), bwrap[10:]...) // without the two --cap-add
	code, _, se = run(t, bw, append(noCaps, "exec", "--landlock", "off", "--net-proxy", strconv.Itoa(pp), "--", filepath.Join(l.a, "helper"), "exit")...)
	if os.Getuid() != 0 && (code != ExitFailed || !strings.Contains(se, "mycel-sandbox: net: unshare")) {
		t.Errorf("no capabilities: exit %d %q, want 70 and the unshare reason", code, se)
	}
}

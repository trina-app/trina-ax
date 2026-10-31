// Linux code runs (code.go): one bubblewrap per run, started by the launcher OUTSIDE the engine's sandbox.
//
//	mycel-sandbox cgexec [--cgroup <turns>/c-<turn>] --rlimit-cpu S --rlimit-fsize B --rlimit-nofile N --
//	  bwrap --unshare-all-but-nothing (user, pid, ipc, uts, net, cgroup) --disable-userns <the distro's /usr read-only,
//	        <chat>/work at /work (bound by an fd the launcher opened without following links), a sized /tmp,
//	        the program at /.code/main.sh|py> --
//	  /.sbx/mycel-sandbox exec --landlock MODE --exec-allow /usr [...] -- /usr/bin/bash|python3 /.code/main.*
//
// What holds the code in (docs/DECISIONS.md "Code sandbox"): the namespaces (an empty network namespace: no network
// at all, not even the model proxy; its own pid namespace: no engine or bridge process to look at), the mounts (no
// other folder of the chat, no other chat, nothing of the install), the engine's seccomp filter, and a cgroup per run
// (memory, pids, cpu; memory.oom.group: an OOM kills the run, not the answer). Landlock's execute list is NOT a
// boundary here (python3 can map and run any code); it only keeps the /work and /tmp files from being executed
// directly. A run stops at its time limit, when the turn ends, or when the chat folder passes the turn disk limit.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
	"mycel/native/internal/plan"
)

// codeRuntimes: the programs the code sandbox looks for in the distro's /usr/bin (docs/INSTALL-LINUX.md). bash and
// python3 run the code; the rest is what the AI is told it has.
var codeRuntimes = []string{"bash", "python3", "jq", "unzip", "zip", "sqlite3", "awk", "sed", "grep", "tar", "gzip", "file"}

// codeState is what setupCode found at start.
type codeState struct {
	ready     bool
	reason    string
	runtimes  map[string]bool
	bins      []libMount // /bin, /sbin as on the host (a link into /usr, or a folder)
	execAllow []string   // /usr + the top-level program and library folders that are real folders here
}

const (
	codeTmpBytes = 256 << 20 // /tmp of a run (tmpfs: charged to the run's cgroup memory)
	codeShmBytes = 64 << 20
	codeNofile   = 512
)

// setupCode checks the runtimes once at start (only with --sandbox bwrap).
func setupCode() {
	lx.code = codeState{runtimes: map[string]bool{}}
	for _, n := range codeRuntimes {
		st, err := os.Stat(filepath.Join("/usr/bin", n))
		lx.code.runtimes[n] = err == nil && st.Mode().IsRegular() && st.Mode()&0o111 != 0
	}
	for _, p := range []string{"/bin", "/sbin"} {
		lm := libMount{path: p}
		if st, err := os.Lstat(p); err == nil {
			lm.exists = true
			if st.Mode()&os.ModeSymlink != 0 {
				lm.link, _ = os.Readlink(p)
			} else {
				lm.isDir = st.IsDir()
			}
		}
		lx.code.bins = append(lx.code.bins, lm)
	}
	lx.code.execAllow = []string{"/usr"}
	for _, lm := range append(append([]libMount{}, lx.code.bins...), lx.libs...) {
		if lm.exists && lm.isDir {
			lx.code.execAllow = append(lx.code.execAllow, lm.path)
		}
	}
	switch {
	case !lx.code.runtimes["bash"]:
		lx.code.reason = "/usr/bin/bash is missing"
	case lx.cg == nil:
		lx.code.reason = "no delegated cgroup (each code run needs its own memory and process limits)"
	default:
		lx.code.ready = true
	}
}

// codeAllowed: may a turn started now have the code sandbox? (beginTurn; the plan is read per turn)
func codeAllowed(l plan.Limits) error {
	switch {
	case !lx.bwrap:
		return fmt.Errorf("code_sandbox_unavailable: the launcher runs without --sandbox bwrap")
	case !lx.code.ready:
		return fmt.Errorf("code_sandbox_unavailable: %s", lx.code.reason)
	case !l.CodeSandbox:
		return fmt.Errorf("code_sandbox_unavailable: the plan does not include the code sandbox")
	}
	return nil
}

func codeStatus(ev map[string]any) {
	cs := map[string]any{"available": false}
	if !lx.bwrap {
		cs["reason"] = "no bwrap sandbox"
	} else {
		cs["runtimes"] = lx.code.runtimes
		if l, err := currentLimits(); err != nil {
			cs["reason"] = "plan unreadable"
		} else if err := codeAllowed(l); err != nil {
			cs["reason"] = err.Error()
		} else {
			cs["available"] = true
		}
	}
	ev["codeSandbox"] = cs
}

// codeParams are the per-run values of the argv (golden-tested in code_linux_test.go).
type codeParams struct {
	EtcDir, Helper, Landlock, Interp, Script string
	Libs, Bins                               []libMount
	ExecAllow                                []string
	WorkFd, CodeFd                           int
}

// buildCodeArgs is the exact argv after the bwrap program name.
func buildCodeArgs(p codeParams) ([]string, error) {
	for n, v := range map[string]string{"sandbox-etc": p.EtcDir, "helper": p.Helper, "interpreter": p.Interp, "script": p.Script} {
		if err := checkArgPath(n, v); err != nil {
			return nil, err
		}
	}
	if p.WorkFd < 3 || p.CodeFd < 3 || p.WorkFd == p.CodeFd {
		return nil, fmt.Errorf("sandbox_failed: bad descriptors")
	}
	a := []string{
		"--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-net", "--unshare-cgroup-try",
		"--disable-userns",
		"--die-with-parent",
		"--new-session",
		"--cap-drop", "ALL",
		"--hostname", "mycel-code",
		"--ro-bind", "/usr", "/usr",
	}
	for _, l := range append(append([]libMount{}, p.Libs...), p.Bins...) {
		switch {
		case !l.exists:
		case l.link != "":
			a = append(a, "--symlink", l.link, l.path)
		case l.isDir:
			a = append(a, "--ro-bind-try", l.path, l.path)
		}
	}
	a = append(a,
		"--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache",
		"--ro-bind-try", "/etc/alternatives", "/etc/alternatives",
		"--ro-bind", filepath.Join(p.EtcDir, "passwd"), "/etc/passwd",
		"--ro-bind", filepath.Join(p.EtcDir, "group"), "/etc/group",
		"--ro-bind", filepath.Join(p.EtcDir, "hosts"), "/etc/hosts",
		"--ro-bind", filepath.Join(p.EtcDir, "nsswitch.conf"), "/etc/nsswitch.conf",
		"--proc", "/proc",
		"--dev", "/dev",
		"--size", strconv.Itoa(codeShmBytes), "--tmpfs", "/dev/shm",
		"--size", strconv.Itoa(codeTmpBytes), "--tmpfs", "/tmp",
		"--bind-fd", strconv.Itoa(p.WorkFd), "/work",
		"--ro-bind-data", strconv.Itoa(p.CodeFd), p.Script,
		"--ro-bind", p.Helper, "/.sbx/mycel-sandbox",
		"--remount-ro", "/",
		"--chdir", "/work",
		"--", "/.sbx/mycel-sandbox", "exec", "--landlock", p.Landlock,
	)
	for _, e := range p.ExecAllow {
		if err := checkArgPath("exec-allow", e); err != nil {
			return nil, err
		}
		a = append(a, "--exec-allow", e)
	}
	return append(a, "--", p.Interp, p.Script), nil
}

// codeEnv is the whole environment of a run: no token, no path of the chat folder.
func codeEnv() []string {
	return []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/work", "TMPDIR=/tmp", "LANG=C.UTF-8", "LC_ALL=C.UTF-8",
		"PYTHONDONTWRITEBYTECODE=1", "PYTHONUNBUFFERED=1", "TERM=dumb"}
}

// newCode creates <turns>/c-<turn> for one run: half the turn's memory (at least 256 MiB), half its processes (at
// least 64), the turn's CPU, no swap, the whole run dies on OOM. applyTurnsLimits gives turns/ room for one run per turn.
func (r *cgRoot) newCode(name string, l plan.Limits) (*turnCg, error) {
	mem := int64(codeMemMiB(l)) << 20
	dir := filepath.Join(r.turns, name)
	if _, err := os.Stat(dir); err == nil {
		old := &turnCg{dir: dir, fd: -1}
		old.kill()
		old.remove()
	}
	if err := os.Mkdir(dir, 0o755); err != nil {
		return nil, err
	}
	c := &turnCg{dir: dir, fd: -1}
	for _, kv := range [][2]string{
		{"memory.max", strconv.FormatInt(mem, 10)},
		{"memory.high", strconv.FormatInt(mem*9/10, 10)},
		{"pids.max", strconv.Itoa(codePids(l))},
		{"memory.oom.group", "1"},
	} {
		if err := writeCg(dir, kv[0], kv[1]); err != nil {
			c.remove()
			return nil, fmt.Errorf("%s: %v", kv[0], err)
		}
	}
	_ = writeCg(dir, "memory.swap.max", "0")
	if r.hasCPU {
		_ = writeCg(dir, "cpu.max", l.TurnCPUMax())
	}
	fd, err := unix.Open(dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		c.remove()
		return nil, err
	}
	c.fd = fd
	return c, nil
}

func codeMemMiB(l plan.Limits) int {
	if m := l.TurnMaxMiB / 2; m > 256 {
		return m
	}
	return 256
}

func codePids(l plan.Limits) int {
	if p := l.TurnPidsMax / 2; p > 64 {
		return p
	}
	return 64
}

// runCode runs one program for a live code turn and returns the code_exit event.
func runCode(ct *codeTurn, req *codeRequest, timeout time.Duration, stopped <-chan struct{}) (map[string]any, error) {
	interp, script := "/usr/bin/bash", "/.code/main.sh"
	if req.Lang == "python" {
		interp, script = "/usr/bin/python3", "/.code/main.py"
	}
	if !lx.code.runtimes[filepath.Base(interp)] {
		return nil, fmt.Errorf("code_unavailable: %s is not installed on this server", filepath.Base(interp))
	}
	te := ct.te
	if te.cg == nil || lx.cg == nil {
		return nil, fmt.Errorf("code_unavailable: the turn has no cgroup")
	}
	root, err := openRoot(ct.chat)
	if err != nil {
		return nil, err
	}
	defer root.close()
	if err := root.mkdirAll("work", 0o700); err != nil {
		return nil, fmt.Errorf("code: work folder: %v", err)
	}
	wfd, err := root.open("work", unix.O_RDONLY|unix.O_DIRECTORY, 0)
	if err != nil {
		return nil, fmt.Errorf("code: work folder: %v", err)
	}
	work := os.NewFile(uintptr(wfd), "work")
	defer work.Close()
	pr, pw, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	defer pr.Close()
	go func() { _, _ = pw.WriteString(req.Code); _ = pw.Close() }()

	argv, err := buildCodeArgs(codeParams{EtcDir: filepath.Clean(*sandboxEtc), Helper: *sandboxHelper, Landlock: *landlockMode,
		Interp: interp, Script: script, Libs: lx.libs, Bins: lx.code.bins, ExecAllow: lx.code.execAllow,
		WorkFd: 3, CodeFd: 4})
	if err != nil {
		return nil, err
	}
	cg, err := lx.cg.newCode("c-"+req.TurnID, te.limits)
	if err != nil {
		return nil, fmt.Errorf("cgroup_unavailable: %v", err)
	}
	defer cg.remove()
	fsize := te.diskMax
	if fsize <= 0 {
		fsize = 1 << 30
	}
	cpu := int64(timeout/time.Second) + 5
	wrap := []string{"cgexec"}
	if !lx.cgFdOK {
		wrap = append(wrap, "--cgroup", cg.dir)
	}
	wrap = append(wrap, "--rlimit-cpu", strconv.FormatInt(cpu, 10), "--rlimit-fsize", strconv.FormatInt(fsize, 10),
		"--rlimit-nofile", strconv.Itoa(codeNofile), "--", *bwrapBin)
	cmd := exec.Command(*sandboxHelper, append(wrap, argv...)...)
	cmd.Env = codeEnv()
	cmd.Dir = "/"
	cmd.ExtraFiles = []*os.File{work, pr} // fd 3 = /work, fd 4 = the program
	attr := &syscall.SysProcAttr{Setsid: true, Pdeathsig: syscall.SIGKILL}
	if lx.cgFdOK {
		attr.UseCgroupFD, attr.CgroupFD = true, cg.fd
	}
	cmd.SysProcAttr = attr
	stdout, stderr := &capBuf{max: codeOutMax}, &capBuf{max: codeOutMax}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	began := time.Now()
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("sandbox_failed: %v", err)
	}
	_ = pr.Close()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	// the chat folder's size, checked more often than the turn's own 2 s watch while code writes into it
	tk := time.NewTicker(300 * time.Millisecond)
	defer tk.Stop()
	sig := ""
	var werr error
loop:
	for {
		select {
		case werr = <-done:
			break loop
		case <-stopped:
			sig = "stopped"
		case <-time.After(time.Until(began.Add(timeout))):
			sig = "timeout"
		case <-tk.C:
			if te.diskMax > 0 && overDisk(ct.chat, te.diskMax) {
				sig = "disk_limit"
				te.hitDisk()
			}
		}
		if sig != "" {
			cg.kill()
			werr = <-done
			break
		}
	}
	if cg.kill() && sig == "" {
		sig = "oom"
	}
	code := 0
	if ee, ok := werr.(*exec.ExitError); ok {
		code = ee.ExitCode()
	}
	// the run never started: the helper refused (exit 70, "mycel-sandbox: …") or bwrap failed ("bwrap: …")
	if sig == "" && code != 0 && stdout.text() == "" {
		e := stderr.text()
		if m := sandboxErrRe.FindStringSubmatch(e); m != nil && code == 70 {
			return nil, fmt.Errorf("sandbox_failed: %s", m[1])
		}
		if strings.HasPrefix(e, "bwrap: ") {
			return nil, fmt.Errorf("sandbox_failed: %s", strings.TrimSpace(strings.SplitN(e, "\n", 2)[0]))
		}
	}
	return map[string]any{"ev": "code_exit", "code": code, "signal": sig, "stdout": stdout.text(), "stderr": stderr.text(),
		"truncated": stdout.dropped > 0 || stderr.dropped > 0, "ms": time.Since(began).Milliseconds()}, nil
}

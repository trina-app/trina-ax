// One cgroup v2 per engine turn (linux-runtime spec 3.8.1, D9). The launcher's systemd unit delegates its cgroup R
// (Delegate=memory pids cpu, owned by the engine account):
//
//	R/                  cgroup.subtree_control = +memory +pids +cpu
//	R/supervisor/       the launcher itself (a cgroup with processes cannot enable controllers for its children)
//	R/turns/            memory.max = all turns' budget, memory.high = 90 %, swap 0, pids.max = (turns + 1) × per turn
//	R/turns/t-<turnId>  memory.max/high, swap 0, pids.max, cpu.max, memory.oom.group = 1 (the whole turn dies on OOM)
//	R/turns/login       codex-login
//
// The turn's first process (bwrap's monitor) is created directly inside its cgroup (clone3 CLONE_INTO_CGROUP via
// SysProcAttr.UseCgroupFD), so nothing of the turn ever runs outside it; at the end cgroup.kill takes everything,
// setsid escapees included, and memory.events tells whether the kernel killed it for memory.
package main

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
	"mycel/native/internal/plan"
)

const cgroupFS = "/sys/fs/cgroup"

type cgRoot struct {
	dir    string // R
	turns  string // R/turns
	hasCPU bool
}

type turnCg struct {
	dir string
	fd  int
}

func numCPU() int { return runtime.NumCPU() }

// probeArg: probeCgroupFD starts this program with only this argument; it exits at once (before flag parsing).
const probeArg = "--mycel-cgroup-probe"

func init() {
	if len(os.Args) == 2 && os.Args[1] == probeArg {
		os.Exit(0)
	}
}

// ownCgroup returns this process's cgroup v2 folder (from /proc/self/cgroup "0::<path>").
func ownCgroup() (string, error) {
	b, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		return "", err
	}
	for _, l := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(l, "0::") {
			p := strings.TrimSpace(strings.TrimPrefix(l, "0::"))
			if !strings.HasPrefix(p, "/") || strings.Contains(p, "..") {
				return "", fmt.Errorf("unexpected cgroup path %q", p)
			}
			return filepath.Join(cgroupFS, p), nil
		}
	}
	return "", fmt.Errorf("no cgroup v2 (no 0:: line in /proc/self/cgroup)")
}

func writeCg(dir, file, val string) error {
	return os.WriteFile(filepath.Join(dir, file), []byte(val), 0)
}

// setupCgroupsAtStart finds and prepares the delegated cgroup (--cgroup auto|required).
func setupCgroupsAtStart() error {
	lx.cgState = "off"
	if *cgroupMode == "off" {
		return nil
	}
	r, err := prepareCgroupRoot()
	if err != nil {
		if *cgroupMode == "required" {
			return fmt.Errorf("--cgroup required: %v", err)
		}
		fmt.Fprintln(os.Stderr, "mycel-launcher: no turn cgroups:", err)
		lx.cgState = "none"
		return nil
	}
	lx.cg, lx.cgState = r, "delegated"
	lx.cgFdOK = probeCgroupFD(r)
	if !lx.cgFdOK && *sandboxHelper == "" {
		if *cgroupMode == "required" {
			return fmt.Errorf("--cgroup required: clone3 into a cgroup is not available and there is no --sandbox-helper for cgexec")
		}
		lx.cg, lx.cgState = nil, "none"
	}
	return nil
}

func prepareCgroupRoot() (*cgRoot, error) {
	own, err := ownCgroup()
	if err != nil {
		return nil, err
	}
	r := own
	if filepath.Base(r) == "supervisor" { // restarted inside our own supervisor/ (or systemd DelegateSubgroup=)
		r = filepath.Dir(r)
	}
	var st unix.Stat_t
	if err := unix.Stat(r, &st); err != nil {
		return nil, err
	}
	if int(st.Uid) != os.Getuid() {
		return nil, fmt.Errorf("cgroup %s is not delegated to this account (owner uid %d)", r, st.Uid)
	}
	ctl, err := os.ReadFile(filepath.Join(r, "cgroup.controllers"))
	if err != nil {
		return nil, err
	}
	have := map[string]bool{}
	for _, c := range strings.Fields(string(ctl)) {
		have[c] = true
	}
	if !have["memory"] || !have["pids"] {
		return nil, fmt.Errorf("cgroup %s lacks the memory or pids controller (has %q)", r, strings.TrimSpace(string(ctl)))
	}
	cr := &cgRoot{dir: r, turns: filepath.Join(r, "turns"), hasCPU: have["cpu"]}
	ctrls := "+memory +pids"
	if cr.hasCPU {
		ctrls += " +cpu"
	}
	sup := filepath.Join(r, "supervisor")
	if err := os.Mkdir(sup, 0o755); err != nil && !os.IsExist(err) {
		return nil, err
	}
	// all threads of this process move with its pid (cgroup v2 cgroup.procs)
	if own != sup {
		if err := writeCg(sup, "cgroup.procs", strconv.Itoa(os.Getpid())); err != nil {
			return nil, fmt.Errorf("moving the launcher into %s: %v", sup, err)
		}
	}
	if err := writeCg(r, "cgroup.subtree_control", ctrls); err != nil {
		return nil, fmt.Errorf("enabling controllers in %s: %v", r, err)
	}
	if err := os.Mkdir(cr.turns, 0o755); err != nil && !os.IsExist(err) {
		return nil, err
	}
	// turns left by a previous launcher (crash): kill and remove
	if ents, err := os.ReadDir(cr.turns); err == nil {
		for _, e := range ents {
			if e.IsDir() {
				old := &turnCg{dir: filepath.Join(cr.turns, e.Name()), fd: -1}
				old.kill()
				old.remove()
			}
		}
	}
	if err := writeCg(cr.turns, "cgroup.subtree_control", ctrls); err != nil {
		return nil, fmt.Errorf("enabling controllers in %s: %v", cr.turns, err)
	}
	if l, err := currentLimits(); err == nil {
		cr.applyTurnsLimits(l)
	}
	return cr, nil
}

// applyTurnsLimits sets the limits shared by all turns (re-applied before every turn: the plan may change).
func (r *cgRoot) applyTurnsLimits(l plan.Limits) {
	budget := int64(l.TurnBudgetMiB) << 20
	_ = writeCg(r.turns, "memory.max", strconv.FormatInt(budget, 10))
	_ = writeCg(r.turns, "memory.high", strconv.FormatInt(budget*9/10, 10))
	_ = writeCg(r.turns, "memory.swap.max", "0") // missing without swap accounting
	_ = writeCg(r.turns, "pids.max", strconv.Itoa((l.MaxConcurrency+1)*l.TurnPidsMax))
}

// newTurn creates R/turns/<name> with the per-turn limits and returns it opened (for CLONE_INTO_CGROUP).
func (r *cgRoot) newTurn(name string, l plan.Limits) (*turnCg, error) {
	dir := filepath.Join(r.turns, name)
	if _, err := os.Stat(dir); err == nil { // the same turn id again (or a crashed login): start clean
		old := &turnCg{dir: dir, fd: -1}
		old.kill()
		old.remove()
	}
	if err := os.Mkdir(dir, 0o755); err != nil {
		return nil, err
	}
	c := &turnCg{dir: dir, fd: -1}
	set := func(f, v string) error {
		if err := writeCg(dir, f, v); err != nil {
			return fmt.Errorf("%s: %v", f, err)
		}
		return nil
	}
	for _, kv := range [][2]string{
		{"memory.max", strconv.FormatInt(int64(l.TurnMaxMiB)<<20, 10)},
		{"memory.high", strconv.FormatInt(int64(l.TurnHighMiB)<<20, 10)},
		{"pids.max", strconv.Itoa(l.TurnPidsMax)},
		{"memory.oom.group", "1"},
	} {
		if err := set(kv[0], kv[1]); err != nil {
			c.remove()
			return nil, err
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

// kill ends every process in the cgroup (cgroup.kill, Linux 5.14+; else SIGKILL to each listed pid) and waits up to
// 2 s until it is empty. Returns whether the kernel OOM-killed something in it.
func (c *turnCg) kill() bool {
	if err := writeCg(c.dir, "cgroup.kill", "1"); err != nil {
		for i := 0; i < 20; i++ {
			b, _ := os.ReadFile(filepath.Join(c.dir, "cgroup.procs"))
			pids := strings.Fields(string(b))
			if len(pids) == 0 {
				break
			}
			for _, p := range pids {
				if n, err := strconv.Atoi(p); err == nil {
					_ = syscall.Kill(n, syscall.SIGKILL)
				}
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if b, err := os.ReadFile(filepath.Join(c.dir, "cgroup.events")); err != nil || bytes.Contains(b, []byte("populated 0")) {
			break
		}
	}
	return cgCounter(filepath.Join(c.dir, "memory.events"), "oom_kill") > 0 || cgCounter(filepath.Join(c.dir, "memory.events"), "oom_group_kill") > 0
}

func cgCounter(file, key string) int64 {
	f, err := os.Open(file)
	if err != nil {
		return 0
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		fs := strings.Fields(s.Text())
		if len(fs) == 2 && fs[0] == key {
			n, _ := strconv.ParseInt(fs[1], 10, 64)
			return n
		}
	}
	return 0
}

func (c *turnCg) remove() {
	if c.fd >= 0 {
		_ = unix.Close(c.fd)
		c.fd = -1
	}
	for i := 0; i < 50; i++ {
		err := unix.Rmdir(c.dir)
		if err == nil || os.IsNotExist(err) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// probeCgroupFD: does clone3 with CLONE_INTO_CGROUP work here? Some container seccomp profiles answer clone3 with
// ENOSYS (Go then cannot start the process at all); the turn then joins its cgroup through `mycel-sandbox cgexec`.
func probeCgroupFD(r *cgRoot) bool {
	dir := filepath.Join(r.turns, "probe")
	_ = unix.Rmdir(dir)
	if err := os.Mkdir(dir, 0o755); err != nil {
		return false
	}
	defer unix.Rmdir(dir)
	fd, err := unix.Open(dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return false
	}
	defer unix.Close(fd)
	self, err := os.Executable()
	if err != nil {
		return false
	}
	cmd := exec.Command(self, probeArg)
	cmd.SysProcAttr = &syscall.SysProcAttr{UseCgroupFD: true, CgroupFD: fd}
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "mycel-launcher: clone3 into a cgroup unavailable, using cgexec:", err)
		return false
	}
	_ = cmd.Wait()
	return true
}

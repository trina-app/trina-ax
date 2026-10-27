//go:build linux

package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// cmdSupervise runs an install without systemd (spec 3.2.5; Docker tests, customers who insist on containers — not
// supported for hosting): ① the engine firewall (needs CAP_NET_ADMIN), ② the launcher as the engine account, ③ the
// bootstrap as the server account, with the same arguments and environment as the systemd units. A child that dies is
// started again after 1 s; SIGTERM/SIGINT stop both (SIGKILL after 30 s); orphans are reaped (PID 1 or subreaper);
// the firewall is re-applied every 2 minutes. When /sys/fs/cgroup is a writable cgroup v2 tree, the launcher and the
// server get delegated cgroups of their own (what systemd's Delegate= gives), else the launcher runs with --cgroup
// auto and no turn limits.
func cmdSupervise(e *env, args []string) (int, error) {
	fs := flag.NewFlagSet("supervise", flag.ContinueOnError)
	e.flags(fs)
	if err := fs.Parse(args); err != nil {
		return 2, usageError{err.Error()}
	}
	if err := requireRoot(); err != nil {
		return 2, err
	}
	if err := checkBase(e.base); err != nil {
		return 1, err
	}
	in, err := loadInstall(e)
	if err != nil {
		return 1, err
	}
	srv, err := lookupAccount(in.ServerUser)
	if err != nil {
		return 1, err
	}
	agt, err := lookupAccount(in.AgentUser)
	if err != nil {
		return 1, err
	}
	_ = unix.Prctl(unix.PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) // orphans come to us even when we are not PID 1
	// the units run with NoNewPrivileges=yes; so does everything started here (bwrap is not setuid on Debian/Ubuntu)
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		return 1, fmt.Errorf("no_new_privs: %v", err)
	}
	logf := func(format string, a ...any) {
		fmt.Fprintf(e.stderr, "%s mycel-ctl supervise: %s\n", time.Now().UTC().Format(time.RFC3339), fmt.Sprintf(format, a...))
	}
	if _, err := firewallApply(e); err != nil {
		logf("firewall: %v (the launcher refuses turns until it loads)", err)
	}
	cgs := delegateCgroups(in, srv, agt, logf)
	procs := []*superProc{
		{name: "launcher", argv: launcherArgv(in, srv.uid, caBundle(), "auto"), env: launcherEnv(in), acct: agt, umask: 0o077, dir: "/", cgroup: cgs["launcher"]},
		{name: "server", argv: bootstrapArgv(in), env: append(serverEnv(in), readDefaults("/etc/default/"+in.ID)...), acct: srv, umask: 0o027, dir: "/", cgroup: cgs["server"]},
	}
	sigs := make(chan os.Signal, 16)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT, syscall.SIGCHLD)
	fwTick := time.NewTicker(2 * time.Minute)
	defer fwTick.Stop()
	poll := time.NewTicker(250 * time.Millisecond)
	defer poll.Stop()
	stopping := false
	var stopDeadline time.Time
	for {
		now := time.Now()
		if !stopping {
			for _, p := range procs {
				if p.pid == 0 && !now.Before(p.restartAt) {
					if err := p.start(); err != nil {
						logf("start %s: %v", p.name, err)
						p.restartAt = now.Add(time.Second)
					} else {
						logf("started %s (pid %d)", p.name, p.pid)
					}
				}
			}
		}
		select {
		case s := <-sigs:
			if s == syscall.SIGCHLD {
				break
			}
			if !stopping {
				logf("%v: stopping", s)
				stopping, stopDeadline = true, time.Now().Add(30*time.Second)
				for _, p := range procs {
					if p.pid > 0 {
						_ = syscall.Kill(p.pid, syscall.SIGTERM)
					}
				}
			}
		case <-fwTick.C:
			if _, err := firewallApply(e); err != nil {
				logf("firewall: %v", err)
			}
		case <-poll.C:
		}
		// reap every exited child: ours (restart after 1 s) and orphans
		for {
			var ws syscall.WaitStatus
			pid, err := syscall.Wait4(-1, &ws, syscall.WNOHANG, nil)
			if pid <= 0 || err != nil {
				break
			}
			for _, p := range procs {
				if p.pid == pid {
					logf("%s (pid %d) exited: %s", p.name, pid, describeWait(ws))
					p.pid, p.restartAt = 0, time.Now().Add(time.Second)
				}
			}
		}
		if stopping {
			alive := 0
			for _, p := range procs {
				if p.pid > 0 {
					alive++
					if time.Now().After(stopDeadline) {
						_ = syscall.Kill(p.pid, syscall.SIGKILL)
					}
				}
			}
			if alive == 0 {
				return 0, nil
			}
		}
	}
}

func describeWait(ws syscall.WaitStatus) string {
	if ws.Signaled() {
		return "signal " + ws.Signal().String()
	}
	return "exit " + strconv.Itoa(ws.ExitStatus())
}

type superProc struct {
	name      string
	argv      []string
	env       []string
	acct      account
	umask     int
	dir       string
	cgroup    string
	pid       int
	restartAt time.Time
}

// start runs the child as its account: no supplementary groups, no capabilities (a non-root uid after exec keeps
// none), its own process group, killed when the supervisor dies, born inside its delegated cgroup when there is one.
func (p *superProc) start() error {
	cmd := exec.Command(p.argv[0], p.argv[1:]...)
	cmd.Env = p.env
	cmd.Dir = p.dir
	cmd.Stdin = nil
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	attr := &syscall.SysProcAttr{
		Credential: &syscall.Credential{Uid: uint32(p.acct.uid), Gid: uint32(p.acct.gid), Groups: []uint32{}},
		Setpgid:    true,
		Pdeathsig:  syscall.SIGKILL,
	}
	if p.cgroup != "" {
		fd, err := unix.Open(p.cgroup, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
		if err == nil {
			defer unix.Close(fd)
			attr.UseCgroupFD, attr.CgroupFD = true, fd
		}
	}
	cmd.SysProcAttr = attr
	old := syscall.Umask(p.umask)
	err := cmd.Start()
	syscall.Umask(old)
	if err != nil {
		return err
	}
	p.pid = cmd.Process.Pid
	return nil
}

var envKeyRe = regexp.MustCompile(`^[A-Z_][A-Z0-9_]*$`)

// readDefaults reads /etc/default/<id> (KEY=VALUE lines the control plane writes: MYCEL_TEAM_TZ, MYCEL_INSTALL_ID,
// MYCEL_MODELS_DIR), like systemd's EnvironmentFile=-.
func readDefaults(p string) []string {
	f, err := os.Open(p)
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		l := strings.TrimSpace(sc.Text())
		if l == "" || strings.HasPrefix(l, "#") {
			continue
		}
		k, v, ok := strings.Cut(l, "=")
		if !ok || !envKeyRe.MatchString(k) {
			continue
		}
		out = append(out, k+"="+strings.Trim(v, `"'`))
	}
	return out
}

// delegateCgroups gives the launcher and the server cgroups of their own under /sys/fs/cgroup, owned by their
// accounts (cgroup v2 delegation: the folder and its cgroup.procs, cgroup.threads, cgroup.subtree_control). A
// namespaced cgroup root may not hold processes while it enables controllers for its children, so every process in
// it moves to <id>-init first. Best effort: any failure gives no cgroups (the launcher then runs --cgroup auto).
func delegateCgroups(in *Install, srv, agt account, logf func(string, ...any)) map[string]string {
	root := "/sys/fs/cgroup"
	out := map[string]string{}
	var st unix.Statfs_t
	if unix.Statfs(root, &st) != nil || st.Type != unix.CGROUP2_SUPER_MAGIC {
		logf("no cgroup v2 at %s: no turn limits", root)
		return out
	}
	fail := func(err error) map[string]string {
		logf("cgroup delegation not possible (%v): no turn limits", err)
		return map[string]string{}
	}
	ctrl, err := os.ReadFile(filepath.Join(root, "cgroup.controllers"))
	if err != nil {
		return fail(err)
	}
	want := []string{}
	for _, c := range []string{"memory", "pids", "cpu"} {
		if strings.Contains(" "+strings.TrimSpace(string(ctrl))+" ", " "+c+" ") {
			want = append(want, "+"+c)
		}
	}
	initCg := filepath.Join(root, in.ID+"-init")
	if err := os.Mkdir(initCg, 0o755); err != nil && !os.IsExist(err) {
		return fail(err)
	}
	for round := 0; round < 5; round++ {
		b, err := os.ReadFile(filepath.Join(root, "cgroup.procs"))
		if err != nil {
			return fail(err)
		}
		pids := strings.Fields(string(b))
		if len(pids) == 0 {
			break
		}
		for _, pid := range pids {
			_ = os.WriteFile(filepath.Join(initCg, "cgroup.procs"), []byte(pid), 0)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "cgroup.subtree_control"), []byte(strings.Join(want, " ")), 0); err != nil {
		return fail(err)
	}
	for name, a := range map[string]account{"launcher": agt, "server": srv} {
		d := filepath.Join(root, in.ID+"-"+name)
		if err := os.Mkdir(d, 0o755); err != nil && !os.IsExist(err) {
			return fail(err)
		}
		for _, f := range []string{"", "cgroup.procs", "cgroup.threads", "cgroup.subtree_control"} {
			if err := os.Chown(filepath.Join(d, f), a.uid, a.gid); err != nil {
				return fail(err)
			}
		}
		out[name] = d
	}
	logf("delegated cgroups %s-launcher and %s-server (%s)", in.ID, in.ID, strings.Join(want, " "))
	return out
}

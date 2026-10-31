package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

var acct struct {
	uid, gid int
	home     string
}

var avail struct {
	ok     bool
	reason string
	checks map[string]string
}

func setup() error {
	avail.checks = map[string]string{}
	fail := func(why string) error { avail.ok = false; avail.reason = why; return errors.New(why) }
	if os.Geteuid() != 0 {
		return fail("boxd must run as root (idmapped mounts, box network rules)")
	}
	u, err := user.Lookup(*boxUser)
	if err != nil {
		return fail("no box account " + *boxUser)
	}
	acct.uid, _ = strconv.Atoi(u.Uid)
	acct.gid, _ = strconv.Atoi(u.Gid)
	acct.home = u.HomeDir
	if acct.uid == 0 || acct.uid == *serverUID {
		return fail("the box account must not be root or the server account")
	}
	var uts unix.Utsname
	unix.Uname(&uts)
	avail.checks["kernel"] = unix.ByteSliceToString(uts.Release[:])
	if !kernelAtLeast(avail.checks["kernel"], 5, 19) {
		return fail("kernel 5.19 or newer is needed (idmapped bind mounts)")
	}
	if _, err := os.Stat("/sys/fs/cgroup/cgroup.controllers"); err != nil {
		return fail("cgroup v2 is needed")
	}
	if st, err := os.Stat(*teamRoot); err != nil || !st.IsDir() || !filepath.IsAbs(*teamRoot) {
		return fail("--team-root is not an absolute folder")
	}
	v, err := podmanOut("--version")
	if err != nil {
		return fail("podman does not run as the box account: " + err.Error())
	}
	avail.checks["podman"] = strings.TrimSpace(v)
	help, _ := exec.Command("mount", "--help").CombinedOutput()
	if !bytes.Contains(help, []byte("map-users")) {
		return fail("mount(8) has no --map-users (util-linux 2.39 or newer is needed)")
	}
	for _, t := range []string{"nft", "nsenter", "ip"} {
		if _, err := exec.LookPath(t); err != nil {
			return fail(t + " is missing")
		}
	}
	if p, err := exec.LookPath("mkfs.xfs"); err == nil {
		avail.checks["mkfs"] = p
	} else if p, err := exec.LookPath("mkfs.ext4"); err == nil {
		avail.checks["mkfs"] = p
	} else {
		return fail("mkfs.xfs or mkfs.ext4 is needed (box volumes)")
	}
	if _, err := exec.LookPath("conntrack"); err == nil {
		avail.checks["conntrack"] = "yes"
	} else {
		avail.checks["conntrack"] = "no (no destination log in open mode)"
	}
	st, err := os.Stat(*seccompF)
	if err != nil {
		return fail("no box seccomp profile at " + *seccompF)
	}
	if s := st.Sys().(*syscall.Stat_t); s.Uid != 0 || st.Mode().Perm()&0o022 != 0 {
		return fail("the seccomp profile must be root's and not writable by others")
	}
	if _, err := podmanOut("image", "exists", *image); err != nil {
		return fail("box image " + *image + " is missing (scripts/dev-env/build-image.sh)")
	}
	id, _ := podmanOut("image", "inspect", "-f", "{{.Id}}", *image)
	avail.checks["image"] = strings.TrimSpace(id)
	for _, d := range []string{*stateDir, filepath.Join(*stateDir, "boxes"), *runDir, filepath.Join(*runDir, "boxes"), filepath.Join(*runDir, "preview")} {
		if err := os.MkdirAll(d, 0o711); err != nil {
			return fail("cannot make " + d)
		}
		os.Chmod(d, 0o711)
	}
	// fail closed after a restart: boxes that still run have no preview or destination log here; stop them
	names, _ := podmanOut("ps", "-q", "--filter", "label=mycel.box", "--format", "{{.Names}}")
	for _, n := range strings.Fields(names) {
		podmanOut("stop", "-t", strconv.Itoa(stopGrace), n)
	}
	avail.ok = true
	avail.reason = ""
	return nil
}

func kernelAtLeast(rel string, maj, min int) bool {
	f := strings.FieldsFunc(rel, func(r rune) bool { return r == '.' || r == '-' })
	if len(f) < 2 {
		return false
	}
	a, _ := strconv.Atoi(f[0])
	b, _ := strconv.Atoi(f[1])
	return a > maj || (a == maj && b >= min)
}

// podmanCmd: podman as the box account, in its own session, with its own HOME and runtime folder (rootless podman
// needs a systemd user instance: loginctl enable-linger <box account>).
func podmanCmd(ctx context.Context, args ...string) *exec.Cmd {
	c := exec.CommandContext(ctx, "podman", args...)
	c.Dir = acct.home
	c.Env = []string{"HOME=" + acct.home, "XDG_RUNTIME_DIR=/run/user/" + strconv.Itoa(acct.uid), "PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", "LANG=C.UTF-8"}
	c.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Credential: &syscall.Credential{Uid: uint32(acct.uid), Gid: uint32(acct.gid), Groups: []uint32{}}}
	return c
}

func podmanOut(args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	var o, e bytes.Buffer
	c := podmanCmd(ctx, args...)
	c.Stdout, c.Stderr = &o, &e
	if err := c.Run(); err != nil {
		msg := strings.TrimSpace(e.String())
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return o.String(), fmt.Errorf("podman %s: %v %s", args[0], err, msg)
	}
	return o.String(), nil
}

func run(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %v %s", name, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func mounted(p string) bool {
	b, _ := os.ReadFile("/proc/self/mountinfo")
	for _, l := range strings.Split(string(b), "\n") {
		f := strings.Fields(l)
		if len(f) > 4 && f[4] == p {
			return true
		}
	}
	return false
}

// openFolder opens <team root>/<rel> without following any link at any level (openat2 RESOLVE_NO_SYMLINKS |
// RESOLVE_BENEATH) and checks it is a folder of the server account. The mount uses this descriptor, not the path, so a
// link swapped in afterwards changes nothing.
func openFolder(rel string) (int, error) {
	root, err := unix.Open(*teamRoot, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	defer unix.Close(root)
	fd, err := unix.Openat2(root, rel, &unix.OpenHow{Flags: unix.O_PATH | unix.O_DIRECTORY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_BENEATH | unix.RESOLVE_NO_MAGICLINKS})
	if err != nil {
		return -1, fmt.Errorf("folder: %v", err)
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil || st.Uid != uint32(*serverUID) {
		unix.Close(fd)
		return -1, fmt.Errorf("folder is not the server account's")
	}
	return fd, nil
}

// mountPoint: <folder>/<name> as an empty folder of the server account (node_modules, .venv are box volume mounts
// over it); refused if it is anything but a folder.
func mountPoint(dirfd int, name string) error {
	var st unix.Stat_t
	err := unix.Fstatat(dirfd, name, &st, unix.AT_SYMLINK_NOFOLLOW)
	if err == nil {
		if st.Mode&unix.S_IFMT != unix.S_IFDIR {
			return fmt.Errorf("%s in the folder is not a folder", name)
		}
		return nil
	}
	// O_PATH descriptors cannot mkdirat; reopen the folder for it
	d, err := unix.Openat(dirfd, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer unix.Close(d)
	if err := unix.Mkdirat(d, name, 0o755); err != nil && !errors.Is(err, unix.EEXIST) {
		return err
	}
	return unix.Fchownat(d, name, *serverUID, *serverGID, unix.AT_SYMLINK_NOFOLLOW)
}

func volume(p boxPaths, l limits) error {
	if err := os.MkdirAll(p.Dir, 0o710); err != nil {
		return err
	}
	os.Chown(p.Dir, 0, acct.gid)
	os.Chmod(p.Dir, 0o710)
	if _, err := os.Stat(p.Img); err != nil {
		f, err := os.OpenFile(p.Img, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		f.Truncate(int64(l.DiskGiB) << 30)
		f.Close()
		mk := avail.checks["mkfs"]
		args := []string{"-q", p.Img}
		if strings.HasSuffix(mk, "ext4") {
			args = []string{"-q", "-F", p.Img}
		}
		if err := run(mk, args...); err != nil {
			os.Remove(p.Img)
			return err
		}
	}
	os.MkdirAll(p.Vol, 0o700)
	if !mounted(p.Vol) {
		if err := run("mount", "-o", "loop,nosuid,nodev", p.Img, p.Vol); err != nil {
			return err
		}
	}
	os.Chown(p.Vol, acct.uid, acct.gid)
	for _, d := range []string{"cache", "cache/home", "cache/npm", "cache/pip", "cache/logs", "cache/run", "node_modules", "venv"} {
		q := filepath.Join(p.Vol, d)
		os.MkdirAll(q, 0o700)
		os.Lchown(q, acct.uid, acct.gid)
	}
	return nil
}

// idmapped: the team folder at <box>/work, mapped server account -> box account (P0 spike section 3.2).
func idmapped(p boxPaths, folder string) error {
	if mounted(p.Work) {
		return nil
	}
	fd, err := openFolder(folder)
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(fd), "folder") // owns fd from here (one close)
	defer f.Close()
	for _, n := range []string{"node_modules", ".venv"} {
		if err := mountPoint(fd, n); err != nil {
			return err
		}
	}
	os.MkdirAll(p.Work, 0o755)
	m := fmt.Sprintf("%d:%d:1", *serverUID, acct.uid)
	g := fmt.Sprintf("%d:%d:1", *serverGID, acct.gid)
	c := exec.Command("mount", "--bind", "--map-users", m, "--map-groups", g, "/proc/self/fd/3", p.Work)
	c.ExtraFiles = []*os.File{f}
	if out, err := c.CombinedOutput(); err != nil {
		return fmt.Errorf("idmapped mount: %v %s", err, strings.TrimSpace(string(out)))
	}
	// no set-uid programs or device files from the team folder
	return run("mount", "-o", "remount,bind,nosuid,nodev", p.Work)
}

func inspect(name, format string) (string, error) {
	s, err := podmanOut("inspect", "-f", format, name)
	return strings.TrimSpace(s), err
}

func runningCount(except string) int {
	n := 0
	boxes.Lock()
	for id, b := range boxes.m {
		if id != except && b.running {
			n++
		}
	}
	boxes.Unlock()
	return n
}

func ensure(r *request) (map[string]any, error) {
	if !avail.ok {
		return nil, fmt.Errorf("boxes are not available: %s", avail.reason)
	}
	b := boxOf(r.Box)
	b.mu.Lock()
	defer b.mu.Unlock()
	name := containerName(r.Box)
	p := pathsOf(*stateDir, *runDir, r.Box)
	if state, err := inspect(name, "{{.State.Status}}"); err == nil && state == "running" && b.running {
		if h, _ := inspect(name, `{{index .Config.Labels "mycel.config"}}`); h == configHash(*image, *seccompF, r.Limits, r.Network) {
			b.touch()
			return infoOf(b, "running"), nil
		}
		stopLocked(b, p, false)
	}
	if runningCount(r.Box) >= *maxBoxes {
		return nil, fmt.Errorf("another project box runs on this server; it stops after its idle time, or stop it from its project")
	}
	if err := volume(p, r.Limits); err != nil {
		return nil, fmt.Errorf("box volume: %v", err)
	}
	if err := idmapped(p, r.Folder); err != nil {
		return nil, err
	}
	want := configHash(*image, *seccompF, r.Limits, r.Network)
	if h, err := inspect(name, `{{index .Config.Labels "mycel.config"}}`); err != nil || h != want {
		podmanOut("rm", "-f", name)
		if _, err := podmanOut(createArgs(r.Box, p, *image, *seccompF, r.Limits, r.Network)...); err != nil {
			return nil, err
		}
	}
	if _, err := podmanOut("start", name); err != nil {
		return nil, err
	}
	pidS, err := inspect(name, "{{.State.Pid}}")
	pid, _ := strconv.Atoi(pidS)
	if err != nil || pid <= 0 {
		podmanOut("kill", name)
		return nil, fmt.Errorf("box did not start")
	}
	// network rules into the box's namespace before any command (fail closed: the box stops if they do not load)
	if err := loadRules(pid, r.Network, r.DenyAddrs); err != nil {
		podmanOut("kill", name)
		return nil, fmt.Errorf("box network rules did not load: %v", err)
	}
	os.MkdirAll(p.Run, 0o700)
	startConnLog(b, pid, p)
	cg := cgroupDir(name)
	boxes.Lock()
	cgCache[r.Box] = cg
	b.running = true
	b.startedAt = time.Now()
	b.lastActive = time.Now()
	b.idle = time.Duration(r.Limits.IdleStopMin) * time.Minute
	boxes.Unlock()
	log.Printf("started %s (%s)", r.Box, r.Network)
	return infoOf(b, "running"), nil
}

func loadRules(pid int, network string, deny []string) error {
	t := strconv.Itoa(pid)
	if err := run("nsenter", "-t", t, "-n", "ip", "link", "set", "lo", "up"); err != nil {
		return err
	}
	c := exec.Command("nsenter", "-t", t, "-n", "nft", "-f", "-")
	c.Stdin = strings.NewReader(rules(network, deny))
	if out, err := c.CombinedOutput(); err != nil {
		return fmt.Errorf("%v %s", err, strings.TrimSpace(string(out)))
	}
	return run("nsenter", "-t", t, "-n", "nft", "list", "table", "inet", "mycel_box")
}

var connLogs = map[string]*exec.Cmd{}

// startConnLog: new connections of an open box, from conntrack in the box's namespace (hole 7: destinations).
func startConnLog(b *box, pid int, p boxPaths) {
	if avail.checks["conntrack"] != "yes" {
		return
	}
	f, err := os.OpenFile(filepath.Join(p.Run, "conn.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	c := exec.Command("nsenter", "-t", strconv.Itoa(pid), "-n", "conntrack", "-E", "-e", "NEW", "-o", "timestamp")
	c.Stdout = &limitWriter{w: f, left: 8 << 20}
	if c.Start() == nil {
		boxes.Lock()
		connLogs[b.id] = c
		boxes.Unlock()
		go func() { c.Wait(); f.Close() }()
	} else {
		f.Close()
	}
}

type limitWriter struct {
	w    io.Writer
	left int64
}

func (l *limitWriter) Write(p []byte) (int, error) {
	if l.left <= 0 {
		return len(p), nil
	}
	n := int64(len(p))
	if n > l.left {
		n = l.left
	}
	l.left -= n
	l.w.Write(p[:n])
	return len(p), nil
}

func stop(id string, destroy bool) error {
	b := boxOf(id)
	b.mu.Lock()
	defer b.mu.Unlock()
	return stopLocked(b, pathsOf(*stateDir, *runDir, id), destroy)
}

func stopLocked(b *box, p boxPaths, destroy bool) error {
	name := containerName(b.id)
	boxes.Lock()
	for port, ln := range b.previews {
		ln.Close()
		delete(b.previews, port)
	}
	b.running = false
	c := connLogs[b.id]
	delete(connLogs, b.id)
	boxes.Unlock()
	if c != nil && c.Process != nil {
		c.Process.Kill()
	}
	var err error
	if _, e := inspect(name, "{{.State.Status}}"); e == nil {
		_, err = podmanOut("stop", "-t", strconv.Itoa(stopGrace), name)
		if destroy {
			podmanOut("rm", "-f", name)
		}
	}
	// the folder is not reachable through boxd's paths while the box does not run
	if mounted(p.Work) {
		run("umount", p.Work)
	}
	if mounted(p.Vol) {
		run("umount", p.Vol)
	}
	if destroy {
		os.RemoveAll(p.Run)
		if !mounted(p.Vol) && !mounted(p.Work) {
			os.RemoveAll(p.Dir)
		}
	}
	log.Printf("stopped %s (destroy %v)", b.id, destroy)
	return err
}

func cgroupDir(name string) string {
	cg, err := inspect(name, "{{.State.CgroupPath}}")
	if err != nil || cg == "" {
		return ""
	}
	return filepath.Join("/sys/fs/cgroup", cg)
}

func oomKills(cg string) int64 {
	b, _ := os.ReadFile(filepath.Join(cg, "memory.events"))
	for _, l := range strings.Split(string(b), "\n") {
		if f := strings.Fields(l); len(f) == 2 && f[0] == "oom_kill" {
			n, _ := strconv.ParseInt(f[1], 10, 64)
			return n
		}
	}
	return 0
}

func execIn(r *request, stopped <-chan struct{}) (map[string]any, error) {
	b := boxOf(r.Box)
	b.mu.Lock()
	running := b.running
	b.mu.Unlock()
	if !running {
		return nil, fmt.Errorf("the box does not run")
	}
	name := containerName(r.Box)
	b.touch()
	defer b.touch()
	cg := cgroupDir(name)
	oom0 := oomKills(cg)
	timeout := time.Duration(r.TimeoutMs) * time.Millisecond
	if r.Background {
		timeout = 30 * time.Second // only the start; the process lives on
	}
	tag := randHex(8)
	args := execArgs(r.Box, r.Cwd, timeout)
	// the exec's tag (MYCEL_EXEC) lets boxd find and kill what this command started when the server stops it
	args = append(args[:2], append([]string{"-e", "MYCEL_EXEC=" + tag}, args[2:]...)...)
	ctx, cancel := context.WithTimeout(context.Background(), timeout+time.Duration(killGraceSec+10)*time.Second)
	defer cancel()
	c := podmanCmd(ctx, args...)
	c.Stdin = strings.NewReader(execScript(r.Command, r.Background, r.LogName, "MYCEL_EOF_"+randHex(8)))
	so, se := &capBuf{max: outMax}, &capBuf{max: outMax}
	c.Stdout, c.Stderr = so, se
	start := time.Now()
	if err := c.Start(); err != nil {
		return nil, err
	}
	done := make(chan error, 1)
	go func() { done <- c.Wait() }()
	signal := ""
	var err error
	select {
	case err = <-done:
	case <-stopped:
		signal = "stopped"
		killTagged(cg, tag)
		err = <-done
	}
	code := 0
	if c.ProcessState != nil {
		code = c.ProcessState.ExitCode()
	}
	if signal == "" {
		if oomKills(cg) > oom0 {
			signal = "oom"
		} else if !r.Background && (code == 124 || (code == 137 && time.Since(start) >= timeout)) {
			signal = "timeout"
		} else if ctx.Err() != nil {
			signal = "timeout"
			killTagged(cg, tag)
		}
	}
	_ = err
	return map[string]any{"ev": "exit", "code": code, "signal": signal, "stdout": so.text(), "stderr": se.text(),
		"truncated": so.dropped > 0 || se.dropped > 0, "ms": time.Since(start).Milliseconds()}, nil
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// cgroupPids: every process in the box's cgroup tree.
func cgroupPids(cg string) []int {
	var out []int
	filepath.WalkDir(cg, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || d.Name() != "cgroup.procs" {
			return nil
		}
		b, _ := os.ReadFile(p)
		for _, f := range strings.Fields(string(b)) {
			if n, e := strconv.Atoi(f); e == nil {
				out = append(out, n)
			}
		}
		return nil
	})
	return out
}

func killTagged(cg, tag string) {
	if cg == "" {
		return
	}
	needle := []byte("MYCEL_EXEC=" + tag + "\x00")
	for _, pid := range cgroupPids(cg) {
		env, _ := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/environ")
		if bytes.Contains(env, needle) {
			unix.Kill(pid, unix.SIGKILL)
		}
	}
}

func processes(id string) ([]procInfo, error) {
	cg := cgroupDir(containerName(id))
	if cg == "" {
		return []procInfo{}, nil
	}
	up := uptime()
	var ps []procInfo
	for _, pid := range cgroupPids(cg) {
		d := "/proc/" + strconv.Itoa(pid)
		cmd, _ := os.ReadFile(d + "/cmdline")
		st, _ := os.ReadFile(d + "/status")
		stat, _ := os.ReadFile(d + "/stat")
		var secs int64
		if i := bytes.LastIndexByte(stat, ')'); i > 0 {
			f := strings.Fields(string(stat[i+1:]))
			if len(f) > 19 {
				t, _ := strconv.ParseInt(f[19], 10, 64)
				secs = int64(up) - t/100
			}
		}
		ps = append(ps, procInfo{Pid: nspid(string(st)), Seconds: secs, Command: strings.TrimSpace(strings.ReplaceAll(string(cmd), "\x00", " "))})
	}
	return psFilter(ps), nil
}

func uptime() float64 {
	b, _ := os.ReadFile("/proc/uptime")
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	return v
}

func infoOf(b *box, state string) map[string]any {
	boxes.Lock()
	defer boxes.Unlock()
	iso := func(t time.Time) any {
		if t.IsZero() {
			return nil
		}
		return t.UTC().Format(time.RFC3339)
	}
	var mem any
	if cg := cgroupDirCached(b.id); cg != "" {
		st, _ := os.ReadFile(filepath.Join(cg, "memory.stat"))
		for _, l := range strings.Split(string(st), "\n") {
			if f := strings.Fields(l); len(f) == 2 && f[0] == "anon" {
				n, _ := strconv.ParseFloat(f[1], 64)
				mem = float64(int(n/(1<<20)*10)) / 10
			}
		}
	}
	return map[string]any{"box": b.id, "state": state, "startedAt": iso(b.startedAt), "lastActiveAt": iso(b.lastActive), "memoryMiB": mem}
}

var cgCache = map[string]string{}

func cgroupDirCached(id string) string { return cgCache[id] }

func statusEv() map[string]any {
	ev := map[string]any{"ev": "status", "available": avail.ok, "checks": avail.checks, "boxes": []any{}}
	if avail.reason != "" {
		ev["reason"] = avail.reason
	}
	list := []any{}
	boxes.Lock()
	ids := make([]*box, 0, len(boxes.m))
	for _, b := range boxes.m {
		ids = append(ids, b)
	}
	boxes.Unlock()
	for _, b := range ids {
		state := "stopped"
		if b.running {
			state = "running"
		}
		list = append(list, infoOf(b, state))
	}
	ev["boxes"] = list
	return ev
}

// preview: a unix socket for the server (0600, its uid) whose connections go to 127.0.0.1:<port> in the box.
func preview(id string, port int) (string, error) {
	b := boxOf(id)
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.running {
		return "", fmt.Errorf("the box does not run")
	}
	sock := filepath.Join(*runDir, "preview", id+"-"+strconv.Itoa(port)+".sock")
	if _, ok := b.previews[port]; ok {
		return sock, nil
	}
	pidS, err := inspect(containerName(id), "{{.State.Pid}}")
	if err != nil {
		return "", err
	}
	nsf, err := os.Open("/proc/" + pidS + "/ns/net")
	if err != nil {
		return "", err
	}
	os.Remove(sock)
	ln, err := net.Listen("unix", sock)
	if err != nil {
		nsf.Close()
		return "", err
	}
	os.Chown(sock, *serverUID, *serverGID)
	os.Chmod(sock, 0o600)
	boxes.Lock()
	b.previews[port] = ln
	boxes.Unlock()
	go func() {
		defer nsf.Close()
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			b.touch()
			go func() {
				defer c.Close()
				up, err := dialIn(int(nsf.Fd()), "127.0.0.1:"+strconv.Itoa(port))
				if err != nil {
					return
				}
				defer up.Close()
				go func() { io.Copy(up, c); up.(*net.TCPConn).CloseWrite() }()
				io.Copy(c, up)
			}()
		}
	}()
	return sock, nil
}

// dialIn: a TCP connection made in another network namespace (setns on a locked thread, back after the dial; a
// thread that cannot go back is not unlocked, so Go ends it).
func dialIn(nsfd int, addr string) (net.Conn, error) {
	runtime.LockOSThread()
	self, err := os.Open("/proc/thread-self/ns/net")
	if err != nil {
		runtime.UnlockOSThread()
		return nil, err
	}
	defer self.Close()
	if err := unix.Setns(nsfd, unix.CLONE_NEWNET); err != nil {
		runtime.UnlockOSThread()
		return nil, err
	}
	c, derr := net.DialTimeout("tcp", addr, 5*time.Second)
	if err := unix.Setns(int(self.Fd()), unix.CLONE_NEWNET); err != nil {
		if c != nil {
			c.Close()
		}
		return nil, err // thread stays locked and is thrown away
	}
	runtime.UnlockOSThread()
	return c, derr
}

// netlog: the last new connections of the box (conntrack lines: time, protocol, destination, port).
func netlog(id string) ([]string, error) {
	f, err := os.Open(filepath.Join(pathsOf(*stateDir, *runDir, id).Run, "conn.log"))
	if err != nil {
		return []string{}, nil
	}
	defer f.Close()
	var lines []string
	s := bufio.NewScanner(f)
	for s.Scan() {
		if l := connLine(s.Text()); l != "" {
			lines = append(lines, l)
			if len(lines) > 500 {
				lines = lines[1:]
			}
		}
	}
	return lines, nil
}

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
	"sort"
	"strconv"
	"strings"
	"sync"
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
	// fail closed after a restart: boxes that still run have no preview or destination log here; stop them. This comes
	// before the checks below: a failed check must not leave a box that runs and that nothing watches.
	names, err := podmanOut("ps", "-q", "--filter", "label=mycel.box", "--format", "{{.Names}}")
	if err != nil {
		log.Printf("setup: cannot list the boxes: %v", err)
	}
	for _, n := range strings.Fields(names) {
		podmanOut("stop", "-t", strconv.Itoa(stopGrace), n)
	}
	var uts unix.Utsname
	unix.Uname(&uts)
	mem := memTotalKiB()
	avail.checks["memory"] = strconv.FormatInt(mem/1024, 10) + " MiB"
	if why := hostMemoryProblem(mem); why != "" {
		return fail(why)
	}
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
		return fail("no box seccomp profile at " + *seccompF + " (scripts/dev-env/build-image.sh, then restart mycel-boxd)")
	}
	if s := st.Sys().(*syscall.Stat_t); s.Uid != 0 || st.Mode().Perm()&0o022 != 0 {
		return fail("the seccomp profile must be root's and not writable by others")
	}
	if _, err := podmanOut("image", "exists", *image); err != nil {
		return fail("box image " + *image + " is missing (scripts/dev-env/build-image.sh, then restart mycel-boxd)")
	}
	id, _ := podmanOut("image", "inspect", "-f", "{{.Id}}", *image)
	avail.checks["image"] = strings.TrimSpace(id)
	for _, d := range []string{*stateDir, filepath.Join(*stateDir, "boxes"), *runDir, filepath.Join(*runDir, "boxes"), filepath.Join(*runDir, "preview")} {
		if err := os.MkdirAll(d, 0o711); err != nil {
			return fail("cannot make " + d)
		}
		os.Chmod(d, 0o711)
	}
	// the disks of the watchdog: box files go to the team root, the state folder and podman's storage
	diskPaths = []string{*teamRoot, *stateDir}
	if g, err := podmanOut("info", "--format", "{{.Store.GraphRoot}}"); err == nil && filepath.IsAbs(strings.TrimSpace(g)) {
		diskPaths = append(diskPaths, strings.TrimSpace(g))
	} else {
		log.Printf("setup: cannot read the podman storage path, the watchdog does not read that disk")
	}
	avail.checks["disks"] = strings.Join(diskPaths, " ")
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

// starts: see ensure.
var starts sync.Mutex

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

// boxImage reads what a box takes at its start: the ID of the image now and the hash of that ID and the seccomp
// profile. Do not use avail.checks["image"]: it has the ID from the boxd start, so it goes stale after a rebuild.
func boxImage() (id, hash string, err error) {
	out, err := podmanOut("image", "inspect", "-f", "{{.Id}}", *image)
	id = strings.TrimSpace(out)
	if err != nil {
		return "", "", fmt.Errorf("cannot read box image %s (if it is missing: scripts/dev-env/build-image.sh): %v", *image, err)
	}
	if id == "" {
		return "", "", fmt.Errorf("box image %s has no ID", *image)
	}
	seccomp, err := os.ReadFile(*seccompF)
	if err != nil {
		return "", "", fmt.Errorf("cannot read the box seccomp profile (scripts/dev-env/build-image.sh): %v", err)
	}
	if !fastAllocRefused(seccomp) {
		log.Printf("the box seccomp profile allows fallocate or its ioctls, which can fill the disk before the watchdog sees it: run scripts/dev-env/build-image.sh")
	}
	return id, imageHash(id, seccomp), nil
}

// ensure makes and starts a box. A running box stays when its limits and network match; a new image or seccomp profile
// reaches it at its next start, when the container is made again. The box volume and the folder are outside the
// container, so they stay. A box from an older boxd never gets to the running branch: setup stops every box at the
// boxd start.
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
		labels, err := inspect(name, labelsFormat)
		if err != nil { // no change is known: a failed read must not stop a running render
			return nil, fmt.Errorf("cannot read the box labels: %v", err)
		}
		if keepRunning(labels, r.Limits, r.Network) {
			b.touch()
			return infoOf(b, "running"), nil
		}
		stopLocked(b, p, false) // first: a box must not keep the old network if a later step fails
	}
	// one start at a time: a box counts as running only at the end of its start, so two first uses at the same moment would
	// both pass the check below. Before the first slow step, and the order is always b.mu, then this lock.
	starts.Lock()
	defer starts.Unlock()
	// before the mounts: a missing image must not leave the folder mounted
	imageID, imgHash, err := boxImage()
	if err != nil {
		return nil, err
	}
	if runningCount(r.Box) >= *maxBoxes {
		return nil, fmt.Errorf("another project box runs on this server; it stops after its idle time, or stop it from its project")
	}
	if free, total, err := diskSpace(); err == nil {
		if why := diskStartRefused(free, total); why != "" {
			return nil, errors.New(why)
		}
	}
	if err := volume(p, r.Limits); err != nil {
		return nil, fmt.Errorf("box volume: %v", err)
	}
	if err := idmapped(p, r.Folder); err != nil {
		return nil, err
	}
	if labels, err := inspect(name, labelsFormat); err != nil || !reuseStopped(labels, imgHash, r.Limits, r.Network) {
		podmanOut("rm", "-f", name)
		if _, err := podmanOut(createArgs(r.Box, p, imageID, *seccompF, imgHash, r.Limits, r.Network)...); err != nil {
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
	watch := make(chan struct{})
	boxes.Lock()
	cgCache[r.Box] = cg
	b.running = true
	b.startedAt = time.Now()
	b.lastActive = time.Now()
	b.lastBusy = time.Time{}
	b.cpuPrev, b.cpuAt = 0, time.Time{} // a new cgroup: its counter starts again
	b.idle = time.Duration(r.Limits.IdleStopMin) * time.Minute
	b.watch = watch
	boxes.Unlock()
	go watchBox(b, watch, cg)
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
	if b.watch != nil { // only a close: the watchdog itself can be the caller, so this must not wait for it
		close(b.watch)
		b.watch = nil
	}
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
	endJobs(b, p) // the last look at the logs: the volume goes next
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

// stopFor: stop a running box for a reason that people must see (the idle check). The check ran with no lock, so it is
// done again here: a command that came since then is activity (execIn touches under b.mu), and watch refuses a later
// start of the box.
func stopFor(id string, watch chan struct{}, code, reason string) error {
	b := boxOf(id)
	b.mu.Lock()
	defer b.mu.Unlock()
	boxes.Lock()
	again := idleVerdict(time.Now(), b.lastActive, b.lastBusy, b.idle)
	boxes.Unlock()
	if again != code || !markStop(b, watch, code, reason) {
		return nil
	}
	return stopLocked(b, pathsOf(*stateDir, *runDir, id), false)
}

// markStop records why the box stops, for the start that watch belongs to: a late watchdog does not touch the next
// start of the box. The first reason stays: diskStop kills the box before it gets b.mu, and in that gap the idle check or
// an exec can see the dead box. If their reason replaced "disk", nobody would hear of the disk floor.
func markStop(b *box, watch chan struct{}, code, reason string) bool {
	boxes.Lock()
	defer boxes.Unlock()
	if b.watch != watch || !b.running || stopKnown(b.stopCode, b.stoppedAt, b.startedAt) {
		return false
	}
	b.stopCode, b.stopReason, b.stoppedAt = code, reason, time.Now()
	return true
}

// diskPaths: the folders whose disks the watchdog reads (setup). Written once before the first box starts.
var diskPaths []string

// diskSpace: free bytes for accounts that are not root, and the size, of the box disk nearest its floor (worstDisk).
// A path that statfs cannot read does not hide the others. An error only if no disk can be read.
func diskSpace() (free, total uint64, err error) {
	paths := diskPaths
	if len(paths) == 0 {
		paths = []string{*teamRoot}
	}
	var ds []disk
	for _, p := range paths {
		var st unix.Statfs_t
		if e := unix.Statfs(p, &st); e != nil {
			err = e
			continue
		}
		size := uint64(st.Frsize)
		if size == 0 {
			size = uint64(st.Bsize)
		}
		ds = append(ds, disk{st.Bavail * size, uint64(st.Blocks) * size})
	}
	w, ok := worstDisk(ds)
	if !ok {
		if err == nil {
			err = errors.New("no disk of known size")
		}
		return 0, 0, err
	}
	return w.free, w.total, nil
}

// watchBox runs for one start of one box and ends when the box stops. Only a statfs per disk and a stat per poll, and no
// podman: at 740 MiB/s a slow poll goes far past the floor. A box in which a command ended the main process also ends
// here, so status says stopped.
func watchBox(b *box, watch chan struct{}, cg string) {
	t := time.NewTicker(diskPoll)
	defer t.Stop()
	failed, seen := false, false
	for {
		select {
		case <-watch:
			return
		case <-t.C:
		}
		free, total, err := diskSpace()
		if err != nil {
			if !failed {
				log.Printf("box %s: cannot read the disk space: %v", b.id, err)
			}
			failed = true
		} else {
			failed = false
			if diskLow(free, total) {
				diskStop(b, watch, cg, diskStopReason(free, total))
				return
			}
		}
		if cg != "" {
			_, err := os.Stat(filepath.Join(cg, "cgroup.procs"))
			if seen && errors.Is(err, os.ErrNotExist) { // seen: a path that was never there says nothing about the box
				autoStop(b, watch, stopExited, reasonExited)
				return
			}
			seen = seen || err == nil
		}
	}
}

const reasonExited = "the main process of the box ended"

// diskStop: at the floor every second counts, and `podman stop` gives the box stopGrace seconds to write on (about
// 3.7 GiB at 740 MiB/s). So the kernel ends every process of the box first, and the usual stop then does the cleanup.
func diskStop(b *box, watch chan struct{}, cg, reason string) {
	if !markStop(b, watch, stopDisk, reason) { // before the kill: an exec that it ends finds the reason
		return
	}
	log.Printf("box %s: stopped at the disk floor: %s", b.id, reason)
	if cg != "" {
		if err := os.WriteFile(filepath.Join(cg, "cgroup.kill"), []byte("1"), 0); err != nil {
			log.Printf("box %s: cgroup.kill: %v", b.id, err)
		}
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	boxes.Lock()
	same := b.watch == watch
	boxes.Unlock()
	if same {
		stopLocked(b, pathsOf(*stateDir, *runDir, b.id), false)
	}
}

func autoStop(b *box, watch chan struct{}, code, reason string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if markStop(b, watch, code, reason) {
		log.Printf("box %s: %s", b.id, reason)
		stopLocked(b, pathsOf(*stateDir, *runDir, b.id), false)
	}
}

// stopText: why boxd stopped this start of the box, or the default when it did not.
func stopText(b *box, def string) string {
	boxes.Lock()
	defer boxes.Unlock()
	if b.stopReason != "" && !b.stoppedAt.Before(b.startedAt) {
		return b.stopReason
	}
	return def
}

// stoppedSince: the reason when boxd stopped the box after t, or "".
func stoppedSince(b *box, t time.Time) string {
	boxes.Lock()
	defer boxes.Unlock()
	if b.stopReason != "" && b.stoppedAt.After(t) {
		return b.stopReason
	}
	return ""
}

func cpuUsec(id string) (int64, bool) {
	boxes.Lock()
	cg := cgroupDirCached(id)
	boxes.Unlock()
	if cg == "" {
		return 0, false
	}
	st, err := os.ReadFile(filepath.Join(cg, "cpu.stat"))
	if err != nil {
		return 0, false
	}
	return cpuUsageUsec(string(st))
}

func cgroupDir(name string) string {
	cg, err := inspect(name, "{{.State.CgroupPath}}")
	if err != nil || cg == "" {
		return ""
	}
	return filepath.Join("/sys/fs/cgroup", cg)
}

// pidsRoom: true when the box has room for a command, or when that is still not so after wait.
func pidsRoom(cg string, wait time.Duration) bool {
	read := func(f string) string {
		v, _ := os.ReadFile(filepath.Join(cg, f))
		return string(v)
	}
	for end := time.Now().Add(wait); ; time.Sleep(250 * time.Millisecond) {
		if !pidsAtLimit(read("pids.current"), read("pids.max")) {
			return true
		}
		if time.Now().After(end) {
			return false
		}
	}
}

func memTotalKiB() int64 {
	b, _ := os.ReadFile("/proc/meminfo")
	for _, l := range strings.Split(string(b), "\n") {
		if f := strings.Fields(l); len(f) >= 2 && f[0] == "MemTotal:" {
			n, _ := strconv.ParseInt(f[1], 10, 64)
			return n
		}
	}
	return 0
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
	name := containerName(r.Box)
	b.mu.Lock()
	running := b.running
	if running {
		// a command can end the box's main process (`pkill sleep`, VM test 2026-10-31): the box then stopped by
		// itself. Clean up and say so; the server's next ensure starts it again.
		if st, err := inspect(name, "{{.State.Status}}"); err != nil || st != "running" {
			markStop(b, b.watch, stopExited, reasonExited)
			stopLocked(b, pathsOf(*stateDir, *runDir, r.Box), false)
			running = false
		}
	}
	if running {
		b.touch() // under b.mu: the idle check does not stop the box under this command (stopFor)
	}
	if running && r.Background {
		// a background command with the name of a job would write over the job's script and log
		logName := r.LogName
		if logName == "" {
			logName = "background"
		}
		refreshJobs(b, pathsOf(*stateDir, *runDir, r.Box))
		if j := b.jobs[logName]; j != nil && j.ended.IsZero() {
			b.mu.Unlock()
			return nil, fmt.Errorf("job %s still runs", logName)
		}
		if r.Job && !evictJobs(b.jobs) {
			b.mu.Unlock()
			return nil, fmt.Errorf("%d jobs run in this box; wait for one to end", maxJobs)
		}
	}
	b.mu.Unlock()
	if !running {
		return nil, fmt.Errorf("box_stopped: %s", stopText(b, "the box does not run"))
	}
	cg := cgroupDir(name)
	// at the process limit nothing can enter the box, not even this exec (VM test 2026-11-01). The box does not die, it
	// waits: give processes a moment to end, then stop it with a reason. The server's next ensure starts it again.
	if !pidsRoom(cg, pidsWait) {
		const why = "the box stopped because it stayed at its process limit"
		b.mu.Lock()
		markStop(b, b.watch, stopPids, why)
		stopLocked(b, pathsOf(*stateDir, *runDir, r.Box), false)
		b.mu.Unlock()
		log.Printf("box %s: stopped at its process limit", r.Box)
		return nil, fmt.Errorf("box_stopped: %s", why)
	}
	defer b.touch()
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
	script := execScript(r.Command, r.Background, r.LogName, "MYCEL_EOF_"+randHex(8))
	if r.Job {
		script = jobScript(r.Command, r.LogName, "MYCEL_EOF_"+randHex(8))
	}
	c.Stdin = strings.NewReader(script)
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
	reason := stoppedSince(b, start) // boxd ended the box under this command: that is why it ended, not its exit code
	if signal == "" && reason != "" {
		signal = "box_stopped"
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
	ev := map[string]any{"ev": "exit", "code": code, "signal": signal, "stdout": so.text(), "stderr": se.text(),
		"truncated": so.dropped > 0 || se.dropped > 0, "ms": time.Since(start).Milliseconds()}
	if signal == "box_stopped" {
		ev["reason"] = reason
	}
	if r.Job && code == 0 && signal == "" {
		b.mu.Lock()
		if b.running { // a stop after this exec ended leaves no job to look at
			b.jobs[r.LogName] = &job{name: r.LogName, tag: tag, started: start}
			ev["job"] = true
		}
		b.mu.Unlock()
	}
	return ev, nil
}

// liveTags: which of tags a process of the box has in its environment (as killTagged finds a command). The box can
// make environments large, so each read has a cap. It stops when it found all of them.
func liveTags(cg string, tags []string) map[string]bool {
	found := map[string]bool{}
	if cg == "" || len(tags) == 0 {
		return found
	}
	buf := make([]byte, environMax)
	for _, pid := range cgroupPids(cg) {
		f, err := os.Open("/proc/" + strconv.Itoa(pid) + "/environ")
		if err != nil {
			continue
		}
		n, _ := io.ReadFull(f, buf)
		f.Close()
		for _, t := range tags {
			if !found[t] && bytes.Contains(buf[:n], []byte("MYCEL_EXEC="+t+"\x00")) {
				found[t] = true
			}
		}
		if len(found) == len(tags) {
			break
		}
	}
	return found
}

const environMax = 256 << 10

// refreshJobs reads the state of each open job. Caller holds b.mu and the box runs. Not an exec: an exec is activity.
func refreshJobs(b *box, p boxPaths) {
	var open []*job
	var tags []string
	for _, j := range b.jobs {
		if j.ended.IsZero() {
			open = append(open, j)
			tags = append(tags, j.tag)
		}
	}
	if len(open) == 0 {
		return
	}
	boxes.Lock()
	cg := cgroupDirCached(b.id)
	boxes.Unlock()
	alive := liveTags(cg, tags) // first: see jobEnded
	for _, j := range open {
		exit, err := readBoxFile(p.Vol, "cache/logs/"+j.name+".exit", exitFileMax, false)
		ended, code := jobEnded(alive[j.tag], err == nil, exit)
		readJobTail(j, p)
		if ended {
			j.code, j.ended = code, time.Now()
		}
	}
}

func readJobTail(j *job, p boxPaths) {
	if b, err := readBoxFile(p.Vol, "cache/logs/"+j.name+".log", jobTailRead, true); err == nil {
		j.tail = tailText(b, jobTailBytes, len(b) >= jobTailRead)
	}
}

// endJobs: the box stopped, so each open job ended. Caller holds b.mu. The box may have written the exit file of a job
// in its last moment. With no exit code, the job keeps why the box stopped.
func endJobs(b *box, p boxPaths) {
	why := stopText(b, "the box stopped")
	now := time.Now()
	vol := mounted(p.Vol)
	for _, j := range b.jobs {
		if !j.ended.IsZero() {
			continue
		}
		if vol {
			exit, err := readBoxFile(p.Vol, "cache/logs/"+j.name+".exit", exitFileMax, false)
			_, j.code = jobEnded(false, err == nil, exit)
			readJobTail(j, p)
		}
		j.ended = now
		if j.code == nil {
			j.why = why
		}
	}
}

// jobsOf: the "jobs" answer. Ended jobs stay until evictJobs needs the room, so a stopped box answers too. This must
// not touch the box's activity time.
func jobsOf(id string) (map[string]any, error) {
	b := boxOf(id)
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.running {
		refreshJobs(b, pathsOf(*stateDir, *runDir, id))
	}
	now := time.Now()
	list := make([]jobInfo, 0, len(b.jobs))
	for _, j := range b.jobs {
		list = append(list, j.info(now))
	}
	sort.Slice(list, func(i, k int) bool { return list[i].Name < list[k].Name })
	return map[string]any{"ev": "jobs", "running": b.running, "jobs": list}, nil
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
	info := map[string]any{"box": b.id, "state": state, "startedAt": iso(b.startedAt), "lastActiveAt": iso(b.lastActive), "memoryMiB": mem}
	if b.stopCode != "" {
		info["stopCode"], info["stopReason"], info["stoppedAt"] = b.stopCode, b.stopReason, iso(b.stoppedAt)
	}
	return info
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
	states := make([]string, 0, len(boxes.m))
	for _, b := range boxes.m {
		state := "stopped"
		if b.running {
			state = "running"
		}
		ids = append(ids, b)
		states = append(states, state)
	}
	boxes.Unlock()
	for i, b := range ids {
		list = append(list, infoOf(b, states[i]))
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

//go:build linux

// The preview of a dev server in the dev environment on srt (docs/research/srt-dev-env.md section 5, docs/DECISIONS.md
// "Dev environment on srt: preview").
//
// A dev server of a run listens on 127.0.0.1 in the run's private network namespace (srt's bwrap). Nothing outside the
// run can reach it, and srt's seccomp filter blocks AF_UNIX inside the sandbox. So the server runs, as the server
// account:
//
//		mycel-sandbox port-forward --cgroup /sys/fs/cgroup/.../trina-dev@<runId>.service --port N --socket <path>
//
//	 1. It reads the processes of the run's unit cgroup (trina-dev@<runId>.service; trina-dev-<runId>.scope on an install
//	    whose root files are older). Only systemd (root) can move a process into that cgroup, so a process of another
//	    run is never there (attack A26).
//	 2. It finds the one network namespace, other than its own, where a process of the run listens on port N.
//	 3. It opens that namespace, and its owner user namespace (NS_GET_USERNS: srt's seccomp helper makes a nested user
//	    namespace, which does not own the network namespace). The owner must be the server account, and its parent must
//	    be our own user namespace: then the server account has all capabilities in it.
//	 4. It binds the unix socket <path> (mode 0600) in the host's file system.
//	 5. It execs util-linux nsenter, which enters the user namespace and then the network namespace by the open files,
//	    and execs `mycel-sandbox port-forward-inner`. Go cannot do this step: setns into a user namespace needs a process
//	    with one thread, and the Go runtime always has more.
//
// port-forward-inner checks that it is in that network namespace, drops every capability, and copies each connection on
// the socket to 127.0.0.1:N (or [::1]:N: Vite often listens only there). It is not in the run's pid namespace, so the
// sandbox cannot see it, signal it or trace it. It ends when its stdin closes (the server ended or stopped it).
//
// Ports 3128 and 1080 are refused: srt's proxy relays listen there in the same namespace.
package main

import (
	"bufio"
	"bytes"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// nsenterPath is util-linux nsenter (scripts/system/packages.json: util-linux).
const nsenterPath = "/usr/bin/nsenter"

// maxConns is the most connections one forwarder copies at a time; more are closed at once.
const maxConns = 256

var (
	scopeRe    = regexp.MustCompile(`^trina-dev(@[a-z0-9]{16}\.service|-[a-z0-9]{16}\.scope)$`)
	nsLinkRe   = regexp.MustCompile(`^(net|user):\[(\d+)\]$`)
	srtPorts   = map[int]bool{3128: true, 1080: true}
	errNoMatch = errors.New("nothing listens on this port in the run")
)

// previewPort checks a port for a preview: 1-65535, not one of srt's relays.
func previewPort(p int) error {
	if p < 1 || p > 65535 {
		return fmt.Errorf("--port takes 1-65535")
	}
	if srtPorts[p] {
		return fmt.Errorf("port %d is srt's proxy, not a dev server", p)
	}
	return nil
}

// scopeDir checks a --cgroup value of port-forward: a clean path below /sys/fs/cgroup whose last part is a run's
// unit (trina-dev@<16>.service, or trina-dev-<16>.scope of an older install).
func scopeDir(d string) (string, error) {
	if _, err := cgroupDir(d); err != nil {
		return "", err
	}
	if !scopeRe.MatchString(filepath.Base(d)) {
		return "", fmt.Errorf("--cgroup must be the folder of a run's unit (trina-dev@<id>.service), not %q", d)
	}
	return d, nil
}

// socketPath checks a --socket value: absolute and clean, in a folder that only this account may write.
func socketPath(p string) error {
	if !filepath.IsAbs(p) || filepath.Clean(p) != p || !strings.HasSuffix(p, ".sock") {
		return fmt.Errorf("--socket must be a clean absolute path ending in .sock, not %q", p)
	}
	var st unix.Stat_t
	if err := unix.Lstat(filepath.Dir(p), &st); err != nil {
		return fmt.Errorf("socket folder: %v", err)
	}
	if st.Mode&unix.S_IFMT != unix.S_IFDIR || int(st.Uid) != os.Getuid() || st.Mode&0o022 != 0 {
		return fmt.Errorf("the socket folder must be a folder of this account that nobody else may write")
	}
	return nil
}

// nsIno reads the inode number of a namespace link (/proc/<pid>/ns/net -> "net:[4026531840]").
func nsIno(link, kind string) (uint64, error) {
	t, err := os.Readlink(link)
	if err != nil {
		return 0, err
	}
	m := nsLinkRe.FindStringSubmatch(t)
	if m == nil || m[1] != kind {
		return 0, fmt.Errorf("%s: not a %s namespace (%q)", link, kind, t)
	}
	return strconv.ParseUint(m[2], 10, 64)
}

// listensOn reads /proc/net/tcp or tcp6 text: is there a socket in state LISTEN (0A) on this local port?
func listensOn(text []byte, port int) bool {
	want := fmt.Sprintf(":%04X", port)
	sc := bufio.NewScanner(bytes.NewReader(text))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		// sl local_address rem_address st ...
		if len(f) > 3 && f[3] == "0A" && strings.HasSuffix(f[1], want) {
			return true
		}
	}
	return false
}

// readPids reads a cgroup.procs file.
func readPids(file string) ([]int, error) {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	var out []int
	for _, s := range strings.Fields(string(b)) {
		if n, err := strconv.Atoi(s); err == nil && n > 0 {
			out = append(out, n)
		}
	}
	return out, nil
}

// pickTarget finds the network namespace (not ownNet) where a process of pids listens on port. It returns one pid in
// it and its inode. More than one such namespace is refused: the preview must name exactly one place.
func pickTarget(procRoot string, pids []int, ownNet uint64, port int) (int, uint64, error) {
	found := map[uint64]int{}
	for _, pid := range pids {
		dir := filepath.Join(procRoot, strconv.Itoa(pid))
		ino, err := nsIno(filepath.Join(dir, "ns", "net"), "net")
		if err != nil || ino == ownNet {
			continue // ended meanwhile, or a process of srt outside the sandbox (node, socat, bwrap's parent)
		}
		if _, ok := found[ino]; ok {
			continue
		}
		for _, f := range []string{"tcp", "tcp6"} {
			if b, err := os.ReadFile(filepath.Join(dir, "net", f)); err == nil && listensOn(b, port) {
				found[ino] = pid
				break
			}
		}
	}
	switch len(found) {
	case 0:
		return 0, 0, errNoMatch
	case 1:
		for ino, pid := range found {
			return pid, ino, nil
		}
	}
	return 0, 0, fmt.Errorf("port %d listens in %d namespaces of the run; refused", port, len(found))
}

// openTarget opens the network namespace of pid and checks that it is still the inode that was picked. stillIn checks
// after the open that the pid still belongs to the run (a pid that ended and came back as another process).
func openTarget(procRoot string, pid int, ino uint64, stillIn func() bool) (int, error) {
	fd, err := unix.Open(filepath.Join(procRoot, strconv.Itoa(pid), "ns", "net"), unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, fmt.Errorf("open the run's network namespace: %v", err)
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil || st.Ino != ino || !stillIn() {
		unix.Close(fd)
		return -1, fmt.Errorf("the run's process changed while the preview started")
	}
	return fd, nil
}

// ownerUserns gets the user namespace that owns the network namespace netFd and checks that the server account may
// enter it: owned by this uid, a child of our own user namespace.
func ownerUserns(netFd int) (int, error) {
	u, err := unix.IoctlRetInt(netFd, unix.NS_GET_USERNS)
	if err != nil {
		return -1, fmt.Errorf("owner of the run's network namespace: %v", err)
	}
	var uid uint32
	if _, _, e := unix.Syscall(unix.SYS_IOCTL, uintptr(u), uintptr(unix.NS_GET_OWNER_UID), uintptr(unsafe.Pointer(&uid))); e != 0 {
		unix.Close(u)
		return -1, fmt.Errorf("owner uid: %v", e)
	}
	if int(uid) != os.Getuid() {
		unix.Close(u)
		return -1, fmt.Errorf("the run's user namespace belongs to uid %d, not to this account", uid)
	}
	parent, err := unix.IoctlRetInt(u, unix.NS_GET_PARENT)
	if err != nil {
		unix.Close(u)
		return -1, fmt.Errorf("parent of the run's user namespace: %v", err)
	}
	defer unix.Close(parent)
	own, err := nsIno("/proc/self/ns/user", "user")
	var st unix.Stat_t
	if err != nil || unix.Fstat(parent, &st) != nil || st.Ino != own {
		unix.Close(u)
		return -1, fmt.Errorf("the run's user namespace is not a child of this account's")
	}
	return u, nil
}

// bindSocket makes the unix listener at path, mode 0600. A stale socket file of an earlier forwarder goes first;
// anything else at the path is refused.
func bindSocket(path string) (int, error) {
	var st unix.Stat_t
	if err := unix.Lstat(path, &st); err == nil {
		if st.Mode&unix.S_IFMT != unix.S_IFSOCK {
			return -1, fmt.Errorf("%s is there and is not a socket", path)
		}
		if err := unix.Unlink(path); err != nil {
			return -1, err
		}
	}
	fd, err := unix.Socket(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	old := unix.Umask(0o177)
	err = unix.Bind(fd, &unix.SockaddrUnix{Name: path})
	unix.Umask(old)
	if err == nil {
		err = unix.Listen(fd, 128)
	}
	if err != nil {
		unix.Close(fd)
		return -1, fmt.Errorf("socket %s: %v", path, err)
	}
	return fd, nil
}

// keepOpen clears close-on-exec, so the fd stays open in nsenter and in the inner forwarder.
func keepOpen(fd int) error {
	_, err := unix.FcntlInt(uintptr(fd), unix.F_SETFD, 0)
	return err
}

// enterAndForward is the last step of port-forward: bind the socket and exec nsenter. It returns only on a failure.
func enterAndForward(netFd, userFd, port int, sock string) error {
	ln, err := bindSocket(sock)
	if err != nil {
		return err
	}
	for _, fd := range []int{netFd, userFd, ln} {
		if err := keepOpen(fd); err != nil {
			unix.Unlink(sock)
			return err
		}
	}
	self, err := os.Executable()
	if err != nil || !filepath.IsAbs(self) {
		unix.Unlink(sock)
		return fmt.Errorf("own path: %v", err)
	}
	fd := func(n int) string { return "/proc/self/fd/" + strconv.Itoa(n) }
	argv := []string{nsenterPath, "--preserve-credentials", "--user=" + fd(userFd), "--net=" + fd(netFd), "--",
		self, "port-forward-inner", "--listen-fd", strconv.Itoa(ln), "--netns-fd", strconv.Itoa(netFd),
		"--userns-fd", strconv.Itoa(userFd), "--port", strconv.Itoa(port)}
	err = unix.Exec(nsenterPath, argv, []string{"PATH=/usr/bin:/bin", "LANG=C"})
	unix.Unlink(sock)
	return fmt.Errorf("exec %s: %v", nsenterPath, err)
}

func cmdPortForward(args []string) {
	fs := flag.NewFlagSet("port-forward", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	cg := fs.String("cgroup", "", "the run's scope cgroup folder")
	port := fs.Int("port", 0, "the dev server's port in the run")
	sock := fs.String("socket", "", "the unix socket to serve it on")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 {
		fail("port-forward: usage: port-forward --cgroup DIR --port N --socket PATH")
	}
	if err := previewPort(*port); err != nil {
		fail("port-forward: %v", err)
	}
	dir, err := scopeDir(*cg)
	if err != nil {
		fail("port-forward: %v", err)
	}
	if err := socketPath(*sock); err != nil {
		fail("port-forward: %v", err)
	}
	procsFile := filepath.Join(dir, "cgroup.procs")
	pids, err := readPids(procsFile)
	if err != nil {
		fail("port-forward: the run is not running (%v)", err)
	}
	own, err := nsIno("/proc/self/ns/net", "net")
	if err != nil {
		fail("port-forward: %v", err)
	}
	pid, ino, err := pickTarget("/proc", pids, own, *port)
	if err != nil {
		fail("port-forward: %v", err)
	}
	stillIn := func() bool {
		now, err := readPids(procsFile)
		if err != nil {
			return false
		}
		for _, p := range now {
			if p == pid {
				return true
			}
		}
		return false
	}
	startForward(pid, ino, *port, *sock, stillIn)
}

// startForward runs steps 3-5 for a picked pid. It does not return.
func startForward(pid int, ino uint64, port int, sock string, stillIn func() bool) {
	netFd, err := openTarget("/proc", pid, ino, stillIn)
	if err != nil {
		fail("port-forward: %v", err)
	}
	userFd, err := ownerUserns(netFd)
	if err != nil {
		fail("port-forward: %v", err)
	}
	fail("port-forward: %v", enterAndForward(netFd, userFd, port, sock))
}

func cmdPortForwardInner(args []string) {
	fs := flag.NewFlagSet("port-forward-inner", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	lnFd := fs.Int("listen-fd", -1, "the unix listener")
	netFd := fs.Int("netns-fd", -1, "the run's network namespace")
	userFd := fs.Int("userns-fd", -1, "the run's user namespace")
	port := fs.Int("port", 0, "the dev server's port")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 || *lnFd < 3 || *netFd < 3 || *userFd < 3 {
		fail("port-forward-inner: started only by port-forward")
	}
	if err := previewPort(*port); err != nil {
		fail("port-forward-inner: %v", err)
	}
	// nsenter must have put us in the run's network namespace
	var st unix.Stat_t
	here, err := nsIno("/proc/self/ns/net", "net")
	if err != nil || unix.Fstat(*netFd, &st) != nil || st.Ino != here {
		fail("port-forward-inner: not in the run's network namespace")
	}
	unix.Close(*netFd)
	unix.Close(*userFd)
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		fail("port-forward-inner: no_new_privs: %v", err)
	}
	// entering the user namespace gave every capability in it; exec as a uid other than 0 there cleared them, but
	// drop and check them on every thread in all cases
	if builtWithCgo {
		fail("port-forward-inner: built with cgo; needs CGO_ENABLED=0 (native/build.sh) to drop capabilities on every thread")
	}
	if err := dropCaps(); err != nil {
		fail("port-forward-inner: %v", err)
	}
	if t, err := unix.GetsockoptInt(*lnFd, unix.SOL_SOCKET, unix.SO_TYPE); err != nil || t != unix.SOCK_STREAM {
		fail("port-forward-inner: fd %d is not a stream listener", *lnFd)
	}
	f := os.NewFile(uintptr(*lnFd), "listener")
	ln, err := net.FileListener(f)
	f.Close()
	if err != nil {
		fail("port-forward-inner: %v", err)
	}
	// the server holds our stdin open; when it ends or stops us, stdin closes and we end
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); os.Exit(0) }()
	fmt.Println("ready")
	serve(ln, *port, maxConns)
}

// serve copies each connection on ln to the dev server's port, at most max at a time.
func serve(ln net.Listener, port, max int) {
	slots := make(chan struct{}, max)
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			time.Sleep(50 * time.Millisecond) // EMFILE and the like: do not spin
			continue
		}
		select {
		case slots <- struct{}{}:
			go func() { defer func() { <-slots }(); copyTo(c, port) }()
		default:
			c.Close()
		}
	}
}

// dialLocal connects to the dev server: 127.0.0.1 first, then ::1.
func dialLocal(port int) (net.Conn, error) {
	c, err := net.DialTimeout("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 10*time.Second)
	if err == nil {
		return c, nil
	}
	if c6, err6 := net.DialTimeout("tcp6", net.JoinHostPort("::1", strconv.Itoa(port)), 10*time.Second); err6 == nil {
		return c6, nil
	}
	return nil, err
}

type halfCloser interface {
	net.Conn
	CloseWrite() error
}

// copyTo copies both ways between in and the dev server, passing half-closes on, until both directions are done.
func copyTo(in net.Conn, port int) {
	defer in.Close()
	out, err := dialLocal(port)
	if err != nil {
		return
	}
	defer out.Close()
	var wg sync.WaitGroup
	wg.Add(2)
	pipe := func(dst, src net.Conn) {
		defer wg.Done()
		_, _ = io.Copy(dst, src)
		if h, ok := dst.(halfCloser); ok {
			_ = h.CloseWrite()
		} else {
			_ = dst.Close()
		}
	}
	go pipe(out, in)
	go pipe(in, out)
	wg.Wait()
}

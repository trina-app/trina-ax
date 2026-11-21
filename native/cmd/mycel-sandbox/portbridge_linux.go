//go:build linux

// A later command of a chat reaches the chat's own dev server (docs/decisions/20261118-devenv-shared-jobs-mac-
// localhost.md). Every run has its own network namespace (srt's bwrap), so a dev server that one run started listens
// on 127.0.0.1:N where no later run can connect. The server runs, as the server account, for a new run A and a dev
// server of run B that A may reach (server/src/devenv/srt/runner.ts reachTargets):
//
//	mycel-sandbox port-forward --cgroup <B's unit> --port N --socket S      (portfwd_linux.go: S reaches B's port N)
//	mycel-sandbox port-bridge  --cgroup <A's unit> --port N --socket S
//
// port-bridge:
//  1. waits (at most 10 s) until a process of A's unit cgroup is in the sandbox's network namespace: the one other than
//     its own where srt's proxy relay listens (port 3128), or with No network the only other one (pickSandbox). Only
//     systemd (root) moves a process into that cgroup.
//  2. opens that namespace and its owner user namespace with the same checks as port-forward (owned by the server
//     account, a child of our own user namespace);
//  3. execs util-linux nsenter, which enters both and execs `mycel-sandbox port-bridge-inner`.
//
// port-bridge-inner checks that it is in that network namespace, listens on 127.0.0.1:N (and [::1]:N when it can) there,
// drops every capability, and copies each connection to the unix socket S (a path in the host's file system: nsenter
// does not enter the mount namespace). It is not in A's pid namespace, so A's command cannot see, signal or trace it. It
// ends when its stdin closes (the server stops it when A ends). Only port N of B is reachable this way: S is B's
// forwarder for that one port.
//
// Ports 3128 and 1080 are refused (srt's relays in the same namespace), as for port-forward.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

// relayPort is srt's HTTP proxy relay in the sandbox's network namespace: the namespace where it listens is the one the
// command runs in.
const relayPort = 3128

// bridgeWait is how long port-bridge waits for the run's sandbox namespace.
var bridgeWait = 10 * time.Second

// pickSandbox finds the run's sandbox network namespace among pids: where srt's relay listens, or, with no relay (the
// team setting No network), the only namespace other than ownNet. More than one with no relay: refused.
func pickSandbox(procRoot string, pids []int, ownNet uint64) (int, uint64, error) {
	pid, ino, err := pickTarget(procRoot, pids, ownNet, relayPort)
	if !errors.Is(err, errNoMatch) {
		return pid, ino, err
	}
	found := map[uint64]int{}
	for _, p := range pids {
		n, err := nsIno(filepath.Join(procRoot, strconv.Itoa(p), "ns", "net"), "net")
		if err == nil && n != ownNet {
			if _, ok := found[n]; !ok {
				found[n] = p
			}
		}
	}
	switch len(found) {
	case 0:
		return 0, 0, errNoMatch
	case 1:
		for n, p := range found {
			return p, n, nil
		}
	}
	return 0, 0, fmt.Errorf("%d network namespaces in the run and no proxy relay; refused", len(found))
}

// dialSocket checks a --socket value of port-bridge: what socketPath checks, and it is a unix socket now.
func dialSocket(p string) error {
	if err := socketPath(p); err != nil {
		return err
	}
	var st unix.Stat_t
	if err := unix.Lstat(p, &st); err != nil {
		return fmt.Errorf("socket %s: %v", p, err)
	}
	if st.Mode&unix.S_IFMT != unix.S_IFSOCK || int(st.Uid) != os.Getuid() {
		return fmt.Errorf("%s is not a socket of this account", p)
	}
	return nil
}

func cmdPortBridge(args []string) {
	fs := flag.NewFlagSet("port-bridge", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	cg := fs.String("cgroup", "", "the new run's unit cgroup folder")
	port := fs.Int("port", 0, "the port to listen on in the run")
	sock := fs.String("socket", "", "the dev server's forwarder socket")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 {
		fail("port-bridge: usage: port-bridge --cgroup DIR --port N --socket PATH")
	}
	if err := previewPort(*port); err != nil {
		fail("port-bridge: %v", err)
	}
	dir, err := scopeDir(*cg)
	if err != nil {
		fail("port-bridge: %v", err)
	}
	if err := dialSocket(*sock); err != nil {
		fail("port-bridge: %v", err)
	}
	own, err := nsIno("/proc/self/ns/net", "net")
	if err != nil {
		fail("port-bridge: %v", err)
	}
	procsFile := filepath.Join(dir, "cgroup.procs")
	var pid int
	var ino uint64
	for until := time.Now().Add(bridgeWait); ; {
		pids, err := readPids(procsFile)
		if err != nil {
			fail("port-bridge: the run is not running (%v)", err)
		}
		pid, ino, err = pickSandbox("/proc", pids, own)
		if err == nil {
			break
		}
		if !errors.Is(err, errNoMatch) || time.Now().After(until) {
			fail("port-bridge: the run's sandbox: %v", err)
		}
		time.Sleep(100 * time.Millisecond)
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
	netFd, err := openTarget("/proc", pid, ino, stillIn)
	if err != nil {
		fail("port-bridge: %v", err)
	}
	userFd, err := ownerUserns(netFd)
	if err != nil {
		fail("port-bridge: %v", err)
	}
	fail("port-bridge: %v", enterAndBridge(netFd, userFd, *port, *sock))
}

// enterAndBridge execs nsenter into the run's namespaces with port-bridge-inner. It returns only on a failure.
func enterAndBridge(netFd, userFd, port int, sock string) error {
	for _, fd := range []int{netFd, userFd} {
		if err := keepOpen(fd); err != nil {
			return err
		}
	}
	self, err := os.Executable()
	if err != nil || !filepath.IsAbs(self) {
		return fmt.Errorf("own path: %v", err)
	}
	fd := func(n int) string { return "/proc/self/fd/" + strconv.Itoa(n) }
	argv := []string{nsenterPath, "--preserve-credentials", "--user=" + fd(userFd), "--net=" + fd(netFd), "--",
		self, "port-bridge-inner", "--netns-fd", strconv.Itoa(netFd), "--userns-fd", strconv.Itoa(userFd),
		"--port", strconv.Itoa(port), "--socket", sock}
	err = unix.Exec(nsenterPath, argv, []string{"PATH=/usr/bin:/bin", "LANG=C"})
	return fmt.Errorf("exec %s: %v", nsenterPath, err)
}

func cmdPortBridgeInner(args []string) {
	fs := flag.NewFlagSet("port-bridge-inner", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	netFd := fs.Int("netns-fd", -1, "the run's network namespace")
	userFd := fs.Int("userns-fd", -1, "the run's user namespace")
	port := fs.Int("port", 0, "the port to listen on")
	sock := fs.String("socket", "", "the dev server's forwarder socket")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 || *netFd < 3 || *userFd < 3 {
		fail("port-bridge-inner: started only by port-bridge")
	}
	if err := previewPort(*port); err != nil {
		fail("port-bridge-inner: %v", err)
	}
	if err := dialSocket(*sock); err != nil {
		fail("port-bridge-inner: %v", err)
	}
	var st unix.Stat_t
	here, err := nsIno("/proc/self/ns/net", "net")
	if err != nil || unix.Fstat(*netFd, &st) != nil || st.Ino != here {
		fail("port-bridge-inner: not in the run's network namespace")
	}
	unix.Close(*netFd)
	unix.Close(*userFd)
	lns, err := listenLocal(*port)
	if err != nil {
		fail("port-bridge-inner: %v", err)
	}
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		fail("port-bridge-inner: no_new_privs: %v", err)
	}
	if builtWithCgo {
		fail("port-bridge-inner: built with cgo; needs CGO_ENABLED=0 (native/build.sh) to drop capabilities on every thread")
	}
	if err := dropCaps(); err != nil {
		fail("port-bridge-inner: %v", err)
	}
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); os.Exit(0) }()
	fmt.Println("ready")
	var wg sync.WaitGroup
	slots := make(chan struct{}, maxConns)
	for _, ln := range lns {
		wg.Add(1)
		go func(ln net.Listener) { defer wg.Done(); serveSocket(ln, *sock, slots) }(ln)
	}
	wg.Wait()
}

// listenLocal listens on 127.0.0.1:port, and on [::1]:port when this namespace has IPv6 loopback (Vite and curl may use
// either). The IPv4 one must work.
func listenLocal(port int) ([]net.Listener, error) {
	l4, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return nil, fmt.Errorf("listen on 127.0.0.1:%d in the run: %v", port, err)
	}
	out := []net.Listener{l4}
	if l6, err := net.Listen("tcp6", net.JoinHostPort("::1", strconv.Itoa(port))); err == nil {
		out = append(out, l6)
	}
	return out, nil
}

// serveSocket copies each connection on ln to the unix socket sock, at most cap(slots) at a time over all listeners.
func serveSocket(ln net.Listener, sock string, slots chan struct{}) {
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			time.Sleep(50 * time.Millisecond)
			continue
		}
		select {
		case slots <- struct{}{}:
			go func() {
				defer func() { <-slots }()
				out, err := net.DialTimeout("unix", sock, 10*time.Second)
				if err != nil {
					c.Close()
					return
				}
				copyBoth(c, out)
			}()
		default:
			c.Close()
		}
	}
}

// copyBoth copies both ways between a and b, passing half-closes on, and closes both when done.
func copyBoth(a, b net.Conn) {
	defer a.Close()
	defer b.Close()
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
	go pipe(a, b)
	go pipe(b, a)
	wg.Wait()
}

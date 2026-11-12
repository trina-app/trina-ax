//go:build linux

// A turn's own network namespace (QA TC-309). Abstract unix sockets (@name) belong to a network namespace, not to the
// file system: bwrap's mounts do not hide them, the engine firewall (nftables, IP only) does not see them, and
// Landlock scopes them only from ABI 6 (Linux 6.12). In the host namespace a turn could connect to every host
// service listening on one (multipathd, iscsid, systemd and D-Bus helpers ...). seccomp cannot tell an abstract
// address from a path (connect() passes a pointer), and the bridge needs a unix socket (tools.sock, a path).
//
// So `exec --net-proxy PORT` moves the engine into a new network namespace with only loopback, and keeps the model
// proxy at the same address through a forwarder:
//
//  1. start `mycel-sandbox forward` (still in the host namespace) with one end of a socketpair;
//  2. unshare(CLONE_NEWNET) on this (locked, later execve'ing) thread, bring lo up, listen on 127.0.0.1:PORT there;
//  3. after this thread's Landlock domain: hand the listener to the forwarder, wait for its "ready" (its own
//     restrictions are in place);
//  4. drop every capability (bwrap gave CAP_SYS_ADMIN + CAP_NET_ADMIN of the turn's user namespace for steps 2-3)
//     and check /proc/self/status; then Landlock, seccomp and execve as before.
//
// The forwarder accepts in the turn's namespace and connects to 127.0.0.1:PORT in the host namespace: the connection
// the model proxy sees belongs to a process of the turn's session (the proxy's tcp-peer check), as the engine account
// (the nftables rule), in the turn cgroup. It has no capabilities, the engine (its parent, same uid) cannot reach its
// memory (privateNetFinish: Landlock, or not dumpable), and its seccomp filter refuses unix sockets and execve on top
// of the engine policy. It dies with the turn (bwrap's pid namespace).
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
	"mycel/native/internal/seccomp"
)

// netSetup is what privateNetStart leaves for privateNetFinish.
type netSetup struct{ ctl, ln int }

// privateNetStart runs steps 1-2 above on the main (locked) thread, before Landlock.
func privateNetStart(port int) netSetup {
	sp, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_SEQPACKET|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		fail("net: socketpair: %v", err)
	}
	self, err := os.Executable()
	if err != nil {
		fail("net: %v", err)
	}
	child := os.NewFile(uintptr(sp[1]), "forward")
	cmd := exec.Command(self, "forward", "--port", strconv.Itoa(port))
	cmd.Stderr = os.Stderr
	cmd.ExtraFiles = []*os.File{child} // fd 3
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	// bwrap hands its capabilities on as ambient ones: without them the forwarder's execve gives it none (this thread
	// keeps its effective set for the steps below; capset only changes the calling thread, so it is done here, on the
	// thread that forks and later execs, not inside the multi-threaded forwarder)
	if err := unix.Prctl(unix.PR_CAP_AMBIENT, unix.PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0); err != nil {
		fail("net: clear ambient capabilities: %v", err)
	}
	if err := cmd.Start(); err != nil { // forked from this thread: still the host network namespace
		fail("net: forwarder: %v", err)
	}
	child.Close()

	if err := unix.Unshare(unix.CLONE_NEWNET); err != nil {
		fail("net: unshare: %v (bwrap must grant CAP_SYS_ADMIN in the turn's user namespace)", err)
	}
	if err := loopbackUp(); err != nil {
		fail("net: lo: %v", err)
	}
	ln, err := unix.Socket(unix.AF_INET, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		fail("net: socket: %v", err)
	}
	if err := unix.Bind(ln, &unix.SockaddrInet4{Port: port, Addr: [4]byte{127, 0, 0, 1}}); err != nil {
		fail("net: bind 127.0.0.1:%d: %v", port, err)
	}
	if err := unix.Listen(ln, 128); err != nil {
		fail("net: listen: %v", err)
	}
	return netSetup{ctl: sp[0], ln: ln}
}

// privateNetFinish runs steps 3-4, after this thread's Landlock domain (if any) is in place. engineInDomain tells
// the forwarder how to keep the engine out of its memory:
//   - the engine is in a Landlock domain and the forwarder in none: Landlock refuses every ptrace access from inside a
//     domain to a process outside it (/proc/<pid>/mem included), so the forwarder stays dumpable and the launcher's
//     tcp-peer lookup can read its /proc/<pid>/fd (the model proxy's peer check);
//   - no domain (--landlock off, or best-effort without Landlock): the forwarder makes itself not dumpable. Then only
//     root can read its descriptors, the proxy cannot tell which turn a connection belongs to and refuses it: the
//     turn cannot reach the model, but it never gets the host namespace either (installs run --landlock required).
func privateNetFinish(st netSetup, engineInDomain bool) {
	mode := []byte{'N'}
	if engineInDomain {
		mode[0] = 'D'
	}
	if err := unix.Sendmsg(st.ctl, mode, unix.UnixRights(st.ln), nil, 0); err != nil {
		fail("net: hand over the listener: %v", err)
	}
	unix.Close(st.ln)
	ack := make([]byte, 16)
	n, err := unix.Read(st.ctl, ack)
	if err != nil || n != 5 || string(ack[:n]) != "ready" {
		fail("net: the forwarder did not start (%d %v)", n, err)
	}
	unix.Close(st.ctl)
	if err := dropCaps(); err != nil {
		fail("net: %v", err)
	}
}

func loopbackUp() error {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	ifr, err := unix.NewIfreq("lo")
	if err != nil {
		return err
	}
	if err := unix.IoctlIfreq(fd, unix.SIOCGIFFLAGS, ifr); err != nil {
		return err
	}
	ifr.SetUint16(ifr.Uint16() | unix.IFF_UP)
	return unix.IoctlIfreq(fd, unix.SIOCSIFFLAGS, ifr)
}

// dropCaps clears every capability set of the calling thread (bounding stays, but nothing can raise a capability
// again: no_new_privs is set and every bind in the sandbox is nosuid) and checks the result. In the helper that is the
// thread that execve()s the engine; the forwarder has none to begin with and only checks.
func dropCaps() error {
	_ = unix.Prctl(unix.PR_CAP_AMBIENT, unix.PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0)
	hdr := unix.CapUserHeader{Version: unix.LINUX_CAPABILITY_VERSION_3}
	var data [2]unix.CapUserData
	if err := unix.Capset(&hdr, &data[0]); err != nil {
		return fmt.Errorf("drop capabilities: %v", err)
	}
	b, err := os.ReadFile("/proc/thread-self/status")
	if err != nil {
		return fmt.Errorf("capabilities: %v", err)
	}
	for _, l := range strings.Split(string(b), "\n") {
		for _, k := range []string{"CapInh:", "CapPrm:", "CapEff:", "CapAmb:"} {
			if strings.HasPrefix(l, k) && strings.Trim(strings.TrimPrefix(l, k), " \t0") != "" {
				return fmt.Errorf("capabilities still set: %s", l)
			}
		}
	}
	return nil
}

// cmdForward is the forwarder (started only by privateNet; fd 3 is its end of the socketpair).
func cmdForward(args []string) {
	fs := flag.NewFlagSet("forward", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	port := fs.Int("port", 0, "model proxy port")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 || *port <= 0 || *port > 65535 {
		fail("forward: usage: forward --port N")
	}
	if err := dropCaps(); err != nil { // started without ambient capabilities: nothing to drop, only checked
		fail("forward: %v", err)
	}
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		fail("forward: no_new_privs: %v", err)
	}
	const ctl = 3
	buf, oob := make([]byte, 1), make([]byte, unix.CmsgSpace(4))
	_, oobn, _, _, err := unix.Recvmsg(ctl, buf, oob, unix.MSG_CMSG_CLOEXEC)
	if err != nil {
		fail("forward: receive: %v", err)
	}
	ln, err := listenerFrom(oob[:oobn])
	if err != nil {
		fail("forward: %v", err)
	}
	switch buf[0] { // privateNetFinish: is the engine kept out of this process by Landlock?
	case 'D':
	case 'N':
		if err := unix.Prctl(unix.PR_SET_DUMPABLE, 0, 0, 0, 0); err != nil {
			fail("forward: dumpable: %v", err)
		}
	default:
		fail("forward: bad hand-over")
	}
	if err := seccomp.InstallOpts(seccomp.Options{Forwarder: true}); err != nil {
		fail("forward: %v", err)
	}
	if _, err := unix.Write(ctl, []byte("ready")); err != nil {
		fail("forward: %v", err)
	}
	unix.Close(ctl)
	target := net.JoinHostPort("127.0.0.1", strconv.Itoa(*port))
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				os.Exit(0)
			}
			time.Sleep(50 * time.Millisecond) // EMFILE and the like: do not spin
			continue
		}
		go relay(c.(*net.TCPConn), target)
	}
}

func listenerFrom(oob []byte) (net.Listener, error) {
	msgs, err := unix.ParseSocketControlMessage(oob)
	if err != nil || len(msgs) != 1 {
		return nil, fmt.Errorf("no listener received")
	}
	fds, err := unix.ParseUnixRights(&msgs[0])
	if err != nil || len(fds) != 1 {
		return nil, fmt.Errorf("no listener received")
	}
	f := os.NewFile(uintptr(fds[0]), "listener")
	defer f.Close()
	if t, err := unix.GetsockoptInt(fds[0], unix.SOL_SOCKET, unix.SO_TYPE); err != nil || t != unix.SOCK_STREAM {
		return nil, fmt.Errorf("the received socket is not a TCP listener")
	}
	return net.FileListener(f)
}

// relay copies both ways, passing half-closes on, until both directions are done.
func relay(in *net.TCPConn, target string) {
	defer in.Close()
	c, err := net.DialTimeout("tcp4", target, 10*time.Second)
	if err != nil {
		return
	}
	out := c.(*net.TCPConn)
	defer out.Close()
	var wg sync.WaitGroup
	wg.Add(2)
	pipe := func(dst, src *net.TCPConn) {
		defer wg.Done()
		_, _ = io.Copy(dst, src)
		_ = dst.CloseWrite()
	}
	go pipe(out, in)
	go pipe(in, out)
	wg.Wait()
}

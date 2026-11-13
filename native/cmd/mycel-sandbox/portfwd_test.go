//go:build linux

package main

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// pfStart is the test binary as "pf-start": port-forward from step 3 on, for a pid the test picked (a real run has a
// scope cgroup; the test has none). nsenter execs this file again as the inner forwarder.
func pfStart(args []string) {
	if len(args) > 0 && args[0] == "port-forward-inner" {
		cmdPortForwardInner(args[1:])
		return
	}
	pid, _ := strconv.Atoi(args[0])
	ino, _ := strconv.ParseUint(args[1], 10, 64)
	port, _ := strconv.Atoi(args[2])
	startForward(pid, ino, port, args[3], func() bool { return args[4] == "in" })
}

// devServer is the test binary as "dev-server", started by `unshare -Urn`: loopback up, listen on 127.0.0.1 (or ::1
// with "6"), print the port, answer "dev:<what came>".
func devServer(args []string) {
	if err := loopbackUp(); err != nil {
		fmt.Println("lo:", err)
		os.Exit(1)
	}
	network, addr := "tcp4", "127.0.0.1:0"
	if len(args) > 0 && args[0] == "6" {
		network, addr = "tcp6", "[::1]:0"
	}
	ln, err := net.Listen(network, addr)
	if err != nil {
		fmt.Println("listen:", err)
		os.Exit(1)
	}
	fmt.Println(ln.Addr().(*net.TCPAddr).Port)
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go func(c net.Conn) {
			defer c.Close()
			b := make([]byte, 64)
			n, _ := c.Read(b)
			c.Write(append([]byte("dev:"), b[:n]...))
		}(c)
	}
}

func TestPreviewPort(t *testing.T) {
	for p, ok := range map[int]bool{0: false, -1: false, 65536: false, 3128: false, 1080: false, 3000: true, 5173: true, 65535: true} {
		if err := previewPort(p); (err == nil) != ok {
			t.Errorf("port %d: %v", p, err)
		}
	}
}

func TestScopeDir(t *testing.T) {
	for _, good := range []string{
		"/sys/fs/cgroup/mycel.slice/mycel-devenv.slice/trina-dev@abcdefgh01234567.service",
		"/sys/fs/cgroup/mycel.slice/mycel-devenv.slice/trina-dev-abcdefgh01234567.scope",
	} {
		if _, err := scopeDir(good); err != nil {
			t.Errorf("%s: %v", good, err)
		}
	}
	for _, d := range []string{
		"", "relative/trina-dev-abcdefgh01234567.scope", "/tmp/trina-dev-abcdefgh01234567.scope",
		"/sys/fs/cgroup/mycel.slice/mycel-server.service", "/sys/fs/cgroup/x/../trina-dev-abcdefgh01234567.scope",
		"/sys/fs/cgroup/x/trina-dev-short.scope", "/sys/fs/cgroup/x/trina-dev-ABCDEFGH01234567.scope",
		"/sys/fs/cgroup/x/trina-dev-abcdefgh01234567.service", "/sys/fs/cgroup/x/trina-dev@abcdefgh01234567.scope",
		"/sys/fs/cgroup/x/trina-dev@short.service", "/sys/fs/cgroup/x/trina-dev@ABCDEFGH01234567.service",
		"/sys/fs/cgroup/x/other@abcdefgh01234567.service", "/tmp/trina-dev@abcdefgh01234567.service",
	} {
		if _, err := scopeDir(d); err == nil {
			t.Errorf("%q accepted", d)
		}
	}
}

func TestSocketPath(t *testing.T) {
	d := t.TempDir()
	os.Chmod(d, 0o700)
	if err := socketPath(filepath.Join(d, "r-3000.sock")); err != nil {
		t.Errorf("good path: %v", err)
	}
	for _, p := range []string{"r.sock", filepath.Join(d, "r-3000"), d + "/x/../r.sock", filepath.Join(d, "missing", "r.sock")} {
		if err := socketPath(p); err == nil {
			t.Errorf("%q accepted", p)
		}
	}
	os.Chmod(d, 0o777)
	if err := socketPath(filepath.Join(d, "r.sock")); err == nil {
		t.Error("a folder others may write accepted")
	}
}

const tcpText = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0C38 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0 100 0 0 10 0
   1: 0100007F:0BB8 0100007F:D2F0 01 00000000:00000000 00:00000000 00000000  1000        0 2 1 0 20 4 30 10 -1
   2: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 3 1 0 100 0 0 10 0
`

func TestListensOn(t *testing.T) {
	for p, want := range map[int]bool{3128: true, 5173: true, 3000: false, 80: false} {
		if got := listensOn([]byte(tcpText), p); got != want {
			t.Errorf("port %d: %v, want %v", p, got, want)
		}
	}
}

// fakeProc makes <root>/<pid>/ns/net -> net:[ino] and <root>/<pid>/net/tcp with the given listening ports.
func fakeProc(t *testing.T, root string, pid int, ino uint64, ports ...int) {
	t.Helper()
	dir := filepath.Join(root, strconv.Itoa(pid))
	os.MkdirAll(filepath.Join(dir, "ns"), 0o755)
	os.MkdirAll(filepath.Join(dir, "net"), 0o755)
	if err := os.Symlink(fmt.Sprintf("net:[%d]", ino), filepath.Join(dir, "ns", "net")); err != nil {
		t.Fatal(err)
	}
	var b strings.Builder
	b.WriteString("  sl  local_address rem_address   st\n")
	for i, p := range ports {
		fmt.Fprintf(&b, "   %d: 0100007F:%04X 00000000:0000 0A 0 0 0 0 1000 0 %d\n", i, p, i+1)
	}
	os.WriteFile(filepath.Join(dir, "net", "tcp"), []byte(b.String()), 0o644)
	os.WriteFile(filepath.Join(dir, "net", "tcp6"), []byte("  sl\n"), 0o644)
}

func TestPickTarget(t *testing.T) {
	root := t.TempDir()
	const host = 4026531840
	fakeProc(t, root, 10, host, 3000)      // srt's node or socat, outside the sandbox: its port is the host's
	fakeProc(t, root, 11, 900, 3128)       // the sandbox: srt's relay only
	fakeProc(t, root, 12, 900, 3128, 3000) // the dev server in the sandbox
	fakeProc(t, root, 13, 901, 4000)       // a nested namespace in the same run
	pid, ino, err := pickTarget(root, []int{10, 11, 12, 13, 99}, host, 3000)
	if err != nil || pid != 12 || ino != 900 {
		t.Errorf("pick 3000: %d %d %v, want 12 900", pid, ino, err)
	}
	if _, _, err := pickTarget(root, []int{10, 11}, host, 3000); err != errNoMatch {
		t.Errorf("only the host listens on 3000: %v, want errNoMatch", err)
	}
	// a pid that is not in the cgroup list is never looked at (A26: the list comes from the run's own scope)
	if _, _, err := pickTarget(root, []int{10, 11}, host, 4000); err != errNoMatch {
		t.Errorf("4000 of a pid outside the list: %v", err)
	}
	fakeProc(t, root, 14, 902, 3000)
	if _, _, err := pickTarget(root, []int{12, 14}, host, 3000); err == nil || err == errNoMatch {
		t.Errorf("two namespaces with the port: %v, want a refusal", err)
	}
}

func TestServeCopies(t *testing.T) {
	dev, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer dev.Close()
	go func() {
		for {
			c, err := dev.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) { defer c.Close(); b, _ := io.ReadAll(c); c.Write(append([]byte("dev:"), b...)) }(c)
		}
	}()
	sock := filepath.Join(t.TempDir(), "p.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go serve(ln, dev.Addr().(*net.TCPAddr).Port, 4)
	for i := 0; i < 3; i++ {
		c, err := net.Dial("unix", sock)
		if err != nil {
			t.Fatal(err)
		}
		c.Write([]byte("GET /"))
		c.(*net.UnixConn).CloseWrite() // the half-close reaches the dev server
		b, _ := io.ReadAll(c)
		c.Close()
		if string(b) != "dev:GET /" {
			t.Errorf("round %d: %q", i, b)
		}
	}
}

func TestPortForwardRealNamespaces(t *testing.T) {
	if builtWithCgo {
		t.Skip("built with cgo: run with CGO_ENABLED=0 for this test")
	}
	if _, err := os.Stat(nsenterPath); err != nil {
		t.Skip("no nsenter")
	}
	if out, err := exec.Command("unshare", "-Urn", "true").CombinedOutput(); err != nil {
		t.Skipf("no unprivileged user namespaces here: %v %s", err, out)
	}
	w := t.TempDir()
	os.Chmod(w, 0o755)
	pf, dv := filepath.Join(w, "pf-start"), filepath.Join(w, "dev-server")
	cp(t, pf)
	cp(t, dv)
	for _, family := range []string{"4", "6"} {
		t.Run("ipv"+family, func(t *testing.T) {
			srv := exec.Command("unshare", "-Urn", dv, family)
			out, _ := srv.StdoutPipe()
			srv.Stderr = os.Stderr
			if err := srv.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { srv.Process.Kill(); srv.Wait() }()
			line, _ := bufio.NewReader(out).ReadString('\n')
			port, err := strconv.Atoi(strings.TrimSpace(line))
			if err != nil {
				t.Skipf("dev server: %q", line)
			}
			pid := srv.Process.Pid
			own, _ := nsIno("/proc/self/ns/net", "net")
			gotPid, ino, err := pickTarget("/proc", []int{os.Getpid(), pid}, own, port)
			if err != nil || gotPid != pid {
				t.Fatalf("pick: %d %v", gotPid, err)
			}
			sockDir := filepath.Join(w, "run"+family)
			os.Mkdir(sockDir, 0o700)
			sock := filepath.Join(sockDir, "r-"+strconv.Itoa(port)+".sock")

			// the pid left the run between the pick and the open: refused, no socket
			if code, _, se := run(t, pf, strconv.Itoa(pid), strconv.FormatUint(ino, 10), strconv.Itoa(port), sock, "out"); code != ExitFailed || !strings.Contains(se, "changed") {
				t.Errorf("pid gone: exit %d %q", code, se)
			}
			fw := exec.Command(pf, strconv.Itoa(pid), strconv.FormatUint(ino, 10), strconv.Itoa(port), sock, "in")
			stdin, _ := fw.StdinPipe()
			fout, _ := fw.StdoutPipe()
			fw.Stderr = os.Stderr
			if err := fw.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { fw.Process.Kill(); fw.Wait() }()
			ready := make(chan string, 1)
			go func() { l, _ := bufio.NewReader(fout).ReadString('\n'); ready <- l }()
			select {
			case l := <-ready:
				if strings.TrimSpace(l) != "ready" {
					t.Fatalf("forwarder: %q", l)
				}
			case <-time.After(10 * time.Second):
				t.Fatal("forwarder did not start")
			}
			if st, err := os.Stat(sock); err != nil || st.Mode().Perm() != 0o600 {
				t.Errorf("socket mode: %v %v", st, err)
			}
			// the forwarder is in the run's network namespace and holds no capability
			if fi, _ := nsIno(fmt.Sprintf("/proc/%d/ns/net", fw.Process.Pid), "net"); fi != ino {
				t.Errorf("forwarder netns %d, want %d", fi, ino)
			}
			status, _ := os.ReadFile(fmt.Sprintf("/proc/%d/status", fw.Process.Pid))
			for _, l := range strings.Split(string(status), "\n") {
				if strings.HasPrefix(l, "CapEff:") && strings.Trim(strings.TrimPrefix(l, "CapEff:"), " \t0") != "" {
					t.Errorf("forwarder has capabilities: %s", l)
				}
			}
			c, err := net.Dial("unix", sock)
			if err != nil {
				t.Fatal(err)
			}
			c.Write([]byte("hi"))
			b := make([]byte, 64)
			n, _ := c.Read(b)
			c.Close()
			if string(b[:n]) != "dev:hi" {
				t.Errorf("through the socket: %q", b[:n])
			}
			// the server closes stdin: the forwarder ends
			stdin.Close()
			done := make(chan error, 1)
			go func() { done <- fw.Wait() }()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Error("the forwarder did not end when its stdin closed")
			}
		})
	}
}

//go:build linux

package main

// Tests that need root, a real nft and a kernel (Docker: `--cap-add NET_ADMIN`; supervise also `--privileged
// --cgroupns=private` for the cgroup part). They run only with MYCEL_CTL_ROOT_TESTS=1 as root; see
// native/cmd/mycel-ctl/testdata/run-docker.sh.

import (
	"bytes"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func rootTests(t *testing.T) {
	if os.Getenv("MYCEL_CTL_ROOT_TESTS") != "1" || os.Getuid() != 0 {
		t.Skip("needs root in a disposable container (MYCEL_CTL_ROOT_TESTS=1)")
	}
}

// TestHelperDial is not a test: the real-nft test runs this binary as another uid to dial an address.
func TestHelperDial(t *testing.T) {
	spec := os.Getenv("MYCEL_CTL_DIAL")
	if spec == "" {
		t.Skip()
	}
	netw, addr, _ := strings.Cut(spec, " ")
	if netw == "udp" {
		c, err := net.Dial("udp", addr)
		if err != nil {
			fmt.Println("RESULT fail " + err.Error())
			os.Exit(0)
		}
		c.SetDeadline(time.Now().Add(time.Second))
		if _, err := c.Write([]byte("ping")); err != nil {
			fmt.Println("RESULT fail " + err.Error())
			os.Exit(0)
		}
		b := make([]byte, 16)
		n, err := c.Read(b)
		if err != nil || string(b[:n]) != "pong" {
			fmt.Println("RESULT fail", err)
			os.Exit(0)
		}
		fmt.Println("RESULT ok")
		os.Exit(0)
	}
	start := time.Now()
	c, err := net.DialTimeout(netw, addr, 3*time.Second)
	if err != nil {
		fmt.Printf("RESULT fail %v (%v)\n", err, time.Since(start).Round(time.Millisecond))
		os.Exit(0)
	}
	c.Close()
	fmt.Println("RESULT ok")
	os.Exit(0)
}

func dialAs(t *testing.T, uid int, spec string) string {
	cmd := exec.Command(os.Args[0], "-test.run", "^TestHelperDial$")
	cmd.Env = []string{"MYCEL_CTL_DIAL=" + spec}
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(uid), Gid: uint32(uid), Groups: []uint32{}}}
	out, _ := cmd.CombinedOutput()
	for _, l := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(l, "RESULT ") {
			return strings.TrimPrefix(l, "RESULT ")
		}
	}
	return "no result: " + string(out)
}

func listenTCP(t *testing.T, addr string) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatalf("listen %s: %v", addr, err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
}

// The engine uid reaches 127.0.0.1:<proxy> and nothing else (spec 3.4.1, D8); other accounts are untouched.
func TestFirewallRealNft(t *testing.T) {
	rootTests(t)
	const engine, server, other = 990, 989, 1234
	base := filepath.Join(t.TempDir(), "base")
	for _, d := range []string{"root", "run"} {
		must(t, os.MkdirAll(filepath.Join(base, d), 0o755))
	}
	os.Chmod(filepath.Dir(base), 0o755)
	proxy := 47821
	must(t, os.WriteFile(filepath.Join(base, "root/firewall.conf.json"),
		[]byte(fmt.Sprintf(`{"format":1,"id":"mycel-t","engineUid":%d,"serverUid":%d,"proxyPort":%d,"serverPort":47820,"deployment":"hosted","serverAllowPrivate":[]}`, engine, server, proxy)), 0o644))
	listenTCP(t, fmt.Sprintf("127.0.0.1:%d", proxy))
	listenTCP(t, "127.0.0.1:47820")
	v6 := true
	if ln, err := net.Listen("tcp", fmt.Sprintf("[::1]:%d", proxy)); err != nil {
		v6 = false
	} else {
		t.Cleanup(func() { ln.Close() })
		go func() {
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				c.Close()
			}
		}()
	}
	udp, err := net.ListenPacket("udp", "127.0.0.1:53")
	must(t, err)
	t.Cleanup(func() { udp.Close() })
	go func() {
		b := make([]byte, 16)
		for {
			n, a, err := udp.ReadFrom(b)
			if err != nil {
				return
			}
			if string(b[:n]) == "ping" {
				udp.WriteTo([]byte("pong"), a)
			}
		}
	}()
	e := newEnv()
	e.base = base
	var out bytes.Buffer
	e.stdout, e.stderr = &out, &out
	code, err := cmdFirewall(e, []string{"apply", "--base", base})
	if code != 0 {
		t.Fatalf("apply: %d %v %s", code, err, out.String())
	}
	t.Cleanup(func() { exec.Command("nft", "delete", "table", "inet", "mycel-t").Run() })
	ok := func(uid int, spec string) {
		if r := dialAs(t, uid, spec); r != "ok" {
			t.Errorf("uid %d %s: want ok, got %s", uid, spec, r)
		}
	}
	fails := func(uid int, spec string) {
		r := dialAs(t, uid, spec)
		if r == "ok" {
			t.Errorf("uid %d %s: want refused, got ok", uid, spec)
		}
		t.Logf("uid %d %s -> %s", uid, spec, r)
	}
	ok(engine, fmt.Sprintf("tcp 127.0.0.1:%d", proxy))
	fails(engine, "tcp 127.0.0.1:47820")
	fails(engine, "tcp 127.0.0.2:"+strconv.Itoa(proxy))
	fails(engine, "tcp 169.254.169.254:80")
	fails(engine, "tcp 1.1.1.1:443")
	fails(engine, "udp 127.0.0.1:53")
	if v6 {
		fails(engine, fmt.Sprintf("tcp [::1]:%d", proxy))
		ok(other, fmt.Sprintf("tcp [::1]:%d", proxy))
	}
	ok(other, "tcp 127.0.0.1:47820")
	ok(other, "udp 127.0.0.1:53")
	ok(server, "tcp 127.0.0.1:47820")
	fails(server, "tcp 169.254.169.254:80")
	fails(server, "tcp 10.11.12.13:80")
	// status re-checks; remove deletes the table
	out.Reset()
	if code, err := cmdFirewall(e, []string{"status", "--base", base}); code != 0 {
		t.Fatalf("status: %v %s", err, out.String())
	}
	if code, err := cmdFirewall(e, []string{"remove", "--base", base}); code != 0 {
		t.Fatalf("remove: %v", err)
	}
	if exec.Command("nft", "list", "table", "inet", "mycel-t").Run() == nil {
		t.Fatal("table still there after remove")
	}
	ok(engine, "tcp 127.0.0.1:47820")
}

// TestHelperSupervise is not a test: runs `mycel-ctl supervise` in its own process (it reaps every child).
func TestHelperSupervise(t *testing.T) {
	b := os.Getenv("MYCEL_CTL_SUPERVISE_BASE")
	if b == "" {
		t.Skip()
	}
	os.Exit(run([]string{"supervise", "--base", b}))
}

// supervise starts the launcher and the bootstrap as their accounts with the unit arguments, restarts a child that
// dies, and stops both on SIGTERM.
func TestSupervise(t *testing.T) {
	rootTests(t)
	srv, err := lookupAccount("axserver")
	if err != nil {
		t.Skip("no axserver account")
	}
	agt, err := lookupAccount("axagent")
	if err != nil {
		t.Skip("no axagent account")
	}
	base := "/opt/sv-base"
	os.RemoveAll(base)
	t.Cleanup(func() { os.RemoveAll(base) })
	for _, d := range []string{"root", "run", "agent/home", "data", "config", "app"} {
		must(t, os.MkdirAll(filepath.Join(base, d), 0o755))
	}
	outDir := filepath.Join(base, "out")
	must(t, os.MkdirAll(outDir, 0o777))
	os.Chmod(outDir, 0o777)
	fake := "#!/bin/sh\n{ id -u; echo \"$@\"; env; cat /proc/self/cgroup; umask; } > " + outDir + "/%s.$$\nexec sleep 1000\n"
	must(t, os.WriteFile(filepath.Join(base, "root/mycel-launcher"), []byte(fmt.Sprintf(fake, "launcher")), 0o755))
	must(t, os.WriteFile(filepath.Join(base, "root/mycel-bootstrap"), []byte(fmt.Sprintf(fake, "server")), 0o755))
	must(t, os.WriteFile(filepath.Join(base, "root/install.json"), []byte(`{"format":1,"id":"svt","base":"`+base+`","serverUser":"axserver","agentUser":"axagent","port":47820,"proxyPort":47821,"tlsPort":0,"hosted":false,"autoUpdate":false,"allowUnsigned":true,"engines":["claude"],"version":"0.1.0","systemd":false}`), 0o644))
	must(t, os.WriteFile(filepath.Join(base, "root/firewall.conf.json"), []byte(fmt.Sprintf(`{"format":1,"id":"svt","engineUid":%d,"serverUid":%d,"proxyPort":47821,"serverPort":47820,"deployment":"self","serverAllowPrivate":[]}`, agt.uid, srv.uid)), 0o644))
	cmd := exec.Command(os.Args[0], "-test.run", "^TestHelperSupervise$")
	cmd.Env = []string{"MYCEL_CTL_SUPERVISE_BASE=" + base, "PATH=/usr/sbin:/usr/bin:/sbin:/bin"}
	var log bytes.Buffer
	cmd.Stdout, cmd.Stderr = &log, &log
	must(t, cmd.Start())
	defer cmd.Process.Kill()
	read := func(name string) []string {
		for i := 0; i < 50; i++ {
			ms, _ := filepath.Glob(filepath.Join(outDir, name+".*"))
			if len(ms) > 0 {
				time.Sleep(100 * time.Millisecond)
				var all []string
				for _, m := range ms {
					b, _ := os.ReadFile(m)
					all = append(all, string(b))
				}
				return all
			}
			time.Sleep(100 * time.Millisecond)
		}
		t.Fatalf("%s did not start; log:\n%s", name, log.String())
		return nil
	}
	l := read("launcher")[0]
	s := read("server")[0]
	if !strings.HasPrefix(l, strconv.Itoa(agt.uid)+"\n") || !strings.Contains(l, "--dedicated-account") || !strings.Contains(l, "--cgroup auto") || !strings.Contains(l, "HOME="+base+"/agent/home") {
		t.Errorf("launcher:\n%s", l)
	}
	if !strings.HasPrefix(s, strconv.Itoa(srv.uid)+"\n") || !strings.Contains(s, "--allow-unsigned") || !strings.Contains(s, "MYCEL_INSTALL_BASE="+base) || !strings.Contains(s, "MYCEL_ALLOW_UNSIGNED=1") {
		t.Errorf("server:\n%s", s)
	}
	if !strings.Contains(l, "0077") || !strings.Contains(s, "0027") {
		t.Errorf("umask: launcher %q server %q", l, s)
	}
	if fileExists("/sys/fs/cgroup/svt-launcher") {
		if !strings.Contains(l, "0::/svt-launcher") {
			t.Errorf("launcher not in its delegated cgroup:\n%s", l)
		}
		var st syscall.Stat_t
		syscall.Stat("/sys/fs/cgroup/svt-launcher/cgroup.procs", &st)
		if int(st.Uid) != agt.uid {
			t.Errorf("launcher cgroup not delegated to the engine account")
		}
	} else {
		t.Logf("no cgroup delegation here: %s", log.String())
	}
	// kill the launcher: it comes back
	ms, _ := filepath.Glob(filepath.Join(outDir, "launcher.*"))
	pid, _ := strconv.Atoi(strings.TrimPrefix(filepath.Ext(ms[0]), "."))
	must(t, syscall.Kill(pid, syscall.SIGKILL))
	time.Sleep(2500 * time.Millisecond)
	if ms2, _ := filepath.Glob(filepath.Join(outDir, "launcher.*")); len(ms2) < 2 {
		t.Fatalf("launcher not restarted:\n%s", log.String())
	}
	must(t, cmd.Process.Signal(syscall.SIGTERM))
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatalf("supervise did not stop on SIGTERM:\n%s", log.String())
	}
	if n, _ := countProcs(agt.uid, ""); n != 0 {
		t.Errorf("%d engine-account processes left after stop", n)
	}
	t.Logf("supervise log:\n%s", log.String())
}

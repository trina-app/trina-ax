//go:build linux

package main

import (
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func TestPickSandbox(t *testing.T) {
	root := t.TempDir()
	const host = 4026531840
	fakeProc(t, root, 10, host, 3128) // srt's node outside the sandbox (the host's 3128 is not the relay of the run)
	fakeProc(t, root, 11, 900, 3128)  // the sandbox: srt's relay
	fakeProc(t, root, 12, 901)        // a nested namespace in the same run
	pid, ino, err := pickSandbox(root, []int{10, 11, 12}, host)
	if err != nil || pid != 11 || ino != 900 {
		t.Errorf("with the relay: %d %d %v, want 11 900", pid, ino, err)
	}
	// No network: no relay, one sandbox namespace
	pid, ino, err = pickSandbox(root, []int{10, 12}, host)
	if err != nil || pid != 12 || ino != 901 {
		t.Errorf("no relay, one namespace: %d %d %v, want 12 901", pid, ino, err)
	}
	// not started yet: only the host's processes
	if _, _, err := pickSandbox(root, []int{10}, host); err != errNoMatch {
		t.Errorf("nothing in a sandbox yet: %v, want errNoMatch", err)
	}
	// two namespaces and no relay: which one the command runs in is not known, refused
	fakeProc(t, root, 13, 902)
	if _, _, err := pickSandbox(root, []int{10, 12, 13}, host); err == nil || err == errNoMatch {
		t.Errorf("two namespaces with no relay: %v, want a refusal", err)
	}
}

func TestDialSocket(t *testing.T) {
	dir := t.TempDir()
	os.Chmod(dir, 0o700)
	sock := filepath.Join(dir, "f.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if err := dialSocket(sock); err != nil {
		t.Errorf("a socket of this account: %v", err)
	}
	file := filepath.Join(dir, "x.sock")
	os.WriteFile(file, []byte("x"), 0o600)
	for _, p := range []string{file, filepath.Join(dir, "none.sock"), "rel.sock", dir + "/../x.sock", filepath.Join(dir, "f.txt")} {
		if err := dialSocket(p); err == nil {
			t.Errorf("%q accepted", p)
		}
	}
}

func TestServeSocketCopies(t *testing.T) {
	dir := t.TempDir()
	sock := filepath.Join(dir, "f.sock")
	fwd, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer fwd.Close()
	go func() {
		for {
			c, err := fwd.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) { defer c.Close(); b, _ := io.ReadAll(c); c.Write(append([]byte("dev:"), b...)) }(c)
		}
	}()
	lns, err := listenLocal(0)
	if err != nil {
		t.Fatal(err)
	}
	for _, ln := range lns {
		defer ln.Close()
		go serveSocket(ln, sock, make(chan struct{}, 4))
	}
	port := lns[0].Addr().(*net.TCPAddr).Port
	for i := 0; i < 3; i++ {
		c, err := net.Dial("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		if err != nil {
			t.Fatal(err)
		}
		c.Write([]byte("GET /"))
		c.(*net.TCPConn).CloseWrite()
		b, _ := io.ReadAll(c)
		c.Close()
		if string(b) != "dev:GET /" {
			t.Errorf("round %d: %q", i, b)
		}
	}
}

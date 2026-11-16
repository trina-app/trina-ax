package main

import (
	"bufio"
	"encoding/json"
	"net"
	"path/filepath"
	"runtime"
	"testing"
)

// The request over the launcher socket: on macOS it answers "skipped" and runs nothing; the Linux checks are in
// enginecheck_linux_test.go.
func TestSandboxCheckRequest(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS answer")
	}
	sock := filepath.Join(t.TempDir(), "l.sock")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.AcceptUnix()
		if err == nil {
			serve(c)
		}
	}()
	c, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.Write([]byte(`{"op":"sandbox-check"}` + "\n"))
	line, err := bufio.NewReader(c).ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var ev struct {
		Ev      string `json:"ev"`
		Ok      bool   `json:"ok"`
		Skipped string `json:"skipped"`
	}
	if json.Unmarshal(line, &ev) != nil || ev.Ev != "sandbox-check" || !ev.Ok || ev.Skipped == "" {
		t.Fatalf("answer %s", line)
	}
}

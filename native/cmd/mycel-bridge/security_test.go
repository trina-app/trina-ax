package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// the shim passes its arguments (and the stdin of `security -i`) to the broker and gives back its answer
func TestSecurityShim(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "shim")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	sock := filepath.Join(dir, "sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	got := make(chan map[string]any, 4)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			line, _ := bufio.NewReader(c).ReadBytes('\n')
			var m map[string]any
			_ = json.Unmarshal(line, &m)
			got <- m
			c.Write([]byte(`{"code":44,"stdout":"out\n","stderr":"err\n"}` + "\n"))
			c.Close()
		}
	}()
	var out, errb bytes.Buffer
	code := securityShim([]string{"find-generic-password", "-a", "u", "-w", "-s", "Claude Code-credentials"}, strings.NewReader("ignored"), &out, &errb, sock)
	m := <-got
	if code != 44 || out.String() != "out\n" || errb.String() != "err\n" || m["stdin"] != nil || len(m["args"].([]any)) != 6 {
		t.Fatalf("argv form: %d %q %q %v", code, out.String(), errb.String(), m)
	}
	code = securityShim([]string{"-i"}, strings.NewReader("add-generic-password -U\n"), &out, &errb, sock)
	if m := <-got; code != 44 || m["stdin"] != "add-generic-password -U\n" {
		t.Fatalf("-i: %v", m)
	}
	if securityShim([]string{"show-keychain-info"}, strings.NewReader(""), &out, &errb, "") != 1 {
		t.Fatal("no socket must fail")
	}
	if securityShim([]string{"show-keychain-info"}, strings.NewReader(""), &out, &errb, filepath.Join(dir, "none")) != 1 {
		t.Fatal("unreachable broker must fail")
	}
}

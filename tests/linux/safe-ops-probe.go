//go:build linux

// Synthetic adversarial helper, built only for T1. Never included in a release bundle.
//
package main

import (
	"encoding/json"
	"io"
	"net"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

func main() {
	b, _ := io.ReadAll(io.LimitReader(os.Stdin, 100))
	mode := string(b)
	switch mode {
	case "spin":
		for {
		}
	case "memory":
		var all [][]byte
		for {
			p := make([]byte, 16<<20)
			for i := range p {
				p[i] = 1
			}
			all = append(all, p)
		}
	case "disk":
		p := make([]byte, 1<<20)
		for i := 0; i < 100; i++ {
			if os.WriteFile("/work/f"+strings.Repeat("x", i), p, 0600) != nil {
				os.Stdout.WriteString("disk-limited")
				return
			}
		}
	case "probe":
		denied := map[string]bool{}
		for _, p := range []string{"/etc/passwd", "/home", "/srv", "/sys/fs/cgroup", "/bin/sh"} {
			_, e := os.Stat(p)
			denied[p] = e != nil
		}
		c, e := net.DialTimeout("tcp", "127.0.0.1:19728", time.Second)
		denied["network"] = e != nil
		if c != nil {
			c.Close()
		}
		denied["exec"] = exec.Command("/bin/sh", "-c", "exit 0").Run() != nil
		denied["namespace"] = syscall.Unshare(syscall.CLONE_NEWUSER) != nil
		l, e := net.Listen("tcp", "127.0.0.1:19728")
		denied["listen"] = e != nil
		if l != nil {
			l.Close()
		}
		json.NewEncoder(os.Stdout).Encode(denied)
	default:
		os.Exit(3)
	}
}

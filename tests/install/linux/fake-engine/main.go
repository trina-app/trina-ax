// The install test's fake engine (tests/install/g-linux-install.ts): a static Linux ELF, because the installer accepts
// only real executables as engines (no scripts, no interpreters). The test installs it as `claude` and `codex` and runs
// turns through the installed launcher (bwrap + Landlock + seccomp + nftables) as the server account would.
//
//	<engine> --version            prints a version line (the installer's version check)
//	<engine> read P | write P | list P | stat P | exec P | tcp HOST PORT | id | hold MS
//
// Exit codes: 0 done, 1 refused (EACCES / EPERM / EROFS), 3 not found (ENOENT), 4 connection refused, 5 timeout,
// 2 other error. One line on stderr says what happened.
package main

import (
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func code(err error) int {
	var ne net.Error
	switch {
	case err == nil:
		return 0
	case errors.Is(err, fs.ErrNotExist), errors.Is(err, syscall.ENOENT):
		return 3
	case errors.Is(err, syscall.EACCES), errors.Is(err, syscall.EPERM), errors.Is(err, syscall.EROFS), errors.Is(err, fs.ErrPermission):
		return 1
	case errors.Is(err, syscall.ECONNREFUSED), errors.Is(err, syscall.ECONNRESET):
		return 4
	case errors.As(err, &ne) && ne.Timeout():
		return 5
	}
	return 2
}

func main() {
	a := os.Args[1:]
	if len(a) == 0 {
		fmt.Fprintln(os.Stderr, "usage: --version | read|write|list|stat|exec P | tcp HOST PORT | id | hold MS")
		os.Exit(2)
	}
	var err error
	switch a[0] {
	case "--version":
		fmt.Println("0.0.0 (install-test fake engine)")
	case "id":
		fmt.Printf("uid=%d gid=%d\n", os.Getuid(), os.Getgid())
	case "hold":
		ms, _ := strconv.Atoi(arg(a, 1))
		time.Sleep(time.Duration(ms) * time.Millisecond)
	case "read":
		var b []byte
		if b, err = os.ReadFile(arg(a, 1)); err == nil {
			os.Stdout.Write(b)
		}
	case "write":
		err = os.WriteFile(arg(a, 1), []byte("written by the fake engine\n"), 0o600)
	case "list":
		var ents []os.DirEntry
		if ents, err = os.ReadDir(arg(a, 1)); err == nil {
			names := make([]string, 0, len(ents))
			for _, e := range ents {
				names = append(names, e.Name())
			}
			fmt.Println(strings.Join(names, "\n"))
		}
	case "stat":
		_, err = os.Stat(arg(a, 1))
	case "exec":
		err = syscall.Exec(arg(a, 1), []string{arg(a, 1), "--version"}, os.Environ())
	case "tcp":
		var c net.Conn
		if c, err = net.DialTimeout("tcp", net.JoinHostPort(arg(a, 1), arg(a, 2)), 3*time.Second); err == nil {
			c.Close()
		}
	default:
		fmt.Fprintln(os.Stderr, "unknown command", a[0])
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
	os.Exit(code(err))
}

func arg(a []string, i int) string {
	if i < len(a) {
		return a[i]
	}
	return ""
}

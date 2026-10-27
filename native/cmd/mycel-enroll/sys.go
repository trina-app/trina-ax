package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"strconv"
	"strings"
	"time"
)

// Runner runs a program (by absolute path or PATH name) with optional stdin and returns its stdout. A non-zero exit
// is a *CmdError carrying the exit code and the first part of stderr. Tests replace it with a recording fake.
type Runner interface {
	Run(ctx context.Context, name string, args []string, stdin []byte) ([]byte, error)
}

// CmdError is a program that ran and failed (or could not start: Code -1).
type CmdError struct {
	Name   string
	Code   int
	Stderr string
}

func (e *CmdError) Error() string {
	s := strings.TrimSpace(e.Stderr)
	if len(s) > 500 {
		s = s[:500] + "…"
	}
	if s == "" {
		return fmt.Sprintf("%s exited %d", e.Name, e.Code)
	}
	return fmt.Sprintf("%s exited %d: %s", e.Name, e.Code, s)
}

// exitCode returns the exit code of a failed command, or -1 when err is something else.
func exitCode(err error) int {
	var ce *CmdError
	if errors.As(err, &ce) {
		return ce.Code
	}
	return -1
}

type execRunner struct{}

func (execRunner) Run(ctx context.Context, name string, args []string, stdin []byte) ([]byte, error) {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 30*time.Minute)
		defer cancel()
	}
	c := exec.CommandContext(ctx, name, args...)
	if stdin != nil {
		c.Stdin = bytes.NewReader(stdin)
	}
	var out, errb bytes.Buffer
	c.Stdout, c.Stderr = &out, &errb
	// a fixed, small environment: nothing from the cloud-init/systemd environment leaks into the tools
	c.Env = []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8"}
	err := c.Run()
	if err != nil {
		code := -1
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			code = ee.ExitCode()
		} else {
			errb.WriteString(err.Error())
		}
		return out.Bytes(), &CmdError{Name: name, Code: code, Stderr: errb.String()}
	}
	return out.Bytes(), nil
}

func lookupUser(name string) (int, int, error) {
	u, err := user.Lookup(name)
	if err != nil {
		return 0, 0, err
	}
	uid, err1 := strconv.Atoi(u.Uid)
	gid, err2 := strconv.Atoi(u.Gid)
	if err1 != nil || err2 != nil {
		return 0, 0, fmt.Errorf("account %s has a non-numeric uid/gid", name)
	}
	return uid, gid, nil
}

// systemdRunning: systemd is PID 1 (the documented check, sd_booted(3)).
func systemdRunning() bool {
	st, err := os.Stat("/run/systemd/system")
	return err == nil && st.IsDir()
}

// unescapeMountinfo decodes the octal escapes (\040 for a space…) of /proc/self/mountinfo paths.
func unescapeMountinfo(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			if n, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

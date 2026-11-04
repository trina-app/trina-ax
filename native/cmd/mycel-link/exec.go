package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

const (
	// TENANT_COMMAND_STDOUT_MAX: hostd fails a result with more stdout than this
	stdoutMax = 1 << 20
	// LINK_STDERR_MAX: hostd keeps the last 64 KiB of stderr
	stderrMax = 64 << 10
	// hostd's request body limit
	bodyMax = 3 << 20
	// a body over this is sent as "over 1 MiB" (see encodeResult)
	bodySafe   = bodyMax - 64<<10
	maxTimeout = 24 * time.Hour
	// pipes of a killed command that a grandchild still holds open
	waitDelay = 5 * time.Second
)

// a stdout that hostd refuses as "guest output over 1 MiB"
var overLimit = strings.Repeat("?", stdoutMax+1)

// a fixed environment: the command gets nothing of the agent's own environment
var cmdEnv = []string{
	"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	"HOME=/root",
	"LANG=C.UTF-8",
}

// headBuf keeps the first max bytes and counts the rest
type headBuf struct {
	b     bytes.Buffer
	max   int
	total int
}

func (h *headBuf) Write(p []byte) (int, error) {
	h.total += len(p)
	if room := h.max - h.b.Len(); room > 0 {
		h.b.Write(p[:min(room, len(p))])
	}
	return len(p), nil
}

// tailBuf keeps the last max bytes
type tailBuf struct {
	b   []byte
	max int
}

func (t *tailBuf) Write(p []byte) (int, error) {
	t.b = append(t.b, p...)
	if len(t.b) > 2*t.max {
		t.b = append([]byte(nil), t.b[len(t.b)-t.max:]...)
	}
	return len(p), nil
}
func (t *tailBuf) bytes() []byte {
	if len(t.b) > t.max {
		return t.b[len(t.b)-t.max:]
	}
	return t.b
}

// runCommand runs argv with exec (no shell) in its own process group, stdin on fd 0, and kills the whole group at
// timeoutSec. Exit codes: the command's own; -1 when a signal ended it; 127 when it could not start.
func runCommand(ctx context.Context, c Command) Result {
	timeout := time.Duration(c.TimeoutSec * float64(time.Second))
	timeout = max(time.Second, min(timeout, maxTimeout))
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, c.Argv[0], c.Argv[1:]...)
	cmd.Env = cmdEnv
	cmd.Dir = "/"
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = waitDelay
	if c.Stdin != nil {
		cmd.Stdin = strings.NewReader(*c.Stdin)
	}
	out := &headBuf{max: stdoutMax}
	errb := &tailBuf{max: stderrMax}
	cmd.Stdout = out
	cmd.Stderr = errb
	err := cmd.Run()
	if errors.Is(cctx.Err(), context.DeadlineExceeded) && ctx.Err() == nil {
		return Result{ExitCode: -1, TimedOut: true}
	}
	r := Result{Stdout: out.b.String(), Stderr: string(errb.bytes())}
	if out.total > stdoutMax {
		// hostd counts UTF-16 units, not bytes: send a stdout that is over the limit in both counts
		r.Stdout = overLimit
	}
	var ee *exec.ExitError
	switch {
	case err == nil:
		r.ExitCode = 0
	case errors.As(err, &ee):
		r.ExitCode = ee.ExitCode()
	case errors.Is(err, exec.ErrWaitDelay):
		r.ExitCode = cmd.ProcessState.ExitCode()
	default:
		r.ExitCode = 127
		r.Stderr = "mycel-link: cannot start the command\n"
	}
	return r
}

// encodeResult makes the result body. JSON escapes can make a body bigger than its text (a control byte is 6 bytes);
// a body that hostd would refuse as too large (413) is sent with a stdout over 1 MiB instead, so hostd reports
// "guest output over 1 MiB" and does not wait for a timeout. The stderr tail is cut to 64 KiB of valid UTF-8.
func encodeResult(r Result) []byte {
	r.Stderr = validTail(r.Stderr, stderrMax)
	b := marshal(r)
	if len(b) > bodySafe {
		r.Stdout = overLimit
		r.Stderr = validTail(r.Stderr, 4<<10)
		b = marshal(r)
	}
	return b
}

func marshal(r Result) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	// "<", ">" and "&" stay as they are (6 bytes each when escaped)
	enc.SetEscapeHTML(false)
	enc.Encode(r)
	return bytes.TrimRight(buf.Bytes(), "\n")
}

// validTail: the last max bytes, starting at a rune boundary
func validTail(s string, max int) string {
	if len(s) <= max {
		return s
	}
	s = s[len(s)-max:]
	for i := 0; i < utf8.UTFMax && i < len(s); i++ {
		if utf8.RuneStart(s[i]) {
			return s[i:]
		}
	}
	return s
}

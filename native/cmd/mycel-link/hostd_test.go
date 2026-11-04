package main

// The agent against the REAL hostd ax-link server (trina-cloud hostd/hostd/src/link.ts, run with bun by
// testdata/hostd-link.ts): TLS with hostd's own ECDSA P-256 certificate and pin, register with the HMAC token, the
// signatures, the long poll, results, the 1 MiB limit, the timeout, and the resend after a reboot.
//
//	MYCEL_LINK_HOSTD_DIR=<trina-cloud worktree>/hostd go test ./cmd/mycel-link -run Hostd
//
// Without MYCEL_LINK_HOSTD_DIR (or without bun) the test is skipped.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type hostdProc struct {
	t      *testing.T
	in     *json.Encoder
	mu     sync.Mutex
	next   int
	wait   map[int]chan map[string]any
	stderr *syncBuf
	Port   int    `json:"port"`
	Pin    string `json:"pin"`
	Token  string `json:"token"`
	Tenant string `json:"tenantId"`
}

func startHostd(t *testing.T) *hostdProc {
	dir := os.Getenv("MYCEL_LINK_HOSTD_DIR")
	if dir == "" {
		t.Skip("MYCEL_LINK_HOSTD_DIR is not set (trina-cloud hostd folder)")
	}
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Skip("bun is not installed")
	}
	script, _ := filepath.Abs("testdata/hostd-link.ts")
	cmd := exec.Command(bun, script, t.TempDir())
	cmd.Env = append(os.Environ(), "MYCEL_LINK_HOSTD_DIR="+dir, "POLL_WAIT_MS=2000")
	h := &hostdProc{t: t, wait: map[int]chan map[string]any{}, stderr: &syncBuf{}}
	cmd.Stderr = h.stderr
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stdin.Close(); cmd.Process.Kill(); cmd.Wait() })
	h.in = json.NewEncoder(stdin)
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 64<<10), 8<<20)
	ready := make(chan error, 1)
	go func() {
		first := true
		for sc.Scan() {
			if first {
				first = false
				ready <- json.Unmarshal(sc.Bytes(), h)
				continue
			}
			var m map[string]any
			json.Unmarshal(sc.Bytes(), &m)
			ref := int(m["ref"].(float64))
			h.mu.Lock()
			ch := h.wait[ref]
			delete(h.wait, ref)
			h.mu.Unlock()
			ch <- m
		}
		if first {
			ready <- fmt.Errorf("hostd helper ended: %s", h.stderr.String())
		}
	}()
	select {
	case err := <-ready:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(30 * time.Second):
		t.Fatalf("hostd helper did not start: %s", h.stderr.String())
	}
	return h
}

// call sends one request and returns a channel for its answer
func (h *hostdProc) call(m map[string]any) chan map[string]any {
	h.mu.Lock()
	h.next++
	ref := h.next
	ch := make(chan map[string]any, 1)
	h.wait[ref] = ch
	m["ref"] = ref
	h.in.Encode(m)
	h.mu.Unlock()
	return ch
}

func (h *hostdProc) do(m map[string]any) map[string]any {
	h.t.Helper()
	select {
	case r := <-h.call(m):
		return r
	case <-time.After(60 * time.Second):
		h.t.Fatalf("no answer to %v", m["op"])
		return nil
	}
}

func (h *hostdProc) url() string { return fmt.Sprintf("https://127.0.0.1:%d", h.Port) }

func TestHostdLinkServer(t *testing.T) {
	h := startHostd(t)
	// the commands of this test are not on the production allow-list (macOS has no /usr/bin/cat); one test argv
	// stays refused to check the 126 path
	allowTest := func(argv []string) bool { return len(argv) > 0 && argv[0] != "/usr/bin/false" }

	t.Run("a wrong pin: no register", func(t *testing.T) {
		_, other := ecdsaCert(t)
		e := newEnv(t, h.url(), other, h.Token, h.Tenant)
		stop := start(t, e.opts("boot-x"))
		time.Sleep(1500 * time.Millisecond)
		stop()
		if st := h.do(map[string]any{"op": "state"}); st["linkPubkey"] != nil {
			t.Fatal("registered through a wrong pin")
		}
	})

	e := newEnv(t, h.url(), h.Pin, h.Token, h.Tenant)
	o := e.opts("boot-1")
	o.Allow = allowTest
	stop1 := start(t, o)
	if r := h.do(map[string]any{"op": "waitOnline"}); r["ok"] != true {
		t.Fatalf("not online: %v\nagent: %s\nhostd: %s", r, e.log.String(), h.stderr.String())
	}
	st := h.do(map[string]any{"op": "state"})
	if st["linkPubkey"] == nil || st["linkTokenHash"] != nil || st["bootId"] != "boot-1" {
		t.Fatalf("state after register: %v", st)
	}
	if b, _ := os.ReadFile(e.cfg); strings.Contains(string(b), h.Token) {
		t.Fatal("token still in link.json")
	}

	exec1 := func(argv []string, stdin any, timeoutSec int) map[string]any {
		return h.do(map[string]any{"op": "exec", "argv": argv, "stdin": stdin, "timeoutSec": timeoutSec})
	}
	t.Run("stdin, stdout, stderr, exit code", func(t *testing.T) {
		r := exec1([]string{"/bin/sh", "-c", "cat; echo E >&2; exit 4"}, "STDIN-SECRET-123\n", 10)
		res, _ := r["result"].(map[string]any)
		if r["ok"] != true || res["stdout"] != "STDIN-SECRET-123\n" || res["stderr"] != "E\n" || res["exitCode"] != float64(4) {
			t.Fatalf("%v", r)
		}
	})
	t.Run("not allowed: 126", func(t *testing.T) {
		r := exec1([]string{"/usr/bin/false"}, nil, 10)
		if res, _ := r["result"].(map[string]any); r["ok"] != true || res["exitCode"] != float64(126) {
			t.Fatalf("%v", r)
		}
	})
	t.Run("timeout: guest_agent_timeout", func(t *testing.T) {
		t0 := time.Now()
		r := exec1([]string{"/bin/sleep", "30"}, nil, 1)
		if r["ok"] != false || r["code"] != "guest_agent_timeout" || time.Since(t0) > 10*time.Second {
			t.Fatalf("%v after %v", r, time.Since(t0))
		}
	})
	t.Run("stdout over 1 MiB: hostd fails it", func(t *testing.T) {
		r := exec1([]string{"/bin/sh", "-c", "head -c 400000 /dev/zero | tr '\\0' 'x' | sed 's/x/한/g'"}, nil, 20)
		if r["ok"] != false || !strings.Contains(fmt.Sprint(r["message"]), "1 MiB") {
			t.Fatalf("%v", r)
		}
	})
	t.Run("parallel: 6 commands, 4 at a time", func(t *testing.T) {
		var chs []chan map[string]any
		for i := 0; i < 6; i++ {
			chs = append(chs, h.call(map[string]any{"op": "exec", "argv": []string{"/bin/sh", "-c", fmt.Sprintf("sleep 1; echo %d", i)}, "stdin": nil, "timeoutSec": 10}))
		}
		t0 := time.Now()
		for i, ch := range chs {
			r := <-ch
			if res, _ := r["result"].(map[string]any); r["ok"] != true || res["stdout"] != fmt.Sprintf("%d\n", i) {
				t.Fatalf("cmd %d: %v", i, r)
			}
		}
		// 6 commands of 1 s with 4 slots: 2 rounds
		if d := time.Since(t0); d < 1900*time.Millisecond || d > 8*time.Second {
			t.Fatalf("took %v", d)
		}
	})

	parent := t
	t.Run("agent restart in the same boot: hostd fails the killed command at once", func(t *testing.T) {
		mark := filepath.Join(t.TempDir(), "started")
		ch := h.call(map[string]any{"op": "exec", "argv": []string{"/bin/sh", "-c", "touch " + mark + "; sleep 60"}, "stdin": nil, "timeoutSec": 60})
		eventually(t, "command start", 10*time.Second, func() bool { _, err := os.Stat(mark); return err == nil })
		t0 := time.Now()
		stop1()
		o1 := e.opts("boot-1")
		o1.Allow = allowTest
		// the parent test: the agent must outlive this subtest
		stop1 = start(parent, o1)
		select {
		case r := <-ch:
			if r["ok"] != false || r["code"] != "guest_agent_timeout" || time.Since(t0) > 15*time.Second {
				t.Fatalf("%v after %v", r, time.Since(t0))
			}
		case <-time.After(30 * time.Second):
			t.Fatal("hostd still waits for the killed command")
		}
	})

	var stop2 func()
	t.Run("reboot: hostd sends the lost command again; the token is not needed", func(t *testing.T) {
		mark := filepath.Join(t.TempDir(), "first-run")
		// the first run hangs (it dies with the "reboot"); the run after the reboot answers at once
		ch := h.call(map[string]any{"op": "exec", "argv": []string{"/bin/sh", "-c", "if [ -e " + mark + " ]; then echo after-reboot; else touch " + mark + "; sleep 60; fi"}, "stdin": nil, "timeoutSec": 30})
		eventually(t, "first run", 10*time.Second, func() bool { _, err := os.Stat(mark); return err == nil })
		stop1()
		since := time.Now().UnixMilli()
		o2 := e.opts("boot-2")
		o2.Allow = allowTest
		stop2 = start(t, o2)
		select {
		case r := <-ch:
			if res, _ := r["result"].(map[string]any); r["ok"] != true || res["stdout"] != "after-reboot\n" {
				t.Fatalf("%v", r)
			}
		case <-time.After(30 * time.Second):
			t.Fatal("no result after the reboot")
		}
		if r := h.do(map[string]any{"op": "waitOnline", "since": since, "notBoot": "boot-1"}); r["bootId"] != "boot-2" {
			t.Fatalf("%v", r)
		}
	})

	t.Run("reimage: a new root (new key) registers with the new token", func(t *testing.T) {
		// the old root is gone: its agent stops. hostd still holds that agent's long poll until POLL_WAIT_MS ends, and
		// a command queued in that time goes to the dead poll (hostd marks it dispatched and only a new boot id sends
		// it again: a hostd gap, see the commit message). Wait for the poll to end.
		if stop2 != nil {
			stop2()
		}
		time.Sleep(2500 * time.Millisecond)
		tok := h.do(map[string]any{"op": "reimage", "opId": "op-2"})["token"].(string)
		e2 := newEnv(t, h.url(), h.Pin, tok, h.Tenant)
		o3 := e2.opts("boot-3")
		o3.Allow = allowTest
		start(t, o3)
		if r := h.do(map[string]any{"op": "waitOnline", "notBoot": "boot-2"}); r["ok"] != true {
			t.Fatalf("%v\nagent: %s", r, e2.log.String())
		}
		r := exec1([]string{"/bin/echo", "ok"}, nil, 10)
		if res, _ := r["result"].(map[string]any); res["stdout"] != "ok\n" {
			t.Fatalf("%v\nagent3: %s\nhostd: %s", r, e2.log.String(), h.stderr.String())
		}
		for _, s := range []string{tok, h.Token, "STDIN-SECRET-123", "after-reboot"} {
			for name, l := range map[string]string{"agent 1": e.log.String(), "agent 3": e2.log.String(), "hostd": h.stderr.String()} {
				if strings.Contains(l, s) {
					t.Fatalf("%s log holds a secret or output %q", name, s)
				}
			}
		}
	})
}

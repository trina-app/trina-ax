// Code sandbox (docs/DECISIONS.md "Code sandbox", build phase D1): the server's run_code tool asks the launcher to run
// one bash or python3 program for a live turn whose LaunchRequest had codeSandbox. The program does NOT run inside the
// engine's sandbox: every run gets its own bubblewrap (no network namespace peers, its own pid namespace, only
// <chat>/work read-write at /work, the distro's /usr read-only) and its own cgroup beside the turn's (code_linux.go).
// The engine's own sandbox does not change: it still cannot execute anything of /usr/bin.
//
// Protocol (one connection per run, from the server account like every launcher request):
//
//	-> {"op":"code","turnId":"…","lang":"bash"|"python","code":"…","timeoutMs":N}
//	<- {"ev":"code_exit","code":N,"signal":"timeout"|"oom"|"disk_limit"|"stopped"|"","stdout":"…","stderr":"…","truncated":bool,"ms":N}
//	   or {"ev":"error","message":"…"}
//
// The chat folder and the permission come from the live turn (registered at beginTurn), never from this request. The
// server may send {"op":"kill"} or close the connection: the run stops. One run per turn at a time.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"sync"
	"time"
	"unicode/utf8"
)

// codeRequest is one run (the server's run_code tool, server/src/chat/code-sandbox.ts).
type codeRequest struct {
	Op        string `json:"op"`
	TurnID    string `json:"turnId"`
	Lang      string `json:"lang"`
	Code      string `json:"code"`
	TimeoutMs int64  `json:"timeoutMs"`
}

const (
	codeMaxBytes       = 256 << 10 // the program text
	codeOutMax         = 64 << 10  // kept of stdout and of stderr each
	codeDefaultTimeout = 60 * time.Second
	codeMaxTimeout     = 600 * time.Second
)

// codeTurns: the live turns that may run code (turn id -> chat folder), registered by beginTurn, removed by cleanup.
var codeTurns = struct {
	mu sync.Mutex
	m  map[string]*codeTurn
}{m: map[string]*codeTurn{}}

type codeTurn struct {
	chat string
	te   *turnEnv
	busy sync.Mutex
	// stop ends the run in progress (turn cleanup); nil while none runs
	mu   sync.Mutex
	stop func()
}

func registerCodeTurn(id, chat string, te *turnEnv) {
	codeTurns.mu.Lock()
	codeTurns.m[id] = &codeTurn{chat: chat, te: te}
	codeTurns.mu.Unlock()
}

// unregisterCodeTurn removes the turn and stops a run that is still going (the turn is over).
func unregisterCodeTurn(id string) {
	codeTurns.mu.Lock()
	ct := codeTurns.m[id]
	delete(codeTurns.m, id)
	codeTurns.mu.Unlock()
	if ct != nil {
		ct.mu.Lock()
		stop := ct.stop
		ct.mu.Unlock()
		if stop != nil {
			stop()
		}
	}
}

func lookupCodeTurn(id string) *codeTurn {
	codeTurns.mu.Lock()
	defer codeTurns.mu.Unlock()
	return codeTurns.m[id]
}

// checkCode validates a request; the interpreter is chosen per platform (code_linux.go).
func checkCode(req *codeRequest) (time.Duration, error) {
	if !chatIDRe.MatchString(req.TurnID) {
		return 0, fmt.Errorf("bad turn id")
	}
	if req.Lang != "bash" && req.Lang != "python" {
		return 0, fmt.Errorf("lang must be bash or python")
	}
	if len(req.Code) == 0 || len(req.Code) > codeMaxBytes {
		return 0, fmt.Errorf("code must be 1 to %d bytes", codeMaxBytes)
	}
	t := codeDefaultTimeout
	if req.TimeoutMs > 0 {
		t = time.Duration(req.TimeoutMs) * time.Millisecond
	}
	if t < time.Second {
		t = time.Second
	}
	if t > codeMaxTimeout {
		t = codeMaxTimeout
	}
	return t, nil
}

// capBuf keeps the first max bytes written to it and counts the rest.
type capBuf struct {
	mu      sync.Mutex
	b       []byte
	max     int
	dropped int64
}

func (c *capBuf) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if room := c.max - len(c.b); room > 0 {
		n := len(p)
		if n > room {
			n = room
		}
		c.b = append(c.b, p[:n]...)
		c.dropped += int64(len(p) - n)
	} else {
		c.dropped += int64(len(p))
	}
	return len(p), nil
}

// text is the kept output as valid UTF-8 (a cut in the middle of a character is dropped; other bad bytes become
// U+FFFD in the JSON answer).
func (c *capBuf) text() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	b := c.b
	for i := 0; i < 3 && len(b) > 0 && !utf8.Valid(b); i++ {
		b = b[:len(b)-1]
	}
	if !utf8.Valid(b) {
		b = c.b
	}
	return string(b)
}

// serveCode handles one "code" connection (main.go serve).
func serveCode(line []byte, o *out, r *bufio.Reader) {
	var req codeRequest
	if err := json.Unmarshal(line, &req); err != nil || req.Op != "code" {
		o.send(map[string]any{"ev": "error", "message": "bad request"})
		return
	}
	timeout, err := checkCode(&req)
	if err != nil {
		o.send(map[string]any{"ev": "error", "message": "code: " + err.Error()})
		return
	}
	ct := lookupCodeTurn(req.TurnID)
	if ct == nil {
		o.send(map[string]any{"ev": "error", "message": "code_unavailable: no running turn with the code sandbox"})
		return
	}
	if !ct.busy.TryLock() {
		o.send(map[string]any{"ev": "error", "message": "code_busy: another code run of this turn is still running"})
		return
	}
	defer ct.busy.Unlock()
	stopped := make(chan struct{})
	var once sync.Once
	stop := func() { once.Do(func() { close(stopped) }) }
	ct.mu.Lock()
	ct.stop = stop
	ct.mu.Unlock()
	defer func() {
		ct.mu.Lock()
		ct.stop = nil
		ct.mu.Unlock()
	}()
	go func() { // the server closed the connection or sent kill: stop the run
		for {
			l, err := r.ReadBytes('\n')
			var m map[string]any
			if err != nil || (json.Unmarshal(l, &m) == nil && m["op"] == "kill") {
				stop()
				return
			}
		}
	}()
	ev, err := runCode(ct, &req, timeout, stopped)
	if err != nil {
		o.send(map[string]any{"ev": "error", "message": err.Error()})
		return
	}
	o.send(ev)
}

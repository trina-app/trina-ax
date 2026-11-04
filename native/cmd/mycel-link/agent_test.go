package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------------------------------------------------------------- protocol details

func TestSigningStringMatchesHostd(t *testing.T) {
	// the values of hostd linkSigningString (link.ts) for the same input
	got := signingString("post", "/link/v1/poll", 1762243200000, []byte(`{"bootId":"b","running":[]}`))
	want := "ax-link-v1\nPOST\n/link/v1/poll\n1762243200000\n551b513a69e01a3033ec22de4b38a2ec35d9319f69ae2a8aa95d9ee2251f2980"
	if got != want {
		t.Fatalf("got %q", got)
	}
	got = signingString("POST", "/link/v1/result", 5, []byte("ü<&>"))
	if !strings.HasSuffix(got, "\n357b9e1bd1859d5a6e3df37639d0cdf86390597df27a1486a8e8cd8b8da9332c") {
		t.Fatalf("utf-8 body hash: %q", got)
	}
}

func TestAllowList(t *testing.T) {
	yes := [][]string{
		{"/var/lib/mycel/root/mycel-ctl", "status", "--json"},
		{"/var/lib/mycel/root/mycel-ctl", "idle-wait", "--json", "--max", "600"},
		{"/usr/bin/cat", "/run/ax/enroll-status.json"},
		{"/usr/bin/rm", "-f", "/run/ax/enroll.json"},
		{"/usr/bin/df", "-B1", "/var/lib/mycel"},
		{"/usr/bin/systemctl", "is-system-running"},
	}
	no := [][]string{
		nil, {},
		{"df", "-B1", "/var/lib/mycel"}, // the bare argv of proxmox.ts
		{"/usr/bin/cat", "/etc/ax/link.json"},
		{"/usr/bin/rm", "-rf", "/"},
		{"/usr/bin/systemctl", "is-system-running", "--wait"},
		{"/bin/sh", "-c", "id"},
		{"/var/lib/mycel/root/mycel-ctl/../../../../bin/sh"},
		{"/var/lib/mycel/root/mycel-ctl", "status\x00"},
	}
	for _, a := range yes {
		if !allowed(a) {
			t.Errorf("not allowed: %q", a)
		}
	}
	for _, a := range no {
		if allowed(a) {
			t.Errorf("allowed: %q", a)
		}
	}
}

func TestCmdNameShowsNoArgs(t *testing.T) {
	if n := cmdName([]string{mycelCtl, "set-server-config", "--token", "s3cret"}); n != "mycel-ctl set-server-config" {
		t.Fatal(n)
	}
	if n := cmdName([]string{mycelCtl, "S3CRET-VALUE"}); n != "mycel-ctl" {
		t.Fatal(n)
	}
	if n := cmdName([]string{"/usr/bin/cat", "/run/ax/enroll-status.json"}); n != "cat" {
		t.Fatal(n)
	}
}

// ---------------------------------------------------------------- running commands

func str(s string) *string { return &s }

func TestRunCommand(t *testing.T) {
	ctx := context.Background()
	r := runCommand(ctx, Command{Argv: []string{"/bin/cat"}, Stdin: str("in\n"), TimeoutSec: 5})
	if r.ExitCode != 0 || r.Stdout != "in\n" || r.TimedOut {
		t.Fatalf("cat: %+v", r)
	}
	r = runCommand(ctx, Command{Argv: []string{"/bin/sh", "-c", "echo err >&2; exit 3"}, TimeoutSec: 5})
	if r.ExitCode != 3 || r.Stderr != "err\n" {
		t.Fatalf("exit 3: %+v", r)
	}
	// no stdin: /dev/null (cat ends at once)
	r = runCommand(ctx, Command{Argv: []string{"/bin/cat"}, TimeoutSec: 5})
	if r.ExitCode != 0 || r.Stdout != "" {
		t.Fatalf("no stdin: %+v", r)
	}
	r = runCommand(ctx, Command{Argv: []string{"/nonexistent/prog"}, TimeoutSec: 5})
	if r.ExitCode != 127 {
		t.Fatalf("missing program: %+v", r)
	}
	// the environment of the agent does not leak into the command
	t.Setenv("MYCEL_LINK_TEST_SECRET", "x")
	r = runCommand(ctx, Command{Argv: []string{"/usr/bin/env"}, TimeoutSec: 5})
	if strings.Contains(r.Stdout, "MYCEL_LINK_TEST_SECRET") || !strings.Contains(r.Stdout, "PATH=/usr/local/sbin:") {
		t.Fatalf("env: %q", r.Stdout)
	}
}

func TestRunCommandTimeoutKillsTheGroup(t *testing.T) {
	dir := t.TempDir()
	mark := filepath.Join(dir, "child-alive")
	t0 := time.Now()
	// the grandchild would write the mark after 3 s if the kill missed it
	r := runCommand(context.Background(), Command{Argv: []string{"/bin/sh", "-c", "(sleep 3; touch " + mark + ") & sleep 30"}, TimeoutSec: 1})
	if !r.TimedOut || r.ExitCode != -1 {
		t.Fatalf("%+v", r)
	}
	if d := time.Since(t0); d > 8*time.Second {
		t.Fatalf("took %v", d)
	}
	time.Sleep(3500 * time.Millisecond)
	if _, err := os.Stat(mark); err == nil {
		t.Fatal("the grandchild was not killed")
	}
}

func TestRunCommandOutputLimits(t *testing.T) {
	// stdout over 1 MiB: hostd must see "over 1 MiB", also for multi-byte text (hostd counts UTF-16 units)
	r := runCommand(context.Background(), Command{Argv: []string{"/bin/sh", "-c", "head -c 1048577 /dev/zero | tr '\\0' x"}, TimeoutSec: 10})
	if len(r.Stdout) != stdoutMax+1 || r.Stdout != overLimit {
		t.Fatalf("stdout len %d", len(r.Stdout))
	}
	r = runCommand(context.Background(), Command{Argv: []string{"/bin/sh", "-c", "head -c 1048576 /dev/zero | tr '\\0' x"}, TimeoutSec: 10})
	if len(r.Stdout) != stdoutMax || strings.Trim(r.Stdout, "x") != "" {
		t.Fatalf("exactly 1 MiB: len %d", len(r.Stdout))
	}
	// stderr: the last 64 KiB
	r = runCommand(context.Background(), Command{Argv: []string{"/bin/sh", "-c", "head -c 200000 /dev/zero | tr '\\0' e >&2; echo END >&2"}, TimeoutSec: 10})
	if len(r.Stderr) != stderrMax || !strings.HasSuffix(r.Stderr, "END\n") {
		t.Fatalf("stderr len %d", len(r.Stderr))
	}
}

func TestEncodeResult(t *testing.T) {
	b := encodeResult(Result{ID: "a", Stdout: "<&>", Stderr: "e"})
	if string(b) != `{"id":"a","exitCode":0,"stdout":"<&>","stderr":"e","timedOut":false}` {
		t.Fatal(string(b))
	}
	// 1 MiB of control bytes is 6 MiB of JSON: over hostd's 3 MiB body limit, so it goes as "over 1 MiB"
	b = encodeResult(Result{ID: "a", Stdout: strings.Repeat("\x01", stdoutMax)})
	if len(b) > bodyMax {
		t.Fatalf("body %d", len(b))
	}
	var r Result
	json.Unmarshal(b, &r)
	if len(r.Stdout) <= stdoutMax {
		t.Fatal("not marked as over the limit")
	}
	// stderr cut at a rune boundary
	s := strings.Repeat("한", 30000)
	r = Result{}
	json.Unmarshal(encodeResult(Result{ID: "a", Stderr: s}), &r)
	if len(r.Stderr) > stderrMax || !strings.HasSuffix(s, r.Stderr) || strings.ContainsRune(r.Stderr, '\uFFFD') {
		t.Fatalf("stderr tail len %d", len(r.Stderr))
	}
}

// ---------------------------------------------------------------- files

func TestKeyIsMadeOnceWith0600(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	k1, err := loadOrMakeKey(filepath.Join(dir, keyFile))
	if err != nil {
		t.Fatal(err)
	}
	k2, err := loadOrMakeKey(filepath.Join(dir, keyFile))
	if err != nil || !k1.Equal(k2) {
		t.Fatal("key changed", err)
	}
	st, _ := os.Stat(filepath.Join(dir, keyFile))
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", st.Mode())
	}
}

func TestDropTokenKeepsTheOtherFields(t *testing.T) {
	p := filepath.Join(t.TempDir(), "link.json")
	os.WriteFile(p, []byte(`{"v":1,"tenantId":"T","url":"https://10.0.0.1:8443","pin":"P","token":"secret","x":true}`), 0o600)
	if err := dropToken(p); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p)
	var m map[string]any
	json.Unmarshal(b, &m)
	if _, ok := m["token"]; ok || m["tenantId"] != "T" || m["x"] != true || m["url"] != "https://10.0.0.1:8443" {
		t.Fatal(string(b))
	}
	if st, _ := os.Stat(p); st.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", st.Mode())
	}
}

// ---------------------------------------------------------------- the agent against a protocol fixture

// fixture: a small hostd stand-in with an ECDSA P-256 certificate that checks what hostd checks (token, signature,
// path, 60 s skew). It answers polls at once (no long poll).
type fixture struct {
	t   *testing.T
	srv *httptest.Server
	pin string

	mu         sync.Mutex
	token      string
	pubkey     string
	queue      []Command
	results    map[string]Result
	registers  int
	polls      int
	failResult int // answer 503 to this many result posts
	fail401    int // answer 401 to this many polls
	bootIDs    []string
}

func newFixture(t *testing.T) *fixture {
	f := &fixture{t: t, token: "tok-" + strconv.Itoa(int(time.Now().UnixNano())), results: map[string]Result{}}
	f.srv = httptest.NewUnstartedServer(http.HandlerFunc(f.handle))
	cert, pin := ecdsaCert(t)
	f.srv.TLS = &tls.Config{Certificates: []tls.Certificate{cert}}
	f.srv.StartTLS()
	f.pin = pin
	t.Cleanup(f.srv.Close)
	return f
}

func ecdsaCert(t *testing.T) (tls.Certificate, string) {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "ax-link"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &k.PublicKey, k)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := x509.ParseCertificate(der)
	h := sha256.Sum256(c.RawSubjectPublicKeyInfo)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: k}, base64.RawURLEncoding.EncodeToString(h[:])
}

func (f *fixture) handle(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	defer f.mu.Unlock()
	code := func(c int) { w.WriteHeader(c); w.Write([]byte(`{}`)) }
	if r.URL.Path == pathRegister {
		var b struct{ TenantID, Token, PublicKey, AgentVersion string }
		json.Unmarshal(body, &b)
		f.registers++
		if b.TenantID != "T1" {
			code(401)
			return
		}
		if f.pubkey != "" && f.pubkey == b.PublicKey {
			code(200)
			return
		}
		if f.token == "" || b.Token != f.token {
			code(401)
			return
		}
		f.pubkey, f.token = b.PublicKey, ""
		code(200)
		return
	}
	ts, _ := strconv.ParseInt(r.Header.Get("x-ax-ts"), 10, 64)
	sig, _ := base64.StdEncoding.DecodeString(r.Header.Get("x-ax-sig"))
	pub, _ := base64.StdEncoding.DecodeString(f.pubkey)
	if r.Header.Get("x-ax-tenant") != "T1" || len(pub) != ed25519.PublicKeySize || time.Since(time.UnixMilli(ts)).Abs() > 60*time.Second ||
		!ed25519.Verify(pub, []byte(signingString(r.Method, r.URL.Path, ts, body)), sig) {
		code(401)
		return
	}
	switch r.URL.Path {
	case pathPoll:
		f.polls++
		if f.fail401 > 0 {
			f.fail401--
			code(401)
			return
		}
		var b struct {
			BootID  string   `json:"bootId"`
			Running []string `json:"running"`
		}
		json.Unmarshal(body, &b)
		f.bootIDs = append(f.bootIDs, b.BootID)
		out, _ := json.Marshal(map[string]any{"cmds": f.queue})
		f.queue = nil
		w.Write(out)
	case pathResult:
		if f.failResult > 0 {
			f.failResult--
			code(503)
			return
		}
		var res Result
		json.Unmarshal(body, &res)
		f.results[res.ID] = res
		w.Write([]byte(`{"ok":true}`))
	default:
		code(404)
	}
}

func (f *fixture) push(c ...Command) { f.mu.Lock(); f.queue = append(f.queue, c...); f.mu.Unlock() }
func (f *fixture) result(id string) (Result, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	r, ok := f.results[id]
	return r, ok
}

func eventually(t *testing.T, what string, d time.Duration, ok func() bool) {
	t.Helper()
	end := time.Now().Add(d)
	for time.Now().Before(end) {
		if ok() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// syncBuf is a log sink shared by goroutines
type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.b.Write(p) }
func (s *syncBuf) String() string              { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

type env struct {
	dir, cfg, state, spool string
	log                    *syncBuf
}

func newEnv(t *testing.T, url, pin, token, tenant string) *env {
	d := t.TempDir()
	e := &env{dir: d, cfg: filepath.Join(d, "link.json"), state: filepath.Join(d, "state"), spool: filepath.Join(d, "run"), log: &syncBuf{}}
	b, _ := json.Marshal(LinkFile{V: 1, TenantID: tenant, URL: url, Pin: pin, Token: token})
	if err := os.WriteFile(e.cfg, b, 0o600); err != nil {
		t.Fatal(err)
	}
	return e
}

func (e *env) opts(boot string) Options {
	return Options{ConfigFile: e.cfg, StateDir: e.state, SpoolDir: e.spool, Log: slog.New(slog.NewTextHandler(e.log, nil)), BootID: func() string { return boot }}
}

// start runs an agent until the test ends (or stop is called)
func start(t *testing.T, o Options) (stop func()) {
	t.Helper()
	a, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { a.Run(ctx); close(done) }()
	var once sync.Once
	stop = func() { once.Do(func() { cancel(); <-done }) }
	t.Cleanup(stop)
	return stop
}

func echoRun(_ context.Context, c Command) Result {
	in := ""
	if c.Stdin != nil {
		in = *c.Stdin
	}
	return Result{ExitCode: 0, Stdout: "ran " + strings.Join(c.Argv, " ") + " " + in}
}

func TestAgentRegistersRunsAndReports(t *testing.T) {
	f := newFixture(t)
	e := newEnv(t, f.srv.URL, f.pin, f.token, "T1")
	o := e.opts("boot-1")
	o.Run = echoRun
	token := f.token
	start(t, o)
	eventually(t, "register", 5*time.Second, func() bool { f.mu.Lock(); defer f.mu.Unlock(); return f.pubkey != "" && f.polls > 0 })
	// the spent token is gone from link.json
	b, _ := os.ReadFile(e.cfg)
	if strings.Contains(string(b), token) || !strings.Contains(string(b), f.pin) {
		t.Fatalf("link.json after register: %s", b)
	}
	f.push(Command{ID: "c-1", Argv: []string{mycelCtl, "status", "--json"}, Stdin: str("STDIN-SECRET"), TimeoutSec: 10},
		Command{ID: "c-2", Argv: []string{"/bin/sh", "-c", "id"}, TimeoutSec: 10},
		Command{ID: "c-1", Argv: []string{mycelCtl, "status", "--json"}, TimeoutSec: 10}, // a duplicate in the same answer
		Command{ID: "../x", Argv: []string{mycelCtl}, TimeoutSec: 10})
	eventually(t, "results", 5*time.Second, func() bool { _, a := f.result("c-1"); _, b := f.result("c-2"); return a && b })
	if r, _ := f.result("c-1"); r.Stdout != "ran "+mycelCtl+" status --json STDIN-SECRET" || r.ExitCode != 0 {
		t.Fatalf("c-1: %+v", r)
	}
	if r, _ := f.result("c-2"); r.ExitCode != 126 {
		t.Fatalf("not allowed: %+v", r)
	}
	if _, ok := f.result("../x"); ok {
		t.Fatal("a bad id ran")
	}
	eventually(t, "spool empty", 2*time.Second, func() bool { ents, _ := os.ReadDir(e.spool); return len(ents) == 0 })
	f.mu.Lock()
	if f.bootIDs[0] != "boot-1" {
		t.Fatalf("boot id %q", f.bootIDs[0])
	}
	f.mu.Unlock()
	log := e.log.String()
	for _, s := range []string{token, "STDIN-SECRET", "ran ", "status --json"} {
		if strings.Contains(log, s) {
			t.Fatalf("log holds %q:\n%s", s, log)
		}
	}
	if !strings.Contains(log, "ax-link online") || !strings.Contains(log, "mycel-ctl status") {
		t.Fatalf("log:\n%s", log)
	}
}

func TestResultIsSpooledAndSentAgain(t *testing.T) {
	f := newFixture(t)
	f.failResult = 2
	e := newEnv(t, f.srv.URL, f.pin, f.token, "T1")
	o := e.opts("b")
	gate := make(chan struct{})
	o.Run = func(ctx context.Context, c Command) Result { <-gate; return echoRun(ctx, c) }
	stop := start(t, o)
	f.push(Command{ID: "c-9", Argv: []string{mycelCtl, "x"}, TimeoutSec: 10})
	close(gate)
	// the first post fails (503): the result waits in the spool, 0600
	eventually(t, "spool file", 5*time.Second, func() bool { _, err := os.Stat(filepath.Join(e.spool, "c-9"+resultSuffix)); return err == nil })
	st, _ := os.Stat(filepath.Join(e.spool, "c-9"+resultSuffix))
	if st != nil && st.Mode().Perm() != 0o600 {
		t.Fatalf("spool mode %v", st.Mode())
	}
	// the agent restarts before hostd took it; the new process sends it from the spool
	stop()
	if _, ok := f.result("c-9"); ok {
		t.Skip("the result went through before the restart (timing)")
	}
	f.mu.Lock()
	f.failResult = 0
	f.mu.Unlock()
	o2 := e.opts("b")
	o2.Run = func(context.Context, Command) Result { t.Error("ran again"); return Result{} }
	start(t, o2)
	eventually(t, "result after restart", 10*time.Second, func() bool { _, ok := f.result("c-9"); return ok })
	eventually(t, "spool empty", 2*time.Second, func() bool { ents, _ := os.ReadDir(e.spool); return len(ents) == 0 })
}

func TestPollUnauthorizedRegistersAgain(t *testing.T) {
	f := newFixture(t)
	f.fail401 = 1
	e := newEnv(t, f.srv.URL, f.pin, f.token, "T1")
	start(t, e.opts("b"))
	// register (token) → poll 401 → register again (same key, no token) → poll ok
	eventually(t, "second register", 10*time.Second, func() bool { f.mu.Lock(); defer f.mu.Unlock(); return f.registers >= 2 && f.polls >= 2 })
}

func TestWrongPinNeverTalks(t *testing.T) {
	f := newFixture(t)
	_, other := ecdsaCert(t)
	e := newEnv(t, f.srv.URL, other, f.token, "T1")
	start(t, e.opts("b"))
	time.Sleep(1500 * time.Millisecond)
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.registers != 0 {
		t.Fatal("the agent sent a request to a server with another key")
	}
	if !strings.Contains(e.log.String(), "does not match the pin") {
		t.Fatalf("log:\n%s", e.log.String())
	}
	b, _ := os.ReadFile(e.cfg)
	if !strings.Contains(string(b), f.token) {
		t.Fatal("token removed without a register")
	}
}

func TestBadLinkFile(t *testing.T) {
	d := t.TempDir()
	for _, s := range []string{`{}`, `{"v":2,"tenantId":"T","url":"https://a:1","pin":"x"}`, `{"v":1,"tenantId":"T","url":"http://a:1","pin":"` + strings.Repeat("A", 43) + `"}`, `{"v":1,"tenantId":"T","url":"https://a:1","pin":"short"}`} {
		p := filepath.Join(d, "link.json")
		os.WriteFile(p, []byte(s), 0o600)
		if _, err := New(Options{ConfigFile: p, StateDir: d, SpoolDir: d}); err == nil {
			t.Errorf("accepted %s", s)
		}
	}
}

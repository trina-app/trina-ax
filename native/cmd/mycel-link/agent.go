package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	mrand "math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// protocol constants (hostd link.ts)
const (
	pathRegister = "/link/v1/register"
	pathPoll     = "/link/v1/poll"
	pathResult   = "/link/v1/result"
	// LINK_AGENT_PARALLEL
	maxParallel = 4
	// hostd keeps the poll open up to 25 s
	pollTimeout  = 45 * time.Second
	callTimeout  = 30 * time.Second
	respMax      = 16 << 20
	backoffMin   = time.Second
	backoffMax   = 30 * time.Second
	minPollEvery = time.Second
	keyFile      = "key"
	resultSuffix = ".result.json"
	doneKeep     = 256
)

// cmd ids become file names in the spool; hostd sends UUIDs
var cmdIDRe = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

// LinkFile is /etc/ax/link.json (hostd driver.ts LinkFile)
type LinkFile struct {
	V        int    `json:"v"`
	TenantID string `json:"tenantId"`
	URL      string `json:"url"`
	Pin      string `json:"pin"`
	Token    string `json:"token,omitempty"`
}

// Command is one entry of the poll answer
type Command struct {
	ID         string   `json:"id"`
	Argv       []string `json:"argv"`
	Stdin      *string  `json:"stdin"`
	TimeoutSec float64  `json:"timeoutSec"`
}

// Result is the body of /link/v1/result
type Result struct {
	ID       string `json:"id"`
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	TimedOut bool   `json:"timedOut"`
}

// Options of one agent. Tests set the hooks; main sets only the paths and the logger.
type Options struct {
	ConfigFile string
	StateDir   string
	SpoolDir   string
	Log        *slog.Logger
	// nil: the production allow-list (allow.go)
	Allow func(argv []string) bool
	// nil: /proc/sys/kernel/random/boot_id
	BootID func() string
	// nil: time.Now
	Now func() time.Time
	// nil: runCommand (exec.go)
	Run func(ctx context.Context, c Command) Result
}

// Agent is one mycel-link process
type Agent struct {
	o      Options
	cfg    LinkFile
	key    ed25519.PrivateKey
	pubB64 string
	base   *url.URL
	client *http.Client
	bootID string

	mu      sync.Mutex
	running map[string]bool   // ids that run now (sent in each poll)
	pending map[string][]byte // results not yet sent (also in the spool)
	done    map[string]bool   // ids sent lately (doneKeep): a command id never runs twice in one process
	doneIDs []string
	kick    chan struct{}
	sem     chan struct{}
	wg      sync.WaitGroup
}

// New reads link.json and the key (it makes the key on the first start)
func New(o Options) (*Agent, error) {
	if o.Log == nil {
		o.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if o.Allow == nil {
		o.Allow = allowed
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Run == nil {
		o.Run = runCommand
	}
	if o.BootID == nil {
		o.BootID = systemBootID
	}
	cfg, err := readLinkFile(o.ConfigFile)
	if err != nil {
		return nil, err
	}
	base, err := url.Parse(strings.TrimRight(cfg.URL, "/"))
	if err != nil || base.Scheme != "https" || base.Host == "" {
		return nil, fmt.Errorf("link.json: url must be https://host:port")
	}
	pin, err := base64.RawURLEncoding.DecodeString(cfg.Pin)
	if err != nil || len(pin) != sha256.Size {
		return nil, fmt.Errorf("link.json: pin must be base64url of 32 bytes")
	}
	key, err := loadOrMakeKey(filepath.Join(o.StateDir, keyFile))
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(o.SpoolDir, 0o700); err != nil {
		return nil, fmt.Errorf("spool dir: %w", err)
	}
	a := &Agent{
		o: o, cfg: cfg, key: key, base: base,
		pubB64:  base64.StdEncoding.EncodeToString(key.Public().(ed25519.PublicKey)),
		client:  pinnedClient(pin),
		bootID:  o.BootID(),
		running: map[string]bool{},
		pending: map[string][]byte{},
		done:    map[string]bool{},
		kick:    make(chan struct{}, 1),
		sem:     make(chan struct{}, maxParallel),
	}
	return a, nil
}

func readLinkFile(p string) (LinkFile, error) {
	var f LinkFile
	b, err := os.ReadFile(p)
	if err != nil {
		return f, fmt.Errorf("link.json: %w", err)
	}
	if err := json.Unmarshal(b, &f); err != nil {
		return f, fmt.Errorf("link.json: not valid JSON")
	}
	if f.V != 1 || f.TenantID == "" || f.URL == "" || f.Pin == "" {
		return f, fmt.Errorf("link.json: needs v 1, tenantId, url and pin")
	}
	return f, nil
}

// dropToken removes the spent token from link.json and keeps every other field
func dropToken(p string) error {
	b, err := os.ReadFile(p)
	if err != nil {
		return err
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		return err
	}
	if _, ok := m["token"]; !ok {
		return nil
	}
	delete(m, "token")
	out, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return writeFileAtomic(p, append(out, '\n'))
}

// writeFileAtomic writes a 0600 file through a temp file and a rename
func writeFileAtomic(p string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(p), "."+filepath.Base(p)+".*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	ok := false
	defer func() {
		if !ok {
			os.Remove(name)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, p); err != nil {
		return err
	}
	ok = true
	return nil
}

// loadOrMakeKey: PKCS#8 PEM, root 0600
func loadOrMakeKey(p string) (ed25519.PrivateKey, error) {
	if b, err := os.ReadFile(p); err == nil {
		blk, _ := pem.Decode(b)
		if blk == nil {
			return nil, fmt.Errorf("agent key %s: not PEM", p)
		}
		k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
		if err != nil {
			return nil, fmt.Errorf("agent key %s: %w", p, err)
		}
		ek, ok := k.(ed25519.PrivateKey)
		if !ok {
			return nil, fmt.Errorf("agent key %s: not Ed25519", p)
		}
		return ek, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("agent key: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return nil, fmt.Errorf("state dir: %w", err)
	}
	_, k, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(k)
	if err != nil {
		return nil, err
	}
	if err := writeFileAtomic(p, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})); err != nil {
		return nil, fmt.Errorf("agent key: %w", err)
	}
	return k, nil
}

// pinnedClient trusts exactly one server key: SHA-256 of the certificate's SubjectPublicKeyInfo. Any key type.
// No proxy from the environment: the link goes straight to the hostd box.
func pinnedClient(pin []byte) *http.Client {
	tc := &tls.Config{
		MinVersion: tls.VersionTLS13,
		// the chain and the name are not checked; VerifyConnection checks the pin (it runs also with this flag)
		InsecureSkipVerify: true,
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return errors.New("ax-link: no server certificate")
			}
			h := sha256.Sum256(cs.PeerCertificates[0].RawSubjectPublicKeyInfo)
			if subtle.ConstantTimeCompare(h[:], pin) != 1 {
				return errors.New("ax-link: server key does not match the pin")
			}
			return nil
		},
	}
	return &http.Client{
		Transport: &http.Transport{
			Proxy:               nil,
			TLSClientConfig:     tc,
			TLSHandshakeTimeout: 15 * time.Second,
			MaxIdleConnsPerHost: 4,
			IdleConnTimeout:     90 * time.Second,
		},
		// never follow a redirect: a 307 or 308 sends the body (the token) and the signed headers again, and an http://
		// target has no TLS, so no pin. A 3xx is not 200, so post returns an error.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

func systemBootID() string {
	if b, err := os.ReadFile("/proc/sys/kernel/random/boot_id"); err == nil {
		if s := strings.TrimSpace(string(b)); s != "" {
			return s
		}
	}
	// not Linux: one id per process
	var r [16]byte
	rand.Read(r[:])
	return hex.EncodeToString(r[:])
}

// signingString: "ax-link-v1\n" + method + "\n" + path + "\n" + ts + "\n" + sha256hex(body)
func signingString(method, path string, ts int64, body []byte) string {
	h := sha256.Sum256(body)
	return "ax-link-v1\n" + strings.ToUpper(method) + "\n" + path + "\n" + strconv.FormatInt(ts, 10) + "\n" + hex.EncodeToString(h[:])
}

type httpError struct{ status int }

func (e *httpError) Error() string { return "ax-link: HTTP " + strconv.Itoa(e.status) }

func statusOf(err error) int {
	var he *httpError
	if errors.As(err, &he) {
		return he.status
	}
	return 0
}

// post sends one JSON body. signed: x-ax-tenant, x-ax-ts (Unix ms), x-ax-sig (base64 Ed25519). Status 200 only.
func (a *Agent) post(ctx context.Context, p string, body []byte, signed bool, timeout time.Duration) ([]byte, error) {
	u := *a.base
	u.Path = strings.TrimRight(a.base.Path, "/") + p
	u.RawPath = ""
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("user-agent", "mycel-link/"+agentVersion)
	if signed {
		ts := a.o.Now().UnixMilli()
		sig := ed25519.Sign(a.key, []byte(signingString(http.MethodPost, u.EscapedPath(), ts, body)))
		req.Header.Set("x-ax-tenant", a.cfg.TenantID)
		req.Header.Set("x-ax-ts", strconv.FormatInt(ts, 10))
		req.Header.Set("x-ax-sig", base64.StdEncoding.EncodeToString(sig))
	}
	res, err := a.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	out, err := io.ReadAll(io.LimitReader(res.Body, respMax))
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		return nil, &httpError{res.StatusCode}
	}
	return out, nil
}

func (a *Agent) register(ctx context.Context) error {
	body, _ := json.Marshal(map[string]any{"tenantId": a.cfg.TenantID, "token": a.cfg.Token, "publicKey": a.pubB64, "agentVersion": agentVersion})
	if _, err := a.post(ctx, pathRegister, body, false, callTimeout); err != nil {
		return err
	}
	if a.cfg.Token != "" {
		// hostd cleared the token hash; the token is no use any more, so it does not stay on disk
		if err := dropToken(a.o.ConfigFile); err != nil {
			a.o.Log.Warn("cannot remove the spent token from link.json", "error", err.Error())
		} else {
			a.cfg.Token = ""
		}
	}
	return nil
}

func (a *Agent) poll(ctx context.Context) ([]Command, error) {
	a.mu.Lock()
	ids := make([]string, 0, len(a.running))
	for id := range a.running {
		ids = append(ids, id)
	}
	a.mu.Unlock()
	sort.Strings(ids)
	body, _ := json.Marshal(map[string]any{"bootId": a.bootID, "running": ids})
	out, err := a.post(ctx, pathPoll, body, true, pollTimeout)
	if err != nil {
		return nil, err
	}
	var r struct {
		Cmds []Command `json:"cmds"`
	}
	if err := json.Unmarshal(out, &r); err != nil {
		return nil, fmt.Errorf("ax-link: bad poll answer")
	}
	return r.Cmds, nil
}

type backoff struct{ d time.Duration }

func (b *backoff) next() time.Duration {
	if b.d == 0 {
		b.d = backoffMin
	} else {
		b.d = min(b.d*2, backoffMax)
	}
	// +-20 %
	return time.Duration(float64(b.d) * (0.8 + 0.4*mrand.Float64()))
}
func (b *backoff) reset() { b.d = 0 }

func sleepCtx(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

// Run registers, then polls until ctx ends. Errors only for a broken spool; network errors are retried.
func (a *Agent) Run(ctx context.Context) error {
	if err := a.loadSpool(); err != nil {
		return err
	}
	a.wg.Add(1)
	go func() { defer a.wg.Done(); a.sender(ctx) }()
	defer a.wg.Wait()
	var bo backoff
	registered := false
	up := false
	lastErr := ""
	fail := func(what string, err error) {
		// one line per new kind of error, not one per retry
		msg := what + ": " + err.Error()
		if up || msg != lastErr {
			a.o.Log.Warn("ax-link "+what+" failed", "error", err.Error())
		}
		up = false
		lastErr = msg
		sleepCtx(ctx, bo.next())
	}
	a.o.Log.Info("mycel-link starting", "version", agentVersion, "tenantId", a.cfg.TenantID, "url", a.base.Host)
	for ctx.Err() == nil {
		if !registered {
			if err := a.register(ctx); err != nil {
				if ctx.Err() != nil {
					break
				}
				fail("register", err)
				continue
			}
			registered = true
		}
		start := time.Now()
		cmds, err := a.poll(ctx)
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			if statusOf(err) == http.StatusUnauthorized {
				// hostd does not know this key (or the clock is off): register again; it is idempotent
				registered = false
			}
			fail("poll", err)
			continue
		}
		bo.reset()
		if !up {
			a.o.Log.Info("ax-link online", "bootId", a.bootID)
			up = true
			lastErr = ""
		}
		for _, c := range cmds {
			a.accept(ctx, c)
		}
		// a hostd that answers at once (no long poll) must not make a busy loop
		if len(cmds) == 0 && time.Since(start) < minPollEvery {
			sleepCtx(ctx, minPollEvery-time.Since(start))
		}
	}
	return nil
}

// accept starts one command from a poll. An id that runs or waits to be sent is skipped (hostd sent it again).
func (a *Agent) accept(ctx context.Context, c Command) {
	if !cmdIDRe.MatchString(c.ID) {
		a.o.Log.Warn("ax-link command with a bad id skipped")
		return
	}
	a.mu.Lock()
	if _, waits := a.pending[c.ID]; a.running[c.ID] || waits || a.done[c.ID] {
		a.mu.Unlock()
		return
	}
	a.running[c.ID] = true
	a.mu.Unlock()
	if !a.o.Allow(c.Argv) {
		a.o.Log.Warn("ax-link command not allowed", "id", c.ID, "cmd", cmdName(c.Argv))
		a.finish(ctx, Result{ID: c.ID, ExitCode: 126, Stderr: "mycel-link: command not allowed\n"})
		return
	}
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		select {
		case a.sem <- struct{}{}:
		case <-ctx.Done():
			return
		}
		defer func() { <-a.sem }()
		t0 := time.Now()
		r := a.o.Run(ctx, c)
		r.ID = c.ID
		if ctx.Err() != nil {
			// the agent stops: no result; hostd times the command out (a reboot makes it send the command again)
			return
		}
		a.o.Log.Info("ax-link command done", "id", c.ID, "cmd", cmdName(c.Argv), "exitCode", r.ExitCode, "timedOut", r.TimedOut, "ms", time.Since(t0).Milliseconds())
		a.finish(ctx, r)
	}()
}

// finish puts the result in the spool first, then marks it pending for the sender
func (a *Agent) finish(ctx context.Context, r Result) {
	b := encodeResult(r)
	if err := writeFileAtomic(filepath.Join(a.o.SpoolDir, r.ID+resultSuffix), b); err != nil {
		a.o.Log.Warn("ax-link cannot spool a result; it is sent from memory only", "id", r.ID, "error", err.Error())
	}
	a.mu.Lock()
	delete(a.running, r.ID)
	a.pending[r.ID] = b
	a.mu.Unlock()
	a.wake()
}

func (a *Agent) wake() {
	select {
	case a.kick <- struct{}{}:
	default:
	}
}

// loadSpool marks the results of an earlier process (same boot) as pending
func (a *Agent) loadSpool() error {
	ents, err := os.ReadDir(a.o.SpoolDir)
	if err != nil {
		return fmt.Errorf("spool dir: %w", err)
	}
	for _, e := range ents {
		id, ok := strings.CutSuffix(e.Name(), resultSuffix)
		if !ok || !e.Type().IsRegular() || !cmdIDRe.MatchString(id) {
			continue
		}
		b, err := os.ReadFile(filepath.Join(a.o.SpoolDir, e.Name()))
		if err != nil {
			return fmt.Errorf("spool: %w", err)
		}
		a.pending[id] = b
	}
	return nil
}

// sender posts pending results until hostd answers 200
func (a *Agent) sender(ctx context.Context) {
	var bo backoff
	for ctx.Err() == nil {
		a.mu.Lock()
		ids := make([]string, 0, len(a.pending))
		for id := range a.pending {
			ids = append(ids, id)
		}
		a.mu.Unlock()
		sort.Strings(ids)
		failed := false
		for _, id := range ids {
			if ctx.Err() != nil {
				return
			}
			a.mu.Lock()
			body := a.pending[id]
			a.mu.Unlock()
			_, err := a.post(ctx, pathResult, body, true, callTimeout)
			switch st := statusOf(err); {
			case err == nil:
				a.sent(id)
			case st == http.StatusBadRequest || st == http.StatusRequestEntityTooLarge || st == http.StatusNotFound:
				// hostd will never take this body: drop it, hostd times the command out
				a.o.Log.Warn("ax-link result refused by hostd", "id", id, "status", st)
				a.sent(id)
			default:
				if ctx.Err() == nil {
					a.o.Log.Warn("ax-link result not sent; will retry", "id", id, "error", err.Error())
				}
				failed = true
			}
			if failed {
				break
			}
		}
		if failed {
			sleepCtx(ctx, bo.next())
			continue
		}
		bo.reset()
		select {
		case <-ctx.Done():
			return
		case <-a.kick:
		}
	}
}

func (a *Agent) sent(id string) {
	os.Remove(filepath.Join(a.o.SpoolDir, id+resultSuffix))
	a.mu.Lock()
	delete(a.pending, id)
	a.done[id] = true
	a.doneIDs = append(a.doneIDs, id)
	if len(a.doneIDs) > doneKeep {
		delete(a.done, a.doneIDs[0])
		a.doneIDs = a.doneIDs[1:]
	}
	a.mu.Unlock()
}

// cmdName is what the log shows of an argv: the program, and the mycel-ctl sub-command. Never the other args.
func cmdName(argv []string) string {
	if len(argv) == 0 {
		return ""
	}
	n := filepath.Base(argv[0])
	if argv[0] == mycelCtl && len(argv) > 1 && safeWord.MatchString(argv[1]) {
		n += " " + argv[1]
	}
	return n
}

var safeWord = regexp.MustCompile(`^[a-z][a-z0-9-]{0,40}$`)

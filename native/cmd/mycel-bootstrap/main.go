// mycel-bootstrap: starts and supervises the server (design tab 6 "부트스트랩(시작 확인·되돌리기)").
//
// The server LaunchDaemon runs THIS program (root-owned file in <base>/root/, run as the server account), never the
// server directly. Before every start it checks the version app/current points to: manifest.json must list every
// file of the version folder with its sha256 (and, with release keys, carry a valid Ed25519 signature), so a
// compromised server cannot make a code change permanent by editing app/versions/ (it can write there).
//
// Updates without root: the server unpacks a new version, writes app/state.json {pending: <new>}, points app/current
// at it and exits. The bootstrap then starts the new version and watches it: if /api/health does not answer ok with
// that version within --health-timeout, or the new version dies --max-attempts times before that, app/current goes
// back to state.previous and the failure is recorded in state.json history (the server reports it in the UI).
// Normal crashes restart after 1 s; more than 5 crashes in 5 minutes back off 1, 2, 4 ... 60 s. launchd's KeepAlive
// only restarts the bootstrap itself.
package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type multi []string

func (m *multi) String() string     { return strings.Join(*m, ",") }
func (m *multi) Set(v string) error { *m = append(*m, v); return nil }

var (
	appDir        = flag.String("app", "", "<base>/app (versions/, current, state.json)")
	configFile    = flag.String("config", "", "server.json (passed to the server as MYCEL_CONFIG; listen address for the health check)")
	healthTimeout = flag.Duration("health-timeout", 120*time.Second, "a pending update must answer /api/health within this time")
	maxAttempts   = flag.Int("max-attempts", 3, "a pending update that dies this many times before it is healthy is rolled back")
	allowUnsigned = flag.Bool("allow-unsigned", false, "accept versions without manifest.sig (development and test installs; no release key exists yet)")
	updateLog     = flag.String("update-log", "", "append update / roll-back events here (JSON lines)")
	pubkeys       multi
)

// ---------- state.json (shared/src/install.ts AppState) ----------

type historyEntry struct {
	At     string  `json:"at"`
	From   *string `json:"from"`
	To     string  `json:"to"`
	Result string  `json:"result"`
	Detail *string `json:"detail"`
}

type appState struct {
	Format       int            `json:"format"`
	Current      *string        `json:"current"`
	Previous     *string        `json:"previous"`
	Pending      *string        `json:"pending"`
	PendingSince *string        `json:"pendingSince"`
	Attempts     int            `json:"attempts"`
	History      []historyEntry `json:"history"`
}

func sp(s string) *string { return &s }
func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func statePath() string { return filepath.Join(*appDir, "state.json") }

func readState() appState {
	st := appState{Format: 1, History: []historyEntry{}}
	b, err := os.ReadFile(statePath())
	if err != nil {
		return st
	}
	if json.Unmarshal(b, &st) != nil {
		logf("state.json unreadable, starting from an empty state")
		return appState{Format: 1, History: []historyEntry{}}
	}
	if st.History == nil {
		st.History = []historyEntry{}
	}
	st.Format = 1
	return st
}

func writeState(st appState) error {
	if len(st.History) > 50 {
		st.History = st.History[len(st.History)-50:]
	}
	b, _ := json.MarshalIndent(st, "", "  ")
	tmp := statePath() + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o640); err != nil {
		return err
	}
	return os.Rename(tmp, statePath())
}

func record(st *appState, from *string, to, result, detail string) {
	var d *string
	if detail != "" {
		d = sp(detail)
	}
	e := historyEntry{At: time.Now().UTC().Format(time.RFC3339Nano), From: from, To: to, Result: result, Detail: d}
	st.History = append(st.History, e)
	if *updateLog != "" {
		if f, err := os.OpenFile(*updateLog, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o640); err == nil {
			line, _ := json.Marshal(map[string]any{"t": e.At, "level": "warn", "msg": "update " + result, "from": from, "to": to, "detail": d})
			_, _ = f.Write(append(line, '\n'))
			_ = f.Close()
		}
	}
	logf("update %s: %s -> %s %s", result, str(from), to, detail)
}

// ---------- app/current ----------

// a version is a folder name in app/versions/ (shared/src/install.ts BundleManifest.version), never a path
var versionRe = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z.+_-]{0,49}$`)

func validVersion(v string) bool { return versionRe.MatchString(v) && v != "." && v != ".." }

func currentVersion() (string, error) {
	t, err := os.Readlink(filepath.Join(*appDir, "current"))
	if err != nil {
		return "", err
	}
	v := filepath.Base(t)
	if !validVersion(v) {
		return "", fmt.Errorf("app/current points to %q, not a version folder", t)
	}
	if filepath.Clean(t) != filepath.Join("versions", v) && filepath.Clean(t) != filepath.Join(*appDir, "versions", v) {
		return "", fmt.Errorf("app/current points outside versions/: %s", t)
	}
	return v, nil
}

func switchTo(v string) error {
	if !validVersion(v) {
		return fmt.Errorf("not a version name: %q", v)
	}
	tmp := filepath.Join(*appDir, fmt.Sprintf(".current-%d", os.Getpid()))
	_ = os.Remove(tmp)
	if err := os.Symlink(filepath.Join("versions", v), tmp); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(*appDir, "current"))
}

// ---------- manifest ----------

type manifest struct {
	Format  int    `json:"format"`
	Version string `json:"version"`
	Files   map[string]struct {
		Sha256 string `json:"sha256"`
		Size   int64  `json:"size"`
		Mode   int    `json:"mode"`
	} `json:"files"`
}

func keyID(pub []byte) string { h := sha256.Sum256(pub); return hex.EncodeToString(h[:8]) }

func verifyVersion(v string) error {
	if !validVersion(v) {
		return fmt.Errorf("not a version name: %q", v)
	}
	dir := filepath.Join(*appDir, "versions", v)
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return fmt.Errorf("manifest: %v", err)
	}
	var m manifest
	if err := json.Unmarshal(raw, &m); err != nil || m.Format != 1 {
		return fmt.Errorf("manifest: not a format-1 manifest")
	}
	if m.Version != v {
		return fmt.Errorf("manifest says version %q, folder is %q", m.Version, v)
	}
	if err := verifySignature(dir, raw); err != nil {
		return err
	}
	seen := map[string]bool{}
	err = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		rel = filepath.ToSlash(rel)
		if rel == "." || rel == "manifest.json" || rel == "manifest.sig" {
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return fmt.Errorf("symlink in bundle: %s", rel)
		}
		if d.IsDir() {
			return nil
		}
		if !d.Type().IsRegular() {
			return fmt.Errorf("not a regular file: %s", rel)
		}
		want, ok := m.Files[rel]
		if !ok {
			return fmt.Errorf("file not in manifest: %s", rel)
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		h := sha256.New()
		n, err := io.Copy(h, f)
		f.Close()
		if err != nil {
			return err
		}
		if n != want.Size || hex.EncodeToString(h.Sum(nil)) != want.Sha256 {
			return fmt.Errorf("file changed since release: %s", rel)
		}
		seen[rel] = true
		return nil
	})
	if err != nil {
		return err
	}
	for rel := range m.Files {
		if !seen[rel] {
			return fmt.Errorf("file missing: %s", rel)
		}
	}
	return nil
}

func verifySignature(dir string, raw []byte) error {
	sigRaw, err := os.ReadFile(filepath.Join(dir, "manifest.sig"))
	if errors.Is(err, fs.ErrNotExist) {
		if *allowUnsigned {
			return nil
		}
		return fmt.Errorf("manifest.sig missing (unsigned bundle)")
	}
	if err != nil {
		return err
	}
	var s struct {
		KeyID string `json:"keyId"`
		Sig   string `json:"sig"`
	}
	if json.Unmarshal(sigRaw, &s) != nil {
		return fmt.Errorf("manifest.sig unreadable")
	}
	sig, err := base64.StdEncoding.DecodeString(s.Sig)
	if err != nil {
		return fmt.Errorf("manifest.sig unreadable")
	}
	for _, k := range pubkeys {
		pub, err := base64.StdEncoding.DecodeString(k)
		if err != nil || len(pub) != ed25519.PublicKeySize || keyID(pub) != s.KeyID {
			continue
		}
		if ed25519.Verify(pub, raw, sig) {
			return nil
		}
		return fmt.Errorf("manifest signature does not verify")
	}
	if len(pubkeys) == 0 && *allowUnsigned {
		return nil // no release key configured (test install): integrity only
	}
	return fmt.Errorf("manifest signed by an unknown key %s", s.KeyID)
}

// ---------- health ----------

type serverConfig struct {
	Listen struct {
		Host string `json:"host"`
		Port int    `json:"port"`
	} `json:"listen"`
}

func healthURL() string {
	host, port := "127.0.0.1", 19100
	if b, err := os.ReadFile(*configFile); err == nil {
		var c serverConfig
		if json.Unmarshal(b, &c) == nil {
			if c.Listen.Port > 0 {
				port = c.Listen.Port
			}
			if c.Listen.Host != "" && c.Listen.Host != "0.0.0.0" && c.Listen.Host != "::" {
				host = c.Listen.Host
			}
		}
	}
	return fmt.Sprintf("http://%s:%d/api/health", host, port)
}

func healthy(url, version string) bool {
	cl := http.Client{Timeout: 3 * time.Second}
	r, err := cl.Get(url)
	if err != nil {
		return false
	}
	defer r.Body.Close()
	var h struct {
		Ok      bool   `json:"ok"`
		Version string `json:"version"`
	}
	b, _ := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	return r.StatusCode == 200 && json.Unmarshal(b, &h) == nil && h.Ok && h.Version == version
}

// ---------- supervision ----------

func logf(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "%s mycel-bootstrap: %s\n", time.Now().UTC().Format(time.RFC3339), fmt.Sprintf(format, a...))
}

func startServer(v string) (*exec.Cmd, error) {
	dir := filepath.Join(*appDir, "versions", v)
	cmd := exec.Command(filepath.Join(dir, "bin", "bun"), filepath.Join(dir, "server", "src", "main.js"), "--prod")
	cmd.Dir = dir
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	// MYCEL_SUPERVISOR_PID: the server ends itself when this process is gone (it is not in our process group)
	cmd.Env = append(os.Environ(), "MYCEL_MODE=prod", "MYCEL_CONFIG="+*configFile, "MYCEL_NATIVE_BIN="+filepath.Join(dir, "native"),
		"MYCEL_SUPERVISOR_PID="+strconv.Itoa(os.Getpid()))
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return cmd, cmd.Start()
}

var stopping = make(chan os.Signal, 1)

// stop the child: SIGTERM to its process group, SIGKILL after 20 s
func stopChild(cmd *exec.Cmd, done <-chan error) {
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		<-done
	}
}

// rollBack points app/current back at state.previous after a failed update; returns false when there is nothing to
// go back to.
func rollBack(st *appState, failed, why string) bool {
	st.Pending, st.PendingSince, st.Attempts = nil, nil, 0
	prev := str(st.Previous)
	if prev == "" || prev == failed {
		record(st, sp(failed), failed, "rolled_back", why+"; no previous version to go back to")
		_ = writeState(*st)
		return false
	}
	if err := verifyVersion(prev); err != nil {
		record(st, sp(failed), prev, "rolled_back", why+"; previous version does not verify either: "+err.Error())
		_ = writeState(*st)
		return false
	}
	if err := switchTo(prev); err != nil {
		record(st, sp(failed), prev, "rolled_back", why+"; could not switch back: "+err.Error())
		_ = writeState(*st)
		return false
	}
	// the failed version stays in versions/ for diagnosis but is not offered as a roll-back target
	st.Current, st.Previous = sp(prev), nil
	record(st, sp(failed), prev, "rolled_back", why)
	_ = writeState(*st)
	return true
}

func main() {
	flag.Var(&pubkeys, "pubkey", "release public key, base64 Ed25519 (repeatable: current + spare)")
	flag.Parse()
	if *appDir == "" || *configFile == "" {
		fmt.Fprintln(os.Stderr, "usage: mycel-bootstrap --app <base>/app --config <server.json> [--allow-unsigned] [--pubkey K]...")
		os.Exit(2)
	}
	signal.Notify(stopping, syscall.SIGTERM, syscall.SIGINT)
	url := healthURL()
	var crashes []time.Time
	for {
		st := readState()
		v, err := currentVersion()
		if err != nil {
			logf("no usable app/current: %v", err)
			sleepOrStop(30 * time.Second)
			os.Exit(1)
		}
		pending := str(st.Pending) == v
		if err := verifyVersion(v); err != nil {
			logf("version %s does not verify: %v", v, err)
			if pending || str(st.Previous) != "" {
				if rollBack(&st, v, "verify failed: "+err.Error()) {
					continue
				}
			}
			sleepOrStop(30 * time.Second)
			os.Exit(1)
		}
		if st.Current == nil && !pending {
			st.Current = sp(v)
			_ = writeState(st)
		}
		cmd, err := startServer(v)
		if err != nil {
			logf("cannot start server %s: %v", v, err)
			sleepOrStop(10 * time.Second)
			os.Exit(1)
		}
		started := time.Now()
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()

		var healthyCh <-chan time.Time
		if pending {
			healthyCh = time.After(0)
		}
		deadline := started.Add(*healthTimeout)
		exited := false
		var werr error
	watch:
		for {
			select {
			case werr = <-done:
				exited = true
				break watch
			case sig := <-stopping:
				logf("%v: stopping server", sig)
				stopChild(cmd, done)
				os.Exit(0)
			case <-healthyCh:
				if healthy(url, v) {
					st = readState()
					from := st.Current // the version before this update (the server left current alone when it switched)
					if from != nil && *from == v {
						from = nil
					}
					if from != nil && st.Previous == nil {
						st.Previous = from
					}
					st.Current, st.Pending, st.PendingSince, st.Attempts = sp(v), nil, nil, 0
					record(&st, from, v, "ok", "")
					_ = writeState(st)
					pending, healthyCh = false, nil
					continue
				}
				if time.Now().After(deadline) {
					logf("version %s not healthy after %v", v, *healthTimeout)
					stopChild(cmd, done)
					st = readState()
					rollBack(&st, v, fmt.Sprintf("not healthy within %v", *healthTimeout))
					break watch
				}
				healthyCh = time.After(time.Second)
			}
		}
		if !exited {
			continue // rolled back after the health timeout
		}
		after := readState()
		if nv, err := currentVersion(); err == nil && nv != v {
			logf("server switched app/current %s -> %s, starting it", v, nv)
			continue // update (or manual switch): not a crash
		}
		if pending {
			after.Attempts++
			logf("pending version %s exited (%v) before it was healthy, attempt %d/%d", v, werr, after.Attempts, *maxAttempts)
			if after.Attempts >= *maxAttempts {
				rollBack(&after, v, fmt.Sprintf("exited %d times before it was healthy (last: %v)", after.Attempts, werr))
			} else {
				_ = writeState(after)
			}
			sleepOrStop(time.Second)
			continue
		}
		// a normal crash or a requested restart: back off when it happens too often
		now := time.Now()
		kept := crashes[:0]
		for _, t := range crashes {
			if now.Sub(t) < 5*time.Minute {
				kept = append(kept, t)
			}
		}
		crashes = append(kept, now)
		delay := time.Second
		if n := len(crashes); n > 5 {
			delay = time.Duration(1<<min(n-6, 6)) * time.Second
			if delay > time.Minute {
				delay = time.Minute
			}
		}
		logf("server %s exited after %v (%v), restarting in %v", v, time.Since(started).Round(time.Millisecond), werr, delay)
		sleepOrStop(delay)
	}
}

func sleepOrStop(d time.Duration) {
	select {
	case <-time.After(d):
	case <-stopping:
		os.Exit(0)
	}
}

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
// A roll-back cannot undo the database: when the new version's migrations need a newer reader, the old version exits
// 75 (SchemaTooNewError) on every start. Then the bootstrap goes forward to the new version again (it already migrated
// the database) and watches it like an update, without a roll-back; when it keeps dying too, or there is nothing to go
// forward to, the bootstrap stops starting the server and records why (state.json blocked + history) instead of
// restarting a build that can never read the database (decision: fix/update-rollback-schema-too-new, 2026-11-11).
// Normal crashes restart after 1 s; more than 5 crashes in 5 minutes back off 1, 2, 4 ... 60 s. launchd's KeepAlive
// only restarts the bootstrap itself.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"mycel/native/internal/bundle"
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
	// Forward: the version the bootstrap went forward to again because the one it had rolled back to could not read
	// the database (exit 75); cleared when it is healthy
	Forward *string `json:"forward,omitempty"`
	// Blocked: the bootstrap stopped starting the server (no version can run); cleared when app/current changes
	Blocked *blockedState `json:"blocked,omitempty"`
}

type blockedState struct {
	Version string `json:"version"`
	Since   string `json:"since"`
	Detail  string `json:"detail"`
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
func validVersion(v string) bool { return bundle.ValidVersion(v) }

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

// verifyVersion checks app/versions/<v> (manifest, signature with --pubkey, every file); the rules live in
// native/internal/bundle, shared with mycel-ctl verify-bundle / update.
func verifyVersion(v string) error {
	if !validVersion(v) {
		return fmt.Errorf("not a version name: %q", v)
	}
	_, err := bundle.VerifyDir(filepath.Join(*appDir, "versions", v), v, bundle.Options{Keys: pubkeys, AllowUnsigned: *allowUnsigned})
	return err
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

// hup: SIGHUP is passed on to the server process (not its group: its helpers would die of it). mycel-ctl apply-plan /
// notices-set send it (systemctl kill --kill-whom=main -s HUP <id>-server.service) so the server reads plan.json and
// notices.json again at once; without this the bootstrap itself would die of SIGHUP.
var hup = make(chan os.Signal, 1)

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

// exitSchemaTooNew is the server's exit code when the database needs a newer build (server/src/main.ts EXIT.schemaTooNew)
const exitSchemaTooNew = 75

// tunables (tests make them short)
var (
	retryDelay  = time.Second      // between starts of a pending or forwarded version that died
	blockedPoll = 10 * time.Second // how often a stopped bootstrap looks whether app/current or state.json changed
	healthEvery = time.Second      // health polls of a pending or forwarded version
)

func exitCode(err error) int {
	if ee, ok := err.(*exec.ExitError); ok {
		return ee.ExitCode()
	}
	return -1
}

// forwardTarget: the version to go forward to when v cannot read the database. Only right after the bootstrap rolled
// back from that version to v (the last history entry), only when it still verifies: it ran its migrations before it
// failed, so it is the one build that can read the database now.
func forwardTarget(st appState, v string) string {
	if len(st.History) == 0 {
		return ""
	}
	h := st.History[len(st.History)-1]
	f := str(h.From)
	if h.Result != "rolled_back" || h.To != v || f == "" || f == v || !validVersion(f) {
		return ""
	}
	if err := verifyVersion(f); err != nil {
		logf("cannot go forward to %s: %v", f, err)
		return ""
	}
	return f
}

// block stops starting the server: no version can run (the old one cannot read the database, the new one keeps dying).
// The reason goes to state.json (blocked, for mycel-ctl status) and to the history as a roll-back of v that went
// nowhere (the result the server, mycel-ctl update and the update hold already know). Then it waits (stopAndWait).
func block(st *appState, v, why string) bool {
	st.Pending, st.PendingSince, st.Forward, st.Attempts = nil, nil, nil, 0
	detail := "stopped: " + why + ". Restore the database backup made before the update (data/backups/pre-migrate-*.db) " +
		"or install a version that starts. The server starts again when app/current changes, or on SIGHUP to the bootstrap " +
		"(Linux: systemctl kill -s HUP <id>-server.service; macOS: launchctl kill HUP system/<label>.server)"
	st.Blocked = &blockedState{Version: v, Since: time.Now().UTC().Format(time.RFC3339Nano), Detail: detail}
	record(st, sp(v), v, "rolled_back", detail)
	if err := writeState(*st); err != nil {
		logf("cannot write state.json: %v", err)
		return stopAndWait(v, detail, false)
	}
	return stopAndWait(v, detail, true)
}

// stopAndWait waits while the server is stopped at v, then sets up one more watched try when app/current still points
// at v. False on SIGTERM / SIGINT.
func stopAndWait(v, detail string, persisted bool) bool {
	if !waitBlocked(v, detail, persisted) {
		return false
	}
	st := readState()
	if cur, err := currentVersion(); err == nil && cur == v {
		// one more try of the same version, watched like a forwarded one: no roll-back, stops again after --max-attempts
		st.Forward, st.Attempts = sp(v), 0
	}
	st.Blocked = nil
	_ = writeState(st)
	return true
}

// waitBlocked waits until app/current points elsewhere, someone removes state.json `blocked` (persisted: it was
// written), or SIGHUP asks for one more try. A SIGHUP sent before the stop does not count. False on SIGTERM / SIGINT.
func waitBlocked(v, detail string, persisted bool) bool {
	logf("server stopped at %s: %s", v, detail)
	for len(hup) > 0 {
		<-hup
	}
	for {
		select {
		case <-stopping:
			return false
		case <-hup:
			logf("SIGHUP: trying %s again", v)
			return true
		case <-time.After(blockedPoll):
		}
		if persisted && readState().Blocked == nil {
			return true
		}
		if cur, err := currentVersion(); err != nil || cur != v {
			return true
		}
	}
}

func main() {
	flag.Var(&pubkeys, "pubkey", "release public key, base64 Ed25519 (repeatable: current + spare)")
	flag.Parse()
	if *appDir == "" || *configFile == "" {
		fmt.Fprintln(os.Stderr, "usage: mycel-bootstrap --app <base>/app --config <server.json> [--allow-unsigned] [--pubkey K]...")
		os.Exit(2)
	}
	signal.Notify(stopping, syscall.SIGTERM, syscall.SIGINT)
	signal.Notify(hup, syscall.SIGHUP)
	os.Exit(run())
}

// run supervises the server until SIGTERM / SIGINT (0) or a state it cannot go on from (1: launchd / systemd restart
// the bootstrap).
func run() int {
	url := healthURL()
	var crashes []time.Time
	for {
		st := readState()
		v, err := currentVersion()
		if err != nil {
			logf("no usable app/current: %v", err)
			if !sleepOrStop(30 * time.Second) {
				return 0
			}
			return 1
		}
		if st.Blocked != nil && st.Blocked.Version == v {
			// stopped before this bootstrap started (a reboot): stay stopped
			if !stopAndWait(v, st.Blocked.Detail, true) {
				return 0
			}
			continue
		}
		if st.Blocked != nil {
			st.Blocked = nil // app/current changed (an update, an administrator)
			_ = writeState(st)
		}
		pending := str(st.Pending) == v
		// forwarded: started again after the version before it could not read the database; watched like a pending
		// update, but never rolled back (that is what failed)
		forwarded := !pending && str(st.Forward) == v
		if st.Forward != nil && !forwarded {
			st.Forward = nil // app/current changed since
			_ = writeState(st)
		}
		if err := verifyVersion(v); err != nil {
			logf("version %s does not verify: %v", v, err)
			if pending || str(st.Previous) != "" {
				if rollBack(&st, v, "verify failed: "+err.Error()) {
					continue
				}
			}
			if !sleepOrStop(30 * time.Second) {
				return 0
			}
			return 1
		}
		if st.Current == nil && !pending && !forwarded {
			st.Current = sp(v)
			_ = writeState(st)
		}
		cmd, err := startServer(v)
		if err != nil {
			logf("cannot start server %s: %v", v, err)
			if !sleepOrStop(10 * time.Second) {
				return 0
			}
			return 1
		}
		started := time.Now()
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()

		var healthyCh <-chan time.Time
		if pending || forwarded {
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
				return 0
			case <-hup:
				_ = cmd.Process.Signal(syscall.SIGHUP)
			case <-healthyCh:
				if healthy(url, v) {
					st = readState()
					from := st.Current // the version before this update (the server left current alone when it switched)
					if from != nil && *from == v {
						from = nil
					}
					detail := ""
					if forwarded {
						// the version before cannot read the database: it is no roll-back target any more
						st.Previous, st.Forward = nil, nil
						detail = "started again after it was stopped"
						if from != nil {
							detail = fmt.Sprintf("started again after %s could not read the database this version had already updated", *from)
						}
					} else if from != nil && st.Previous == nil {
						st.Previous = from
					}
					st.Current, st.Pending, st.PendingSince, st.Attempts = sp(v), nil, nil, 0
					record(&st, from, v, "ok", detail)
					_ = writeState(st)
					pending, forwarded, healthyCh = false, false, nil
					continue
				}
				if pending && time.Now().After(deadline) {
					logf("version %s not healthy after %v", v, *healthTimeout)
					stopChild(cmd, done)
					st = readState()
					rollBack(&st, v, fmt.Sprintf("not healthy within %v", *healthTimeout))
					break watch
				}
				// a forwarded version is left running: the older one cannot read the database
				healthyCh = time.After(healthEvery)
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
		code := exitCode(werr)
		if pending || forwarded {
			after.Attempts++
			kind := "forwarded"
			if pending {
				kind = "pending"
			}
			logf("%s version %s exited (%v) before it was healthy, attempt %d/%d", kind, v, werr, after.Attempts, *maxAttempts)
			goOn := true
			switch {
			case forwarded && code == exitSchemaTooNew:
				goOn = block(&after, v, fmt.Sprintf("%s cannot read the database: a newer version has updated it", v))
			case after.Attempts < *maxAttempts:
				_ = writeState(after)
				goOn = sleepOrStop(retryDelay)
			case pending:
				rollBack(&after, v, fmt.Sprintf("exited %d times before it was healthy (last: %v)", after.Attempts, werr))
				goOn = sleepOrStop(retryDelay)
			default:
				goOn = block(&after, v, fmt.Sprintf("%s exited %d times before it was healthy (last: %v), and %s cannot read the database it already updated",
					v, after.Attempts, werr, orUnknown(after.Current)))
			}
			if !goOn {
				return 0
			}
			continue
		}
		if code == exitSchemaTooNew {
			// the database needs a newer build: restarting this one can never help
			if f := forwardTarget(after, v); f != "" {
				err := switchTo(f)
				if err == nil {
					logf("%s cannot read the database; going forward to %s again (it ran its migrations before it was rolled back)", v, f)
					after.Forward, after.Attempts, after.Previous = sp(f), 0, nil
					_ = writeState(after)
					continue
				}
				logf("cannot switch to %s: %v", f, err)
			}
			if !block(&after, v, fmt.Sprintf("%s cannot read the database: a newer version has updated it", v)) {
				return 0
			}
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
		if !sleepOrStop(delay) {
			return 0
		}
	}
}

func orUnknown(p *string) string {
	if p == nil || *p == "" {
		return "the version before"
	}
	return *p
}

// sleepOrStop sleeps d; false when SIGTERM / SIGINT came first.
func sleepOrStop(d time.Duration) bool {
	select {
	case <-time.After(d):
		return true
	case <-stopping:
		return false
	}
}

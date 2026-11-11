package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"mycel/native/internal/bundle"
)

// A fake install: every version's bin/bun is a shell script that behaves as the test says, a health server answers
// with the version a script wrote to <tmp>/running, and <tmp>/starts lists every start.
type fakeInstall struct {
	t                 *testing.T
	app, work, starts string
}

func newFakeInstall(t *testing.T) *fakeInstall {
	t.Helper()
	root := t.TempDir()
	f := &fakeInstall{t: t, app: filepath.Join(root, "app"), work: filepath.Join(root, "work")}
	f.starts = filepath.Join(f.work, "starts")
	os.MkdirAll(filepath.Join(f.app, "versions"), 0o755)
	os.MkdirAll(f.work, 0o755)
	running := filepath.Join(f.work, "running")
	migratingFile := filepath.Join(f.work, "migrating")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// <work>/migrating: the version in it is updating its database (server/src/system/migrate-start.ts)
		if b, err := os.ReadFile(migratingFile); err == nil {
			w.WriteHeader(503)
			fmt.Fprintf(w, `{"ok":false,"status":"migrating","version":%q,"migrating":{"pending":2,"copiedBytes":1048576,"dbBytes":4194304}}`, strings.TrimSpace(string(b)))
			return
		}
		b, err := os.ReadFile(running)
		if err != nil {
			w.WriteHeader(503)
			return
		}
		fmt.Fprintf(w, `{"ok":true,"version":%q}`, strings.TrimSpace(string(b)))
	}))
	t.Cleanup(srv.Close)
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	cfg := filepath.Join(root, "server.json")
	os.WriteFile(cfg, []byte(`{"listen":{"host":"127.0.0.1","port":`+port+`}}`), 0o644)

	saved := []any{*appDir, *configFile, *healthTimeout, *maxAttempts, *allowUnsigned, *updateLog, retryDelay, blockedPoll, healthEvery}
	savedMigrate, savedMigrateLog := *migrateTimeout, migrateLogEvery
	t.Cleanup(func() {
		*migrateTimeout, migrateLogEvery = savedMigrate, savedMigrateLog
		*appDir, *configFile, *healthTimeout, *maxAttempts = saved[0].(string), saved[1].(string), saved[2].(time.Duration), saved[3].(int)
		*allowUnsigned, *updateLog = saved[4].(bool), saved[5].(string)
		retryDelay, blockedPoll, healthEvery = saved[6].(time.Duration), saved[7].(time.Duration), saved[8].(time.Duration)
		for len(stopping) > 0 {
			<-stopping
		}
		for len(hup) > 0 {
			<-hup
		}
	})
	*appDir, *configFile, *allowUnsigned, *updateLog = f.app, cfg, true, ""
	*healthTimeout, *maxAttempts = 3*time.Second, 3
	retryDelay, blockedPoll, healthEvery = 10*time.Millisecond, 30*time.Millisecond, 50*time.Millisecond
	return f
}

// version writes app/versions/<v> whose server runs `body` (sh; $N is this version's start count, 1 first)
func (f *fakeInstall) version(v, body string) {
	d := filepath.Join(f.app, "versions", v)
	os.MkdirAll(filepath.Join(d, "bin"), 0o755)
	os.MkdirAll(filepath.Join(d, "server", "src"), 0o755)
	os.WriteFile(filepath.Join(d, "server", "src", "main.js"), []byte("// fake\n"), 0o644)
	count := filepath.Join(f.work, "count-"+v)
	script := fmt.Sprintf("#!/bin/sh\nN=$(( $(cat %q 2>/dev/null || echo 0) + 1 ))\necho $N > %q\necho %s >> %q\n%s\n",
		count, count, v, f.starts, body)
	os.WriteFile(filepath.Join(d, "bin", "bun"), []byte(script), 0o755)
	if err := bundle.WriteManifest(d, v, nil); err != nil {
		f.t.Fatal(err)
	}
}

// healthyBody: the server answers /api/health as v
func (f *fakeInstall) healthyBody(v string) string {
	return fmt.Sprintf("echo %s > %q\nexec sleep 60", v, filepath.Join(f.work, "running"))
}

func (f *fakeInstall) state() appState {
	f.t.Helper()
	var st appState
	b, err := os.ReadFile(statePath())
	if err == nil {
		err = json.Unmarshal(b, &st)
	}
	if err != nil {
		f.t.Fatal(err)
	}
	return st
}

func (f *fakeInstall) startList() []string {
	b, _ := os.ReadFile(f.starts)
	return strings.Fields(string(b))
}

// updating: the server switched app/current to `to` and wrote state.json as system/update.ts does
func (f *fakeInstall) updating(from, to string) {
	if err := switchTo(to); err != nil {
		f.t.Fatal(err)
	}
	st := appState{Format: 1, Current: sp(from), Previous: sp(from), Pending: sp(to), PendingSince: sp(time.Now().UTC().Format(time.RFC3339)), History: []historyEntry{}}
	if err := writeState(st); err != nil {
		f.t.Fatal(err)
	}
}

// start runs the bootstrap loop; the returned stop ends it and returns its exit code (a failed test stops it too)
func (f *fakeInstall) start() (stop func() int) {
	res := make(chan int, 1)
	go func() { res <- run() }()
	var once sync.Once
	code := -1
	stop = func() int {
		once.Do(func() {
			stopping <- syscall.SIGTERM
			select {
			case code = <-res:
			case <-time.After(30 * time.Second):
				f.t.Error("bootstrap did not stop")
			}
		})
		return code
	}
	f.t.Cleanup(func() { stop() })
	return stop
}

func (f *fakeInstall) waitFor(what string, cond func(appState) bool) appState {
	f.t.Helper()
	until := time.Now().Add(60 * time.Second)
	for time.Now().Before(until) {
		if b, err := os.ReadFile(statePath()); err == nil {
			var st appState
			if json.Unmarshal(b, &st) == nil && cond(st) {
				return st
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	b, _ := os.ReadFile(statePath())
	f.t.Fatalf("timed out waiting for %s; state.json: %s; starts: %v", what, b, f.startList())
	return appState{}
}

func results(st appState) string {
	var out []string
	for _, h := range st.History {
		out = append(out, fmt.Sprintf("%s:%s->%s", h.Result, str(h.From), h.To))
	}
	return strings.Join(out, " ")
}

// The new version migrates, then misses the health check; the roll-back target cannot read the database (exit 75).
// The bootstrap goes forward to the new version again, which comes up this time (a slow first start).
func TestOldVersionExit75GoesForwardAgain(t *testing.T) {
	f := newFakeInstall(t)
	f.version("1.0.0", "exit 75")
	// unhealthy until the test creates <work>/heal (after the roll-back): a start count would race with a slow shell
	heal := filepath.Join(f.work, "heal")
	f.version("1.1.0", fmt.Sprintf("while [ ! -f %q ]; do sleep 0.05; done\n", heal)+f.healthyBody("1.1.0"))
	f.updating("1.0.0", "1.1.0")
	stop := f.start()
	f.waitFor("roll-back", func(st appState) bool { return len(st.History) == 1 })
	os.WriteFile(heal, nil, 0o644)
	st := f.waitFor("ok after going forward", func(st appState) bool {
		return len(st.History) == 2 && st.History[1].Result == "ok"
	})
	if code := stop(); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if got := results(st); got != "rolled_back:1.1.0->1.0.0 ok:1.0.0->1.1.0" {
		t.Fatalf("history %s", got)
	}
	if d := str(st.History[1].Detail); !strings.Contains(d, "1.0.0 could not read the database") {
		t.Fatalf("detail %q", d)
	}
	if str(st.Current) != "1.1.0" || st.Previous != nil || st.Pending != nil || st.Forward != nil || st.Blocked != nil || st.Attempts != 0 {
		t.Fatalf("state %+v", st)
	}
	if cur, _ := currentVersion(); cur != "1.1.0" {
		t.Fatalf("app/current %s", cur)
	}
	// the first start of 1.1.0 may be killed before its script logs it (a loaded machine)
	if got := strings.Join(f.startList(), " "); got != "1.1.0 1.0.0 1.1.0" && got != "1.0.0 1.1.0" {
		t.Fatalf("starts %s", got)
	}
}

// The new version migrates, then dies on every start. Roll-back, the old one exits 75, forward again, it dies
// --max-attempts times: the bootstrap stops starting anything (no endless restart) and says why. SIGHUP tries once more.
func TestNoVersionCanRunStops(t *testing.T) {
	f := newFakeInstall(t)
	f.version("1.0.0", "exit 75")
	f.version("1.1.0", "exit 1")
	f.updating("1.0.0", "1.1.0")
	stop := f.start()
	st := f.waitFor("blocked", func(st appState) bool { return st.Blocked != nil })
	want := "1.1.0 1.1.0 1.1.0 1.0.0 1.1.0 1.1.0 1.1.0"
	if got := strings.Join(f.startList(), " "); got != want {
		t.Fatalf("starts %s", got)
	}
	time.Sleep(20 * blockedPoll)
	if got := strings.Join(f.startList(), " "); got != want {
		t.Fatalf("started again while stopped: %s", got)
	}
	if got := results(st); got != "rolled_back:1.1.0->1.0.0 rolled_back:1.1.0->1.1.0" {
		t.Fatalf("history %s", got)
	}
	if st.Blocked.Version != "1.1.0" || !strings.Contains(st.Blocked.Detail, "1.0.0 cannot read the database") ||
		!strings.Contains(st.Blocked.Detail, "pre-migrate") || !strings.HasPrefix(str(st.History[1].Detail), "stopped: ") {
		t.Fatalf("blocked %+v / %q", st.Blocked, str(st.History[1].Detail))
	}
	if st.Forward != nil || st.Pending != nil || st.Previous != nil {
		t.Fatalf("state %+v", st)
	}
	// SIGHUP: one more watched try, which stops again after --max-attempts
	hup <- syscall.SIGHUP
	f.waitFor("blocked again", func(st appState) bool { return st.Blocked != nil && len(st.History) == 3 })
	if got := strings.Join(f.startList(), " "); got != want+" 1.1.0 1.1.0 1.1.0" {
		t.Fatalf("starts after SIGHUP %s", got)
	}
	if code := stop(); code != 0 {
		t.Fatalf("exit %d", code)
	}
	// a restarted bootstrap (reboot, launchd) stays stopped too
	stop = f.start()
	time.Sleep(10 * blockedPoll)
	if code := stop(); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if n := len(f.startList()); n != 10 {
		t.Fatalf("a restarted bootstrap started the server: %v", f.startList())
	}
}

// Exit 75 with no roll-back before it (a version installed by hand over a newer database): stop at once.
func TestExit75WithoutRollBackStops(t *testing.T) {
	f := newFakeInstall(t)
	f.version("1.0.0", "exit 75")
	if err := switchTo("1.0.0"); err != nil {
		t.Fatal(err)
	}
	stop := f.start()
	st := f.waitFor("blocked", func(st appState) bool { return st.Blocked != nil })
	time.Sleep(10 * blockedPoll)
	if got := f.startList(); len(got) != 1 {
		t.Fatalf("starts %v", got)
	}
	if st.Blocked.Version != "1.0.0" || results(st) != "rolled_back:1.0.0->1.0.0" {
		t.Fatalf("state %+v %s", st.Blocked, results(st))
	}
	// an administrator points app/current at a version that runs: the bootstrap starts it
	f.version("1.1.0", f.healthyBody("1.1.0"))
	if err := switchTo("1.1.0"); err != nil {
		t.Fatal(err)
	}
	f.waitFor("unblocked", func(st appState) bool { return st.Blocked == nil })
	until := time.Now().Add(30 * time.Second)
	for len(f.startList()) < 2 && time.Now().Before(until) {
		time.Sleep(20 * time.Millisecond)
	}
	if code := stop(); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if got := strings.Join(f.startList(), " "); got != "1.0.0 1.1.0" {
		t.Fatalf("starts %s", got)
	}
}

// A normal crash (not 75) of the running version still restarts it.
func TestOrdinaryCrashStillRestarts(t *testing.T) {
	f := newFakeInstall(t)
	f.version("1.0.0", `if [ "$N" -lt 3 ]; then exit 1; fi`+"\n"+f.healthyBody("1.0.0"))
	if err := switchTo("1.0.0"); err != nil {
		t.Fatal(err)
	}
	stop := f.start()
	until := time.Now().Add(30 * time.Second)
	for len(f.startList()) < 3 && time.Now().Before(until) {
		time.Sleep(20 * time.Millisecond)
	}
	if code := stop(); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if st := f.state(); st.Blocked != nil || len(f.startList()) != 3 {
		t.Fatalf("state %+v starts %v", st, f.startList())
	}
}

// A forwarded version that itself exits 75 stops at once (no --max-attempts rounds).
func TestForwardedExit75StopsAtOnce(t *testing.T) {
	f := newFakeInstall(t)
	f.version("1.0.0", "exit 75")
	f.version("1.1.0", "exit 75")
	f.updating("1.0.0", "1.1.0")
	stop := f.start()
	st := f.waitFor("blocked", func(st appState) bool { return st.Blocked != nil })
	time.Sleep(10 * blockedPoll)
	if code := stop(); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if got := strings.Join(f.startList(), " "); got != "1.1.0 1.1.0 1.1.0 1.0.0 1.1.0" {
		t.Fatalf("starts %s", got)
	}
	if st.Blocked.Version != "1.1.0" || !strings.Contains(st.Blocked.Detail, "1.1.0 cannot read the database") {
		t.Fatalf("blocked %+v", st.Blocked)
	}
}

// state.json cannot be written (a full disk, a read-only folder): the bootstrap still stops instead of restarting a
// version that exits 75 with no delay.
func TestStopsWhenStateCannotBeWritten(t *testing.T) {
	f := newFakeInstall(t)
	f.version("1.0.0", "exit 75")
	if err := switchTo("1.0.0"); err != nil {
		t.Fatal(err)
	}
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(writeState(appState{Format: 1, Current: sp("1.0.0"), History: []historyEntry{}}))
	must(os.Chmod(f.app, 0o555))
	t.Cleanup(func() { os.Chmod(f.app, 0o755) })
	stop := f.start()
	until := time.Now().Add(30 * time.Second)
	for len(f.startList()) < 1 && time.Now().Before(until) {
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(20 * blockedPoll)
	if code := stop(); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if got := f.startList(); len(got) != 1 {
		t.Fatalf("restarted while state.json could not be written: %v", got)
	}
}

// migratingBody: the server reports migrating as v for `secs`, then answers healthy (or runs `after` instead)
func (f *fakeInstall) migratingBody(v string, secs float64, after string) string {
	m := filepath.Join(f.work, "migrating")
	if after == "" {
		after = f.healthyBody(v)
	}
	return fmt.Sprintf("echo %s > %q\nsleep %g\nrm -f %q\n%s", v, m, secs, m, after)
}

// QA TC-278: a version that updates a large database for longer than --health-timeout, saying so on /api/health, is
// not rolled back: it comes up after the migration.
func TestMigratingLongerThanHealthTimeoutIsNotRolledBack(t *testing.T) {
	f := newFakeInstall(t)
	*healthTimeout, migrateLogEvery = 700*time.Millisecond, 200*time.Millisecond
	f.version("1.0.0", f.healthyBody("1.0.0"))
	f.version("1.1.0", f.migratingBody("1.1.0", 2.5, ""))
	f.updating("1.0.0", "1.1.0")
	stop := f.start()
	st := f.waitFor("ok", func(st appState) bool { return len(st.History) == 1 })
	if code := stop(); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if got := results(st); got != "ok:1.0.0->1.1.0" {
		t.Fatalf("history %s", got)
	}
	if got := strings.Join(f.startList(), " "); got != "1.1.0" {
		t.Fatalf("starts %s", got)
	}
	if str(st.Current) != "1.1.0" || str(st.Previous) != "1.0.0" || st.Pending != nil {
		t.Fatalf("state %+v", st)
	}
}

// A migration that never ends is still bounded: rolled back at --migrate-timeout, with the reason.
func TestMigratingIsBoundedByMigrateTimeout(t *testing.T) {
	f := newFakeInstall(t)
	*healthTimeout, *migrateTimeout = 300*time.Millisecond, 1500*time.Millisecond
	f.version("1.0.0", f.healthyBody("1.0.0"))
	f.version("1.1.0", f.migratingBody("1.1.0", 60, "exec sleep 60"))
	f.updating("1.0.0", "1.1.0")
	began := time.Now()
	stop := f.start()
	st := f.waitFor("rolled back", func(st appState) bool { return len(st.History) == 1 })
	took := time.Since(began)
	os.Remove(filepath.Join(f.work, "migrating"))
	if code := stop(); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if got := results(st); got != "rolled_back:1.1.0->1.0.0" {
		t.Fatalf("history %s", got)
	}
	if d := str(st.History[0].Detail); !strings.Contains(d, "still updating its database") {
		t.Fatalf("detail %q", d)
	}
	if took < 1500*time.Millisecond {
		t.Fatalf("rolled back after %v, before --migrate-timeout", took)
	}
}

// A version that dies while it migrates still counts towards --max-attempts (no endless loop, PR #401).
func TestDyingWhileMigratingCountsAttempts(t *testing.T) {
	f := newFakeInstall(t)
	f.version("1.0.0", f.healthyBody("1.0.0"))
	f.version("1.1.0", f.migratingBody("1.1.0", 0.2, "exit 1"))
	f.updating("1.0.0", "1.1.0")
	stop := f.start()
	st := f.waitFor("rolled back", func(st appState) bool { return len(st.History) == 1 })
	// the roll-back is recorded before 1.0.0 starts
	for until := time.Now().Add(30 * time.Second); len(f.startList()) < 4 && time.Now().Before(until); {
		time.Sleep(20 * time.Millisecond)
	}
	if code := stop(); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if got := results(st); got != "rolled_back:1.1.0->1.0.0" {
		t.Fatalf("history %s", got)
	}
	if got := strings.Join(f.startList(), " "); !strings.HasPrefix(got, "1.1.0 1.1.0 1.1.0 1.0.0") {
		t.Fatalf("starts %s", got)
	}
}

// "migrating" from another version (an old process still on the port) does not extend the wait.
func TestMigratingOtherVersionDoesNotExtend(t *testing.T) {
	f := newFakeInstall(t)
	*healthTimeout, *migrateTimeout = 500*time.Millisecond, time.Hour
	f.version("1.0.0", "rm -f "+filepath.Join(f.work, "migrating")+"\n"+f.healthyBody("1.0.0"))
	f.version("1.1.0", fmt.Sprintf("echo 0.9.0 > %q\nexec sleep 60", filepath.Join(f.work, "migrating")))
	f.updating("1.0.0", "1.1.0")
	began := time.Now()
	stop := f.start()
	st := f.waitFor("rolled back", func(st appState) bool { return len(st.History) >= 1 })
	if code := stop(); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if time.Since(began) > 20*time.Second || !strings.Contains(str(st.History[0].Detail), "not healthy within") {
		t.Fatalf("history %s %q", results(st), str(st.History[0].Detail))
	}
}

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// short watchdog for a test: every 40 ms, 3 failures, a 100 ms health timeout (the fake hung server takes 300 ms)
func fastWatchdog(t *testing.T, kills int) {
	t.Helper()
	saved := []any{watchEvery, watchFailures, watchMaxKills, watchKillWindow, healthClientTimeout}
	t.Cleanup(func() {
		watchEvery, watchFailures, watchMaxKills = saved[0].(time.Duration), saved[1].(int), saved[2].(int)
		watchKillWindow, healthClientTimeout = saved[3].(time.Duration), saved[4].(time.Duration)
	})
	watchEvery, watchFailures, watchMaxKills, watchKillWindow, healthClientTimeout = 40*time.Millisecond, 3, kills, time.Hour, 100*time.Millisecond
}

func (f *fakeInstall) config(extra string) {
	f.t.Helper()
	b, err := os.ReadFile(*configFile)
	if err != nil {
		f.t.Fatal(err)
	}
	s := strings.TrimSuffix(strings.TrimSpace(string(b)), "}") + "," + extra + "}"
	if err := os.WriteFile(*configFile, []byte(s), 0o644); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fakeInstall) waitStarts(n int) {
	f.t.Helper()
	until := time.Now().Add(20 * time.Second)
	for time.Now().Before(until) {
		if len(f.startList()) >= n {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	f.t.Fatalf("waited for %d starts: %v", n, f.startList())
}

func waitHealthy(t *testing.T, v string) {
	t.Helper()
	url := healthURL()
	until := time.Now().Add(20 * time.Second)
	for time.Now().Before(until) {
		if healthy(url, v) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("%s never answered health", v)
}

// A server that answered once, then stops answering (a fake hung server: health takes longer than the timeout), is
// stopped and started again: the default, with no watchdog block in server.json. The new start is not watched until
// it answers itself.
func TestWatchdogRestartsHungServer(t *testing.T) {
	f := newFakeInstall(t)
	fastWatchdog(t, 3)
	f.version("1.0.0", f.healthyBody("1.0.0"))
	if err := switchTo("1.0.0"); err != nil {
		t.Fatal(err)
	}
	stop := f.start()
	f.waitStarts(1)
	waitHealthy(t, "1.0.0")
	time.Sleep(3 * watchEvery) // the watchdog saw it answer
	os.WriteFile(filepath.Join(f.work, "hung"), nil, 0o644)
	f.waitStarts(2)
	// still hung: the new start never answered, so it is not counted (no kill loop)
	time.Sleep(time.Duration(watchFailures+3) * (watchEvery + healthClientTimeout))
	if n := len(f.startList()); n != 2 {
		t.Fatalf("restarted a start that never answered: %v", f.startList())
	}
	if code := stop(); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if st := f.state(); st.Liveness != nil || st.Pending != nil || len(st.History) != 0 {
		t.Fatalf("a watchdog restart is no update and no give-up: %+v", st)
	}
}

// With server.json watchdog.kill false the watchdog only logs.
func TestWatchdogLogOnlyWhenOff(t *testing.T) {
	f := newFakeInstall(t)
	fastWatchdog(t, 3)
	f.config(`"watchdog":{"kill":false}`)
	f.version("1.0.0", f.healthyBody("1.0.0"))
	switchTo("1.0.0")
	stop := f.start()
	f.waitStarts(1)
	waitHealthy(t, "1.0.0")
	time.Sleep(3 * watchEvery)
	os.WriteFile(filepath.Join(f.work, "hung"), nil, 0o644)
	time.Sleep(time.Duration(2*watchFailures+2) * (watchEvery + healthClientTimeout))
	if n := len(f.startList()); n != 1 {
		t.Fatalf("killed with the switch off: %v", f.startList())
	}
	stop()
}

// A running server that answers 503 "migrating" answers: never a hang.
func TestWatchdogDoesNotCountMigrating(t *testing.T) {
	f := newFakeInstall(t)
	fastWatchdog(t, 3)
	f.config(`"watchdog":{"kill":true}`)
	f.version("1.0.0", f.healthyBody("1.0.0"))
	switchTo("1.0.0")
	stop := f.start()
	f.waitStarts(1)
	waitHealthy(t, "1.0.0")
	time.Sleep(3 * watchEvery)
	os.WriteFile(filepath.Join(f.work, "migrating"), []byte("1.0.0"), 0o644)
	time.Sleep(time.Duration(2*watchFailures+2) * watchEvery)
	if n := len(f.startList()); n != 1 {
		t.Fatalf("killed a migrating server: %v", f.startList())
	}
	stop()
}

// After watchMaxKills kills in the window it gives up: state.json liveness.gaveUp, kept however long it waits, until the
// next healthy answer clears it and arms the watchdog again.
func TestWatchdogGivesUpUntilHealthy(t *testing.T) {
	f := newFakeInstall(t)
	fastWatchdog(t, 2)
	f.config(`"watchdog":{"kill":true}`)
	writeState(appState{Format: 1, History: []historyEntry{}})
	w := &watchdog{}
	now := time.Now()
	hang := func(at time.Time) bool {
		kill := false
		for i := 0; i < watchFailures; i++ {
			kill = w.look("1.0.0", notHealthy, at) || kill
		}
		return kill
	}
	// not armed yet (this start never answered): nothing counts
	w.started()
	if hang(now) {
		t.Fatal("killed before the first answer")
	}
	for i := 0; i < watchMaxKills; i++ {
		w.started()
		w.look("1.0.0", isHealthy, now)
		if !hang(now) {
			t.Fatalf("kill %d did not happen", i+1)
		}
	}
	w.started()
	w.look("1.0.0", isHealthy, now)
	if hang(now) {
		t.Fatal("a kill past the cap")
	}
	st := f.state()
	if st.Liveness == nil || !st.Liveness.GaveUp || !strings.Contains(st.Liveness.Detail, "did not answer health") {
		t.Fatalf("liveness %+v", st.Liveness)
	}
	// the hour passes: still given up (no reset by the clock)
	if hang(now.Add(3*time.Hour)) || f.state().Liveness == nil {
		t.Fatal("the give-up ended by itself")
	}
	// a bootstrap started meanwhile keeps it
	if !gaveUpBefore(f.state()) {
		t.Fatal("not read back")
	}
	// the next healthy answer ends it, and a hang after that is killed again
	w.look("1.0.0", isHealthy, now.Add(3*time.Hour))
	if f.state().Liveness != nil {
		t.Fatal("liveness not cleared by a healthy answer")
	}
	if !hang(now.Add(3 * time.Hour)) {
		t.Fatal("not armed again after the give-up ended")
	}
}

// The watchdog leaves a pending update to the update watch: exit 75 and roll-backs behave as before
// (TestPendingOlderVersionExit75GoesBackAtOnce and the rest run with the watchdog in the loop).
func TestWatchdogIgnoresPendingVersion(t *testing.T) {
	f := newFakeInstall(t)
	fastWatchdog(t, 3)
	f.config(`"watchdog":{"kill":true}`)
	f.version("1.0.0", f.healthyBody("1.0.0"))
	heal := filepath.Join(f.work, "heal")
	f.version("1.1.0", "while [ ! -f "+heal+" ]; do sleep 0.05; done\n"+f.healthyBody("1.1.0"))
	f.updating("1.0.0", "1.1.0")
	*healthTimeout = 10 * time.Second
	stop := f.start()
	f.waitStarts(1)
	time.Sleep(time.Duration(2*watchFailures+2) * watchEvery)
	if n := len(f.startList()); n != 1 {
		t.Fatalf("the watchdog stopped a pending version: %v", f.startList())
	}
	os.WriteFile(heal, nil, 0o644)
	f.waitFor("ok", func(st appState) bool { return len(st.History) == 1 && st.History[0].Result == "ok" })
	stop()
}

// The kill switch: on unless server.json turns it off, a hand-written off honoured in the forms people write.
func TestWatchdogKillSwitch(t *testing.T) {
	saved := *configFile
	t.Cleanup(func() { *configFile = saved })
	dir := t.TempDir()
	*configFile = filepath.Join(dir, "missing.json")
	if !killOn() {
		t.Fatal("no server.json: want on")
	}
	for body, want := range map[string]bool{
		`{}`: true, `not json`: true, `{"watchdog":{}}`: true, `{"watchdog":null}`: true, `{"watchdog":{"kill":null}}`: true,
		`{"watchdog":{"kill":true}}`: true, `{"watchdog":{"kill":1}}`: true, `{"watchdog":{"kill":"yes"}}`: true,
		`{"watchdog":{"kill":false}}`: false, `{"watchdog":{"kill":0}}`: false, `{"watchdog":{"kill":"false"}}`: false,
		`{"watchdog":{"kill":"0"}}`: false, `{"watchdog":{"kill":" Off "}}`: false, `{"watchdog":{"kill":"no"}}`: false,
	} {
		*configFile = filepath.Join(dir, "server.json")
		if err := os.WriteFile(*configFile, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if got := killOn(); got != want {
			t.Errorf("%s: killOn %v, want %v", body, got, want)
		}
	}
}

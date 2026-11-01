package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"mycel/native/internal/bundle"
)

// The window as the app reads it (server/src/system/update-job.ts inWindow): tests/unit/g-update-auto.test.ts checks
// the same table there.
func TestUpdateWindowMatchesServer(t *testing.T) {
	b, err := os.ReadFile("testdata/update-window.json")
	must(t, err)
	var tab struct {
		Default string `json:"default"`
		Cases   []struct {
			Window, Zone, At, Why string
			Inside                bool
		} `json:"cases"`
	}
	must(t, json.Unmarshal(b, &tab))
	if len(tab.Cases) < 10 || tab.Default != defaultUpdateWindow {
		t.Fatalf("window table not read, or its default %q is not %q", tab.Default, defaultUpdateWindow)
	}
	for _, c := range tab.Cases {
		w, ok := parseWindow(c.Window)
		loc, zok := loadZone(c.Zone)
		at, err := time.Parse(time.RFC3339, c.At)
		if !ok || !zok || err != nil {
			t.Fatalf("%+v: window %v zone %v time %v", c, ok, zok, err)
		}
		if got := w.contains(at.In(loc)); got != c.Inside {
			t.Errorf("%s at %s in %s (%s) = %v, want %v", c.Window, c.At, c.Zone, c.Why, got, c.Inside)
		}
	}
	for _, bad := range []string{"", "3:00-05:00", "24:00-01:00", "00:60-01:00", "00:00-25:00", "bad", "03:00-05:00\n"} {
		if _, ok := parseWindow(bad); ok {
			t.Errorf("window %q accepted", bad)
		}
	}
	for _, z := range []string{"../../etc/passwd", "/etc/localtime", "Asia/../UTC", "", strings.Repeat("A", 65)} {
		if _, ok := loadZone(z); ok {
			t.Errorf("zone %q accepted", z)
		}
	}
}

func TestUpdateWindowEnd(t *testing.T) {
	seoul, _ := loadZone("Asia/Seoul")
	for _, c := range []struct{ window, now, end string }{
		{"03:00-05:00", "2026-11-02T03:10:00+09:00", "2026-11-02T05:00:00+09:00"},
		{"23:00-01:00", "2026-11-02T23:30:00+09:00", "2026-11-03T01:00:00+09:00"},
		{"23:00-01:00", "2026-11-03T00:30:00+09:00", "2026-11-03T01:00:00+09:00"},
	} {
		w, _ := parseWindow(c.window)
		now, _ := time.Parse(time.RFC3339, c.now)
		want, _ := time.Parse(time.RFC3339, c.end)
		if got := w.end(now.In(seoul)); !got.Equal(want) {
			t.Errorf("%s from %s: end %s, want %s", c.window, c.now, got, want)
		}
	}
}

// the unit files: every 15 minutes, the job is --scheduled, and only placeholders every released renderer knows
func TestUpdateTimerUnits(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "scripts", "linux", "systemd")
	timer, err := os.ReadFile(filepath.Join(dir, "update.timer.in"))
	must(t, err)
	svc, err := os.ReadFile(filepath.Join(dir, "update.service.in"))
	must(t, err)
	if !strings.Contains(string(timer), "\nOnCalendar=*-*-* *:00/15:00\n") || strings.Contains(string(timer), "04:30") {
		t.Fatalf("timer:\n%s", timer)
	}
	if !strings.Contains(string(svc), "ExecStart=@BASE@/root/mycel-ctl update --base @BASE@ --only-if-needs-root --scheduled\n") || !strings.Contains(string(svc), "\nTimeoutStartSec=2h\n") {
		t.Fatalf("service:\n%s", svc)
	}
	// a 0.2.18 mycel-ctl renders these during the update to 0.2.19: it knows no other placeholders
	known := map[string]bool{"BASE": true, "ID": true}
	for _, m := range placeholderRe.FindAllStringSubmatch(string(timer)+string(svc), -1) {
		if !known[m[1]] {
			t.Errorf("new placeholder @%s@ in the update units", m[1])
		}
	}
}

// fakeClock is the scheduled run's time: sleeping moves it on.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) sleep(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

type schedRun struct {
	clock    *fakeClock
	window   string // admin.js update-window's answer ("" = admin.js fails)
	zone     string
	turns    func(call int) int
	calls    int
	switched string
	asked    []string // admin.js commands and their MYCEL_TEAM_TZ
}

// scheduledHooks: the run's clock, admin.js (update-window, switch) and the launcher's running turns are fakes.
func scheduledHooks(t *testing.T, tb *testBase, r *schedRun) {
	updateTestHook = func(u *updater) {
		u.e.now = r.clock.now
		u.sleep = r.clock.sleep
		u.liveTurns = func() (int, error) {
			r.calls++
			if r.turns == nil {
				return 0, nil
			}
			return r.turns(r.calls), nil
		}
		u.runAsSrv = func(args []string, env []string) (string, error) {
			r.asked = append(r.asked, args[0]+" "+strings.Join(env, " "))
			switch args[0] {
			case "update-window":
				if r.window == "" {
					return "usage: admin.js backup|...", fmt.Errorf("exit status 2")
				}
				return "warning: something on stderr\n" + fmt.Sprintf(`{"window":%q,"timeZone":%q,"custom":true}`, r.window, r.zone) + "\n", nil
			case "switch":
				r.switched = args[1]
				os.Remove(filepath.Join(tb.base, "app/current"))
				os.Symlink("versions/"+args[1], filepath.Join(tb.base, "app/current"))
				tb.health.Store(args[1])
				return "", nil
			}
			return "", fmt.Errorf("unexpected %v", args)
		}
		u.restartSrv = func() error { return nil }
		u.healthTimeout = 3 * time.Second
	}
	t.Cleanup(func() { updateTestHook = nil })
}

func at(s string) *fakeClock {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return &fakeClock{t: t}
}

func schedBase(t *testing.T, f *feedServer) *testBase {
	tb, _ := feedBase(t, f, "0.2.18", "0.2.18")
	updateTestHook = nil
	defaultsDir = t.TempDir()
	t.Cleanup(func() { defaultsDir = "/etc/default" })
	return tb
}

func (tb *testBase) scheduled(t *testing.T, f *feedServer) (int, UpdateResult) {
	t.Helper()
	return tb.update(t, "--only-if-needs-root", "--scheduled", "--pubkey", f.key)
}

func TestScheduledUpdateKeepsTheTeamWindow(t *testing.T) {
	// 13:30 KST (04:30 UTC, the old timer's time): outside the team's 03:00-05:00 Asia/Seoul; nothing is asked of the
	// feed (it is down) and nothing changes
	f := newFeedServer(t)
	f.channel("0.2.19", true)
	tb := schedBase(t, f)
	r := &schedRun{clock: at("2026-11-02T04:30:00Z"), window: "03:00-05:00", zone: "Asia/Seoul"}
	scheduledHooks(t, tb, r)
	f.srv.Close()
	code, res := tb.scheduled(t, f)
	if code != 0 || !res.Skipped || res.Detail != "outside the update window 03:00-05:00 Asia/Seoul" || r.calls != 0 {
		t.Fatalf("%d %+v (launcher asked %d times)", code, res, r.calls)
	}
	if tb.file("root/mycel-launcher") != "old launcher" || currentVersion(tb.base) != "0.2.18" {
		t.Fatal("something changed outside the window")
	}

	// 03:10 KST, nothing running: root files and app
	f = newFeedServer(t)
	f.channel("0.2.19", true)
	tb = schedBase(t, f)
	r = &schedRun{clock: at("2026-11-01T18:10:00Z"), window: "03:00-05:00", zone: "Asia/Seoul"}
	scheduledHooks(t, tb, r)
	code, res = tb.scheduled(t, f)
	if code != 0 || res.Skipped || !res.RootUpdated || !res.AppUpdated || r.switched != "0.2.19" || tb.file("root/mycel-launcher") != "launcher 0.2.19" {
		t.Fatalf("in the window: %d %+v switched %q", code, res, r.switched)
	}
	if _, err := os.Stat(filepath.Join(tb.base, "root/update-deferred.json")); err == nil {
		t.Fatal("deferred record left after an update")
	}
	// a UTC team: 03:10 UTC is its window, 03:10 KST is not
	f = newFeedServer(t)
	f.channel("0.2.19", true)
	tb = schedBase(t, f)
	r = &schedRun{clock: at("2026-11-01T18:10:00Z"), window: "03:00-05:00", zone: "UTC"}
	scheduledHooks(t, tb, r)
	if code, res := tb.scheduled(t, f); code != 0 || !res.Skipped || !strings.Contains(res.Detail, "outside the update window 03:00-05:00 UTC") {
		t.Fatalf("UTC team: %d %+v", code, res)
	}
}

// Answers running: the run waits for a quiet moment (never cuts them off) until the window closes, at most an hour,
// then leaves the update for the next check and records since when it waits.
func TestScheduledUpdateWaitsForQuiet(t *testing.T) {
	f := newFeedServer(t)
	f.channel("0.2.19", true)
	tb := schedBase(t, f)
	r := &schedRun{clock: at("2026-11-01T19:30:00Z"), window: "03:00-05:00", zone: "Asia/Seoul", turns: func(int) int { return 2 }} // 04:30 KST
	scheduledHooks(t, tb, r)
	code, res := tb.scheduled(t, f)
	if code != 0 || !res.Skipped || res.RootUpdated || res.AppUpdated || !strings.Contains(res.Detail, "2 running answer(s) did not finish by 05:00 KST (before the download)") {
		t.Fatalf("%d %+v", code, res)
	}
	if want := at("2026-11-01T20:00:00Z").t; !r.clock.now().Equal(want) {
		t.Fatalf("waited until %s, want the window's end %s", r.clock.now(), want)
	}
	if f.downloaded() != 0 || tb.file("root/mycel-launcher") != "old launcher" || currentVersion(tb.base) != "0.2.18" {
		t.Fatal("downloaded or changed while answers ran")
	}
	d := readDeferred(&env{base: tb.base})
	if d == nil || d.Version != "0.2.19" || d.Turns != 2 || !d.Since.Equal(at("2026-11-01T20:00:00Z").t) {
		t.Fatalf("deferred %+v", d)
	}
	// the next night: one answer ends after ten minutes; the update goes on then, and the record goes
	r2 := &schedRun{clock: at("2026-11-02T18:05:00Z"), window: "03:00-05:00", zone: "Asia/Seoul"}
	start := r2.clock.now()
	r2.turns = func(int) int {
		if r2.clock.now().Sub(start) < 10*time.Minute {
			return 1
		}
		return 0
	}
	scheduledHooks(t, tb, r2)
	code, res = tb.scheduled(t, f)
	if code != 0 || res.Skipped || !res.RootUpdated || !res.AppUpdated || r2.switched != "0.2.19" {
		t.Fatalf("next night: %d %+v", code, res)
	}
	if r2.clock.now().Sub(start) < 10*time.Minute || r2.clock.now().Sub(start) > 11*time.Minute {
		t.Fatalf("waited %v", r2.clock.now().Sub(start))
	}
	if readDeferred(&env{base: tb.base}) != nil {
		t.Fatal("deferred record left after the update")
	}

	// a long window: one run waits at most an hour (the next check carries on)
	f = newFeedServer(t)
	f.channel("0.2.19", true)
	tb = schedBase(t, f)
	r = &schedRun{clock: at("2026-11-01T13:00:00Z"), window: "22:00-06:00", zone: "Asia/Seoul", turns: func(int) int { return 1 }} // 22:00 KST
	scheduledHooks(t, tb, r)
	if code, res := tb.scheduled(t, f); code != 0 || !res.Skipped || !strings.Contains(res.Detail, "did not finish by 23:00 KST") || !r.clock.now().Equal(at("2026-11-01T14:00:00Z").t) {
		t.Fatalf("long window: %d %+v at %s", code, res, r.clock.now())
	}
}

// Answers that start while the release downloads: nothing of root/ is replaced; answers that start after the root
// files: the app switch (a server restart) waits too.
func TestScheduledUpdateDefersLateAnswers(t *testing.T) {
	f := newFeedServer(t)
	f.channel("0.2.19", true)
	tb := schedBase(t, f)
	r := &schedRun{clock: at("2026-11-01T18:10:00Z"), window: "03:00-05:00", zone: "Asia/Seoul", turns: func(n int) int {
		if n == 1 {
			return 0
		}
		return 3
	}}
	scheduledHooks(t, tb, r)
	code, res := tb.scheduled(t, f)
	if code != 0 || !res.Skipped || res.RootUpdated || !strings.Contains(res.Detail, "(root files not replaced)") || f.downloaded() != 1 {
		t.Fatalf("%d %+v", code, res)
	}
	if tb.file("root/mycel-launcher") != "old launcher" || tb.file("root/VERSION") != "0.2.18" || currentVersion(tb.base) != "0.2.18" {
		t.Fatal("root files replaced while answers ran")
	}
	// quiet for the root files, busy again before the switch
	f = newFeedServer(t)
	f.channel("0.2.19", true)
	tb = schedBase(t, f)
	r = &schedRun{clock: at("2026-11-01T18:10:00Z"), window: "03:00-05:00", zone: "Asia/Seoul", turns: func(n int) int {
		if n <= 2 {
			return 0
		}
		return 1
	}}
	scheduledHooks(t, tb, r)
	code, res = tb.scheduled(t, f)
	if code != 0 || res.Skipped || !res.RootUpdated || res.AppUpdated || r.switched != "" || !strings.Contains(res.Detail, "(the app not switched yet)") {
		t.Fatalf("app: %d %+v", code, res)
	}
	if tb.file("root/mycel-launcher") != "launcher 0.2.19" || currentVersion(tb.base) != "0.2.18" || readDeferred(&env{base: tb.base}) == nil {
		t.Fatal("root files not installed, or the app switched, or no record")
	}
	// the next check (quiet): root files are there already, the app follows
	r = &schedRun{clock: at("2026-11-01T18:30:00Z"), window: "03:00-05:00", zone: "Asia/Seoul"}
	scheduledHooks(t, tb, r)
	if code, res := tb.scheduled(t, f); code != 0 || res.Skipped || res.RootUpdated || !res.AppUpdated || r.switched != "0.2.19" {
		t.Fatalf("next check: %d %+v", code, res)
	}
}

// The last resort: a root release that found no quiet moment for three days goes in after --max-wait.
func TestScheduledUpdateLastResort(t *testing.T) {
	f := newFeedServer(t)
	f.channel("0.2.19", true)
	tb := schedBase(t, f)
	clock := at("2026-11-05T18:10:00Z")
	b, _ := json.Marshal(deferredUpdate{Version: "0.2.19", Since: at("2026-11-02T18:00:00Z").t, Turns: 4})
	must(t, os.WriteFile(filepath.Join(tb.base, "root/update-deferred.json"), b, 0o644))
	r := &schedRun{clock: clock, window: "03:00-05:00", zone: "Asia/Seoul", turns: func(int) int { return 4 }}
	scheduledHooks(t, tb, r)
	start := clock.now()
	code, res := tb.update(t, "--only-if-needs-root", "--scheduled", "--max-wait", "600", "--pubkey", f.key)
	if code != 0 || res.Skipped || !res.RootUpdated || !res.AppUpdated || r.switched != "0.2.19" || !strings.Contains(strings.Join(res.Notes, " "), "waited for a quiet moment since 2026-11-02T18:00:00Z") {
		t.Fatalf("%d %+v", code, res)
	}
	if w := clock.now().Sub(start); w < 10*time.Minute || w > 11*time.Minute {
		t.Fatalf("waited %v, want --max-wait", w)
	}
	if readDeferred(&env{base: tb.base}) != nil {
		t.Fatal("record left")
	}
	// two days are not enough: it waits for quiet as usual
	f = newFeedServer(t)
	f.channel("0.2.19", true)
	tb = schedBase(t, f)
	b, _ = json.Marshal(deferredUpdate{Version: "0.2.19", Since: at("2026-11-03T18:00:00Z").t, Turns: 4})
	must(t, os.WriteFile(filepath.Join(tb.base, "root/update-deferred.json"), b, 0o644))
	r = &schedRun{clock: at("2026-11-05T18:10:00Z"), window: "03:00-05:00", zone: "Asia/Seoul", turns: func(int) int { return 4 }}
	scheduledHooks(t, tb, r)
	if code, res := tb.scheduled(t, f); code != 0 || !res.Skipped || res.RootUpdated {
		t.Fatalf("two days: %d %+v", code, res)
	}
	if d := readDeferred(&env{base: tb.base}); d == nil || !d.Since.Equal(at("2026-11-03T18:00:00Z").t) {
		t.Fatalf("the first deferral's time must stay: %+v", d)
	}
}

// What the server account says only moves the time inside a day: an app without update-window, a window that never
// opens or nonsense give 03:00-05:00 in the team's zone (MYCEL_TEAM_TZ of /etc/default/<id>, else this machine's).
func TestScheduledUpdateDefaultWindow(t *testing.T) {
	for _, c := range []struct {
		name, window, zone, defaults, now string
		inside                            bool
		detail                            string
	}{
		{"old app, MYCEL_TEAM_TZ", "", "", "MYCEL_TEAM_TZ=Asia/Seoul\n", "2026-11-01T18:10:00Z", true, ""},
		{"old app, MYCEL_TEAM_TZ, afternoon", "", "", "MYCEL_TEAM_TZ=Asia/Seoul\n", "2026-11-02T04:30:00Z", false, "03:00-05:00 Asia/Seoul; the team's update window could not be read (exit status 2), so the default"},
		{"never opens", "00:00-00:00", "Asia/Seoul", "", "2026-11-01T18:10:00Z", true, ""},
		{"never opens, afternoon", "00:00-00:00", "Asia/Seoul", "", "2026-11-02T04:30:00Z", false, "never opens, so the default for root updates"},
		{"bad window", "25:00-26:00", "Asia/Seoul", "", "2026-11-02T04:30:00Z", false, "is not HH:MM-HH:MM"},
		{"bad zone", "03:00-05:00", "Mars/Olympus", "MYCEL_TEAM_TZ=Asia/Seoul\n", "2026-11-01T18:10:00Z", true, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFeedServer(t)
			f.channel("0.2.19", true)
			tb := schedBase(t, f)
			if c.defaults != "" {
				must(t, os.WriteFile(filepath.Join(defaultsDir, "mycel"), []byte(c.defaults), 0o644))
			}
			r := &schedRun{clock: at(c.now), window: c.window, zone: c.zone}
			scheduledHooks(t, tb, r)
			code, res := tb.scheduled(t, f)
			if code != 0 || res.Skipped == c.inside || (c.detail != "" && !strings.Contains(res.Detail, c.detail)) {
				t.Fatalf("%d %+v", code, res)
			}
			if c.defaults != "" && (len(r.asked) == 0 || r.asked[0] != "update-window MYCEL_TEAM_TZ=Asia/Seoul") {
				t.Fatalf("admin.js was not given the server's MYCEL_TEAM_TZ: %q", r.asked)
			}
		})
	}
}

// Nothing to do in the window: the feed is not newer, the release needs no root, or an administrator's update runs.
func TestScheduledUpdateNothingToDo(t *testing.T) {
	f := newFeedServer(t)
	f.channel("0.2.19", false) // app-only: the server applies it itself
	tb := schedBase(t, f)
	must(t, os.WriteFile(filepath.Join(tb.base, "root/update-deferred.json"), []byte(`{"version":"0.2.19","since":"2026-11-01T00:00:00Z","turns":1}`), 0o644))
	r := &schedRun{clock: at("2026-11-01T18:10:00Z"), window: "03:00-05:00", zone: "Asia/Seoul", turns: func(int) int { return 5 }}
	scheduledHooks(t, tb, r)
	if code, res := tb.scheduled(t, f); code != 0 || !res.Skipped || res.Detail != "release 0.2.19 does not change root files" || r.calls != 0 {
		t.Fatalf("%d %+v", code, res)
	}
	if readDeferred(&env{base: tb.base}) != nil {
		t.Fatal("record of a release that needs nothing kept")
	}
	// an administrator's update holds the lock: the timer's run is not a failure
	f = newFeedServer(t)
	f.channel("0.2.19", true)
	tb = schedBase(t, f)
	unlock, err := lockUpdate(filepath.Join(tb.base, "root/.update.lock"))
	must(t, err)
	defer unlock()
	r = &schedRun{clock: at("2026-11-01T18:10:00Z"), window: "03:00-05:00", zone: "Asia/Seoul"}
	scheduledHooks(t, tb, r)
	if code, res := tb.scheduled(t, f); code != 0 || !res.Skipped || res.Detail != "another update is running" {
		t.Fatalf("locked: %d %+v", code, res)
	}
	if code, _, errs := tb.ctl("", "update", "--scheduled", "--version", "0.2.19"); code != 2 || !strings.Contains(errs, "--scheduled takes the channel's release") {
		t.Fatalf("--scheduled --version: %d %s", code, errs)
	}
}

// P4: needsRoot compares only with the channel heads. A server that skipped a root release takes the root files when
// root/VERSION is older than the feed's rootSince, also when needsRoot is false; one at rootSince or newer does not.
func TestRootSince(t *testing.T) {
	for _, c := range []struct {
		needsRoot bool
		since     string
		root      string
		want      bool
	}{
		{true, "", "0.2.19", true},
		{false, "", "0.2.10", false}, // a feed from before rootSince: as before
		{false, "0.2.18", "0.2.17", true},
		{false, "0.2.18", "0.2.18", false},
		{false, "0.2.18", "0.2.19-pre.1", false},
		{false, "0.2.18", "0.2.18-pre.1", true},
		{false, "0.2.18", "", true},
		{false, "0.2.18", "garbage!", true},
		{false, "not a version!", "0.2.18", true},
	} {
		if got := rootNeeded(&ReleaseFeed{NeedsRoot: c.needsRoot, RootSince: c.since}, c.root); got != c.want {
			t.Errorf("needsRoot %v rootSince %q root %q: %v, want %v", c.needsRoot, c.since, c.root, got, c.want)
		}
	}
	// a server on 0.2.17 (root and app), the feed's 0.2.19 needs no root over 0.2.18 but 0.2.18 changed root files
	f := newFeedServer(t)
	publishSince(t, f, "/server/stable.json", "0.2.19", false, "0.2.18")
	tb, switched := feedBase(t, f, "0.2.17", "0.2.17")
	code, r := tb.update(t, "--only-if-needs-root", "--pubkey", f.key)
	if code != 0 || r.Skipped || !r.RootUpdated || !r.AppUpdated || *switched != "0.2.19" || tb.file("root/VERSION") != "0.2.19" {
		t.Fatalf("skipped a root release: %d %+v", code, r)
	}
	// a server whose root files are at 0.2.18 already: the server's own updater takes 0.2.19
	f = newFeedServer(t)
	publishSince(t, f, "/server/stable.json", "0.2.19", false, "0.2.18")
	tb, switched = feedBase(t, f, "0.2.18", "0.2.18")
	if code, r := tb.update(t, "--only-if-needs-root", "--pubkey", f.key); code != 0 || !r.Skipped || r.Detail != "release 0.2.19 does not change root files" || *switched != "" {
		t.Fatalf("root at rootSince: %d %+v", code, r)
	}
	// root files that already match a newer release: root/VERSION moves up, so the next check does not come back
	f = newFeedServer(t)
	publishSince(t, f, "/server/stable.json", "0.2.19", false, "0.2.19")
	tb, _ = feedBase(t, f, "0.2.19", "0.2.18")
	must(t, os.WriteFile(filepath.Join(tb.base, "root/mycel-launcher"), []byte("launcher 0.2.19"), 0o755))
	must(t, os.WriteFile(filepath.Join(tb.base, "root/mycel-ctl"), []byte("ctl"), 0o755))
	code, r = tb.update(t, "--only-if-needs-root", "--pubkey", f.key)
	if code != 0 || r.RootUpdated || tb.file("root/VERSION") != "0.2.19" || !strings.Contains(strings.Join(r.Notes, " "), "root files already match 0.2.19") {
		t.Fatalf("matching root files: %d %+v %q", code, r, tb.file("root/VERSION"))
	}
	if code, r := tb.update(t, "--only-if-needs-root", "--pubkey", f.key); code != 0 || !r.Skipped || f.downloaded() != 1 {
		t.Fatalf("again: %d %+v (downloads %d)", code, r, f.downloaded())
	}
}

// publishSince is feedServer.publish with a rootSince.
func publishSince(t *testing.T, f *feedServer, p, v string, needsRoot bool, since string) {
	arch := filepath.Join(t.TempDir(), v+"-linux-"+runtime.GOARCH+".tar.zst")
	mkArchive(t, signedBundle(t, v, f.priv, "launcher "+v), arch, nil)
	ab, err := os.ReadFile(arch)
	must(t, err)
	sum := sha256.Sum256(ab)
	feed := map[string]any{"version": v, "minFrom": "0.2.0", "needsRoot": needsRoot, "rootSince": since, "notes": "", "publishedAt": "2026-11-01T00:00:00Z",
		"bundles": []map[string]any{{"os": "linux", "arch": runtime.GOARCH, "url": f.srv.URL + "/bundles/" + v + ".tar.zst", "sha256": hex.EncodeToString(sum[:]), "size": len(ab)}}}
	body, _ := json.Marshal(feed)
	sig, _ := json.Marshal(map[string]string{"keyId": bundle.KeyID(f.priv.Public().(ed25519.PublicKey)), "sig": base64.StdEncoding.EncodeToString(ed25519.Sign(f.priv, body))})
	f.mu.Lock()
	defer f.mu.Unlock()
	f.files["/bundles/"+v+".tar.zst"] = ab
	f.files[p] = body
	f.files[p+".sig"] = sig
}

// P5: verify-bundle through app/current (a link) checks the folder it names.
func TestVerifyBundleThroughLink(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	k := base64.StdEncoding.EncodeToString(pub)
	app := t.TempDir()
	dir := signedBundle(t, "0.2.18", priv, "launcher")
	must(t, os.MkdirAll(filepath.Join(app, "versions"), 0o755))
	must(t, os.Rename(dir, filepath.Join(app, "versions", "0.2.18")))
	must(t, os.Symlink("versions/0.2.18", filepath.Join(app, "current")))
	for _, p := range []string{filepath.Join(app, "current"), filepath.Join(app, "current") + "/", filepath.Join(app, "versions", "0.2.18")} {
		if r := verifyPath(p, bundle.Options{Keys: []string{k}}); !r.OK || r.Version != "0.2.18" || !r.Signed || r.Files != 4 {
			t.Errorf("%s: %+v", p, r)
		}
	}
	// the folder-name rule follows the link: current -> versions/0.2.17 holding 0.2.18 is refused
	must(t, os.Rename(filepath.Join(app, "versions", "0.2.18"), filepath.Join(app, "versions", "0.2.17")))
	must(t, os.Remove(filepath.Join(app, "current")))
	must(t, os.Symlink("versions/0.2.17", filepath.Join(app, "current")))
	if r := verifyPath(filepath.Join(app, "current"), bundle.Options{Keys: []string{k}}); r.OK || !strings.Contains(r.Error, `folder is "0.2.17"`) {
		t.Fatalf("%+v", r)
	}
	// a link named like a version keeps the name rule of that name (it fails closed, as before)
	must(t, os.Symlink("versions/0.2.17", filepath.Join(app, "0.2.16")))
	if r := verifyPath(filepath.Join(app, "0.2.16"), bundle.Options{Keys: []string{k}}); r.OK || !strings.Contains(r.Error, `folder is "0.2.16"`) {
		t.Fatalf("%+v", r)
	}
	if r := verifyPath(filepath.Join(app, "nothing"), bundle.Options{Keys: []string{k}}); r.OK {
		t.Fatal("a missing path verified")
	}
}

// admin.js (switch, update-window) gets the server's MYCEL_ALLOW_UNSIGNED: an allow-unsigned install switches to an
// unsigned version mycel-ctl accepted (the e2e run from a signed 0.2.14 to an unsigned build stopped there)
func TestAdminEnvFollowsAllowUnsigned(t *testing.T) {
	in := testInstall(t, "/var/lib/mycel")
	has := func(env []string) bool {
		for _, v := range env {
			if v == "MYCEL_ALLOW_UNSIGNED=1" {
				return true
			}
		}
		return false
	}
	if has(adminEnv(in)) {
		t.Fatal("signed-only install gives admin.js MYCEL_ALLOW_UNSIGNED")
	}
	in.AllowUnsigned = true
	if !has(adminEnv(in)) || !has(serverEnv(in)) {
		t.Fatal("allow-unsigned install: admin.js and the server must agree")
	}
}

// Review round 1: what the server account says can move the root update but not stop it. A window between two checks
// (shorter than 30 minutes) is the default; a team window no check got into for three days gives the default window;
// when admin.js cannot answer, the last window it gave (root's copy) is used, not the server's own UTC clock.
func TestScheduledUpdateCannotBeStopped(t *testing.T) {
	f := newFeedServer(t)
	f.channel("0.2.19", true)
	tb := schedBase(t, f)
	r := &schedRun{clock: at("2026-11-01T18:10:00Z"), window: "03:20-03:29", zone: "Asia/Seoul"} // 03:10 KST
	scheduledHooks(t, tb, r)
	if code, res := tb.scheduled(t, f); code != 0 || res.Skipped || !res.RootUpdated {
		t.Fatalf("short window: %d %+v", code, res)
	}
	// a window that is never "now": the first check starts the count; three days later the default window applies, in
	// the zone root trusts (MYCEL_TEAM_TZ of /etc/default/<id>)
	f = newFeedServer(t)
	f.channel("0.2.19", true)
	tb = schedBase(t, f)
	must(t, os.WriteFile(filepath.Join(defaultsDir, "mycel"), []byte("MYCEL_TEAM_TZ=Asia/Seoul\n"), 0o644))
	r = &schedRun{clock: at("2026-11-01T18:10:00Z"), window: "12:00-13:00", zone: "Asia/Seoul"}
	scheduledHooks(t, tb, r)
	if code, res := tb.scheduled(t, f); code != 0 || !res.Skipped || !strings.Contains(res.Detail, "outside the update window 12:00-13:00 Asia/Seoul") {
		t.Fatalf("first: %d %+v", code, res)
	}
	r.clock = at("2026-11-04T18:10:00Z") // three days on, 03:10 KST
	scheduledHooks(t, tb, r)
	if code, res := tb.scheduled(t, f); code != 0 || res.Skipped || !res.RootUpdated {
		t.Fatalf("three days: %d %+v", code, res)
	}
	// a server account that names a zone where it is always midday: the rescue does not use that zone
	f = newFeedServer(t)
	f.channel("0.2.19", true)
	tb = schedBase(t, f)
	must(t, os.WriteFile(filepath.Join(defaultsDir, "mycel"), []byte("MYCEL_TEAM_TZ=UTC\n"), 0o644))
	r = &schedRun{clock: at("2026-11-01T03:10:00Z"), window: "03:00-05:00", zone: "Etc/GMT-7"} // 10:10 there, 03:10 UTC
	scheduledHooks(t, tb, r)
	if _, res := tb.scheduled(t, f); !res.Skipped || !strings.Contains(res.Detail, "outside the update window 03:00-05:00 Etc/GMT-7") {
		t.Fatalf("lying zone, first: %+v", res)
	}
	r.clock = at("2026-11-04T03:10:00Z")
	r.zone = "Etc/GMT+7" // and it keeps changing the zone
	scheduledHooks(t, tb, r)
	if code, res := tb.scheduled(t, f); code != 0 || res.Skipped || !res.RootUpdated {
		t.Fatalf("lying zone, three days: %d %+v", code, res)
	}
	// a rescue run is no pass: the count goes on
	if b, _ := os.ReadFile(filepath.Join(tb.base, "root/update-window-pass")); !strings.HasPrefix(string(b), "2026-11-01T03:10:00Z") {
		t.Fatalf("pass record %q", b)
	}
	// a check inside the team's window resets the count
	f = newFeedServer(t)
	f.channel("0.2.19", false)
	tb = schedBase(t, f)
	r = &schedRun{clock: at("2026-11-04T03:10:00Z"), window: "12:00-13:00", zone: "Asia/Seoul"} // 12:10 KST: inside
	scheduledHooks(t, tb, r)
	tb.scheduled(t, f)
	r.clock = at("2026-11-04T18:10:00Z")
	scheduledHooks(t, tb, r)
	if _, res := tb.scheduled(t, f); !res.Skipped || !strings.Contains(res.Detail, "outside the update window 12:00-13:00") {
		t.Fatalf("passed recently: %+v", res)
	}
	// admin.js cannot answer: the window it gave last, not 03:00-05:00 on the server's UTC clock
	f = newFeedServer(t)
	f.channel("0.2.19", true)
	tb = schedBase(t, f)
	r = &schedRun{clock: at("2026-11-02T04:30:00Z"), window: "03:00-05:00", zone: "Asia/Seoul"} // 13:30 KST
	scheduledHooks(t, tb, r)
	tb.scheduled(t, f)
	r.window = ""
	r.clock = at("2026-11-02T03:30:00Z") // 12:30 KST, 03:30 UTC
	scheduledHooks(t, tb, r)
	if _, res := tb.scheduled(t, f); !res.Skipped || !strings.Contains(res.Detail, "outside the update window 03:00-05:00 Asia/Seoul; admin.js did not answer") {
		t.Fatalf("cached window: %+v", res)
	}
}

// The server's own maintenance (a backup, a restore) counts like a running answer.
func TestScheduledUpdateWaitsForMaintenance(t *testing.T) {
	f := newFeedServer(t)
	f.channel("0.2.19", true)
	tb := schedBase(t, f)
	r := &schedRun{clock: at("2026-11-01T19:30:00Z"), window: "03:00-05:00", zone: "Asia/Seoul"}
	scheduledHooks(t, tb, r)
	must(t, os.MkdirAll(filepath.Join(tb.base, "status"), 0o755))
	write := func(m string) {
		must(t, os.WriteFile(filepath.Join(tb.base, "status/status.json"), []byte(fmt.Sprintf(`{"writtenAt":%q,"maintenance":%s}`, r.clock.now().Format(time.RFC3339Nano), m)), 0o644))
	}
	write(`"backup"`)
	old := updateTestHook
	updateTestHook = func(u *updater) { old(u); u.sleep = func(d time.Duration) { r.clock.sleep(d); write(`"backup"`) } }
	code, res := tb.scheduled(t, f)
	if code != 0 || !res.Skipped || !strings.Contains(res.Detail, "0 running answer(s) and the server's backup did not finish") {
		t.Fatalf("%d %+v", code, res)
	}
	// an old status file says nothing
	updateTestHook = old
	must(t, os.WriteFile(filepath.Join(tb.base, "status/status.json"), []byte(`{"writtenAt":"2026-11-01T00:00:00Z","maintenance":"backup"}`), 0o644))
	r.clock = at("2026-11-01T19:40:00Z")
	if code, res := tb.scheduled(t, f); code != 0 || res.Skipped || !res.RootUpdated {
		t.Fatalf("stale: %d %+v", code, res)
	}
}

// Any update that goes through clears the deferral (an administrator's too): the next release is not forced through.
func TestAdminUpdateClearsDeferral(t *testing.T) {
	f := newFeedServer(t)
	f.channel("0.2.19", true)
	tb, _ := feedBase(t, f, "0.2.18", "0.2.18")
	must(t, os.WriteFile(filepath.Join(tb.base, "root/update-deferred.json"), []byte(`{"version":"0.2.19","since":"2026-10-01T00:00:00Z","turns":1}`), 0o644))
	if code, r := tb.update(t, "--pubkey", f.key); code != 0 || r.Skipped {
		t.Fatalf("%d %+v", code, r)
	}
	if readDeferred(&env{base: tb.base}) != nil {
		t.Fatal("deferral kept after an administrator's update")
	}
}

// A scheduled run with the timer turned off (started by hand, or turned off meanwhile) does nothing.
func TestScheduledUpdateTimerOff(t *testing.T) {
	f := newFeedServer(t)
	f.channel("0.2.19", true)
	tb := schedBase(t, f)
	systemdRunDir = t.TempDir()
	must(t, os.WriteFile(filepath.Join(tb.fakeBin, "systemctl"), []byte("#!/bin/sh\n[ \"$1\" = is-enabled ] && { echo disabled; exit 1; }\nexit 0\n"), 0o755))
	r := &schedRun{clock: at("2026-11-01T18:10:00Z"), window: "03:00-05:00", zone: "Asia/Seoul"}
	scheduledHooks(t, tb, r)
	if code, res := tb.scheduled(t, f); code != 0 || !res.Skipped || !strings.Contains(res.Detail, "automatic updates are off") || f.downloaded() != 0 {
		t.Fatalf("%d %+v", code, res)
	}
}

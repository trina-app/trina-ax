package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The staged roll-out as the app decides it (server/src/system/rollout.ts): tests/unit/g-rollout.test.ts checks the
// same table there.
func TestRolloutMatchesServer(t *testing.T) {
	b, err := os.ReadFile("testdata/rollout.json")
	must(t, err)
	var tab struct {
		DefaultRamp []rampStep `json:"defaultRamp"`
		LastBucket  int        `json:"lastBucket"`
		Buckets     []struct {
			Salt, InstallID string
			Bucket          int
		} `json:"buckets"`
		Cases []struct {
			Why         string       `json:"why"`
			Rollout     *rolloutSpec `json:"rollout"`
			PublishedAt string       `json:"publishedAt"`
			Urgent      bool         `json:"urgent"`
			Channel     string       `json:"channel"`
			InstallID   string       `json:"installId"`
			Now         string       `json:"now"`
			Percent     float64      `json:"percent"`
			In          bool         `json:"in"`
			Wait        bool         `json:"wait"`
			Turn        *string      `json:"turn"`
		} `json:"cases"`
	}
	must(t, json.Unmarshal(b, &tab))
	if len(tab.Buckets) < 10 || len(tab.Cases) < 25 || tab.LastBucket != lastBucket || len(tab.DefaultRamp) != 3 {
		t.Fatalf("rollout table not read: %d buckets, %d cases, last bucket %d", len(tab.Buckets), len(tab.Cases), tab.LastBucket)
	}
	for _, c := range tab.Buckets {
		if got := rolloutBucket(c.Salt, c.InstallID); got != c.Bucket {
			t.Errorf("bucket(%q, %q) = %d, want %d", c.Salt, c.InstallID, got, c.Bucket)
		}
	}
	for _, c := range tab.Cases {
		f := &ReleaseFeed{Version: "1.1.0", PublishedAt: c.PublishedAt, Urgent: c.Urgent, Rollout: c.Rollout}
		now, err := time.Parse(time.RFC3339Nano, c.Now)
		must(t, err)
		if got := rolloutPercent(f, c.Channel, now); got != c.Percent {
			t.Errorf("%s: percent %v, want %v", c.Why, got, c.Percent)
		}
		if got := inRollout(f, c.InstallID, c.Channel, now); got != c.In {
			t.Errorf("%s: in %v, want %v", c.Why, got, c.In)
		}
		w := rolloutTurn(f, c.InstallID, c.Channel, now)
		if w.wait != c.Wait {
			t.Errorf("%s: wait %v, want %v", c.Why, w.wait, c.Wait)
			continue
		}
		if !c.Wait {
			continue
		}
		switch {
		case c.Turn == nil && w.at != nil:
			t.Errorf("%s: turn %s, want none", c.Why, w.at)
		case c.Turn != nil && w.at == nil:
			t.Errorf("%s: no turn, want %s", c.Why, *c.Turn)
		case c.Turn != nil:
			want, err := time.Parse(time.RFC3339Nano, *c.Turn)
			must(t, err)
			if !w.at.Equal(want) {
				t.Errorf("%s: turn %s, want %s", c.Why, w.at.Format(time.RFC3339Nano), *c.Turn)
			}
		}
	}
}

// The update timer of 0.4.0-beta.2 and older (this ReleaseFeed without urgent and rollout) reads a ramped feed as
// before: encoding/json skips the fields it does not know.
func TestOldTimerReadsARampedFeed(t *testing.T) {
	type oldFeed struct {
		Version     string `json:"version"`
		MinFrom     string `json:"minFrom"`
		NeedsRoot   bool   `json:"needsRoot"`
		RootSince   string `json:"rootSince"`
		Notes       string `json:"notes"`
		PublishedAt string `json:"publishedAt"`
		Bundles     []struct {
			OS, Arch, URL, Sha256 string
			Size                  int64
		} `json:"bundles"`
	}
	body := []byte(`{"version":"0.5.0","minFrom":null,"urgent":false,"needsRoot":true,"rootSince":"0.5.0","notes":"n","publishedAt":"2026-11-04T01:00:00.000Z","bundles":[],` +
		`"minReaderRequired":3,"rollout":{"percent":100,"salt":"3f9a1c7e5b2d4086a1e0c9b8f7d6e5a4","ramp":[{"afterHours":0,"percent":10},{"afterHours":24,"percent":50},{"afterHours":48,"percent":100}]}}`)
	var f oldFeed
	if err := json.Unmarshal(body, &f); err != nil || f.Version != "0.5.0" || !f.NeedsRoot || f.RootSince != "0.5.0" {
		t.Fatalf("old reader: %v %+v", err, f)
	}
	var g ReleaseFeed
	must(t, json.Unmarshal(body, &g))
	if g.Rollout == nil || len(g.Rollout.Ramp) != 3 || g.Rollout.Percent != 100 {
		t.Fatalf("new reader: %+v", g.Rollout)
	}
}

const testSalt = "3f9a1c7e5b2d4086a1e0c9b8f7d6e5a4"

// a ramped root release published at 2026-11-01T00:00:00Z: 10% at once, 50% after 24 h, everyone after 48 h
func rampFeed(extra map[string]any) map[string]any {
	m := map[string]any{"rollout": map[string]any{"percent": 100, "salt": testSalt, "ramp": []map[string]any{
		{"afterHours": 0, "percent": 10}, {"afterHours": 24, "percent": 50}, {"afterHours": 48, "percent": 100}}}}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

func scheduledAt(t *testing.T, f *feedServer, clock, installID string) (*testBase, *schedRun) {
	tb := schedBase(t, f)
	r := &schedRun{clock: at(clock), window: "03:00-05:00", zone: "Asia/Seoul", installID: installID}
	scheduledHooks(t, tb, r)
	return tb, r
}

// The update timer waits for this server's turn in the staged roll-out (bucket of install-0: 62, the third wave; of
// install-3: 18, the second; of install-4: 3, the first) and installs in the first window from then on. Nothing is
// downloaded while it waits.
func TestScheduledUpdateWaitsForItsTurn(t *testing.T) {
	f := newFeedServer(t)
	f.publishWith("/server/stable.json", "0.2.19", true, rampFeed(nil))

	// day 1, 03:10 KST: the third wave waits for 48 h after publishing (09:00 KST on 11-03)
	tb, _ := scheduledAt(t, f, "2026-11-01T18:10:00Z", "install-0")
	code, res := tb.scheduled(t, f)
	if code != 0 || !res.Skipped || res.RootUpdated || res.AppUpdated ||
		res.Detail != "release 0.2.19 is in a staged roll-out: this server's turn comes at 2026-11-03 09:00 KST (`sudo mycel-ctl update` installs it now)" {
		t.Fatalf("day 1: %d %+v", code, res)
	}
	if f.downloaded() != 0 || tb.file("root/mycel-launcher") != "old launcher" || currentVersion(tb.base) != "0.2.18" {
		t.Fatal("something changed before this server's turn")
	}
	if _, err := os.Stat(filepath.Join(tb.base, "root/update-deferred.json")); err == nil {
		t.Fatal("waiting for the turn is not a deferral (no quiet moment)")
	}
	if b, _ := os.ReadFile(filepath.Join(tb.base, "root/update-window.json")); strings.Contains(string(b), "install") {
		t.Fatalf("the install id is kept in root's 0644 copy: %s", b)
	}
	// day 3, 03:10 KST (after 48 h): it installs
	tb, r := scheduledAt(t, f, "2026-11-03T18:10:00Z", "install-0")
	code, res = tb.scheduled(t, f)
	if code != 0 || res.Skipped || !res.RootUpdated || !res.AppUpdated || r.switched != "0.2.19" {
		t.Fatalf("day 3: %d %+v", code, res)
	}

	// the second wave: not on day 1, on day 2
	tb, _ = scheduledAt(t, f, "2026-11-01T18:10:00Z", "install-3")
	if _, res := tb.scheduled(t, f); !res.Skipped || !strings.Contains(res.Detail, "this server's turn comes at 2026-11-02 09:00 KST") {
		t.Fatalf("second wave, day 1: %+v", res)
	}
	tb, r = scheduledAt(t, f, "2026-11-02T18:10:00Z", "install-3")
	if code, res := tb.scheduled(t, f); code != 0 || res.Skipped || r.switched != "0.2.19" {
		t.Fatalf("second wave, day 2: %d %+v", code, res)
	}

	// the first wave: at once
	tb, r = scheduledAt(t, f, "2026-11-01T18:10:00Z", "install-4")
	if code, res := tb.scheduled(t, f); code != 0 || res.Skipped || !res.RootUpdated || r.switched != "0.2.19" {
		t.Fatalf("first wave: %d %+v", code, res)
	}
}

// No install id (an admin.js that does not say it, or does not answer): the last wave, at 48 h; never left out.
func TestScheduledUpdateWithoutInstallIDIsTheLastWave(t *testing.T) {
	f := newFeedServer(t)
	f.publishWith("/server/stable.json", "0.2.19", true, rampFeed(nil))
	tb, _ := scheduledAt(t, f, "2026-11-02T18:10:00Z", "")
	if code, res := tb.scheduled(t, f); code != 0 || !res.Skipped || !strings.Contains(res.Detail, "this server's turn comes at 2026-11-03 09:00 KST") {
		t.Fatalf("day 2: %d %+v", code, res)
	}
	tb, r := scheduledAt(t, f, "2026-11-03T18:10:00Z", "")
	if code, res := tb.scheduled(t, f); code != 0 || res.Skipped || r.switched != "0.2.19" {
		t.Fatalf("day 3: %d %+v", code, res)
	}
	// MYCEL_INSTALL_ID of /etc/default/<id> is the app's install id too, and comes first
	tb, r = scheduledAt(t, f, "2026-11-01T18:10:00Z", "install-0")
	must(t, os.WriteFile(filepath.Join(defaultsDir, "mycel"), []byte("MYCEL_TEAM_TZ=Asia/Seoul\nMYCEL_INSTALL_ID=install-4\n"), 0o644))
	if code, res := tb.scheduled(t, f); code != 0 || res.Skipped || r.switched != "0.2.19" {
		t.Fatalf("MYCEL_INSTALL_ID: %d %+v", code, res)
	}
}

// An urgent release and a server on the beta channel do not ramp; an administrator's `mycel-ctl update` never waits;
// a feed without a roll-out is taken as before.
func TestScheduledUpdateRolloutSkips(t *testing.T) {
	f := newFeedServer(t)
	f.publishWith("/server/stable.json", "0.2.19", true, rampFeed(map[string]any{"urgent": true}))
	tb, r := scheduledAt(t, f, "2026-11-01T18:10:00Z", "install-0")
	if code, res := tb.scheduled(t, f); code != 0 || res.Skipped || r.switched != "0.2.19" {
		t.Fatalf("urgent: %d %+v", code, res)
	}

	f = newFeedServer(t)
	f.publishWith("/server/stable.json", "0.2.19", true, rampFeed(nil))
	tb, r = scheduledAt(t, f, "2026-11-01T18:10:00Z", "install-0")
	must(t, os.WriteFile(filepath.Join(tb.base, "config/server.json"), []byte(`{"update":{"channel":"beta","feedUrl":"`+f.srv.URL+`/server/stable.json"}}`), 0o644))
	if code, res := tb.scheduled(t, f); code != 0 || res.Skipped || r.switched != "0.2.19" {
		t.Fatalf("beta channel: %d %+v", code, res)
	}

	// an administrator: `sudo mycel-ctl update` takes it at once, any wave, any time
	tb, r = scheduledAt(t, f, "2026-11-01T06:00:00Z", "install-0")
	if code, res := tb.update(t, "--pubkey", f.key); code != 0 || res.Skipped || !res.RootUpdated || r.switched != "0.2.19" {
		t.Fatalf("by hand: %d %+v", code, res)
	}

	// no roll-out in the feed: as before
	f = newFeedServer(t)
	f.channel("0.2.19", true)
	tb, r = scheduledAt(t, f, "2026-11-01T18:10:00Z", "install-0")
	if code, res := tb.scheduled(t, f); code != 0 || res.Skipped || r.switched != "0.2.19" {
		t.Fatalf("no roll-out: %d %+v", code, res)
	}
}

// A release published while the scheduled run waited for a quiet moment is not installed by that run: the gate decided
// on the one before (its window, hold and roll-out), and the next check's gate decides on the new one (review finding:
// a ramped 0.2.20 at 10% went in on day 0 whatever the server's bucket).
func TestScheduledUpdateKeepsTheReleaseItDecidedOn(t *testing.T) {
	f := newFeedServer(t)
	f.channel("0.2.19", true) // no roll-out: this server may take it now
	tb, r := scheduledAt(t, f, "2026-11-01T18:10:00Z", "install-0")
	r.turns = func(call int) int {
		if call == 1 {
			// published during the wait, ramped from now: install-0 (bucket 62) waits 48 h for it
			f.publishWith("/server/stable.json", "0.2.20", true, rampFeed(map[string]any{"publishedAt": "2026-11-01T18:10:00Z"}))
			return 1
		}
		return 0
	}
	code, res := tb.scheduled(t, f)
	if code != 0 || !res.Skipped || res.RootUpdated || res.AppUpdated || f.downloaded() != 0 ||
		res.Detail != "the feed moved from 0.2.19 to 0.2.20 while this run waited for a quiet moment; the next check decides on 0.2.20" {
		t.Fatalf("%d %+v (downloads %d)", code, res, f.downloaded())
	}
	// the next check: 0.2.20 is not this server's turn yet
	r.turns = nil
	if code, res := tb.scheduled(t, f); code != 0 || !res.Skipped || !strings.Contains(res.Detail, "release 0.2.20 is in a staged roll-out: this server's turn comes at 2026-11-04 03:10 KST") {
		t.Fatalf("next check: %d %+v", code, res)
	}
}

// The root files of the version that runs catch up without waiting (the app already took that release).
func TestScheduledRootCatchUpDoesNotWait(t *testing.T) {
	f := newFeedServer(t)
	f.publishWith("/server/stable.json", "0.2.19", true, rampFeed(nil))
	tb, _ := scheduledAt(t, f, "2026-11-01T18:10:00Z", "install-0")
	must(t, os.MkdirAll(filepath.Join(tb.base, "app/versions/0.2.19/bin"), 0o755))
	must(t, os.Remove(filepath.Join(tb.base, "app/current")))
	must(t, os.Symlink("versions/0.2.19", filepath.Join(tb.base, "app/current")))
	tb.health.Store("0.2.19")
	if code, res := tb.scheduled(t, f); code != 0 || res.Skipped || !res.RootUpdated || tb.file("root/VERSION") != "0.2.19" {
		t.Fatalf("%d %+v", code, res)
	}
}

// `mycel-ctl status` says when this server's turn comes for the release the app last saw on the feed.
func TestStatusShowsTheTurn(t *testing.T) {
	tb, _ := switchBase(t, true)
	statusScheduleHook = func(u *updater) {
		u.runAsSrv = func([]string, []string) (string, error) {
			return `{"window":"02:00-04:00","timeZone":"Asia/Seoul","custom":true,"installId":"install-0"}`, nil
		}
	}
	published := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	check := func(feed map[string]any) {
		feed["version"], feed["publishedAt"], feed["bundles"] = "0.2.19", published.Format(time.RFC3339), []any{}
		b, _ := json.Marshal(map[string]any{"at": time.Now().UTC().Format(time.RFC3339), "error": nil, "feed": feed})
		must(t, os.WriteFile(filepath.Join(tb.base, "data/update-check.json"), b, 0o600))
	}
	check(rampFeed(nil))
	seoul, _ := loadZone("Asia/Seoul")
	want := "release 0.2.19 is in a staged roll-out: this server's turn comes at " + published.Add(48*time.Hour).In(seoul).Format("2006-01-02 15:04 MST")
	code, out, _ := tb.ctl("", "status")
	if code != 0 || !strings.Contains(out, want) {
		t.Fatalf("%d\n%s\nwant %q", code, out, want)
	}
	code, out, _ = tb.ctl("", "status", "--detail", "--json")
	var st Status
	if code != 0 || json.Unmarshal([]byte(out), &st) != nil || st.Updates == nil || st.Updates.Rollout == nil || st.Updates.Rollout.Version != "0.2.19" ||
		st.Updates.Rollout.TurnAt == nil || !st.Updates.Rollout.TurnAt.Equal(published.Add(48*time.Hour)) || st.Updates.Rollout.Bucket != 62 {
		t.Fatalf("json: %d %s", code, out)
	}
	// its turn has come, or no roll-out: nothing said
	check(map[string]any{})
	if _, out, _ := tb.ctl("", "status"); strings.Contains(out, "staged roll-out") {
		t.Fatalf("no roll-out, but:\n%s", out)
	}
	check(rampFeed(map[string]any{"urgent": true}))
	if _, out, _ := tb.ctl("", "status"); strings.Contains(out, "staged roll-out") {
		t.Fatalf("urgent, but:\n%s", out)
	}
}

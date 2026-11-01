package main

// When the root update timer may update (update audit 2026-11-01, P2). <id>-update.timer fires every 15 minutes in
// server time; `mycel-ctl update --scheduled` (its job) then goes on only
//
//   - inside the team's update window, in the team's time zone: Admin > Settings > Update time, the same window the
//     app's own updater keeps (server/src/system/update-job.ts inWindow, DEFAULT_UPDATE_WINDOW 03:00-05:00), read
//     through the running app's admin.js (`update-window`, as the server account) and kept in root/update-window.json
//     for when admin.js cannot answer (an older app after a roll-back). A window that never opens (equal ends; the app
//     stores an invalid window that way), one shorter than 30 minutes (the checks are 15 minutes apart, plus up to 5
//     minutes of the timer's random delay) or nothing readable gives 03:00-05:00 in the team's zone; and a team window
//     no check has passed for three days (root/update-window-pass) gives 03:00-05:00 too. So a team setting (or a
//     server account that lies) can move the root update but never stop it: `mycel-ctl auto-update off` does;
//   - when no answer runs and the server runs no maintenance (a backup, a restore: status/status.json). It waits for
//     a quiet moment until the window closes (at most an hour per run; the next check of the window carries on), and
//     never cuts a running answer off. A root release that found no quiet moment for three days
//     (root/update-deferred.json) is installed in the next window after the old wait of --max-wait seconds, running
//     answers or not, so a team that is always busy (or a server account that keeps answers going) cannot hold the
//     launcher and the sandbox back for longer than that;
//   - not for a release whose update failed or was rolled back here a short while ago (root/update-failed.json,
//     0.2.19 review S1): 20 hours after the first failure (the next day's window), then 44 and 92 hours, at most a
//     week. An administrator's `mycel-ctl update` ignores the hold; a newer release in the feed ends it. Without it
//     every check of the window downloaded the release again (about 600 MB) and restarted the server. The root files
//     go in before the app is switched, so a failure the app causes (a server account that lies) holds back only the
//     app, never the launcher and the sandbox.
//
// Outside the window the check ends at once, without network. Before 0.2.19 the timer ran at 04:30 + up to 90 minutes
// in the server's own zone (UTC on most Linux servers: 13:30-15:00 in Korea) and cut answers off after 10 minutes.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	_ "time/tzdata" // the team's zone on a server without /usr/share/zoneinfo

	"mycel/native/internal/bundle"
)

// defaultUpdateWindow is server/src/system/update-job.ts DEFAULT_UPDATE_WINDOW (testdata/update-window.json checks
// both sides).
const defaultUpdateWindow = "03:00-05:00"

const (
	// scheduleRunWait: the longest one scheduled run waits for a quiet moment (the timer's next check goes on after it)
	scheduleRunWait = time.Hour
	// scheduleLastResort: a root release deferred this long is installed after --max-wait even with answers running
	scheduleLastResort = 72 * time.Hour
	// schedulePoll: how often a waiting run asks the launcher again
	schedulePoll = 5 * time.Second
	// scheduleMinWindow: a shorter window could fall between two checks every day
	scheduleMinWindow = 30
)

var (
	windowRe = regexp.MustCompile(`^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$`)
	zoneRe   = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_+\-]*(/[A-Za-z0-9_+\-]+){0,3}$`)
)

// updateWindow is "HH:mm-HH:mm" as minutes after midnight; it may pass midnight ("23:00-01:00").
type updateWindow struct{ from, to int }

func parseWindow(s string) (updateWindow, bool) {
	m := windowRe.FindStringSubmatch(s)
	if m == nil {
		return updateWindow{}, false
	}
	n := func(x string) int { return int(x[0]-'0')*10 + int(x[1]-'0') }
	return updateWindow{n(m[1])*60 + n(m[2]), n(m[3])*60 + n(m[4])}, true
}

func (w updateWindow) String() string {
	return fmt.Sprintf("%02d:%02d-%02d:%02d", w.from/60, w.from%60, w.to/60, w.to%60)
}

// open: equal ends never open (update-job.ts inWindow: from <= to && at >= from && at < to).
func (w updateWindow) open() bool { return w.from != w.to }

// minutes the window lasts (0 for one that never opens)
func (w updateWindow) minutes() int { return ((w.to-w.from)%1440 + 1440) % 1440 }

// contains: the wall-clock time of t (in t's zone) is inside the window, like inWindow.
func (w updateWindow) contains(t time.Time) bool {
	at := t.Hour()*60 + t.Minute()
	if w.from <= w.to {
		return at >= w.from && at < w.to
	}
	return at >= w.from || at < w.to
}

// end is the first moment after t (inside the window, in t's zone) when the window closes.
func (w updateWindow) end(t time.Time) time.Time {
	y, mo, d := t.Date()
	e := time.Date(y, mo, d, w.to/60, w.to%60, 0, 0, t.Location())
	if !e.After(t) {
		e = time.Date(y, mo, d+1, w.to/60, w.to%60, 0, 0, t.Location())
	}
	return e
}

// validZone: an IANA zone name this program knows (the app checks the same with Intl; the name is the server
// account's, so it is checked before LoadLocation sees it).
func loadZone(name string) (*time.Location, bool) {
	if len(name) > 64 || !zoneRe.MatchString(name) || strings.Contains(name, "..") {
		return nil, false
	}
	l, err := time.LoadLocation(name)
	return l, err == nil
}

// updateSchedule is the window a scheduled run keeps, in its zone.
type updateSchedule struct {
	w    updateWindow
	loc  *time.Location
	zone string
	// note says why it is not the team's own window ("" when it is)
	note string
}

func (s updateSchedule) String() string {
	t := s.w.String() + " " + s.zone
	if s.note != "" {
		t += "; " + s.note
	}
	return t
}

// defaultsValue is NAME's value in /etc/default/<id> (the server unit's EnvironmentFile; the last assignment wins, as
// for systemd), "" when it is not set.
func defaultsValue(id, name string) string {
	b, err := readRootFile(filepath.Join(defaultsDir, id), 64<<10)
	if err != nil {
		return ""
	}
	v := ""
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		k, x, ok := strings.Cut(strings.TrimSpace(sc.Text()), "=")
		if ok && strings.TrimSpace(k) == name {
			v = strings.Trim(strings.TrimSpace(x), `"'`)
		}
	}
	return v
}

// fallbackZone is the zone the app gives a team that chose none (time-zone.ts defaultTimeZone): MYCEL_TEAM_TZ of the
// server's environment, else this machine's own.
func fallbackZone(id string) (*time.Location, string) {
	if z := defaultsValue(id, "MYCEL_TEAM_TZ"); z != "" {
		if l, ok := loadZone(z); ok {
			return l, z
		}
	}
	name, _ := time.Now().Zone()
	return time.Local, "the server's own time zone (" + name + ")"
}

// readSchedule asks the running app for the team's window and zone (admin.js update-window, as the server account,
// with the server's MYCEL_TEAM_TZ so a team without a zone gets the server's default). What the server account says
// only moves the time inside a day; anything unreadable gives the default window.
func (u *updater) readSchedule() updateSchedule {
	var env []string
	if z := defaultsValue(u.in.ID, "MYCEL_TEAM_TZ"); z != "" {
		if _, ok := loadZone(z); ok {
			env = append(env, "MYCEL_TEAM_TZ="+z)
		}
	}
	def, _ := parseWindow(defaultUpdateWindow)
	got, err := windowAnswer(u.runAsSrv([]string{"update-window"}, env))
	via := ""
	if err != nil {
		// the app that runs is older than its root files and has no update-window (the bootstrap rolled a 0.2.19 back
		// to 0.2.18 before any check read the window, 0.2.19 review S1): the root files' version (root/VERSION, root's
		// own record) has its app folder there, and its admin.js reads the same settings, read only. Without it a UTC
		// server would retry at 03:00-05:00 UTC, midday in Korea.
		if v := u.rootFilesApp(); v != "" {
			if g, verr := windowAnswer(u.runVersionAdmin(v, []string{"update-window"}, env)); verr == nil {
				got, err, via = g, nil, v
			}
		}
	}
	if err != nil {
		msg := strings.TrimSpace(err.Error())
		if len(msg) > 120 {
			msg = msg[:120] + "…"
		}
		// the last answer that could be read (root's own copy): a UTC server must not fall back to 03:00 UTC
		if b, rerr := readRootFile(u.e.root("update-window.json"), 4<<10); rerr == nil && json.Unmarshal(b, &got) == nil && got.Window != "" {
			s := u.scheduleOf(got.Window, got.TimeZone)
			s.note = joinNote("admin.js did not answer ("+msg+"), so the last window it gave", s.note)
			return s
		}
		loc, zone := fallbackZone(u.in.ID)
		return updateSchedule{w: def, loc: loc, zone: zone, note: "the team's update window could not be read (" + msg + "), so the default"}
	}
	// kept only when it is a real window and zone (it is read back with a 4 KiB limit)
	_, wok := parseWindow(got.Window)
	_, zok := loadZone(got.TimeZone)
	if b, _ := json.Marshal(got); wok && zok && len(b) < 512 {
		if old, rerr := readRootFile(u.e.root("update-window.json"), 4<<10); rerr != nil || string(old) != string(b)+"\n" {
			_ = writeRootFile(u.e.root("update-window.json"), append(b, '\n'), 0o644)
		}
	}
	s := u.scheduleOf(got.Window, got.TimeZone)
	if via != "" {
		s.note = joinNote("read by "+via+"'s admin.js (the app that runs, "+orNone(currentVersion(u.e.base))+", cannot tell it)", s.note)
	}
	return s
}

type windowReply struct {
	Window   string `json:"window"`
	TimeZone string `json:"timeZone"`
}

// windowAnswer reads admin.js update-window's output: its JSON line (other lines, a warning on stderr, are skipped).
func windowAnswer(out string, err error) (windowReply, error) {
	var got windowReply
	if err != nil {
		return got, err
	}
	for _, l := range strings.Split(out, "\n") {
		l = strings.TrimSpace(l)
		var g windowReply
		if strings.HasPrefix(l, "{") && json.Unmarshal([]byte(l), &g) == nil && g.Window != "" {
			return g, nil
		}
	}
	return got, errors.New("no answer")
}

// rootFilesApp names the version whose admin.js may answer update-window when the app that runs does not: the root
// files' version (root/VERSION), when it is newer than 0.2.18 (it has the command), is not what runs (that was asked
// already) and its folder holds an admin.js. "" for none.
func (u *updater) rootFilesApp() string {
	v := rootVersion(u.e)
	if u.runVersionAdmin == nil || !bundle.ValidVersion(v) || v == currentVersion(u.e.base) || compareVersions(v, lastOldUpdater) <= 0 {
		return ""
	}
	if st, err := os.Lstat(filepath.Join(u.e.base, "app", "versions", v, "server", "src", "admin.js")); err != nil || !st.Mode().IsRegular() {
		return ""
	}
	return v
}

// scheduleOf checks what admin.js said (the server account's answer): a known zone, a window that opens and lasts.
func (u *updater) scheduleOf(window, zone string) updateSchedule {
	def, _ := parseWindow(defaultUpdateWindow)
	got := struct{ Window, TimeZone string }{window, zone}
	s := updateSchedule{w: def}
	if l, ok := loadZone(got.TimeZone); ok {
		s.loc, s.zone = l, got.TimeZone
	} else {
		s.loc, s.zone = fallbackZone(u.in.ID)
		s.note = fmt.Sprintf("the team's time zone %q is unknown here", got.TimeZone)
	}
	switch w, ok := parseWindow(got.Window); {
	case !ok:
		s.note = joinNote(s.note, fmt.Sprintf("the team's window %q is not HH:MM-HH:MM, so the default", got.Window))
	case !w.open():
		s.note = joinNote(s.note, "the team's window "+w.String()+" never opens, so the default for root updates")
	case w.minutes() < scheduleMinWindow:
		s.note = joinNote(s.note, fmt.Sprintf("the team's window %s is shorter than %d minutes (the checks are 15 minutes apart), so the default", w, scheduleMinWindow))
	default:
		s.w = w
	}
	return s
}

func joinNote(a, b string) string {
	if a == "" || b == "" {
		return a + b
	}
	return a + "; " + b
}

// ---------- root/update-window-pass: the last check the team's window let through ----------

// windowPassed reads when a check last got inside the window; a missing record starts the count now.
func windowPassed(e *env) time.Time {
	if b, err := readRootFile(e.root("update-window-pass"), 256); err == nil {
		if t, err := time.Parse(time.RFC3339, strings.TrimSpace(string(b))); err == nil {
			return t
		}
	}
	notePass(e)
	return e.now()
}

func notePass(e *env) {
	_ = writeRootFile(e.root("update-window-pass"), []byte(e.now().UTC().Format(time.RFC3339)+"\n"), 0o644)
}

// ---------- root/update-deferred.json: since when a root release waits for a quiet moment ----------

type deferredUpdate struct {
	Version string    `json:"version"`
	Since   time.Time `json:"since"`
	Turns   int       `json:"turns"`
}

func readDeferred(e *env) *deferredUpdate {
	b, err := readRootFile(e.root("update-deferred.json"), 4<<10)
	if err != nil {
		return nil
	}
	var d deferredUpdate
	if json.Unmarshal(b, &d) != nil || d.Since.IsZero() {
		return nil
	}
	return &d
}

// noteDeferred records that version waits (the first deferral's time stays: the server is behind since then).
func noteDeferred(e *env, version string, turns int) {
	d := deferredUpdate{Version: version, Since: e.now().UTC().Truncate(time.Second), Turns: turns}
	if old := readDeferred(e); old != nil && old.Since.Before(d.Since) {
		d.Since = old.Since
	}
	b, _ := json.Marshal(d)
	_ = writeRootFile(e.root("update-deferred.json"), append(b, '\n'), 0o644)
}

func clearDeferred(e *env) {
	if err := os.Remove(e.root("update-deferred.json")); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return
	}
}

// ---------- root/update-failed.json: a release that failed here, which the update timer leaves for a while ----------

// failedUpdate is the release whose update last failed or was rolled back here (0.2.19 review S1: the 15-minute
// timer downloaded it again, about 600 MB, and restarted the server at every check of the window). The update timer
// leaves that version until Until; an administrator's `mycel-ctl update` ignores the hold. A newer release in the
// feed ends it, and so does an update to it or past it. Root's file (0644: Admin > Diagnostics reads it).
type failedUpdate struct {
	Version  string    `json:"version"`
	Result   string    `json:"result"`
	Detail   string    `json:"detail,omitempty"`
	At       time.Time `json:"at"`
	Failures int       `json:"failures"`
	Until    time.Time `json:"until"`
}

// failHoldMax: the longest hold, the app's own AUTO_HOLD_MS (server/src/system/update-job.ts)
const failHoldMax = 7 * 24 * time.Hour

// failHold is the hold after the n-th failure in a row of one version: 20 hours, so the next day's window opens again
// (also after a failure late in a window up to 4 hours long), then 44 and 92 hours, then a week.
func failHold(n int) time.Duration {
	d := 20 * time.Hour
	for i := 1; i < n && d < failHoldMax; i++ {
		d = 2*d + 4*time.Hour
	}
	if d > failHoldMax {
		d = failHoldMax
	}
	return d
}

func readFailed(e *env) *failedUpdate {
	b, err := readRootFile(e.root("update-failed.json"), 8<<10)
	if err != nil {
		return nil
	}
	var f failedUpdate
	if json.Unmarshal(b, &f) != nil || !bundle.ValidVersion(f.Version) || f.At.IsZero() || f.Until.IsZero() {
		return nil
	}
	return &f
}

// active: the hold lasts at now. One that ends more than failHoldMax ahead (the clock went back since) does not count.
func (f *failedUpdate) active(now time.Time) bool {
	return now.Before(f.Until) && f.Until.Sub(now) <= failHoldMax
}

func (f *failedUpdate) String() string {
	what := "failed"
	if f.Result == "rolled_back" {
		what = "was rolled back"
	}
	d := f.Detail
	if d != "" {
		d = ": " + d
	}
	return fmt.Sprintf("release %s %s here at %s (%s%s; %d time(s) in a row): the update timer tries it again after %s; `sudo mycel-ctl update` tries it now",
		f.Version, what, f.At.UTC().Format(time.RFC3339), f.Result, d, f.Failures, f.Until.UTC().Format(time.RFC3339))
}

// noteFailed records a failure of version (a second one of the same version in a row holds it longer).
func noteFailed(e *env, version, result, detail string) *failedUpdate {
	now := e.now().UTC().Truncate(time.Second)
	detail = strings.Join(strings.Fields(detail), " ")
	if r := []rune(detail); len(r) > 300 {
		detail = string(r[:300]) + "…"
	}
	f := failedUpdate{Version: version, Result: result, Detail: detail, At: now, Failures: 1}
	if old := readFailed(e); old != nil && old.Version == version && old.Failures > 0 {
		f.Failures = min(old.Failures+1, 100)
	}
	f.Until = now.Add(failHold(f.Failures))
	b, _ := json.Marshal(f)
	_ = writeRootFile(e.root("update-failed.json"), append(b, '\n'), 0o644)
	return &f
}

func clearFailed(e *env) {
	_ = os.Remove(e.root("update-failed.json"))
}

// clearFailedUpTo ends a hold of version or an older one (an update reached it; a newer release came).
func clearFailedUpTo(e *env, version string) {
	if f := readFailed(e); f != nil && version != "" && compareVersions(version, f.Version) >= 0 {
		clearFailed(e)
	}
}

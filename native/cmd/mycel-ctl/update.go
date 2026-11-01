package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
	"mycel/native/internal/bundle"
)

// UpdateResult is `mycel-ctl update --json` (spec 3.6.5 step 6). Exit codes: ok 0, rolled_back 10, verify_failed 20,
// busy 30 (another update holds the lock), error 1.
type UpdateResult struct {
	From        string   `json:"from"`
	To          string   `json:"to"`
	Result      string   `json:"result"`
	RootUpdated bool     `json:"rootUpdated"`
	AppUpdated  bool     `json:"appUpdated"`
	Skipped     bool     `json:"skipped,omitempty"`
	Detail      string   `json:"detail,omitempty"`
	Notes       []string `json:"notes,omitempty"`
	DurationMs  int64    `json:"durationMs"`
}

var resultCodes = map[string]int{"ok": 0, "rolled_back": 10, "verify_failed": 20, "busy": 30, "error": 1}

// ReleaseFeed is server/src/system/update.ts ReleaseFeed (the signed channel manifest <feed>/server/<channel>.json).
// A Linux bundle is the entry with os "linux" and the machine's arch. rootSince (feeds from 0.2.19 on): the oldest
// release with the same root files as this one (rootNeeded). needsRoot: in a feed without rootSince, the release's
// root files differ from those of the channel heads it was published over; in one with rootSince, it is kept for the
// updaters of 0.2.18 and older, which read only needsRoot (publish-server.ts: true while rootSince is newer than
// 0.2.18, so such a server never takes a release without the root files it needs).
type ReleaseFeed struct {
	Version     string `json:"version"`
	MinFrom     string `json:"minFrom"`
	NeedsRoot   bool   `json:"needsRoot"`
	RootSince   string `json:"rootSince"`
	Notes       string `json:"notes"`
	PublishedAt string `json:"publishedAt"`
	Bundles     []struct {
		OS     string `json:"os"`
		Arch   string `json:"arch"`
		URL    string `json:"url"`
		Sha256 string `json:"sha256"`
		Size   int64  `json:"size"`
	} `json:"bundles"`
}

type updater struct {
	e             *env
	in            *Install
	keys          []string
	maxWait       time.Duration
	healthTimeout time.Duration
	work          string
	arch          string
	res           *UpdateResult
	// scheduled: the update timer's run (--scheduled, schedule.go): wait for a quiet moment until quietBy, and leave
	// the update for later rather than cut answers off, unless force (the last resort)
	scheduled bool
	quietBy   time.Time
	force     bool
	busy      int
	busyWith  string
	deferred  bool
	turnedOff bool
	// attempted: the run began to bring the release in (a download, or a --bundle unpacked); a failure from then on
	// holds the release from the update timer (root/update-failed.json, schedule.go)
	attempted bool
	// hooks for tests (default: the real thing)
	liveTurns func() (int, error)
	runAsSrv  func(args []string, env []string) (string, error)
	// runVersionAdmin runs app/versions/<v>'s admin.js as the server account (nil: not asked)
	runVersionAdmin func(v string, args []string, env []string) (string, error)
	restartSrv      func() error
	sleep           func(time.Duration)
	// maintenance is the server's own operation running now (a backup, a restore), "" for none (status/status.json)
	maintenance func() string
}

// errDeferred: a scheduled run left the update for later (answers kept running); nothing is an error.
var errDeferred = errors.New("deferred")

// updateTestHook replaces the parts of an update that need a real launcher and server account (tests only).
var updateTestHook func(u *updater)

func cmdUpdate(e *env, args []string) (int, error) {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	e.flags(fs)
	version := fs.String("version", "", "update to this version (from the feed; an older one too: a roll-back); default: the channel's newest, only when it is newer than the app that runs")
	bundleFile := fs.String("bundle", "", "update from this release archive (<v>-linux-<arch>.tar.zst) instead of the feed")
	onlyRoot := fs.Bool("only-if-needs-root", false, "do nothing unless the release changes root files (the update timer)")
	scheduled := fs.Bool("scheduled", false, "the update timer: only inside the team's update window (team time zone) and only when no answer runs; waits for a quiet moment instead of interrupting answers")
	asJSON := fs.Bool("json", false, "JSON output")
	maxWait := fs.Int("max-wait", 600, "seconds to wait for running turns before replacing root files")
	healthWait := fs.Int("health-timeout", 180, "seconds to wait for the new version's /api/health")
	var extra multiFlag
	fs.Var(&extra, "pubkey", "extra release public key (base64 Ed25519; key rotation and tests)")
	if err := fs.Parse(args); err != nil {
		return 2, usageError{err.Error()}
	}
	if *version != "" && *bundleFile != "" {
		return 2, usageError{"--version and --bundle exclude each other"}
	}
	if *scheduled && (*version != "" || *bundleFile != "") {
		return 2, usageError{"--scheduled takes the channel's release: not with --version or --bundle"}
	}
	if *version != "" && !bundle.ValidVersion(*version) {
		return 2, usageError{"bad --version"}
	}
	if err := requireRoot(); err != nil {
		return 2, err
	}
	if err := checkBase(e.base); err != nil {
		return 1, err
	}
	start := e.now()
	res := &UpdateResult{From: currentVersion(e.base), Result: "error"}
	finish := func(code int, err error) (int, error) {
		res.DurationMs = e.now().Sub(start).Milliseconds()
		if err != nil && res.Detail == "" {
			res.Detail = err.Error()
		}
		if *asJSON {
			printJSON(e.stdout, res)
		} else if res.Skipped {
			fmt.Fprintf(e.stdout, "%s: nothing changed, %s stays: %s\n", res.Result, orNone(res.From), res.Detail)
		} else {
			fmt.Fprintf(e.stdout, "%s: %s -> %s (root files updated: %v, app updated: %v) %s\n", res.Result, orNone(res.From), orNone(res.To), res.RootUpdated, res.AppUpdated, res.Detail)
		}
		if code != 0 && err == nil {
			err = fmt.Errorf("%s", res.Result)
		}
		return code, err
	}
	in, err := loadInstall(e)
	if err != nil {
		return finish(1, err)
	}
	u := &updater{e: e, in: in, keys: append(append([]string{}, bundle.ReleaseKeys...), extra...), maxWait: time.Duration(*maxWait) * time.Second,
		healthTimeout: time.Duration(*healthWait) * time.Second, arch: runtime.GOARCH, res: res, scheduled: *scheduled}
	u.liveTurns = u.launcherLiveTurns
	u.runAsSrv = u.runAsServer
	u.runVersionAdmin = u.runVersionAsServer
	u.restartSrv = u.restartServer
	u.sleep = time.Sleep
	u.maintenance = u.serverMaintenance
	if updateTestHook != nil {
		updateTestHook(u)
	}
	if u.scheduled {
		// the window and a quiet moment first, without the lock: an administrator's `mycel-ctl update` meanwhile is not
		// "busy", and nothing is downloaded while answers run
		if goOn, err := u.gate(*onlyRoot); err != nil || !goOn {
			if errors.Is(err, errDeferred) {
				err = nil
			}
			if err != nil && res.Result == "ok" {
				res.Result = "error"
			}
			return finish(resultCodes[res.Result], err)
		}
	}
	unlock, err := lockUpdate(e.root(".update.lock"))
	if err != nil {
		res.Result = "busy"
		if u.scheduled {
			// an administrator's update runs now: the timer has nothing to do
			res.Result, res.Skipped, res.Detail = "ok", true, "another update is running"
			return finish(0, nil)
		}
		return finish(30, err)
	}
	defer unlock()
	// what runs now (the scheduled gate waited without the lock: an administrator may have updated meanwhile)
	res.From = currentVersion(e.base)
	err = u.run(*version, *bundleFile, *onlyRoot)
	if errors.Is(err, errDeferred) {
		err = nil
	}
	if err != nil && res.Result == "ok" {
		res.Result = "error"
	}
	switch {
	case err == nil && res.Result == "ok" && !res.Skipped && !u.deferred:
		clearDeferred(e) // any update that went through (an administrator's too): nothing waits any more
		clearFailedUpTo(e, res.To)
	case res.Result != "ok" && u.attempted && bundle.ValidVersion(res.To):
		// the release came in and then failed (an administrator's run too): the update timer leaves it for a while
		// instead of downloading it and restarting the server again at every check of the window (0.2.19 review S1)
		detail := res.Detail
		if detail == "" && err != nil {
			detail = err.Error()
		}
		h := noteFailed(e, res.To, res.Result, detail)
		// it found its quiet moment: after the hold, the next try waits for one again rather than the last resort
		clearDeferred(e)
		res.Notes = append(res.Notes, h.String())
	}
	return finish(resultCodes[res.Result], err)
}

// gate is the scheduled run's first part (schedule.go): inside the team's window, a release this server needs, and a
// quiet moment. false: nothing to do now (res says why).
func (u *updater) gate(onlyRoot bool) (bool, error) {
	if u.timerTurnedOff() {
		u.res.Result, u.res.Skipped, u.res.Detail = "ok", true, "automatic updates are off ("+u.in.ID+"-update.timer disabled)"
		return false, nil
	}
	s := u.readSchedule()
	now := u.e.now().In(s.loc)
	if !s.w.contains(now) {
		// no check got inside the team's window for three days (a window that falls between two checks, or a server
		// account that keeps moving the window or the zone): 03:00-05:00 in a zone root trusts (MYCEL_TEAM_TZ of
		// /etc/default/<id>, else this machine's), not in the zone the server account said. Such a run does not
		// count as a pass, so the count goes on until the team's own window lets a check in again.
		def, _ := parseWindow(defaultUpdateWindow)
		loc, zone := fallbackZone(u.in.ID)
		if since := windowPassed(u.e); u.e.now().Sub(since) >= scheduleLastResort && def.contains(u.e.now().In(loc)) {
			s = updateSchedule{w: def, loc: loc, zone: zone, note: "no check got inside the team's window (" + s.String() + ") since " + since.UTC().Format(time.RFC3339) + ", so the default"}
			now = u.e.now().In(loc)
		} else {
			u.res.Result, u.res.Skipped, u.res.Detail = "ok", true, "outside the update window "+s.String()
			return false, nil
		}
	} else {
		notePass(u.e)
	}
	feed, err := u.fetchFeed("")
	if err != nil {
		return false, err
	}
	u.res.To = feed.Version
	root := rootVersion(u.e)
	why := notNewer(feed.Version, u.res.From, root)
	if why == "" && onlyRoot && !rootJob(feed, root, u.res.From) {
		why = "release " + feed.Version + " does not change root files"
	}
	if why == "" && feed.Version == u.res.From && root == feed.Version {
		why = "already at " + feed.Version
	}
	if why != "" {
		clearDeferred(u.e)
		clearFailedUpTo(u.e, u.res.From) // a hold of a version the app has reached is over
		u.res.Result, u.res.Skipped, u.res.Detail = "ok", true, why
		return false, nil
	}
	// a release that failed here a short while ago waits (root/update-failed.json); a newer one ends the hold
	if h := readFailed(u.e); h != nil {
		switch {
		case compareVersions(feed.Version, h.Version) > 0:
			clearFailed(u.e)
		case feed.Version == h.Version && h.active(u.e.now()):
			u.res.Result, u.res.Skipped, u.res.Detail = "ok", true, h.String()
			return false, nil
		}
	}
	u.quietBy = s.w.end(now)
	if lim := now.Add(scheduleRunWait); lim.Before(u.quietBy) {
		u.quietBy = lim
	}
	if d := readDeferred(u.e); d != nil && u.e.now().Sub(d.Since) >= scheduleLastResort {
		// the last resort: the old wait, then on (answers still running then are interrupted)
		u.force, u.quietBy = true, u.e.now().Add(u.maxWait)
		u.res.Notes = append(u.res.Notes, fmt.Sprintf("a root update has waited for a quiet moment since %s: installing after at most %v even with answers running", d.Since.Format(time.RFC3339), u.maxWait))
	}
	quiet := u.waitQuiet(u.quietBy)
	if u.turnedOff {
		u.res.Result, u.res.Skipped, u.res.Detail = "ok", true, "automatic updates were turned off while it waited"
		return false, nil
	}
	if quiet || u.force {
		return true, nil
	}
	return false, u.deferUpdate(feed.Version, "before the download")
}

// timerTurnedOff: the scheduled job's timer is disabled now (`mycel-ctl auto-update off`, systemctl disable): a run
// started by hand, or one that waited while it was turned off, does nothing more.
func (u *updater) timerTurnedOff() bool {
	if !u.scheduled || !u.in.Systemd || !fileExists(systemdRunDir) {
		return false
	}
	out, _ := exec.Command(u.e.systemctl, "is-enabled", u.in.ID+"-update.timer").Output()
	return strings.TrimSpace(string(out)) == "disabled"
}

// deferUpdate ends a scheduled run that found no quiet moment (nothing changed after `when`): the next check in the
// window tries again; the first deferral's time is kept for the last resort.
func (u *updater) deferUpdate(version, when string) error {
	if u.turnedOff {
		u.res.Result, u.res.Skipped = "ok", !u.res.RootUpdated
		u.res.Detail = "automatic updates were turned off while it waited (" + when + ")"
		return errDeferred
	}
	noteDeferred(u.e, version, u.busy)
	u.deferred = true
	u.res.Result, u.res.Skipped = "ok", !u.res.RootUpdated
	what := fmt.Sprintf("%d running answer(s)", u.busy)
	if u.busyWith != "" {
		what = fmt.Sprintf("%d running answer(s) and the server's %s", u.busy, u.busyWith)
	}
	u.res.Detail = fmt.Sprintf("%s did not finish by %s (%s); the update to %s waits for a quiet moment in the update window",
		what, u.quietBy.Format("15:04 MST"), when, version)
	return errDeferred
}

// serverMaintenance is the operation the server reports in status/status.json (written every 30 s; the server
// account's file, read without following a link): a backup, a restore, an update, an export. Older or missing: "".
func (u *updater) serverMaintenance() string {
	b, err := readSmall(filepath.Join(u.e.base, "status", "status.json"), 1<<20)
	if err != nil {
		return ""
	}
	var st struct {
		WrittenAt   string  `json:"writtenAt"`
		Maintenance *string `json:"maintenance"`
	}
	if json.Unmarshal(b, &st) != nil || st.Maintenance == nil || *st.Maintenance == "" {
		return ""
	}
	at, err := time.Parse(time.RFC3339Nano, st.WrittenAt)
	if err != nil || u.e.now().Sub(at) > 2*time.Minute {
		return ""
	}
	m := *st.Maintenance
	if len(m) > 40 || strings.ContainsAny(m, "\n\r") {
		m = "maintenance"
	}
	return m
}

// lockUpdate takes BASE/root/.update.lock (flock); a second update at the same time is "busy".
func lockUpdate(p string) (func(), error) {
	f, err := os.OpenFile(p, os.O_RDWR|os.O_CREATE|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("another update is running")
	}
	return func() { _ = unix.Flock(int(f.Fd()), unix.LOCK_UN); f.Close() }, nil
}

func (u *updater) run(version, bundleFile string, onlyRoot bool) error {
	work, err := u.workDir()
	if err != nil {
		return err
	}
	u.work = work
	defer os.RemoveAll(work)
	dir := filepath.Join(work, "bundle")
	needsRoot := true
	if bundleFile != "" {
		u.attempted = true
		if err := extractBundle(bundleFile, dir); err != nil {
			u.res.Result = "verify_failed"
			return err
		}
	} else {
		feed, err := u.fetchFeed(version)
		if err != nil {
			return err
		}
		u.res.To, needsRoot = feed.Version, rootJob(feed, rootVersion(u.e), u.res.From)
		if version == "" {
			if why := notNewer(feed.Version, u.res.From, rootVersion(u.e)); why != "" {
				u.res.Result, u.res.Skipped, u.res.Detail = "ok", true, why
				return nil
			}
		}
		if onlyRoot && !needsRoot {
			u.res.Result, u.res.Skipped, u.res.Detail = "ok", true, "release "+feed.Version+" does not change root files"
			return nil
		}
		if feed.Version == u.res.From && rootVersion(u.e) == feed.Version {
			u.res.Result, u.res.Skipped, u.res.Detail = "ok", true, "already at "+feed.Version
			return nil
		}
		if feed.MinFrom != "" && u.res.From != "" && compareVersions(u.res.From, feed.MinFrom) < 0 {
			return fmt.Errorf("%s cannot update to %s by itself (needs %s or newer first)", u.res.From, feed.Version, feed.MinFrom)
		}
		u.attempted = true
		if err := u.download(feed, dir); err != nil {
			return err
		}
	}
	m, err := bundle.VerifyDir(dir, "", bundle.Options{Keys: u.keys, AllowUnsigned: u.in.AllowUnsigned})
	if err != nil {
		u.res.Result = "verify_failed"
		return err
	}
	if version != "" && m.Version != version {
		u.res.Result = "verify_failed"
		return fmt.Errorf("the bundle is version %s, not %s", m.Version, version)
	}
	u.res.To = m.Version
	if err := u.updateRoot(dir, m.Version); err != nil {
		return err
	}
	if onlyRoot && !u.res.RootUpdated && bundleFile != "" {
		u.res.Result, u.res.Skipped, u.res.Detail = "ok", true, "the release changes no root files"
		return nil
	}
	if m.Version == u.res.From {
		u.res.Result = "ok"
		return nil
	}
	return u.updateApp(dir, m.Version)
}

// lastOldUpdater is the last release whose updaters (the app's own and mycel-ctl) read only the feed's needsRoot and
// whose admin.js has no `update-window` (rootSince and the windowed update timer came with 0.2.19).
const lastOldUpdater = "0.2.18"

// rootNeeded: does this server need the release's root files? rootSince names the oldest release with this release's
// root files, so root/VERSION older than it (or missing, or not a version) needs them; one at rootSince or newer has
// them. needsRoot only compared with the releases at the channel heads when it was published, which a server that
// skipped a release can miss (update audit P4: 0.2.17 root files, a 0.2.18 that changed them, a 0.2.19 that did not),
// and in a feed with rootSince it is the flag for 0.2.18 and older (true while rootSince is newer than 0.2.18), so it
// is not read here. A feed without rootSince (published before 0.2.19) keeps the old meaning. The same rule as
// server/src/system/update.ts releaseNeedsRoot.
func rootNeeded(f *ReleaseFeed, root string) bool {
	if f.RootSince == "" {
		return f.NeedsRoot
	}
	if !bundle.ValidVersion(f.RootSince) || root == "" || !bundle.ValidVersion(root) {
		return true
	}
	return compareVersions(root, f.RootSince) < 0
}

// rootJob: is the release the root update timer's (--only-if-needs-root)? Its root files are needed here, or the app
// that runs is 0.2.18 or older (a server whose app the bootstrap rolled back to one, 0.2.19 review S3) and reads only
// needsRoot: it refuses a release with needsRoot, so root installs it, the root files already in place (and so when
// no app/current is there to take it).
func rootJob(f *ReleaseFeed, root, app string) bool {
	return rootNeeded(f, root) || f.NeedsRoot && (app == "" || compareVersions(app, lastOldUpdater) <= 0)
}

// notNewer says why the channel's newest release (an update without --version: the update timer, a plain
// `mycel-ctl update`) is not installed, or "" to go on. Like the app's own updater (server/src/system/update.ts
// status, update-job.ts autoUpdateDecision), it must be newer than the version that runs: a pre-release or a test
// build newer than the channel stays when the feed still names an older release. The same version is skipped too,
// unless root files are older than it or root/VERSION is missing (the app came to it without them): then only the
// root files catch up. --version and --bundle are an admin's explicit choice (a roll-back too) and are not checked:
// root files newer than the release stay anyway (updateRoot), and the app goes to the version asked for.
func notNewer(feed, app, root string) string {
	if app == "" {
		return "" // no app/current: nothing runs that a downgrade could replace
	}
	switch c := compareVersions(feed, app); {
	case c < 0:
		return fmt.Sprintf("the feed's release %s is older than the installed %s, not installed (to go back to it, run `mycel-ctl update --version %s`)", feed, app, feed)
	case c == 0 && root != "" && compareVersions(root, feed) >= 0:
		if root != feed {
			return "already at " + feed + " (root files " + root + ")"
		}
		return "already at " + feed
	}
	return ""
}

// workDir is a fresh folder under BASE/.install-tmp (root 700; the installer and mycel-ctl share it). An update-*
// folder already there was left by an update that was killed before its deferred RemoveAll (a downloaded archive and
// the unpacked bundle, about 600 MB): the caller holds root/.update.lock, so no other update can be using it, and
// it is removed first (RemoveAll does not follow links; nobody but root can write this folder anyway).
func (u *updater) workDir() (string, error) {
	t := filepath.Join(u.e.base, ".install-tmp")
	if err := os.Mkdir(t, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
		return "", err
	}
	var st syscall.Stat_t
	if err := syscall.Lstat(t, &st); err != nil || st.Mode&syscall.S_IFMT != syscall.S_IFDIR || int(st.Uid) != rootUID || st.Mode&0o077 != 0 {
		return "", fmt.Errorf("%s must be a root-only folder (700)", t)
	}
	if ents, err := os.ReadDir(t); err == nil {
		for _, d := range ents {
			if !strings.HasPrefix(d.Name(), "update-") {
				continue
			}
			if err := os.RemoveAll(filepath.Join(t, d.Name())); err != nil {
				u.res.Notes = append(u.res.Notes, "could not remove a folder an earlier update left: "+err.Error())
			} else {
				u.res.Notes = append(u.res.Notes, "removed "+d.Name()+", left in .install-tmp by an earlier update that did not finish")
			}
		}
	}
	return os.MkdirTemp(t, "update-")
}

// ---------- feed ----------

type serverJSON struct {
	Update struct {
		Channel string  `json:"channel"`
		FeedURL *string `json:"feedUrl"`
	} `json:"update"`
}

func (u *updater) feedURL() (string, error) {
	b, err := os.ReadFile(filepath.Join(u.e.base, "config", "server.json"))
	if err != nil {
		return "", err
	}
	var c serverJSON
	if err := json.Unmarshal(b, &c); err != nil {
		return "", fmt.Errorf("server.json: %v", err)
	}
	if c.Update.FeedURL == nil || *c.Update.FeedURL == "" {
		return "", fmt.Errorf("no update feed configured (server.json update.feedUrl)")
	}
	return *c.Update.FeedURL, nil
}

// allowedURL: https, or plain http to this machine (tests with a local feed).
func allowedURL(raw string) error {
	x, err := url.Parse(raw)
	if err != nil || x.User != nil {
		return fmt.Errorf("bad URL %q", raw)
	}
	if x.Scheme == "https" {
		return nil
	}
	if x.Scheme == "http" {
		if ip := net.ParseIP(x.Hostname()); ip != nil && ip.IsLoopback() {
			return nil
		}
	}
	return fmt.Errorf("URL must be https: %s", raw)
}

var httpClient = &http.Client{
	Timeout: 30 * time.Minute,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) > 5 || allowedURL(req.URL.String()) != nil {
			return fmt.Errorf("redirect refused")
		}
		return nil
	},
}

func fetchSmall(raw string, max int64) ([]byte, error) {
	if err := allowedURL(raw); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", raw, nil)
	r, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return nil, fmt.Errorf("%s: HTTP %d", raw, r.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, max+1))
	if int64(len(b)) > max {
		return nil, fmt.Errorf("%s: too large", raw)
	}
	return b, err
}

// fetchFeed reads the channel feed (or, for an older --version, <feed folder>/<version>/release.json) and its .sig,
// signed with a release key; returns the verified feed.
func (u *updater) fetchFeed(version string) (*ReleaseFeed, error) {
	fu, err := u.feedURL()
	if err != nil {
		return nil, err
	}
	feed, err := u.signedFeed(fu)
	if err != nil {
		return nil, err
	}
	if version != "" && feed.Version != version {
		x, _ := url.Parse(fu)
		x.Path = path.Join(path.Dir(x.Path), version, "release.json")
		if feed, err = u.signedFeed(x.String()); err != nil {
			return nil, err
		}
		if feed.Version != version {
			return nil, fmt.Errorf("release.json of %s says %s", version, feed.Version)
		}
	}
	return feed, nil
}

func (u *updater) signedFeed(raw string) (*ReleaseFeed, error) {
	body, err := fetchSmall(raw, 1<<20)
	if err != nil {
		return nil, err
	}
	sig, err := fetchSmall(raw+".sig", 4<<10)
	if err != nil {
		return nil, err
	}
	if err := bundle.VerifySig(body, sig, u.keys); err != nil {
		u.res.Result = "verify_failed"
		return nil, err
	}
	var f ReleaseFeed
	if err := json.Unmarshal(body, &f); err != nil || !bundle.ValidVersion(f.Version) {
		u.res.Result = "verify_failed"
		return nil, fmt.Errorf("release feed unreadable")
	}
	return &f, nil
}

// download fetches this machine's bundle of the feed (size and sha256 from the signed feed) and unpacks it.
func (u *updater) download(f *ReleaseFeed, dir string) error {
	for _, b := range f.Bundles {
		if b.OS != "linux" || b.Arch != u.arch {
			continue
		}
		if err := allowedURL(b.URL); err != nil {
			return err
		}
		file := filepath.Join(u.work, "bundle.tar.zst")
		out, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
		if err != nil {
			return err
		}
		r, err := httpClient.Get(b.URL)
		if err != nil {
			out.Close()
			return err
		}
		h := sha256.New()
		n, cerr := io.Copy(io.MultiWriter(out, h), io.LimitReader(r.Body, b.Size+1))
		r.Body.Close()
		if err := out.Close(); cerr == nil {
			cerr = err
		}
		if r.StatusCode != 200 {
			return fmt.Errorf("download: HTTP %d", r.StatusCode)
		}
		if cerr != nil {
			return cerr
		}
		if n != b.Size || hex.EncodeToString(h.Sum(nil)) != b.Sha256 {
			u.res.Result = "verify_failed"
			return fmt.Errorf("download does not match the release hash")
		}
		if err := extractBundle(file, dir); err != nil {
			u.res.Result = "verify_failed"
			return err
		}
		return nil
	}
	return fmt.Errorf("release %s has no bundle for linux-%s", f.Version, u.arch)
}

// ---------- root files ----------

// rootDiff lists the files of the bundle's root/ that differ from <base>/root (relative paths).
func rootDiff(bundleRoot, installed string) ([]string, error) {
	var diff []string
	err := filepath.WalkDir(bundleRoot, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.Type().IsRegular() {
			return nil
		}
		rel, _ := filepath.Rel(bundleRoot, p)
		want, _, err := bundle.HashFile(p)
		if err != nil {
			return err
		}
		have, _, herr := bundle.HashFile(filepath.Join(installed, rel))
		if herr != nil || have != want {
			diff = append(diff, rel)
		}
		return nil
	})
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	return diff, err
}

// updateRoot replaces changed root files (spec 3.6.5 step 3): staged in root/.new (copied, then the copies' hashes
// checked again: the bundle folder is only root's, but the check is cheap), installed after the running turns end
// (at most --max-wait), then units, firewall and launcher are refreshed. Root files newer than the bundle stay.
func (u *updater) updateRoot(dir, v string) error {
	if rv := rootVersion(u.e); rv != "" && compareVersions(rv, v) > 0 {
		u.res.Notes = append(u.res.Notes, "root files "+rv+" are newer than "+v+"; kept")
		return nil
	}
	src := filepath.Join(dir, "root")
	diff, err := rootDiff(src, u.e.root())
	if err != nil {
		return err
	}
	// root/<rel> -> its source in the verified bundle: the bundle's root/ files, and root's own copies of the programs
	// safe operations 1A run (safeops.go safeOpsCopies; the app's copies belong to the server account)
	from := map[string]string{}
	for _, rel := range diff {
		from[rel] = filepath.Join(src, rel)
	}
	for _, c := range safeOpsCopies {
		bsrc := filepath.Join(dir, filepath.FromSlash(c.Rel))
		if _, err := os.Lstat(bsrc); err != nil {
			continue // a bundle without it (tests, an older layout): the copy stays as it is
		}
		want, _, err := bundle.HashFile(bsrc)
		if err != nil {
			return err
		}
		rel := filepath.Join("safe-ops", c.Name)
		if have, _, err := bundle.HashFile(u.e.root(rel)); err != nil || have != want {
			diff = append(diff, rel)
			from[rel] = bsrc
		}
	}
	systemd := u.in.Systemd && fileExists(systemdRunDir)
	if len(diff) == 0 {
		// root files already those of v: say so (rootNeeded compares root/VERSION with the feed's rootSince, and a server
		// whose files are right would otherwise be sent here again by every check)
		if rv := rootVersion(u.e); rv == "" || compareVersions(rv, v) < 0 {
			if err := writeRootFile(u.e.root("VERSION"), []byte(v+"\n"), 0o644); err != nil {
				return err
			}
			u.res.Notes = append(u.res.Notes, "root files already match "+v+": root/VERSION is "+v+" now")
		}
		return u.syncUnits(systemd, false)
	}
	stage := u.e.root(".new")
	if err := os.RemoveAll(stage); err != nil {
		return err
	}
	if err := os.Mkdir(stage, 0o700); err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	for _, rel := range diff {
		if err := copyFile(from[rel], filepath.Join(stage, rel)); err != nil {
			return err
		}
		want, _, _ := bundle.HashFile(from[rel])
		got, _, err := bundle.HashFile(filepath.Join(stage, rel))
		if err != nil || got != want {
			u.res.Result = "verify_failed"
			return fmt.Errorf("copy of root/%s changed", rel)
		}
	}
	if !u.waitForTurns() {
		return u.deferUpdate(v, "root files not replaced")
	}
	units := false
	for _, rel := range diff {
		dest := u.e.root(rel)
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return err
		}
		if filepath.Dir(rel) == "safe-ops" {
			// the server account runs these: root/safe-ops is 755 whatever the umask of a `sudo mycel-ctl update`
			if _, err := ensureSafeOpsDir(u.e); err != nil {
				return err
			}
		}
		if err := os.Rename(filepath.Join(stage, rel), dest); err != nil {
			return err
		}
		if strings.HasPrefix(rel, "systemd/") {
			units = true
		}
	}
	if err := writeRootFile(u.e.root("VERSION"), []byte(v+"\n"), 0o644); err != nil {
		return err
	}
	u.res.RootUpdated = true
	if err := u.syncUnits(systemd, units); err != nil {
		return err
	}
	if _, err := firewallApply(u.e); err != nil {
		return fmt.Errorf("firewall: %v", err)
	}
	if systemd {
		if out, err := exec.Command(u.e.systemctl, "restart", u.in.ID+"-launcher.service").CombinedOutput(); err != nil {
			return fmt.Errorf("restart launcher: %v %s", err, out)
		}
	} else {
		u.res.Notes = append(u.res.Notes, "no systemd: restart `mycel-ctl supervise` to run the new root files")
	}
	return nil
}

// syncUnits renders the units from root/systemd and root/install.json on every update (not only when a template
// changed), so units an older tool left disagreeing with install.json (--allow-unsigned, update audit P3) are right
// again; daemon-reload when anything changed (or the templates did).
func (u *updater) syncUnits(systemd, templates bool) error {
	if !systemd {
		return nil
	}
	_, changed, err := renderUnits(u.in, u.e.root("systemd"), systemdUnitDir)
	if err != nil {
		return fmt.Errorf("units: %v", err)
	}
	if changed || templates {
		if out, err := exec.Command(u.e.systemctl, "daemon-reload").CombinedOutput(); err != nil {
			return fmt.Errorf("daemon-reload: %v %s", err, out)
		}
	}
	return nil
}

// copyFile copies a root file: executables 0755, the rest 0644, owner root (the process's own).
func copyFile(src, dest string) error {
	st, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file", src)
	}
	mode := os.FileMode(0o644)
	if st.Mode()&0o111 != 0 {
		mode = 0o755
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, mode)
	if err != nil {
		return err
	}
	_, cerr := io.Copy(out, in)
	if err := out.Close(); cerr == nil {
		cerr = err
	}
	if cerr == nil {
		cerr = os.Chmod(dest, mode)
	}
	return cerr
}

// waitForTurns waits until the launcher runs no turn before a restart. An administrator's update waits at most
// maxWait; turns still running then become "interrupted" when the launcher restarts (the server is not told to stop
// taking turns, spec 3.6.5). A scheduled run waits until quietBy and then gives up (false) instead, unless force.
func (u *updater) waitForTurns() bool {
	if !u.scheduled {
		u.waitQuiet(u.e.now().Add(u.maxWait))
		return true
	}
	return (u.waitQuiet(u.quietBy) || u.force) && !u.turnedOff
}

// waitQuiet asks the launcher until it runs no turn and the server runs no maintenance (true) or the deadline passes
// (false; u.busy and u.busyWith are the last answers).
func (u *updater) waitQuiet(deadline time.Time) bool {
	for i := 0; ; i++ {
		if i > 0 && i%12 == 0 && u.timerTurnedOff() { // about once a minute
			u.turnedOff = true
			return false
		}
		n, err := u.liveTurns()
		m := ""
		if u.maintenance != nil {
			m = u.maintenance()
		}
		if err == nil && n == 0 && m == "" {
			return true
		}
		u.busy, u.busyWith = n, m
		if !u.e.now().Before(deadline) {
			return false
		}
		u.sleep(schedulePoll)
	}
}

// launcherLiveTurns asks the launcher how many turns run. The launcher answers only the server account (peer
// check), so mycel-ctl runs itself once as that account (launcher-status-as-server). Without an answer (an older
// launcher, or none running) it counts the engine account's processes besides the launcher instead.
func (u *updater) launcherLiveTurns() (int, error) {
	if srv, err := lookupAccount(u.in.ServerUser); err == nil {
		self, _ := os.Executable()
		cmd := exec.Command(self, "launcher-status-as-server", "--sock", filepath.Join(u.e.base, "run-launcher", "launcher.sock"))
		cmd.Env = []string{"PATH=/usr/bin:/bin"}
		cmd.Dir = "/"
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(srv.uid), Gid: uint32(srv.gid), Groups: []uint32{}}}
		if out, err := cmd.Output(); err == nil {
			var st struct {
				Ev        string `json:"ev"`
				LiveTurns *int   `json:"liveTurns"`
			}
			if json.Unmarshal(out, &st) == nil && st.Ev == "status" && st.LiveTurns != nil {
				return *st.LiveTurns, nil
			}
		}
	}
	agt, err := lookupAccount(u.in.AgentUser)
	if err != nil {
		return 0, err
	}
	return countProcs(agt.uid, "mycel-launcher")
}

// countProcs counts processes of uid whose name is not except.
func countProcs(uid int, except string) (int, error) {
	ents, err := os.ReadDir("/proc")
	if err != nil {
		return 0, err
	}
	n := 0
	for _, e := range ents {
		if _, err := strconv.Atoi(e.Name()); err != nil {
			continue
		}
		var st syscall.Stat_t
		if syscall.Stat("/proc/"+e.Name(), &st) != nil || int(st.Uid) != uid {
			continue
		}
		comm, _ := os.ReadFile("/proc/" + e.Name() + "/comm")
		if strings.TrimSpace(string(comm)) == except {
			continue
		}
		n++
	}
	return n, nil
}

// cmdLauncherStatusChild runs as the server account (see launcherLiveTurns): one status request, the answer line.
func cmdLauncherStatusChild(e *env, args []string) (int, error) {
	fs := flag.NewFlagSet("launcher-status-as-server", flag.ContinueOnError)
	sock := fs.String("sock", "", "launcher.sock")
	if err := fs.Parse(args); err != nil || *sock == "" {
		return 2, usageError{"--sock"}
	}
	c, err := net.DialTimeout("unix", *sock, 3*time.Second)
	if err != nil {
		return 1, err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := c.Write([]byte(`{"op":"status"}` + "\n")); err != nil {
		return 1, err
	}
	line, err := bufio.NewReader(c).ReadString('\n')
	if err != nil && line == "" {
		return 1, err
	}
	fmt.Fprint(e.stdout, line)
	return 0, nil
}

// ---------- app ----------

// updateApp copies the verified version folder to app/versions/<v> (server account's, like the macOS installer),
// asks the running version to switch (admin.js switch: state.json pending + app/current, as the server account),
// restarts the server and waits for the new version's /api/health; the bootstrap rolls back a version that does not
// come up, which is reported as rolled_back.
func (u *updater) updateApp(dir, v string) error {
	srv, err := lookupAccount(u.in.ServerUser)
	if err != nil {
		return err
	}
	versions := filepath.Join(u.e.base, "app", "versions")
	dest := filepath.Join(versions, v)
	if st, err := os.Lstat(dest); err == nil {
		// used again without a fresh copy when it verifies: touched first (its ctime moves to now, the link itself if it
		// is one), so the server's old-version prune (server/src/system/prune.ts leaves a folder changed in the last 24
		// hours) does not remove it between this check and the switch
		if st.IsDir() {
			now := unix.NsecToTimespec(time.Now().UnixNano())
			_ = unix.UtimesNanoAt(unix.AT_FDCWD, dest, []unix.Timespec{now, now}, unix.AT_SYMLINK_NOFOLLOW)
		}
		if _, verr := bundle.VerifyDir(dest, v, bundle.Options{Keys: u.keys, AllowUnsigned: u.in.AllowUnsigned}); verr != nil {
			if err := os.RemoveAll(dest); err != nil {
				return err
			}
		}
	}
	if _, err := os.Lstat(dest); errors.Is(err, fs.ErrNotExist) {
		partial := dest + ".partial"
		if err := os.RemoveAll(partial); err != nil {
			return err
		}
		if err := copyTree(dir, partial, srv); err != nil {
			os.RemoveAll(partial)
			return err
		}
		if err := os.Rename(partial, dest); err != nil {
			return err
		}
	}
	if u.scheduled && !u.waitForTurns() {
		// root files may be new already; the app (a server restart) waits like the rest
		return u.deferUpdate(v, "the app not switched yet")
	}
	u.res.AppUpdated = true
	systemd := u.in.Systemd && fileExists(systemdRunDir)
	sw := []string{"switch", v}
	if !systemd {
		sw = append(sw, "--restart") // the running server stops itself; the bootstrap (under supervise) starts v
	}
	if out, err := u.runAsSrv(sw, nil); err != nil {
		return fmt.Errorf("switch: %v %s", err, strings.TrimSpace(out))
	}
	if systemd {
		if err := u.restartSrv(); err != nil {
			return err
		}
	}
	deadline := time.Now().Add(u.healthTimeout)
	for time.Now().Before(deadline) {
		if h := health(u.in.Port, 3*time.Second); h["ok"] == true && h["version"] == v {
			u.res.Result = "ok"
			return nil
		}
		if rb := u.rolledBack(v); rb != "" {
			u.res.Result, u.res.Detail = "rolled_back", rb
			return nil
		}
		time.Sleep(2 * time.Second)
	}
	if rb := u.rolledBack(v); rb != "" {
		u.res.Result, u.res.Detail = "rolled_back", rb
		return nil
	}
	return fmt.Errorf("version %s did not answer /api/health within %v", v, u.healthTimeout)
}

// rolledBack reads app/state.json: the bootstrap recorded a roll-back away from v (returns its detail).
func (u *updater) rolledBack(v string) string {
	b, err := os.ReadFile(filepath.Join(u.e.base, "app", "state.json"))
	if err != nil {
		return ""
	}
	var st struct {
		Pending *string `json:"pending"`
		History []struct {
			From   *string `json:"from"`
			To     string  `json:"to"`
			Result string  `json:"result"`
			Detail *string `json:"detail"`
		} `json:"history"`
	}
	if json.Unmarshal(b, &st) != nil || len(st.History) == 0 {
		return ""
	}
	h := st.History[len(st.History)-1]
	if h.Result == "rolled_back" && (h.From != nil && *h.From == v || h.To == v) && (st.Pending == nil || *st.Pending != v) {
		if h.Detail != nil {
			return *h.Detail
		}
		return "rolled back"
	}
	return ""
}

// copyTree copies a verified bundle folder to dest, owned by the server account (folders 755, files 755/644).
func copyTree(src, dest string, owner account) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		t := filepath.Join(dest, rel)
		switch {
		case d.IsDir():
			if err := os.Mkdir(t, 0o755); err != nil && !(rel == "." && errors.Is(err, fs.ErrExist)) {
				return err
			}
		case d.Type().IsRegular():
			if err := copyFile(p, t); err != nil {
				return err
			}
		default:
			return fmt.Errorf("%s is not a file or folder", rel)
		}
		return os.Lchown(t, owner.uid, owner.gid)
	})
}

// runAsServer runs the CURRENT version's admin.js as the server account (its SERVER_VERSION is the running one, so
// `switch <new>` is not "already running"), with an empty environment besides the installation's.
func (u *updater) runAsServer(args []string, extraEnv []string) (string, error) {
	return u.runAdmin(filepath.Join(u.in.Base, "app", "current"), args, extraEnv)
}

// runVersionAsServer runs the admin.js of app/versions/<v> instead (readSchedule: `update-window` of the root files'
// version when the app that runs is older and does not know the command). The folder is the server account's like
// app/current, and the program runs as that account: it can say nothing it could not say through app/current.
func (u *updater) runVersionAsServer(v string, args []string, extraEnv []string) (string, error) {
	if !bundle.ValidVersion(v) {
		return "", fmt.Errorf("bad version %q", v)
	}
	return u.runAdmin(filepath.Join(u.in.Base, "app", "versions", v), args, extraEnv)
}

func (u *updater) runAdmin(dir string, args []string, extraEnv []string) (string, error) {
	srv, err := lookupAccount(u.in.ServerUser)
	if err != nil {
		return "", err
	}
	// a hung admin.js must not hold the update timer's job (TimeoutStartSec): update-window is a settings read
	limit := 10 * time.Minute
	if args[0] == "update-window" {
		limit = 2 * time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), limit)
	defer cancel()
	cmd := exec.CommandContext(ctx, filepath.Join(dir, "bin", "bun"), append([]string{filepath.Join(dir, "server", "src", "admin.js")}, args...)...)
	cmd.Dir = "/"
	cmd.Env = append(adminEnv(u.in), extraEnv...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(srv.uid), Gid: uint32(srv.gid), Groups: []uint32{}}}
	// the server account's program: at most 1 MiB of output kept, and a child left holding the pipe does not keep
	// this waiting past the program's own end
	var out limitedBuffer
	out.b = &bytes.Buffer{}
	out.max = 1 << 20
	cmd.Stdout, cmd.Stderr = &out, &out
	cmd.WaitDelay = 5 * time.Second
	err = cmd.Run()
	if errors.Is(err, exec.ErrWaitDelay) && cmd.ProcessState != nil && cmd.ProcessState.Success() {
		err = nil // it ended well; only a child it left kept the pipe open
	}
	return out.b.String(), err
}

// adminEnv is admin.js's environment: the installation's, and MYCEL_ALLOW_UNSIGNED=1 when the install accepts unsigned
// versions, as the server unit has it (serverEnv): without it `admin.js switch` of a signed running version refused an
// unsigned one that mycel-ctl had just accepted ("bundle is not signed"; seen in the 0.2.14 -> 0.2.19 container run).
func adminEnv(in *Install) []string {
	b := in.Base
	env := []string{"PATH=/usr/bin:/bin", "HOME=" + filepath.Join(b, "data"), "LANG=C.UTF-8", "MYCEL_MODE=prod",
		"MYCEL_CONFIG=" + filepath.Join(b, "config", "server.json"), "MYCEL_INSTALL_BASE=" + b, "MYCEL_LABEL=" + in.ID}
	if in.AllowUnsigned {
		env = append(env, "MYCEL_ALLOW_UNSIGNED=1")
	}
	return env
}

func (u *updater) restartServer() error {
	if out, err := exec.Command(u.e.systemctl, "restart", u.in.ID+"-server.service").CombinedOutput(); err != nil {
		return fmt.Errorf("restart server: %v %s", err, out)
	}
	return nil
}

// compareVersions orders versions exactly like server/src/system/update.ts compareVersions (the app's own updater,
// the installer's `admin.js compare-versions` and the release scripts): -1, 0, 1. Semver: numbers compare as numbers,
// a release is newer than its pre-releases, pre-release identifiers compare one by one (all-digit ones as numbers, so
// rc.10 is newer than rc.9; numeric before text; text by bytes; more identifiers newer when the rest is equal), build
// metadata (+...) is ignored. To give the same answer on every input, numbers are read the way JavaScript reads them:
// a part of the main version is its leading digits (parseInt, none = 0), an identifier is numeric only when it is all
// digits (/^\d+$/), and both become float64 like a JavaScript number. testdata/version-order.json is checked by both
// sides (TestCompareVersionsMatchesServer here, tests/unit/g-update.test.ts there).
func compareVersions(a, b string) int {
	split := func(v string) ([]float64, []string) {
		core := strings.SplitN(v, "+", 2)[0]
		main, pre, hasPre := strings.Cut(core, "-")
		var nums []float64
		for _, x := range strings.Split(main, ".") {
			n, _ := jsNumber(x[:len(x)-len(strings.TrimLeft(x, "0123456789"))])
			nums = append(nums, n)
		}
		if !hasPre {
			return nums, nil
		}
		return nums, strings.Split(pre, ".")
	}
	xn, xp := split(a)
	yn, yp := split(b)
	for i := 0; i < len(xn) || i < len(yn); i++ {
		var p, q float64
		if i < len(xn) {
			p = xn[i]
		}
		if i < len(yn) {
			q = yn[i]
		}
		if p != q {
			if p < q {
				return -1
			}
			return 1
		}
	}
	if xp == nil || yp == nil {
		switch {
		case xp == nil && yp == nil:
			return 0
		case xp != nil:
			return -1
		default:
			return 1
		}
	}
	for i := 0; i < len(xp) || i < len(yp); i++ {
		if i >= len(xp) {
			return -1
		}
		if i >= len(yp) {
			return 1
		}
		p, q := xp[i], yp[i]
		if p == q {
			continue
		}
		pn, pok := jsNumber(p)
		qn, qok := jsNumber(q)
		switch {
		case pok && qok:
			if pn < qn {
				return -1
			}
			if pn > qn {
				return 1
			}
		case pok != qok:
			if pok {
				return -1
			}
			return 1
		default:
			if p < q {
				return -1
			}
			return 1
		}
	}
	return 0
}

// jsNumber reads an all-digit string as JavaScript's Number() does (the nearest float64); ok is false for "" and
// anything else.
func jsNumber(s string) (float64, bool) {
	if s == "" || strings.TrimLeft(s, "0123456789") != "" {
		return 0, false
	}
	n, err := strconv.ParseFloat(s, 64)
	return n, err == nil || errors.Is(err, strconv.ErrRange)
}

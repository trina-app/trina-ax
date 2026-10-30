package main

import (
	"bufio"
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
// A Linux bundle is the entry with os "linux" and the machine's arch. needsRoot: the release changes root files.
type ReleaseFeed struct {
	Version     string `json:"version"`
	MinFrom     string `json:"minFrom"`
	NeedsRoot   bool   `json:"needsRoot"`
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
	// hooks for tests (default: the real thing)
	liveTurns  func() (int, error)
	runAsSrv   func(args []string, env []string) (string, error)
	restartSrv func() error
}

// updateTestHook replaces the parts of an update that need a real launcher and server account (tests only).
var updateTestHook func(u *updater)

func cmdUpdate(e *env, args []string) (int, error) {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	e.flags(fs)
	version := fs.String("version", "", "update to this version (from the feed); default: the channel's newest")
	bundleFile := fs.String("bundle", "", "update from this release archive (<v>-linux-<arch>.tar.zst) instead of the feed")
	onlyRoot := fs.Bool("only-if-needs-root", false, "do nothing unless the release changes root files (the update timer)")
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
	unlock, err := lockUpdate(e.root(".update.lock"))
	if err != nil {
		res.Result = "busy"
		return finish(30, err)
	}
	defer unlock()
	u := &updater{e: e, in: in, keys: append(append([]string{}, bundle.ReleaseKeys...), extra...), maxWait: time.Duration(*maxWait) * time.Second,
		healthTimeout: time.Duration(*healthWait) * time.Second, arch: runtime.GOARCH, res: res}
	u.liveTurns = u.launcherLiveTurns
	u.runAsSrv = u.runAsServer
	u.restartSrv = u.restartServer
	if updateTestHook != nil {
		updateTestHook(u)
	}
	err = u.run(*version, *bundleFile, *onlyRoot)
	if err != nil && res.Result == "ok" {
		res.Result = "error"
	}
	return finish(resultCodes[res.Result], err)
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
		if err := extractBundle(bundleFile, dir); err != nil {
			u.res.Result = "verify_failed"
			return err
		}
	} else {
		feed, err := u.fetchFeed(version)
		if err != nil {
			return err
		}
		u.res.To, needsRoot = feed.Version, feed.NeedsRoot
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

// workDir is a fresh folder under BASE/.install-tmp (root 700; the installer and mycel-ctl share it).
func (u *updater) workDir() (string, error) {
	t := filepath.Join(u.e.base, ".install-tmp")
	if err := os.Mkdir(t, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
		return "", err
	}
	var st syscall.Stat_t
	if err := syscall.Lstat(t, &st); err != nil || st.Mode&syscall.S_IFMT != syscall.S_IFDIR || int(st.Uid) != rootUID || st.Mode&0o077 != 0 {
		return "", fmt.Errorf("%s must be a root-only folder (700)", t)
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
	if len(diff) == 0 {
		return nil
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
	u.waitForTurns()
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
	systemd := u.in.Systemd && fileExists(systemdRunDir)
	if units && systemd {
		if _, _, err := renderUnits(u.in, u.e.root("systemd"), systemdUnitDir); err != nil {
			return fmt.Errorf("units: %v", err)
		}
		if out, err := exec.Command(u.e.systemctl, "daemon-reload").CombinedOutput(); err != nil {
			return fmt.Errorf("daemon-reload: %v %s", err, out)
		}
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

// waitForTurns waits until the launcher runs no turn, at most maxWait. Turns still running then become
// "interrupted" when the launcher restarts (the server is not told to stop taking turns, spec 3.6.5).
func (u *updater) waitForTurns() {
	deadline := time.Now().Add(u.maxWait)
	for {
		n, err := u.liveTurns()
		if err == nil && n == 0 {
			return
		}
		if time.Now().After(deadline) {
			return
		}
		time.Sleep(2 * time.Second)
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
	if _, err := os.Lstat(dest); err == nil {
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
	srv, err := lookupAccount(u.in.ServerUser)
	if err != nil {
		return "", err
	}
	b := u.in.Base
	cmd := exec.Command(filepath.Join(b, "app", "current", "bin", "bun"), append([]string{filepath.Join(b, "app", "current", "server", "src", "admin.js")}, args...)...)
	cmd.Dir = "/"
	cmd.Env = append([]string{"PATH=/usr/bin:/bin", "HOME=" + filepath.Join(b, "data"), "LANG=C.UTF-8", "MYCEL_MODE=prod",
		"MYCEL_CONFIG=" + filepath.Join(b, "config", "server.json"), "MYCEL_INSTALL_BASE=" + b, "MYCEL_LABEL=" + u.in.ID}, extraEnv...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(srv.uid), Gid: uint32(srv.gid), Groups: []uint32{}}}
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func (u *updater) restartServer() error {
	if out, err := exec.Command(u.e.systemctl, "restart", u.in.ID+"-server.service").CombinedOutput(); err != nil {
		return fmt.Errorf("restart server: %v %s", err, out)
	}
	return nil
}

// compareVersions orders semver like server/src/system/update.ts compareVersions: -1, 0, 1.
func compareVersions(a, b string) int {
	split := func(v string) ([]int, []string) {
		core := strings.SplitN(v, "+", 2)[0]
		main, pre, hasPre := strings.Cut(core, "-")
		var nums []int
		for _, x := range strings.Split(main, ".") {
			n, _ := strconv.Atoi(x)
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
		var p, q int
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
		pn, perr := strconv.Atoi(p)
		qn, qerr := strconv.Atoi(q)
		switch {
		case perr == nil && qerr == nil:
			if pn < qn {
				return -1
			}
			if pn > qn {
				return 1
			}
		case (perr == nil) != (qerr == nil):
			if perr == nil {
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

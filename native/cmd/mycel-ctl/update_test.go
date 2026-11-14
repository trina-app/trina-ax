package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"mycel/native/internal/bundle"
)

// The version order is the server's (server/src/system/update.ts compareVersions): tests/unit/g-update.test.ts checks
// the same table there.
func TestCompareVersionsMatchesServer(t *testing.T) {
	b, err := os.ReadFile("testdata/version-order.json")
	must(t, err)
	var tab struct {
		Ascending []string    `json:"ascending"`
		Same      [][2]string `json:"same"`
		Pairs     [][]any     `json:"pairs"`
	}
	must(t, json.Unmarshal(b, &tab))
	sign := func(n int) int {
		switch {
		case n < 0:
			return -1
		case n > 0:
			return 1
		}
		return 0
	}
	for i, a := range tab.Ascending {
		for j, b := range tab.Ascending {
			if got := compareVersions(a, b); got != sign(i-j) {
				t.Errorf("%s vs %s = %d, want %d", a, b, got, sign(i-j))
			}
		}
	}
	for _, p := range tab.Same {
		if compareVersions(p[0], p[1]) != 0 || compareVersions(p[1], p[0]) != 0 {
			t.Errorf("%s and %s should be the same version", p[0], p[1])
		}
	}
	for _, p := range tab.Pairs {
		a, b, want := p[0].(string), p[1].(string), int(p[2].(float64))
		if got := compareVersions(a, b); got != want {
			t.Errorf("%s vs %s = %d, want %d", a, b, got, want)
		}
		if got := compareVersions(b, a); got != -want {
			t.Errorf("%s vs %s = %d, want %d", b, a, got, -want)
		}
	}
	if len(tab.Ascending) < 7 || len(tab.Pairs) == 0 {
		t.Fatal("version table not read")
	}
}

// feedServer is a release feed on 127.0.0.1 (allowedURL lets plain http to this machine through): the channel feed
// <url>/server/stable.json + .sig, older releases' <url>/server/<v>/release.json + .sig, and their bundles, all signed
// with a test key.
type feedServer struct {
	t         *testing.T
	priv      ed25519.PrivateKey
	key       string
	srv       *httptest.Server
	mu        sync.Mutex
	files     map[string][]byte
	downloads int
}

func newFeedServer(t *testing.T) *feedServer {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	f := &feedServer{t: t, priv: priv, key: base64.StdEncoding.EncodeToString(pub), files: map[string][]byte{}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		b, ok := f.files[r.URL.Path]
		if ok && strings.HasPrefix(r.URL.Path, "/bundles/") {
			f.downloads++
		}
		f.mu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(b)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// publish makes a signed bundle of v (its launcher says which version it is) and its signed feed at p.
func (f *feedServer) publish(p, v string, needsRoot bool) {
	f.publishWith(p, v, needsRoot, nil)
}

// publishWith is publish with more (or other) feed fields: rollout, urgent, publishedAt (rollout_test.go).
func (f *feedServer) publishWith(p, v string, needsRoot bool, extra map[string]any) {
	t := f.t
	arch := filepath.Join(t.TempDir(), v+"-linux-"+runtime.GOARCH+".tar.zst")
	mkArchive(t, signedBundle(t, v, f.priv, "launcher "+v), arch, nil)
	ab, err := os.ReadFile(arch)
	must(t, err)
	sum := sha256.Sum256(ab)
	feed := map[string]any{"version": v, "minFrom": "0.2.0", "needsRoot": needsRoot, "notes": "", "publishedAt": "2026-11-01T00:00:00Z",
		"bundles": []map[string]any{{"os": "linux", "arch": runtime.GOARCH, "url": f.srv.URL + "/bundles/" + v + ".tar.zst", "sha256": hex.EncodeToString(sum[:]), "size": len(ab)}}}
	for k, x := range extra {
		feed[k] = x
	}
	body, _ := json.Marshal(feed)
	sig, _ := json.Marshal(map[string]string{"keyId": bundle.KeyID(f.priv.Public().(ed25519.PublicKey)), "sig": base64.StdEncoding.EncodeToString(ed25519.Sign(f.priv, body))})
	f.mu.Lock()
	defer f.mu.Unlock()
	f.files["/bundles/"+v+".tar.zst"] = ab
	f.files[p] = body
	f.files[p+".sig"] = sig
}

func (f *feedServer) channel(v string, needsRoot bool) {
	f.publish("/server/stable.json", v, needsRoot)
}

func (f *feedServer) downloaded() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.downloads
}

// feedBase is a test install at app version `app` with root files of `root` that reads the feed f.
func feedBase(t *testing.T, f *feedServer, app, root string) (*testBase, *string) {
	tb := newTestBase(t, app)
	systemdRunDir = filepath.Join(t.TempDir(), "none")
	t.Cleanup(func() { systemdRunDir = "/run/systemd/system" })
	must(t, os.WriteFile(filepath.Join(tb.base, "config/server.json"), []byte(`{"update":{"channel":"stable","feedUrl":"`+f.srv.URL+`/server/stable.json"}}`), 0o644))
	if root == "" {
		must(t, os.Remove(filepath.Join(tb.base, "root/VERSION")))
	} else {
		must(t, os.WriteFile(filepath.Join(tb.base, "root/VERSION"), []byte(root+"\n"), 0o644))
	}
	switched := new(string)
	updateHooks(t, tb, func(v string) {
		*switched = v
		os.Remove(filepath.Join(tb.base, "app/current"))
		os.Symlink("versions/"+v, filepath.Join(tb.base, "app/current"))
		tb.health.Store(v)
	})
	return tb, switched
}

func (tb *testBase) update(t *testing.T, args ...string) (int, UpdateResult) {
	t.Helper()
	code, out, errs := tb.ctl("", append([]string{"update"}, append(args, "--json")...)...)
	var r UpdateResult
	if err := json.Unmarshal([]byte(out), &r); err != nil {
		t.Fatalf("update %v: %d %q %s", args, code, out, errs)
	}
	return code, r
}

func (tb *testBase) file(p string) string {
	b, _ := os.ReadFile(filepath.Join(tb.base, p))
	return strings.TrimSpace(string(b))
}

// The update timer (and a plain `mycel-ctl update`) installs the channel's release only when it is newer than the app
// that runs, in the server's version order; nothing is downloaded or changed otherwise.
func TestUpdateFeedNeverDowngrades(t *testing.T) {
	for _, c := range []struct {
		installed, feed string
		installs        bool
		why             string
	}{
		{"0.2.18-pre.1.805103ac", "0.2.17", false, "older than the installed 0.2.18-pre.1.805103ac"}, // the server found this
		{"0.2.18-pre.1.805103ac", "0.2.18-pre.1.805103ac", false, "already at 0.2.18-pre.1.805103ac"},
		{"0.2.18-qa4.x", "0.2.18-pre.1.805103ac", false, "older than the installed 0.2.18-qa4.x"},
		{"0.2.10", "0.2.9", false, "older than the installed 0.2.10"},
		{"0.2.18-pre.1.805103ac", "0.2.18", true, ""},
		{"0.2.17-devenv.1", "0.2.17", true, ""},
		{"0.2.9", "0.2.10", true, ""},
	} {
		t.Run(c.installed+"_feed_"+c.feed, func(t *testing.T) {
			f := newFeedServer(t)
			f.channel(c.feed, true)
			tb, switched := feedBase(t, f, c.installed, c.installed)
			for _, args := range [][]string{{"--only-if-needs-root"}, {}} { // the timer, then an admin's plain update
				code, r := tb.update(t, append(args, "--pubkey", f.key)...)
				if code != 0 || r.Result != "ok" {
					t.Fatalf("%v: %d %+v", args, code, r)
				}
				if !c.installs {
					if !r.Skipped || !strings.Contains(r.Detail, c.why) || r.RootUpdated || r.AppUpdated || r.From != c.installed {
						t.Fatalf("%v: %+v", args, r)
					}
					if f.downloaded() != 0 || *switched != "" || tb.file("root/mycel-launcher") != "old launcher" || tb.file("root/VERSION") != c.installed ||
						currentVersion(tb.base) != c.installed {
						t.Fatalf("%v: something changed: downloads %d, switched to %q, launcher %q, root %q, app %q", args, f.downloaded(), *switched,
							tb.file("root/mycel-launcher"), tb.file("root/VERSION"), currentVersion(tb.base))
					}
					continue
				}
				if len(args) == 0 {
					// the second run, after the timer installed it: already there
					if !r.Skipped || !strings.Contains(r.Detail, "already at "+c.feed) || f.downloaded() != 1 {
						t.Fatalf("again: %+v (downloads %d)", r, f.downloaded())
					}
					continue
				}
				if r.Skipped || !r.RootUpdated || !r.AppUpdated || r.From != c.installed || r.To != c.feed || *switched != c.feed || f.downloaded() != 1 {
					t.Fatalf("%+v switched %q downloads %d", r, *switched, f.downloaded())
				}
				if tb.file("root/mycel-launcher") != "launcher "+c.feed || tb.file("root/VERSION") != c.feed {
					t.Fatalf("root files: %q %q", tb.file("root/mycel-launcher"), tb.file("root/VERSION"))
				}
			}
		})
	}
	// what the journal shows for the timer run
	f := newFeedServer(t)
	f.channel("0.2.17", true)
	tb, _ := feedBase(t, f, "0.2.18-pre.1.805103ac", "0.2.18-pre.1.805103ac")
	code, out, _ := tb.ctl("", "update", "--only-if-needs-root", "--pubkey", f.key)
	if code != 0 || out != "ok: nothing changed, 0.2.18-pre.1.805103ac stays: the feed's release 0.2.17 is older than the installed 0.2.18-pre.1.805103ac, not installed (to go back to it, run `mycel-ctl update --version 0.2.17`)\n" {
		t.Fatalf("%d %q", code, out)
	}
}

// The same version: nothing to do while the root files are at it or newer (the bootstrap rolled the app back under
// newer root files); root files older than the app catch up, and the app stays.
func TestUpdateFeedSameVersion(t *testing.T) {
	f := newFeedServer(t)
	f.channel("0.2.17", true)
	tb, switched := feedBase(t, f, "0.2.17", "0.2.18-pre.1.805103ac")
	if code, r := tb.update(t, "--only-if-needs-root", "--pubkey", f.key); code != 0 || !r.Skipped || r.Detail != "already at 0.2.17 (root files 0.2.18-pre.1.805103ac)" || f.downloaded() != 0 {
		t.Fatalf("root files newer: %d %+v (downloads %d)", code, r, f.downloaded())
	}
	for _, root := range []string{"0.2.16", ""} { // older root files, no root/VERSION
		f := newFeedServer(t)
		f.channel("0.2.17", true)
		tb, switched = feedBase(t, f, "0.2.17", root)
		code, r := tb.update(t, "--only-if-needs-root", "--pubkey", f.key)
		if code != 0 || r.Result != "ok" || r.Skipped || !r.RootUpdated || r.AppUpdated || *switched != "" || f.downloaded() != 1 {
			t.Fatalf("root %q: %d %+v switched %q", root, code, r, *switched)
		}
		if tb.file("root/mycel-launcher") != "launcher 0.2.17" || tb.file("root/VERSION") != "0.2.17" || currentVersion(tb.base) != "0.2.17" {
			t.Fatalf("root %q: %q %q %q", root, tb.file("root/mycel-launcher"), tb.file("root/VERSION"), currentVersion(tb.base))
		}
	}
}

// The refusal never keeps a server from updating when it cannot tell what runs: no app/current (a fresh or broken
// install), a link that names no version, root/VERSION missing or unreadable; an app the bootstrap rolled back under
// newer root files takes the newer release again, as before.
func TestNotNewerNeverBlocksUnknownState(t *testing.T) {
	for _, c := range []struct{ feed, app, root, want string }{
		{"0.2.17", "", "", ""},
		{"0.2.17", "", "0.2.18", ""},
		{"0.2.17", "versions", "0.2.17", ""}, // app/current -> versions/ (no version folder)
		{"0.2.17", "0.2.17", "", ""},
		{"0.2.17", "0.2.17", "garbage", ""},
		{"0.2.17", "0.2.17", "0.2.16", ""},
		{"0.2.18", "0.2.17", "0.2.18", ""}, // rolled back: tried again
		{"0.2.17", "0.2.17", "0.2.17", "already at 0.2.17"},
		{"0.2.17", "0.2.18", "0.2.18", "older than the installed 0.2.18"},
	} {
		if got := notNewer(c.feed, c.app, c.root); (c.want == "") != (got == "") || !strings.Contains(got, c.want) {
			t.Errorf("notNewer(%q, %q, %q) = %q, want %q", c.feed, c.app, c.root, got, c.want)
		}
	}
}

// An admin goes back on purpose with --version: an older release is installed (the app; root files newer than it
// stay), from the channel or from <feed>/server/<v>/release.json.
func TestUpdateExplicitVersionMayGoBack(t *testing.T) {
	for _, channel := range []string{"0.2.18", "0.2.17"} {
		f := newFeedServer(t)
		f.channel(channel, true)
		if channel != "0.2.17" {
			// (not for the channel's own version: a second build of it is another archive once a second has passed
			// between the two, and the channel feed names the first one)
			f.publish("/server/0.2.17/release.json", "0.2.17", true)
		}
		tb, switched := feedBase(t, f, "0.2.18-pre.1.805103ac", "0.2.18-pre.1.805103ac")
		code, r := tb.update(t, "--version", "0.2.17", "--pubkey", f.key)
		if code != 0 || r.Result != "ok" || r.Skipped || !r.AppUpdated || r.RootUpdated || r.To != "0.2.17" || *switched != "0.2.17" {
			t.Fatalf("channel %s: %d %+v switched %q", channel, code, r, *switched)
		}
		if !strings.Contains(strings.Join(r.Notes, " "), "root files 0.2.18-pre.1.805103ac are newer than 0.2.17; kept") ||
			tb.file("root/mycel-launcher") != "old launcher" || tb.file("root/VERSION") != "0.2.18-pre.1.805103ac" || currentVersion(tb.base) != "0.2.17" {
			t.Fatalf("channel %s: %+v %q %q", channel, r.Notes, tb.file("root/VERSION"), currentVersion(tb.base))
		}
	}
}

// A newer release the bootstrap rolls back is still reported as rolled_back (10), and the next run tries it again
// (it is newer than the version that runs); the refusal does not get in the way.
func TestUpdateFeedRollBack(t *testing.T) {
	f := newFeedServer(t)
	f.channel("0.2.18", true)
	tb := newTestBase(t, "0.2.18-pre.1.805103ac")
	systemdRunDir = filepath.Join(t.TempDir(), "none")
	t.Cleanup(func() { systemdRunDir = "/run/systemd/system" })
	must(t, os.WriteFile(filepath.Join(tb.base, "config/server.json"), []byte(`{"update":{"channel":"stable","feedUrl":"`+f.srv.URL+`/server/stable.json"}}`), 0o644))
	updateHooks(t, tb, func(v string) {
		st := `{"format":1,"current":"0.2.18-pre.1.805103ac","previous":null,"pending":null,"pendingSince":null,"attempts":0,"history":[{"at":"x","from":"` + v + `","to":"0.2.18-pre.1.805103ac","result":"rolled_back","detail":"exited 3 times before it was healthy"}]}`
		os.WriteFile(filepath.Join(tb.base, "app/state.json"), []byte(st), 0o644)
	})
	for i := 0; i < 2; i++ {
		code, r := tb.update(t, "--only-if-needs-root", "--pubkey", f.key)
		if code != 10 || r.Result != "rolled_back" || !strings.Contains(r.Detail, "exited 3 times") {
			t.Fatalf("run %d: %d %+v", i, code, r)
		}
	}
}

// retireBase is a test install with systemd (units in a folder of the test) and an empty root/systemd for syncUnits. The
// server's restart goes into the same record as the systemctl calls, so a test sees the order.
func retireBase(t *testing.T) *testBase {
	tb := newTestBase(t, "0.1.0")
	systemdRunDir, systemdUnitDir = t.TempDir(), t.TempDir()
	t.Cleanup(func() { systemdRunDir, systemdUnitDir = "/run/systemd/system", "/etc/systemd/system" })
	must(t, os.Mkdir(filepath.Join(tb.base, "root/systemd"), 0o755))
	updateHooks(t, tb, func(v string) {
		os.Remove(filepath.Join(tb.base, "app/current"))
		os.Symlink("versions/"+v, filepath.Join(tb.base, "app/current"))
		tb.health.Store(v)
	})
	prev := updateTestHook
	updateTestHook = func(u *updater) {
		prev(u)
		u.restartSrv = func() error {
			f, err := os.OpenFile(tb.sysCalls, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
			if err != nil {
				return err
			}
			defer f.Close()
			_, err = f.WriteString("restart mycel-server.service\n")
			return err
		}
	}
	prevState, prevMounts, prevInfo := retiredBoxState, retiredBoxMounts, mountInfo
	retiredBoxState = func(base string) []string { return []string{filepath.Join(base, "boxd"), filepath.Join(base, "boxd-storage")} }
	retiredBoxMounts = func(base string) []string { return []string{filepath.Join(base, "boxd")} }
	mountInfo = filepath.Join(t.TempDir(), "none")
	t.Cleanup(func() { retiredBoxState, retiredBoxMounts, mountInfo = prevState, prevMounts, prevInfo })
	return tb
}

// retireArchive is a signed update archive of v (a kit with no root/mycel-boxd).
func retireArchive(t *testing.T, v string) (string, string) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	dir := signedBundle(t, v, priv, "launcher "+v)
	arch := filepath.Join(t.TempDir(), v+"-linux-"+runtime.GOARCH+".tar.zst")
	mkArchive(t, dir, arch, nil)
	return arch, base64.StdEncoding.EncodeToString(pub)
}

// what install-trial.sh left: the service, the drop-in of the team server, root/mycel-boxd, and the box volumes
func boxTrial(t *testing.T, tb *testBase, dropin string) (unit, dropinPath string) {
	unit = filepath.Join(systemdUnitDir, retiredBoxUnit)
	must(t, os.WriteFile(unit, []byte("[Service]\nExecStart="+tb.base+"/root/mycel-boxd --server-uid 1\n"), 0o644))
	dropinPath = filepath.Join(systemdUnitDir, "mycel-server.service.d", "dev-env.conf")
	must(t, os.MkdirAll(filepath.Dir(dropinPath), 0o755))
	must(t, os.WriteFile(dropinPath, []byte(dropin), 0o644))
	must(t, os.WriteFile(filepath.Join(tb.base, "root/mycel-boxd"), []byte("old boxd"), 0o755))
	must(t, os.MkdirAll(filepath.Join(tb.base, "boxd", "box1", "work"), 0o755))
	return unit, dropinPath
}

const boxDropin = "[Unit]\nWants=mycel-boxd.service\n\n[Service]\nEnvironment=MYCEL_DEV_ENV=1\nEnvironment=MYCEL_BOXD_SOCK=/run/mycel-boxd/boxd.sock\n"

func (tb *testBase) calls() []string {
	b, _ := os.ReadFile(tb.sysCalls)
	return strings.Split(strings.TrimSpace(string(b)), "\n")
}

func indexOf(l []string, s string) int {
	for i, x := range l {
		if x == s {
			return i
		}
	}
	return -1
}

// A server of the box trial: the update stops and removes the service, the drop-in and root/mycel-boxd before the
// team server restarts, and leaves the box state with a note.
func TestUpdateRetiresBoxRunner(t *testing.T) {
	tb := retireBase(t)
	unit, dropin := boxTrial(t, tb, boxDropin)
	arch, k := retireArchive(t, "0.2.0")
	code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
	c := tb.calls()
	d, rl, s := indexOf(c, "disable --now mycel-boxd.service"), indexOf(c, "daemon-reload"), indexOf(c, "restart mycel-server.service")
	if code != 0 || !r.AppUpdated || d < 0 || rl < d || s < rl {
		t.Fatalf("%d %+v %v", code, r, c)
	}
	for _, p := range []string{unit, dropin, filepath.Dir(dropin), filepath.Join(tb.base, "root/mycel-boxd")} {
		if fileExists(p) {
			t.Fatalf("%s is still there", p)
		}
	}
	if !fileExists(filepath.Join(tb.base, "boxd", "box1", "work")) {
		t.Fatal("the box state was deleted")
	}
	notes := strings.Join(r.Notes, " ")
	for _, want := range []string{"mycel-boxd.service and its boxes are stopped", "the dev environment is off", "install-srt.sh", "the box state stays: " + filepath.Join(tb.base, "boxd") + " ", "Removed: the box runner"} {
		if !strings.Contains(notes, want) {
			t.Fatalf("no %q in %s", want, notes)
		}
	}
}

// A server that moved to srt after the trial: install-srt.sh wrote the same drop-in, so it stays; the service goes.
func TestUpdateKeepsTheSrtDropin(t *testing.T) {
	tb := retireBase(t)
	srt := "[Service]\nEnvironment=MYCEL_DEV_ENV=1 MYCEL_DEV_ENV_RUNNER=srt\n"
	unit, dropin := boxTrial(t, tb, srt)
	arch, k := retireArchive(t, "0.2.0")
	code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
	if code != 0 || !r.AppUpdated || fileExists(unit) || !fileExists(dropin) {
		t.Fatalf("%d %+v %v", code, r, tb.calls())
	}
	if b, _ := os.ReadFile(dropin); string(b) != srt {
		t.Fatalf("the srt drop-in changed: %q", b)
	}
	if strings.Contains(strings.Join(r.Notes, " "), "the dev environment is off") {
		t.Fatalf("%+v", r.Notes)
	}
}

// The first update to this release ran the older mycel-ctl, which has no retire step. The next run of the new one finds
// the server at this version already: it retires the box runner and restarts the team server without the drop-in.
func TestUpdateRetiresWhenAlreadyAtTheVersion(t *testing.T) {
	tb := retireBase(t)
	unit, dropin := boxTrial(t, tb, boxDropin)
	arch, k := retireArchive(t, "0.2.0")
	if code, r := tb.update(t, "--bundle", arch, "--pubkey", k); code != 0 || !r.AppUpdated {
		t.Fatalf("%d %+v", code, r)
	}
	// as after the older mycel-ctl: the box files are back, and the server runs 0.2.0
	boxTrial(t, tb, boxDropin)
	must(t, os.Remove(tb.sysCalls))
	code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
	c := tb.calls()
	if code != 0 || r.AppUpdated || indexOf(c, "disable --now mycel-boxd.service") < 0 || indexOf(c, "restart mycel-server.service") < indexOf(c, "daemon-reload") || fileExists(unit) || fileExists(dropin) {
		t.Fatalf("%d %+v %v", code, r, c)
	}
	if !strings.Contains(strings.Join(r.Notes, " "), "restarted without the box drop-in") {
		t.Fatalf("%+v", r.Notes)
	}
	// once more: nothing left to do, no restart
	must(t, os.Remove(tb.sysCalls))
	if code, r := tb.update(t, "--bundle", arch, "--pubkey", k); code != 0 || indexOf(tb.calls(), "restart mycel-server.service") >= 0 {
		t.Fatalf("%d %+v %v", code, r, tb.calls())
	}
}

// The box mounts below the box folders, deepest first; other mounts and look-alike names are not.
func TestMountsUnder(t *testing.T) {
	f := filepath.Join(t.TempDir(), "mountinfo")
	must(t, os.WriteFile(f, []byte(strings.Join([]string{
		"36 35 98:0 / / rw - ext4 /dev/root rw",
		"40 36 98:0 /p /var/lib/mycel/boxd/b1/work rw - ext4 /dev/root rw",
		"41 40 98:0 /q /var/lib/mycel/boxd/b1/work/deep\\040x rw - ext4 /dev/root rw",
		"42 36 98:0 /r /var/lib/mycel/boxd-other rw - ext4 /dev/root rw",
		"43 36 0:5 / /run/mycel-boxd rw - tmpfs tmpfs rw",
	}, "\n")), 0o644))
	prev := mountInfo
	mountInfo = f
	t.Cleanup(func() { mountInfo = prev })
	got := strings.Join(mountsUnder([]string{"/var/lib/mycel/boxd", "/run/mycel-boxd"}), "|")
	if got != "/var/lib/mycel/boxd/b1/work/deep x|/var/lib/mycel/boxd/b1/work|/run/mycel-boxd" {
		t.Fatal(got)
	}
}

// Almost every server: no service, no drop-in. Nothing in systemctl and no note; the kit's old root/mycel-boxd goes.
func TestUpdateWithoutTheBoxTrial(t *testing.T) {
	tb := retireBase(t)
	must(t, os.WriteFile(filepath.Join(tb.base, "root/mycel-boxd"), []byte("kit boxd"), 0o755))
	arch, k := retireArchive(t, "0.2.0")
	code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
	c := strings.Join(tb.calls(), "\n")
	if code != 0 || !r.AppUpdated || strings.Contains(c, "mycel-boxd") || strings.Contains(c, "daemon-reload") || strings.Contains(strings.Join(r.Notes, " "), "box") {
		t.Fatalf("%d %+v %s", code, r, c)
	}
	if fileExists(filepath.Join(tb.base, "root/mycel-boxd")) {
		t.Fatal("root/mycel-boxd is still there")
	}
}

// A service that does not stop is a note: the update of the server goes on.
func TestUpdateRetireFailsIsANote(t *testing.T) {
	tb := retireBase(t)
	boxTrial(t, tb, boxDropin)
	must(t, os.WriteFile(filepath.Join(tb.fakeBin, "systemctl"), []byte("#!/bin/sh\necho \"$*\" >> '"+tb.sysCalls+"'\n[ \"$1\" = disable ] && { echo 'unit busy'; exit 1; }\nexit 0\n"), 0o755))
	arch, k := retireArchive(t, "0.2.0")
	code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
	if code != 0 || !r.AppUpdated || !strings.Contains(strings.Join(r.Notes, " "), "mycel-boxd.service did not stop") || indexOf(tb.calls(), "restart mycel-server.service") < 0 {
		t.Fatalf("%d %+v %v", code, r, tb.calls())
	}
}

// QA TC-339: with 600 MB free, `mycel-ctl update` failed cleanly but did not say how much space it needs. The check
// runs before the download (and before unpacking a --bundle) and names both numbers.
func TestUpdateSaysHowMuchSpaceItNeeds(t *testing.T) {
	const mb = int64(1 << 20)
	// the version that runs is the estimate; three times the archive when that is larger
	if got, want := spaceNeeded(150*mb, 540*mb, 0), uint64(150*mb+2*540*mb+spaceMargin); got != want {
		t.Fatalf("spaceNeeded = %d, want %d", got, want)
	}
	if got, want := spaceNeeded(300*mb, 0, 0), uint64(300*mb+2*900*mb+spaceMargin); got != want {
		t.Fatalf("spaceNeeded without a current version = %d, want %d", got, want)
	}
	// the copy of the database the new version makes before it migrates counts too
	if got, want := spaceNeeded(150*mb, 540*mb, 700*mb), uint64(150*mb+2*540*mb+700*mb+spaceMargin); got != want {
		t.Fatalf("spaceNeeded with a database = %d, want %d", got, want)
	}
	msg := spaceError("/var/lib/mycel", "0.5.0", 1536<<20, 600<<20).Error()
	for _, s := range []string{"not enough free space for 0.5.0", "/var/lib/mycel", "it needs about 1.5 GB free, it has 0.6 GB", "nothing was changed"} {
		if !strings.Contains(msg, s) {
			t.Fatalf("%q does not say %q", msg, s)
		}
	}
	base := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(base, "app", "versions", "0.4.0"), 0o755))
	must(t, os.WriteFile(filepath.Join(base, "app", "versions", "0.4.0", "main.js"), make([]byte, 4096), 0o644))
	must(t, os.Symlink("versions/0.4.0", filepath.Join(base, "app", "current")))
	if treeSize(filepath.Join(base, "app", "versions", "0.4.0")) != 4096 {
		t.Fatal("treeSize does not count the version's files")
	}
	u := &updater{e: &env{base: base}}
	if err := u.checkSpace("0.5.0", 1<<20); err != nil {
		t.Fatalf("a small update on a temp disk: %v", err)
	}
	err := u.checkSpace("0.5.0", 1<<52) // 4 PiB: never free
	if err == nil || !strings.Contains(err.Error(), "it needs about") || !strings.Contains(err.Error(), "free, it has") {
		t.Fatalf("an update that cannot fit: %v", err)
	}
}

// QA TC-340 retest: a reset in the middle of an update leaves the new mycel-ctl once any root file changed, so its
// status reports the half state. mycel-ctl update replaces it first, then the rest in name order.
func TestRootDiffPutsMycelCtlFirst(t *testing.T) {
	w := t.TempDir()
	kit, installed := filepath.Join(w, "kit"), filepath.Join(w, "root")
	must(t, os.MkdirAll(filepath.Join(kit, "systemd"), 0o755))
	must(t, os.MkdirAll(installed, 0o755))
	for _, n := range []string{"mycel-account", "mycel-bootstrap", "mycel-ctl", "mycel-launcher", "mycel-sandbox", "systemd/server.service.in"} {
		must(t, os.WriteFile(filepath.Join(kit, n), []byte("new "+n), 0o755))
	}
	diff, err := rootDiff(kit, installed)
	must(t, err)
	if got := strings.Join(diff, " "); got != "mycel-ctl mycel-account mycel-bootstrap mycel-launcher mycel-sandbox systemd/server.service.in" {
		t.Fatalf("order: %s", got)
	}
	// an unchanged mycel-ctl is not in the list
	must(t, os.WriteFile(filepath.Join(installed, "mycel-ctl"), []byte("new mycel-ctl"), 0o755))
	diff, err = rootDiff(kit, installed)
	must(t, err)
	if got := strings.Join(diff, " "); got != "mycel-account mycel-bootstrap mycel-launcher mycel-sandbox systemd/server.service.in" {
		t.Fatalf("without mycel-ctl: %s", got)
	}
}

// The same order in install-linux.sh: the first root program it installs is mycel-ctl.
func TestInstallScriptInstallsMycelCtlFirst(t *testing.T) {
	src, err := os.ReadFile("../../../scripts/install-linux.sh")
	must(t, err)
	_, part, ok := strings.Cut(string(src), "\nrootfile() {")
	if !ok {
		t.Fatal("no rootfile() in install-linux.sh")
	}
	_, part, _ = strings.Cut(part, "\n}\n")
	var first string
	for _, line := range strings.Split(part, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "#") || !strings.Contains(line, "rootfile ") {
			continue
		}
		first = line
		break
	}
	if !strings.HasPrefix(first, "for f in mycel-ctl ") || !strings.Contains(first, " mycel-bootstrap ") || !strings.Contains(first, " mycel-launcher ") {
		t.Fatalf("first root file install: %q", first)
	}
}

// Root files half replaced by an update that stopped (from a kit newer than the feed): a plain mycel-ctl update does
// not answer "already at" but says why it cannot finish them and what can.
func TestUpdateSaysWhenRootFilesAreHalfReplaced(t *testing.T) {
	f := newFeedServer(t)
	f.channel("0.2.17", true)
	tb, _ := feedBase(t, f, "0.2.17", "0.2.17")
	kit := filepath.Join(tb.base, "app/versions/0.2.17/root")
	must(t, os.MkdirAll(kit, 0o755))
	for _, n := range []string{"mycel-ctl", "mycel-launcher"} {
		must(t, os.WriteFile(filepath.Join(kit, n), []byte("0.2.17 "+n), 0o755))
		must(t, os.WriteFile(filepath.Join(tb.base, "root", n), []byte("0.2.17 "+n), 0o755))
	}
	if code, r := tb.update(t, "--pubkey", f.key); code != 0 || !r.Skipped || r.Detail != "already at 0.2.17" {
		t.Fatalf("whole root files: %d %+v", code, r)
	}
	must(t, os.WriteFile(filepath.Join(tb.base, "root/mycel-ctl"), []byte("0.2.18 mycel-ctl"), 0o755))
	for _, args := range [][]string{{"--pubkey", f.key}, {"--version", "0.2.17", "--pubkey", f.key}, {"--only-if-needs-root", "--pubkey", f.key}} {
		code, out, errs := tb.ctl("", append([]string{"update"}, args...)...)
		if code == 0 || strings.Contains(out, "already at") || !strings.Contains(errs, "an update did not finish: some root files (mycel-ctl) are not those of 0.2.17") || !strings.Contains(errs, "install-linux.sh update --from . in the kit's folder") {
			t.Fatalf("%v: %d\n%s\n%s", args, code, out, errs)
		}
	}
	if f.downloaded() != 0 || tb.file("root/mycel-ctl") != "0.2.18 mycel-ctl" {
		t.Fatalf("changed something: downloads %d, %q", f.downloaded(), tb.file("root/mycel-ctl"))
	}
}

// QA TC-338: an administrator's update says what it waits for, and the answers still running at the end of the wait
// are stopped for the update by the launcher itself (a confirmed end the server can name) right before its restart,
// never cut by the restart.
func TestUpdateWaitsVisiblyAndTellsTheLauncher(t *testing.T) {
	tb := retireBase(t)
	arch, k := retireArchive(t, "0.2.0")
	prev := updateTestHook
	updateTestHook = func(u *updater) {
		prev(u)
		left := []int{2, 2, 1}
		u.liveTurns = func() (int, error) {
			if len(left) == 0 {
				return 0, nil
			}
			n := left[0]
			left = left[1:]
			return n, nil
		}
		u.sleep = func(time.Duration) {}
	}
	code, out, errs := tb.ctl("", "update", "--bundle", arch, "--pubkey", k, "--json")
	var r UpdateResult
	if err := json.Unmarshal([]byte(out), &r); err != nil || code != 0 || !r.RootUpdated {
		t.Fatalf("%d %q %s", code, out, errs)
	}
	// one line per change of the count, on stderr (stdout stays the JSON result)
	if strings.Count(errs, "waiting for 2 running answer(s)") != 1 || strings.Count(errs, "waiting for 1 running answer(s)") != 1 {
		t.Fatalf("stderr: %q", errs)
	}
	c := tb.calls()
	p, l := indexOf(c, "prepare-stop update"), indexOf(c, "restart mycel-launcher.service")
	if p < 0 || l != p+1 {
		t.Fatalf("the launcher is told right before its restart: %v", c)
	}
}

// An update of root files only (the app keeps its version, so the server is not restarted after the launcher) says
// "update-root": the server's queue then goes on as soon as the launcher is back.
func TestUpdateRootOnlyTellsTheLauncher(t *testing.T) {
	tb := retireBase(t)
	arch, k := retireArchive(t, "0.1.0")
	code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
	c := tb.calls()
	if code != 0 || !r.RootUpdated || r.AppUpdated {
		t.Fatalf("%d %+v %v", code, r, c)
	}
	if p, l := indexOf(c, "prepare-stop update-root"), indexOf(c, "restart mycel-launcher.service"); p < 0 || l != p+1 {
		t.Fatalf("calls: %v", c)
	}
}

// retireScript runs the box runner step of scripts/install-linux.sh with a fake systemctl. dropin is the text of the
// team server's dev-env.conf ("" = none); unit: the box service is there. It gives the output, the systemctl calls and
// the folder of the test.
func retireScript(t *testing.T, unit bool, dropin string) (string, string, string) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip(err)
	}
	src, err := os.ReadFile("../../../scripts/install-linux.sh")
	must(t, err)
	_, part, ok := strings.Cut(string(src), "# BEGIN box runner retire")
	part, _, ok2 := strings.Cut(part, "# END box runner retire")
	if !ok || !ok2 {
		t.Fatal("no box runner retire part in install-linux.sh")
	}
	w := t.TempDir()
	base, units, bin := filepath.Join(w, "base"), filepath.Join(w, "units"), filepath.Join(w, "bin")
	must(t, os.MkdirAll(filepath.Join(base, "root"), 0o755))
	must(t, os.MkdirAll(filepath.Join(base, "boxd"), 0o755))
	must(t, os.Mkdir(units, 0o755))
	must(t, os.Mkdir(bin, 0o755))
	must(t, os.WriteFile(filepath.Join(base, "root/mycel-boxd"), []byte("old boxd"), 0o755))
	if unit {
		must(t, os.WriteFile(filepath.Join(units, retiredBoxUnit), []byte("[Service]\nExecStart="+base+"/root/mycel-boxd\n"), 0o644))
	}
	if dropin != "" {
		must(t, os.MkdirAll(filepath.Join(units, "mycel-server.service.d"), 0o755))
		must(t, os.WriteFile(filepath.Join(units, "mycel-server.service.d", "dev-env.conf"), []byte(dropin), 0o644))
	}
	must(t, os.WriteFile(filepath.Join(bin, "systemctl"), []byte("#!/bin/sh\necho \"$*\" >> '"+w+"/calls'\n"), 0o755))
	script := "set -euo pipefail\nID=mycel BASE='" + base + "' UNIT_DIR='" + units + "' SYSTEMD=1 PATH='" + bin + "':\"$PATH\"\n" +
		"warn() { echo \"warning: $*\"; }\nsay() { echo \"say: $*\"; }\nhave_systemd() { return 0; }\n" + part + "\nretire_box_runner\necho end\n"
	out, err := exec.Command("bash", "-c", script).CombinedOutput()
	if err != nil || !strings.HasSuffix(string(out), "end\n") {
		t.Fatalf("%v %s", err, out)
	}
	calls, _ := os.ReadFile(filepath.Join(w, "calls"))
	if fileExists(filepath.Join(base, "root/mycel-boxd")) || !fileExists(filepath.Join(base, "boxd")) {
		t.Fatalf("root/mycel-boxd stays, or the box state went: %s", out)
	}
	return string(out), string(calls), w
}

func TestInstallScriptRetiresBoxRunner(t *testing.T) {
	t.Run("the box trial", func(t *testing.T) {
		out, calls, w := retireScript(t, true, boxDropin)
		if !strings.Contains(calls, "disable --now mycel-boxd.service") || fileExists(filepath.Join(w, "units", retiredBoxUnit)) || fileExists(filepath.Join(w, "units", "mycel-server.service.d")) {
			t.Fatalf("%q\n%s", calls, out)
		}
		for _, want := range []string{"say: the box runner of the dev environment is removed", "warning: the dev environment is off", "warning: the box state stays: " + filepath.Join(w, "base", "boxd")} {
			if !strings.Contains(out, want) {
				t.Fatalf("no %q in\n%s", want, out)
			}
		}
	})
	t.Run("srt's drop-in stays", func(t *testing.T) {
		srt := "[Service]\nEnvironment=MYCEL_DEV_ENV=1 MYCEL_DEV_ENV_RUNNER=srt\n"
		out, _, w := retireScript(t, true, srt)
		if b, _ := os.ReadFile(filepath.Join(w, "units", "mycel-server.service.d", "dev-env.conf")); string(b) != srt || strings.Contains(out, "the dev environment is off") {
			t.Fatalf("%q\n%s", b, out)
		}
	})
	t.Run("no box trial", func(t *testing.T) {
		out, calls, _ := retireScript(t, false, "")
		if calls != "" || strings.TrimSpace(out) != "end" {
			t.Fatalf("%q\n%s", calls, out)
		}
	})
}

// The app's switch waits for the running answers before the server restarts, as root files did already (the dev
// server's timer runs `mycel-ctl update` without --scheduled for every dev build): an app-only
// update used to restart at once and cut a render off mid-way. Until the run ends, root/update-waiting.json tells the
// server (it starts no scheduled run meanwhile, server/src/system/update-wait.ts); it is gone afterwards.
func TestAppOnlyUpdateWaitsForRunningAnswers(t *testing.T) {
	tb := newTestBase(t, "0.1.0")
	systemdRunDir = filepath.Join(t.TempDir(), "none")
	t.Cleanup(func() { systemdRunDir = "/run/systemd/system" })
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	k := base64.StdEncoding.EncodeToString(pub)
	marker := filepath.Join(tb.base, "root", updateWaitingFile)
	// the root files' wait finds it quiet; answers start after it, before the app's switch
	left := []int{0, 2, 2, 1}
	polls, sawMarker, switchedWhileBusy, markedAtSwitch := 0, false, false, false
	updateHooks(t, tb, func(v string) {
		switchedWhileBusy = len(left) > 0
		// still there at the switch (the restart follows): the server starts nothing long meanwhile
		_, err := os.Lstat(marker)
		markedAtSwitch = err == nil
		os.Remove(filepath.Join(tb.base, "app/current"))
		os.Symlink("versions/"+v, filepath.Join(tb.base, "app/current"))
		tb.health.Store(v)
	})
	prev := updateTestHook
	updateTestHook = func(u *updater) {
		prev(u)
		u.liveTurns = func() (int, error) {
			polls++
			if len(left) == 0 {
				return 0, nil
			}
			n := left[0]
			left = left[1:]
			return n, nil
		}
		u.sleep = func(time.Duration) {
			if b, err := os.ReadFile(marker); err == nil && strings.Contains(string(b), `"until"`) {
				sawMarker = true
			}
		}
	}
	arch := filepath.Join(t.TempDir(), "a.tar.zst")
	mkArchive(t, signedBundle(t, "0.2.0", priv, "new launcher"), arch, nil)
	code, out, errs := tb.ctl("", "update", "--bundle", arch, "--pubkey", k, "--json")
	var r UpdateResult
	if err := json.Unmarshal([]byte(out), &r); err != nil || code != 0 || r.Result != "ok" || !r.AppUpdated {
		t.Fatalf("%d %q %s", code, out, errs)
	}
	if switchedWhileBusy || polls < 5 {
		t.Fatalf("switched before the answers ended (polls %d)", polls)
	}
	if !strings.Contains(errs, "waiting for 2 running answer(s)") || !strings.Contains(errs, "waiting for 1 running answer(s)") {
		t.Fatalf("stderr: %q", errs)
	}
	if !sawMarker || !markedAtSwitch {
		t.Fatalf("root/update-waiting.json: while waiting %v, at the switch %v", sawMarker, markedAtSwitch)
	}
	if _, err := os.Lstat(marker); !os.IsNotExist(err) {
		t.Fatalf("root/update-waiting.json left after the wait: %v", err)
	}
}

// An unscheduled run waits at most --max-wait in all: root files and the app share one deadline, and the answers still
// running then are stopped for the update (they can be sent again).
func TestUnscheduledUpdateSharesOneDeadline(t *testing.T) {
	tb := newTestBase(t, "0.1.0")
	systemdRunDir = filepath.Join(t.TempDir(), "none")
	t.Cleanup(func() { systemdRunDir = "/run/systemd/system" })
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	k := base64.StdEncoding.EncodeToString(pub)
	updateHooks(t, tb, func(v string) {
		os.Remove(filepath.Join(tb.base, "app/current"))
		os.Symlink("versions/"+v, filepath.Join(tb.base, "app/current"))
		tb.health.Store(v)
	})
	clock := time.Now()
	prev := updateTestHook
	updateTestHook = func(u *updater) {
		prev(u)
		u.e.now = func() time.Time { return clock }
		u.liveTurns = func() (int, error) { return 1, nil } // never quiet
		u.sleep = func(d time.Duration) { clock = clock.Add(d) }
	}
	run := func(name string, args ...string) time.Duration {
		start := clock
		arch := filepath.Join(t.TempDir(), name+".tar.zst")
		mkArchive(t, signedBundle(t, name, priv, "launcher "+name), arch, nil)
		code, out, errs := tb.ctl("", append([]string{"update", "--bundle", arch, "--pubkey", k, "--json"}, args...)...)
		var r UpdateResult
		if err := json.Unmarshal([]byte(out), &r); err != nil || code != 0 || !r.AppUpdated || !r.RootUpdated {
			t.Fatalf("%s: %d %q %s", name, code, out, errs)
		}
		return clock.Sub(start)
	}
	if w := run("0.2.0", "--max-wait", "60"); w < 60*time.Second || w > 70*time.Second {
		t.Fatalf("waited %v in all, want about --max-wait (60 s) once", w)
	}
	// the default: 30 minutes on a self-installed server
	if w := run("0.3.0"); w < 30*time.Minute || w > 31*time.Minute {
		t.Fatalf("default wait %v, want 30 minutes", w)
	}
	// a hosted server: 600 s, inside the 1800 s its control plane gives the whole command
	ij := filepath.Join(tb.base, "root/install.json")
	b, err := os.ReadFile(ij)
	must(t, err)
	var m map[string]any
	must(t, json.Unmarshal(b, &m))
	m["hosted"] = true
	b, _ = json.Marshal(m)
	must(t, os.WriteFile(ij, b, 0o644))
	if w := run("0.4.0"); w < 10*time.Minute || w > 11*time.Minute {
		t.Fatalf("hosted default wait %v, want 10 minutes", w)
	}
}

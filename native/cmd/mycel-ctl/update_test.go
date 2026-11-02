package main

import (
	"bufio"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net"
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
	t := f.t
	arch := filepath.Join(t.TempDir(), v+"-linux-"+runtime.GOARCH+".tar.zst")
	mkArchive(t, signedBundle(t, v, f.priv, "launcher "+v), arch, nil)
	ab, err := os.ReadFile(arch)
	must(t, err)
	sum := sha256.Sum256(ab)
	feed := map[string]any{"version": v, "minFrom": "0.2.0", "needsRoot": needsRoot, "notes": "", "publishedAt": "2026-11-01T00:00:00Z",
		"bundles": []map[string]any{{"os": "linux", "arch": runtime.GOARCH, "url": f.srv.URL + "/bundles/" + v + ".tar.zst", "sha256": hex.EncodeToString(sum[:]), "size": len(ab)}}}
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

// boxdBase is a test install with systemd (units in a folder of the test) and an empty root/systemd for syncUnits. The
// server's restart goes into the same record as the systemctl calls, so a test sees the order.
func boxdBase(t *testing.T) *testBase {
	tb := newTestBase(t, "0.1.0")
	systemdRunDir, systemdUnitDir = t.TempDir(), t.TempDir()
	t.Cleanup(func() { systemdRunDir, systemdUnitDir = "/run/systemd/system", "/etc/systemd/system" })
	must(t, os.Mkdir(filepath.Join(tb.base, "root/systemd"), 0o755))
	fakeBoxd(t, `{"ev":"status","available":true,"boxes":[]}`)
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
	return tb
}

// fakeBoxd answers a status request on a socket of the test, as the helper does after its checks.
func fakeBoxd(t *testing.T, answer string) {
	dir, err := os.MkdirTemp("", "bx") // short: a socket path has a limit, and t.TempDir has the name of the test
	must(t, err)
	t.Cleanup(func() { os.RemoveAll(dir) })
	ln, err := net.Listen("unix", filepath.Join(dir, "s"))
	must(t, err)
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			line, _ := bufio.NewReader(c).ReadString('\n')
			if line == `{"op":"status"}`+"\n" {
				c.Write([]byte(answer + "\n"))
			}
			c.Close()
		}
	}()
	prev := boxdSock
	boxdSock = ln.Addr().String()
	t.Cleanup(func() { boxdSock = prev })
}

// boxdUnitFile writes the service with this ExecStart program.
func boxdUnitFile(t *testing.T, prog string) {
	must(t, os.WriteFile(filepath.Join(systemdUnitDir, boxdUnit), []byte("[Unit]\nDescription=box helper\n\n[Service]\nExecStart="+prog+" --server-uid 1 --server-gid 1 --team-root /x\n"), 0o644))
}

// boxdArchive is a signed update archive of v, with root/mycel-boxd unless boxd is "".
func boxdArchive(t *testing.T, v, boxd string) (string, string) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	dir := signedBundle(t, v, priv, "launcher "+v)
	if boxd != "" {
		must(t, os.WriteFile(filepath.Join(dir, "root/mycel-boxd"), []byte(boxd), 0o755))
		must(t, bundle.WriteManifest(dir, v, priv))
	}
	arch := filepath.Join(t.TempDir(), v+"-linux-"+runtime.GOARCH+".tar.zst")
	mkArchive(t, dir, arch, nil)
	return arch, base64.StdEncoding.EncodeToString(pub)
}

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

const boxdRestart = "restart mycel-boxd.service"

// A changed root/mycel-boxd restarts the service: after the launcher, before the team server (the server must find the
// new helper). The file is root's own, never a version folder's copy.
func TestUpdateRestartsChangedBoxd(t *testing.T) {
	for name, installed := range map[string]string{"replaced": "old boxd", "first time": ""} {
		t.Run(name, func(t *testing.T) {
			tb := boxdBase(t)
			if installed != "" {
				must(t, os.WriteFile(filepath.Join(tb.base, "root/mycel-boxd"), []byte(installed), 0o755))
			}
			boxdUnitFile(t, tb.base+"/root/mycel-boxd")
			arch, k := boxdArchive(t, "0.2.0", "new boxd")
			code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
			if code != 0 || r.Result != "ok" || !r.RootUpdated || !r.AppUpdated {
				t.Fatalf("%d %+v", code, r)
			}
			c := tb.calls()
			l, b, s := indexOf(c, "restart mycel-launcher.service"), indexOf(c, boxdRestart), indexOf(c, "restart mycel-server.service")
			if l < 0 || b < l || s < b {
				t.Fatalf("restart order: %v", c)
			}
			if !strings.Contains(strings.Join(r.Notes, " "), "boxes that ran have stopped") {
				t.Fatalf("notes: %v", r.Notes)
			}
			st, err := os.Stat(filepath.Join(tb.base, "root/mycel-boxd"))
			must(t, err)
			if st.Mode().Perm() != 0o755 || tb.file("root/mycel-boxd") != "new boxd" {
				t.Fatalf("root/mycel-boxd: %v %q", st.Mode(), tb.file("root/mycel-boxd"))
			}
		})
	}
}

// A restart stops the boxes that run, so nothing else restarts the helper. What each case keeps out of systemctl.
func TestUpdateLeavesBoxdAlone(t *testing.T) {
	t.Run("same program", func(t *testing.T) { // other root files change: the launcher restarts, the helper does not
		tb := boxdBase(t)
		must(t, os.WriteFile(filepath.Join(tb.base, "root/mycel-boxd"), []byte("same boxd"), 0o755))
		boxdUnitFile(t, tb.base+"/root/mycel-boxd")
		arch, k := boxdArchive(t, "0.2.0", "same boxd")
		code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
		if c := tb.calls(); code != 0 || !r.RootUpdated || indexOf(c, boxdRestart) >= 0 || indexOf(c, "restart mycel-launcher.service") < 0 {
			t.Fatalf("%d %+v %v", code, r, c)
		}
	})
	t.Run("no unit on a hosted server", func(t *testing.T) { // the file comes with the kit; nothing else changes
		tb := boxdBase(t)
		in := tb.file("root/install.json")
		must(t, os.WriteFile(filepath.Join(tb.base, "root/install.json"), []byte(strings.Replace(in, `"hosted":false`, `"hosted":true`, 1)), 0o644))
		arch, k := boxdArchive(t, "0.2.0", "new boxd")
		code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
		if code != 0 || r.Result != "ok" || indexOf(tb.calls(), boxdRestart) >= 0 || tb.file("root/mycel-boxd") != "new boxd" || strings.Contains(strings.Join(r.Notes, " "), "mycel-boxd") {
			t.Fatalf("%d %+v %v", code, r, tb.calls())
		}
	})
	t.Run("no systemd", func(t *testing.T) {
		tb := boxdBase(t)
		boxdUnitFile(t, tb.base+"/root/mycel-boxd")
		systemdRunDir = filepath.Join(t.TempDir(), "none")
		arch, k := boxdArchive(t, "0.2.0", "new boxd")
		code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
		if code != 0 || r.Result != "ok" || tb.file("root/mycel-boxd") != "new boxd" {
			t.Fatalf("%d %+v", code, r)
		}
		if _, err := os.Stat(tb.sysCalls); err == nil {
			t.Fatalf("systemctl called without systemd: %v", tb.calls())
		}
	})
	t.Run("a service that runs another program", func(t *testing.T) { // an earlier trial: a restart loads nothing new
		tb := boxdBase(t)
		boxdUnitFile(t, "/usr/local/sbin/mycel-boxd")
		arch, k := boxdArchive(t, "0.2.0", "new boxd")
		code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
		if code != 0 || indexOf(tb.calls(), boxdRestart) >= 0 || !strings.Contains(strings.Join(r.Notes, " "), "install-trial.sh") {
			t.Fatalf("%d %+v %v", code, r, tb.calls())
		}
	})
	t.Run("root files newer than the release", func(t *testing.T) { // an older release: the newer helper stays
		tb := boxdBase(t)
		must(t, os.WriteFile(filepath.Join(tb.base, "root/mycel-boxd"), []byte("newer boxd"), 0o755))
		must(t, os.WriteFile(filepath.Join(tb.base, "root/VERSION"), []byte("9.0.0\n"), 0o644))
		boxdUnitFile(t, tb.base+"/root/mycel-boxd")
		arch, k := boxdArchive(t, "0.2.0", "older boxd")
		code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
		if code != 0 || r.Result != "ok" || r.RootUpdated || !r.AppUpdated || indexOf(tb.calls(), boxdRestart) >= 0 || tb.file("root/mycel-boxd") != "newer boxd" {
			t.Fatalf("%d %+v %v", code, r, tb.calls())
		}
	})
	t.Run("a release without the file", func(t *testing.T) { // from before the kit had it: the installed file stays
		tb := boxdBase(t)
		must(t, os.WriteFile(filepath.Join(tb.base, "root/mycel-boxd"), []byte("installed boxd"), 0o755))
		boxdUnitFile(t, tb.base+"/root/mycel-boxd")
		arch, k := boxdArchive(t, "0.2.0", "")
		code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
		if code != 0 || !r.RootUpdated || indexOf(tb.calls(), boxdRestart) >= 0 || tb.file("root/mycel-boxd") != "installed boxd" {
			t.Fatalf("%d %+v %v", code, r, tb.calls())
		}
	})
}

// staleBoxd makes systemctl name a process, and the program of that process has this content.
func staleBoxd(t *testing.T, tb *testBase, content string) {
	must(t, os.WriteFile(filepath.Join(tb.fakeBin, "systemctl"), []byte("#!/bin/sh\necho \"$*\" >> '"+tb.sysCalls+"'\n[ \"$1\" = show ] && echo 4242\nexit 0\n"), 0o755))
	exe := filepath.Join(t.TempDir(), "exe")
	if content != "" {
		must(t, os.WriteFile(exe, []byte(content), 0o755))
	}
	prev := boxdExe
	boxdExe = func(pid string) string {
		if pid != "4242" {
			t.Errorf("pid %q", pid)
		}
		return exe
	}
	t.Cleanup(func() { boxdExe = prev })
}

// matchedBoxd installs the archive of a release with boxd as its helper, so a second update of it finds an empty diff.
func matchedBoxd(t *testing.T, boxd string) (*testBase, string, string) {
	tb := boxdBase(t)
	boxdUnitFile(t, tb.base+"/root/mycel-boxd")
	arch, k := boxdArchive(t, "0.2.0", boxd)
	if code, r := tb.update(t, "--bundle", arch, "--pubkey", k); code != 0 || !r.RootUpdated {
		t.Fatalf("%d %+v", code, r)
	}
	must(t, os.Remove(tb.sysCalls))
	return tb, arch, k
}

// An install-linux.sh from before its restart step left an old process. The file is right, so no diff shows it.
func TestUpdateRestartsStaleBoxd(t *testing.T) {
	t.Run("root files match", func(t *testing.T) {
		tb, arch, k := matchedBoxd(t, "new boxd")
		staleBoxd(t, tb, "old boxd")
		code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
		if code != 0 || r.RootUpdated || indexOf(tb.calls(), boxdRestart) < 0 || !strings.Contains(strings.Join(r.Notes, " "), "runs an old program") {
			t.Fatalf("%d %+v %v", code, r, tb.calls())
		}
	})
	t.Run("other root files change", func(t *testing.T) {
		tb := boxdBase(t)
		must(t, os.WriteFile(filepath.Join(tb.base, "root/mycel-boxd"), []byte("same boxd"), 0o755))
		boxdUnitFile(t, tb.base+"/root/mycel-boxd")
		staleBoxd(t, tb, "old boxd")
		arch, k := boxdArchive(t, "0.2.0", "same boxd")
		code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
		c := tb.calls()
		if code != 0 || !r.RootUpdated || indexOf(c, boxdRestart) < 0 || indexOf(c, boxdRestart) > indexOf(c, "restart mycel-server.service") {
			t.Fatalf("%d %+v %v", code, r, c)
		}
	})
}

// A restart stops the boxes, so only a process with other content restarts.
func TestUpdateLeavesCurrentBoxd(t *testing.T) {
	for name, exe := range map[string]string{
		"same content":       "new boxd", // a file replaced with the same content: the path of the process says "(deleted)"
		"unreadable process": "",
	} {
		t.Run(name, func(t *testing.T) {
			tb, arch, k := matchedBoxd(t, "new boxd")
			staleBoxd(t, tb, exe)
			code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
			if code != 0 || indexOf(tb.calls(), boxdRestart) >= 0 || strings.Contains(strings.Join(r.Notes, " "), "old program") {
				t.Fatalf("%d %+v %v", code, r, tb.calls())
			}
		})
	}
	t.Run("a service that runs another program", func(t *testing.T) {
		tb, arch, k := matchedBoxd(t, "new boxd")
		boxdUnitFile(t, "/usr/local/sbin/mycel-boxd")
		staleBoxd(t, tb, "old boxd")
		code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
		if code != 0 || indexOf(tb.calls(), boxdRestart) >= 0 {
			t.Fatalf("%d %+v %v", code, r, tb.calls())
		}
	})
	t.Run("no process", func(t *testing.T) {
		tb, arch, k := matchedBoxd(t, "new boxd")
		code, r := tb.update(t, "--bundle", arch, "--pubkey", k) // the default fake systemctl prints no pid
		if code != 0 || indexOf(tb.calls(), boxdRestart) >= 0 {
			t.Fatalf("%d %+v %v", code, r, tb.calls())
		}
	})
}

// boxdRestartScript runs the restart step of scripts/install-linux.sh with a fake systemctl. systemctl is the shell
// text of the fake after its log line, status the answer of boxd. It gives the output of the step and the systemctl calls.
func boxdRestartScript(t *testing.T, unit, before, systemctl, status string) (string, string) {
	for _, tool := range []string{"bash", "python3", "sha256sum"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip(err)
		}
	}
	src, err := os.ReadFile("../../../scripts/install-linux.sh")
	must(t, err)
	_, part, ok := strings.Cut(string(src), "# BEGIN boxd restart")
	part, _, ok2 := strings.Cut(part, "# END boxd restart")
	if !ok || !ok2 {
		t.Fatal("no boxd restart part in install-linux.sh")
	}
	w := t.TempDir()
	base, units, bin := filepath.Join(w, "base"), filepath.Join(w, "units"), filepath.Join(w, "bin")
	must(t, os.MkdirAll(filepath.Join(base, "root"), 0o755))
	must(t, os.Mkdir(units, 0o755))
	must(t, os.Mkdir(bin, 0o755))
	must(t, os.WriteFile(filepath.Join(base, "root/mycel-boxd"), []byte("new boxd"), 0o755))
	if unit != "" {
		must(t, os.WriteFile(filepath.Join(units, boxdUnit), []byte("[Service]\nExecStart="+strings.ReplaceAll(unit, "@BASE@", base)+" --server-uid 1\n"), 0o644))
	}
	must(t, os.WriteFile(filepath.Join(bin, "systemctl"), []byte("#!/bin/sh\necho \"$*\" >> '"+w+"/calls'\n"+systemctl+"\n"), 0o755))
	fakeBoxd(t, status)
	script := "set -euo pipefail\nBASE='" + base + "' UNIT_DIR='" + units + "' SYSTEMD=1 PATH='" + bin + "':\"$PATH\"\n" +
		"warn() { echo \"warning: $*\"; }\nsay() { echo \"say: $*\"; }\nhave_systemd() { return 0; }\n" + part +
		"\nBOXD_SOCK='" + boxdSock + "'\nB=" + before + "\nboxd_restart \"$B\"\necho end\n"
	out, err := exec.Command("bash", "-c", script).CombinedOutput()
	if err != nil || !strings.HasSuffix(string(out), "end\n") {
		t.Fatalf("%v %s", err, out)
	}
	calls, _ := os.ReadFile(filepath.Join(w, "calls"))
	return string(out), string(calls)
}

func TestInstallScriptRestartsBoxd(t *testing.T) {
	const runsRoot, active, changed, same = "@BASE@/root/mycel-boxd", "echo active", "old-sum", `$(boxd_sum)`
	restart := "restart mycel-boxd.service\n"
	for name, c := range map[string]struct {
		unit, before, fake string
		restarts           bool
		out                string
	}{
		"changed":           {runsRoot, changed, active, true, "say: mycel-boxd changed"},
		"first time":        {runsRoot, `""`, active, true, "say: mycel-boxd changed"},
		"a failed service":  {runsRoot, changed, "echo failed", true, "say: mycel-boxd changed"},
		"same file":         {runsRoot, same, active, false, ""},
		"no unit":           {"", changed, active, false, ""},
		"another program":   {"/usr/local/sbin/mycel-boxd", changed, active, false, "warning: mycel-boxd.service does not run"},
		"a longer name":     {runsRoot + ".old", changed, active, false, "warning: mycel-boxd.service does not run"},
		"a stopped service": {runsRoot, changed, `[ "$1" = is-active ] && { echo inactive; exit 3; }`, false, "say: mycel-boxd.service is stopped"},
		"a failed restart":  {runsRoot, changed, `[ "$1" = restart ] && { echo nope; exit 1; }; exit 0`, true, "warning: restart of mycel-boxd.service failed"},
	} {
		t.Run(name, func(t *testing.T) {
			out, calls := boxdRestartScript(t, c.unit, c.before, c.fake, `{"ev":"status","available":true,"boxes":[]}`)
			if strings.Contains(calls, restart) != c.restarts || !strings.Contains(out, c.out) {
				t.Fatalf("%q\n%s", calls, out)
			}
		})
	}
}

func TestInstallScriptAsksBoxdAfterRestart(t *testing.T) {
	out, _ := boxdRestartScript(t, "@BASE@/root/mycel-boxd", "old-sum", "echo active", `{"ev":"status","available":false,"reason":"no podman"}`)
	if !strings.Contains(out, "warning: mycel-boxd.service restarted, but boxes may not work: boxes are not available: no podman") {
		t.Fatal(out)
	}
}

// A failed restart is a note: the update of the server goes on. The note shows without --json too (the timer's journal,
// an administrator's terminal).
func TestUpdateBoxdRestartFails(t *testing.T) {
	tb := boxdBase(t)
	boxdUnitFile(t, tb.base+"/root/mycel-boxd")
	must(t, os.WriteFile(filepath.Join(tb.fakeBin, "systemctl"), []byte("#!/bin/sh\necho \"$*\" >> '"+tb.sysCalls+"'\n[ \"$*\" = '"+boxdRestart+"' ] && { echo 'unit failed'; exit 1; }\nexit 0\n"), 0o755))
	arch, k := boxdArchive(t, "0.2.0", "new boxd")
	code, out, errs := tb.ctl("", "update", "--bundle", arch, "--pubkey", k)
	if code != 0 || !strings.HasPrefix(out, "ok: 0.1.0 -> 0.2.0") || !strings.Contains(out, "\nnote: restart of mycel-boxd.service failed") || !strings.Contains(out, "unit failed") {
		t.Fatalf("%d %q %s", code, out, errs)
	}
	if c := tb.calls(); indexOf(c, "restart mycel-server.service") < 0 || currentVersion(tb.base) != "0.2.0" {
		t.Fatalf("the app did not update: %v", c)
	}
}

// `systemctl restart` of a Type=simple unit says ok when the process starts. So the update asks the helper, and a helper
// that does not work is a note. The update goes on, and the note does not say that the restart went well.
func TestUpdateAsksBoxdAfterRestart(t *testing.T) {
	cases := map[string]struct {
		setup func(t *testing.T)
		note  string
	}{
		"boxes not available": {func(t *testing.T) {
			fakeBoxd(t, `{"ev":"status","available":false,"reason":"box image x is missing"}`)
		}, "boxes are not available: box image x is missing"},
		"no answer": {func(t *testing.T) {
			prevSock, prevWait := boxdSock, boxdWait
			boxdSock, boxdWait = filepath.Join(t.TempDir(), "none"), time.Millisecond
			t.Cleanup(func() { boxdSock, boxdWait = prevSock, prevWait })
		}, "no answer on"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			tb := boxdBase(t)
			c.setup(t)
			boxdUnitFile(t, tb.base+"/root/mycel-boxd")
			arch, k := boxdArchive(t, "0.2.0", "new boxd")
			code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
			notes := strings.Join(r.Notes, " ")
			if code != 0 || !r.AppUpdated || !strings.Contains(notes, c.note) || strings.Contains(notes, "boxes that ran have stopped") {
				t.Fatalf("%d %+v", code, r)
			}
		})
	}
	t.Run("a boxd that does not take status from root", func(t *testing.T) { // it answers, so it runs
		tb := boxdBase(t)
		fakeBoxd(t, `{"ev":"error","message":"only the server may use boxd"}`)
		boxdUnitFile(t, tb.base+"/root/mycel-boxd")
		arch, k := boxdArchive(t, "0.2.0", "new boxd")
		if code, r := tb.update(t, "--bundle", arch, "--pubkey", k); code != 0 || !strings.Contains(strings.Join(r.Notes, " "), "boxes that ran have stopped") {
			t.Fatalf("%d %+v", code, r)
		}
	})
}

// An administrator stopped the helper (a small VM needs the memory). `systemctl restart` would start it again.
func TestUpdateLeavesStoppedBoxdStopped(t *testing.T) {
	tb := boxdBase(t)
	boxdUnitFile(t, tb.base+"/root/mycel-boxd")
	must(t, os.WriteFile(filepath.Join(tb.fakeBin, "systemctl"), []byte("#!/bin/sh\necho \"$*\" >> '"+tb.sysCalls+"'\n[ \"$1\" = is-active ] && { echo inactive; exit 3; }\nexit 0\n"), 0o755))
	arch, k := boxdArchive(t, "0.2.0", "new boxd")
	code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
	if code != 0 || indexOf(tb.calls(), boxdRestart) >= 0 || tb.file("root/mycel-boxd") != "new boxd" || !strings.Contains(strings.Join(r.Notes, " "), "stays stopped") {
		t.Fatalf("%d %+v %v", code, r, tb.calls())
	}
}

// A failed service restarts: the new program can be the repair.
func TestUpdateRestartsFailedBoxd(t *testing.T) {
	tb := boxdBase(t)
	boxdUnitFile(t, tb.base+"/root/mycel-boxd")
	must(t, os.WriteFile(filepath.Join(tb.fakeBin, "systemctl"), []byte("#!/bin/sh\necho \"$*\" >> '"+tb.sysCalls+"'\n[ \"$1\" = is-active ] && { echo failed; exit 3; }\nexit 0\n"), 0o755))
	arch, k := boxdArchive(t, "0.2.0", "new boxd")
	if code, r := tb.update(t, "--bundle", arch, "--pubkey", k); code != 0 || indexOf(tb.calls(), boxdRestart) < 0 {
		t.Fatalf("%d %+v %v", code, r, tb.calls())
	}
}

// The firewall fails after the new helper is in place. The next run finds the same file and sees no change, so this run
// restarts the helper.
func TestUpdateRestartsBoxdWhenALaterStepFails(t *testing.T) {
	tb := boxdBase(t)
	boxdUnitFile(t, tb.base+"/root/mycel-boxd")
	must(t, os.WriteFile(filepath.Join(tb.fakeBin, "nft-fail"), nil, 0o644))
	arch, k := boxdArchive(t, "0.2.0", "new boxd")
	code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
	if code == 0 || !strings.Contains(r.Detail, "firewall") || indexOf(tb.calls(), boxdRestart) < 0 {
		t.Fatalf("%d %+v %v", code, r, tb.calls())
	}
}

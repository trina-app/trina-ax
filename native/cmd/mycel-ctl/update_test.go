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
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

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
		f.publish("/server/0.2.17/release.json", "0.2.17", true)
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

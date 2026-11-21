package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"mycel/native/internal/bundle"
)

// migration writes a migration of reader level lvl into a version folder (1: no declaration, as most are).
func migration(t *testing.T, dir string, n, lvl int) {
	t.Helper()
	must(t, os.MkdirAll(filepath.Join(dir, "server", "migrations"), 0o755))
	head := "-- a migration\n"
	if lvl > 1 {
		head = fmt.Sprintf("-- a migration\n-- min_compatible_reader: %d\n", lvl)
	}
	must(t, os.WriteFile(filepath.Join(dir, "server", "migrations", fmt.Sprintf("%03d_x.sql", n)), []byte(head+"CREATE TABLE t (a INTEGER);\n"), 0o644))
}

// levelBundle is signedBundle with migrations up to reader level lvl.
func levelBundle(t *testing.T, v string, priv ed25519.PrivateKey, lvl int) string {
	dir := filepath.Join(t.TempDir(), v)
	for p, c := range map[string]string{"bin/bun": "bun " + v, "server/src/main.js": "main", "root/mycel-launcher": "launcher " + v, "root/mycel-ctl": "ctl"} {
		must(t, os.MkdirAll(filepath.Dir(filepath.Join(dir, p)), 0o755))
		mode := os.FileMode(0o644)
		if strings.HasPrefix(p, "bin/") || strings.HasPrefix(p, "root/") {
			mode = 0o755
		}
		must(t, os.WriteFile(filepath.Join(dir, p), []byte(c), mode))
	}
	migration(t, dir, 1, 1)
	migration(t, dir, 121, lvl)
	must(t, bundle.WriteManifest(dir, v, priv))
	return dir
}

// publishLevel publishes v with a bundle of reader level lvl; feedLevel is the feed's minReaderRequired (nil: none).
func (f *feedServer) publishLevel(p, v string, lvl int, feedLevel any) string {
	t := f.t
	arch := f.archive(v, fmt.Sprint("level ", lvl), func() string { return levelBundle(t, v, f.priv, lvl) })
	ab, err := os.ReadFile(arch)
	must(t, err)
	sum := sha256.Sum256(ab)
	feed := map[string]any{"version": v, "minFrom": "0.2.0", "needsRoot": true, "notes": "", "publishedAt": "2026-11-01T00:00:00Z",
		"bundles": []map[string]any{{"os": "linux", "arch": runtime.GOARCH, "url": f.srv.URL + "/bundles/" + v + ".tar.zst", "sha256": hex.EncodeToString(sum[:]), "size": len(ab)}}}
	if feedLevel != nil {
		feed["minReaderRequired"] = feedLevel
	}
	body, _ := json.Marshal(feed)
	sig, _ := json.Marshal(map[string]string{"keyId": bundle.KeyID(f.priv.Public().(ed25519.PublicKey)), "sig": base64.StdEncoding.EncodeToString(ed25519.Sign(f.priv, body))})
	f.mu.Lock()
	defer f.mu.Unlock()
	f.files["/bundles/"+v+".tar.zst"] = ab
	f.files[p] = body
	f.files[p+".sig"] = sig
	return arch
}

// levelBase: a test install running app (whose migrations brought the database to reader level lvl).
func levelBase(t *testing.T, f *feedServer, app string, lvl int) (*testBase, *string) {
	tb, switched := feedBase(t, f, app, app)
	migration(t, filepath.Join(tb.base, "app/versions", app), 1, 1)
	migration(t, filepath.Join(tb.base, "app/versions", app), 121, lvl)
	return tb, switched
}

func (tb *testBase) unchanged(t *testing.T, app string) {
	t.Helper()
	if tb.file("root/mycel-launcher") != "old launcher" || tb.file("root/VERSION") != app || currentVersion(tb.base) != app {
		t.Fatalf("something changed: launcher %q, root %q, app %q", tb.file("root/mycel-launcher"), tb.file("root/VERSION"), currentVersion(tb.base))
	}
	if _, err := os.Stat(filepath.Join(tb.base, "root/update-failed.json")); err == nil {
		t.Fatalf("held as a failure: %s", tb.file("root/update-failed.json"))
	}
}

func TestReaderLevelOfAFolder(t *testing.T) {
	dir := t.TempDir()
	if readerLevel(dir) != 1 {
		t.Fatal("no migrations: 1")
	}
	migration(t, dir, 1, 1)
	migration(t, dir, 250, 5)
	migration(t, dir, 121, 7)
	migration(t, dir, 251, 6)
	// a declaration past the first 400 bytes is not one (bundleReaderLevel reads the same head)
	must(t, os.WriteFile(filepath.Join(dir, "server/migrations/300_late.sql"), []byte(strings.Repeat("-- x\n", 100)+"-- min_compatible_reader: 9\n"), 0o644))
	// a link is not followed, another file is not a migration
	must(t, os.Symlink("/etc/passwd", filepath.Join(dir, "server/migrations/301_link.sql")))
	must(t, os.WriteFile(filepath.Join(dir, "server/migrations/README"), []byte("-- min_compatible_reader: 9\n"), 0o644))
	if got := readerLevel(dir); got != 7 {
		t.Fatalf("readerLevel = %d, want 7", got)
	}
	for raw, want := range map[string]int{"": 0, "7": 7, "1": 1, "0": 0, "-3": 0, "6.5": 0, `"7"`: 0, "null": 0, "{}": 0, "1e9": 0} {
		if got := readMinReader(json.RawMessage(raw)); got != want {
			t.Errorf("readMinReader(%s) = %d, want %d", raw, got, want)
		}
	}
	// a feed whose minReaderRequired does not read is still read (unknown level)
	var fd ReleaseFeed
	if err := json.Unmarshal([]byte(`{"version":"0.5.3","minReaderRequired":"seven","bundles":[]}`), &fd); err != nil || fd.Version != "0.5.3" || fd.MinReaderRequired != 0 {
		t.Fatalf("%v %+v", err, fd)
	}
	if err := json.Unmarshal([]byte(`{"version":"0.5.3","minReaderRequired":6,"bundles":[]}`), &fd); err != nil || fd.MinReaderRequired != 6 {
		t.Fatalf("%v %+v", err, fd)
	}
}

// A dev build (0.5.3-dev.4) migrated the database to reader level 7; the stable channel's 0.5.3 reads level 6 and sorts
// after it. The timer and a plain update leave it without a download, root files and app untouched, and nothing is held
// (no hold that ends in another try); an administrator's --version is refused the same way.
func TestUpdateLeavesAReleaseThatCannotReadTheDatabase(t *testing.T) {
	f := newFeedServer(t)
	f.publishLevel("/server/stable.json", "0.5.3", 6, 6)
	tb, switched := levelBase(t, f, "0.5.3-dev.4", 7)
	for _, args := range [][]string{{"--only-if-needs-root"}, {}} {
		code, r := tb.update(t, append(args, "--pubkey", f.key)...)
		if code != 0 || r.Result != "ok" || !r.Skipped || !strings.Contains(r.Detail, "release 0.5.3 cannot open this server's data yet: it reads database level 6, and 0.5.3-dev.4 has already updated the database to level 7") {
			t.Fatalf("%v: %d %+v", args, code, r)
		}
		if f.downloaded() != 0 || *switched != "" {
			t.Fatalf("%v: downloads %d, switched %q", args, f.downloaded(), *switched)
		}
		tb.unchanged(t, "0.5.3-dev.4")
	}
	code, r := tb.update(t, "--version", "0.5.3", "--pubkey", f.key)
	if code != 1 || r.Result != "error" || !strings.Contains(r.Detail, "cannot open this server's data yet") || !strings.Contains(r.Detail, "Nothing was changed") || f.downloaded() != 0 {
		t.Fatalf("--version: %d %+v (downloads %d)", code, r, f.downloaded())
	}
	tb.unchanged(t, "0.5.3-dev.4")
}

// A feed without minReaderRequired (or one that does not read): the bundle's own migrations say it, after the download
// and before any root file is replaced. A --bundle is checked the same way.
func TestUpdateChecksTheBundlesReaderLevel(t *testing.T) {
	for _, feedLevel := range []any{nil, "six"} {
		f := newFeedServer(t)
		f.publishLevel("/server/stable.json", "0.5.3", 6, feedLevel)
		tb, switched := levelBase(t, f, "0.5.3-dev.4", 7)
		code, r := tb.update(t, "--only-if-needs-root", "--pubkey", f.key)
		if code != 0 || r.Result != "ok" || !r.Skipped || !strings.Contains(r.Detail, "cannot open this server's data yet") || r.RootUpdated || f.downloaded() != 1 || *switched != "" {
			t.Fatalf("feed level %v: %d %+v (downloads %d, switched %q)", feedLevel, code, r, f.downloaded(), *switched)
		}
		tb.unchanged(t, "0.5.3-dev.4")
	}
	f := newFeedServer(t)
	arch := f.publishLevel("/server/stable.json", "0.5.3", 6, nil)
	tb, _ := levelBase(t, f, "0.5.3-dev.4", 7)
	code, r := tb.update(t, "--bundle", arch, "--pubkey", f.key)
	if code != 1 || !strings.Contains(r.Detail, "cannot open this server's data yet") || r.RootUpdated || r.AppUpdated {
		t.Fatalf("--bundle: %d %+v", code, r)
	}
	tb.unchanged(t, "0.5.3-dev.4")
}

// What must keep working: dev -> stable of the same level (0.5.3-dev.4 -> 0.5.3, both 7), a real upgrade that raises
// the level (0.5.2 at 6 -> 0.5.3 at 7), and an older install whose database needs less.
func TestUpdateTakesAReleaseThatCanReadTheDatabase(t *testing.T) {
	for _, c := range []struct {
		app              string
		appLvl, relLevel int
		feedLevel        any
	}{
		{"0.5.3-dev.4", 7, 7, 7},
		{"0.5.2", 6, 7, 7},
		{"0.5.2", 6, 7, nil},
		{"0.4.0", 4, 6, 6},
	} {
		t.Run(c.app, func(t *testing.T) {
			f := newFeedServer(t)
			f.publishLevel("/server/stable.json", "0.5.3", c.relLevel, c.feedLevel)
			tb, switched := levelBase(t, f, c.app, c.appLvl)
			code, r := tb.update(t, "--only-if-needs-root", "--pubkey", f.key)
			if code != 0 || r.Result != "ok" || r.Skipped || !r.RootUpdated || !r.AppUpdated || *switched != "0.5.3" || tb.file("root/mycel-launcher") != "launcher 0.5.3" {
				t.Fatalf("%d %+v switched %q", code, r, *switched)
			}
		})
	}
}

// The update timer in the team's window: the release is left at the gate (no download, no quiet-moment wait, no hold),
// at every check, and a newer release that can read the database goes on as usual.
func TestScheduledUpdateLeavesAReleaseThatCannotReadTheDatabase(t *testing.T) {
	f := newFeedServer(t)
	f.publishLevel("/server/stable.json", "0.2.19", 6, 6)
	tb := schedBase(t, f)
	migration(t, filepath.Join(tb.base, "app/versions/0.2.18"), 121, 7)
	r := &schedRun{clock: at("2026-11-01T18:10:00Z"), window: "03:00-05:00", zone: "Asia/Seoul"}
	scheduledHooks(t, tb, r)
	for i := 0; i < 3; i++ {
		code, res := tb.scheduled(t, f)
		if code != 0 || !res.Skipped || !strings.Contains(res.Detail, "release 0.2.19 cannot open this server's data yet") || f.downloaded() != 0 || r.switched != "" || r.calls != 0 {
			t.Fatalf("check %d: %d %+v (downloads %d, launcher asked %d)", i, code, res, f.downloaded(), r.calls)
		}
		tb.unchanged(t, "0.2.18")
		r.clock.sleep(20 * time.Minute)
	}
	f.publishLevel("/server/stable.json", "0.2.20", 7, 7)
	code, res := tb.scheduled(t, f)
	if code != 0 || res.Skipped || !res.RootUpdated || !res.AppUpdated || r.switched != "0.2.20" {
		t.Fatalf("newer release: %d %+v switched %q", code, res, r.switched)
	}
}

// stageRestore writes data/restore-pending.json as stageDbRestore does (server/src/system/backup.ts), with the staged
// copy's reader level (lvl 0: none, as a version before the field wrote it); link: the staged copy is a symlink.
func stageRestore(t *testing.T, base string, lvl int, link bool) {
	t.Helper()
	data := filepath.Join(base, "data")
	must(t, os.MkdirAll(data, 0o700))
	staged := filepath.Join(data, "restore-staged.db")
	os.Remove(staged)
	if link {
		other := filepath.Join(t.TempDir(), "x.db")
		must(t, os.WriteFile(other, []byte("db"), 0o600))
		must(t, os.Symlink(other, staged))
	} else {
		must(t, os.WriteFile(staged, []byte("db"), 0o600))
	}
	p := map[string]any{"format": 1, "file": staged, "backupId": "pre-migrate-2026-11-16T03-00-00-000Z-1-x", "requestedAt": "2026-11-16T03:01:52.982Z", "requestedBy": nil}
	if lvl > 0 {
		p["readerLevel"] = lvl
	}
	b, _ := json.Marshal(p)
	must(t, os.WriteFile(filepath.Join(data, "restore-pending.json"), b, 0o600))
}

// QA TC-2859, docs/BACKUP-RESTORE.md "Going back to the version before an update": 0.5.7 updated the database to level
// 8; the administrator staged the pre-update copy (level 7) and asks for 0.5.4 (level 7). The staged copy is what the
// next start opens, so 0.5.4 is taken. Without a usable staged level the refusal stays: no restore staged, one staged
// by a version that wrote no level, a staged copy that is a link, a pending file that names another file.
func TestUpdateByHandTakesAnOlderReleaseWhenARestoreIsStaged(t *testing.T) {
	for _, c := range []struct {
		name  string
		stage func(t *testing.T, base string)
		ok    bool
	}{
		{"staged level 7", func(t *testing.T, b string) { stageRestore(t, b, 7, false) }, true},
		{"nothing staged", func(*testing.T, string) {}, false},
		{"staged copy still level 8", func(t *testing.T, b string) { stageRestore(t, b, 8, false) }, false},
		{"staged without a level", func(t *testing.T, b string) { stageRestore(t, b, 0, false) }, false},
		{"staged copy is a link", func(t *testing.T, b string) { stageRestore(t, b, 7, true) }, false},
		{"pending names another file", func(t *testing.T, b string) {
			stageRestore(t, b, 7, false)
			pf := filepath.Join(b, "data", "restore-pending.json")
			raw, _ := os.ReadFile(pf)
			must(t, os.WriteFile(pf, []byte(strings.Replace(string(raw), "restore-staged.db", "app.db", 1)), 0o600))
		}, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFeedServer(t)
			f.publishLevel("/server/stable.json", "0.5.4", 7, 7)
			f.publishLevel("/server/0.5.4/release.json", "0.5.4", 7, 7)
			tb, switched := levelBase(t, f, "0.5.7", 8)
			c.stage(t, tb.base)
			code, r := tb.update(t, "--version", "0.5.4", "--pubkey", f.key)
			if c.ok {
				if code != 0 || r.Result != "ok" || r.Skipped || *switched != "0.5.4" {
					t.Fatalf("%d %+v switched %q", code, r, *switched)
				}
				return
			}
			if code != 1 || !strings.Contains(r.Detail, "cannot open this server's data yet") || !strings.Contains(r.Detail, "Nothing was changed") || *switched != "" {
				t.Fatalf("%d %+v switched %q", code, r, *switched)
			}
			if c.name == "staged copy still level 8" && !strings.Contains(r.Detail, "the restore staged now (data/restore-pending.json) puts back a database of level 8") {
				t.Fatalf("message: %s", r.Detail)
			}
			tb.unchanged(t, "0.5.7")
		})
	}
}

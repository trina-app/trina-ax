package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"mycel/native/internal/bundle"
)

// syncTestBase is a test install whose update switches app/current like the server's admin.js would.
func syncTestBase(t *testing.T) *testBase {
	tb := newTestBase(t, "0.1.0")
	systemdRunDir = filepath.Join(t.TempDir(), "none")
	t.Cleanup(func() { systemdRunDir = "/run/systemd/system" })
	updateHooks(t, tb, func(v string) {
		os.Remove(filepath.Join(tb.base, "app/current"))
		os.Symlink("versions/"+v, filepath.Join(tb.base, "app/current"))
		tb.health.Store(v)
	})
	return tb
}

// listBundle is a signed 0.2.0 archive with root/packages.sh = script (none when script is "") and root/packages.json.
func listBundle(t *testing.T, launcher, script string) (dir, arch, key string) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	dir = signedBundle(t, "0.2.0", priv, launcher)
	if script != "" {
		must(t, os.WriteFile(filepath.Join(dir, "root", packagesSh), []byte(script), 0o644))
		must(t, os.WriteFile(filepath.Join(dir, "root/packages.json"), []byte(`{"format":1}`), 0o644))
		must(t, bundle.WriteManifest(dir, "0.2.0", priv))
	}
	arch = filepath.Join(t.TempDir(), "0.2.0-linux-"+runtime.GOARCH+".tar.zst")
	mkArchive(t, dir, arch, nil)
	return dir, arch, base64.StdEncoding.EncodeToString(pub)
}

// The list of system packages travels with the root files (root/packages.json and its reader root/packages.sh, from
// scripts/system): once a release's root files are in place, update runs `packages.sh sync` with the install's id and
// base and the verified bundle's bun, and its lines become notes. Also when the root files were right already (a server
// whose browser download failed last time gets it now). A bundle without the list runs nothing.
func TestUpdateSyncsSystemPackages(t *testing.T) {
	for _, c := range []struct {
		name     string
		list     bool
		sameRoot bool
		calls    int
	}{
		{"root files change", true, false, 1},
		{"root files right already", true, true, 1},
		{"a bundle without the list", false, false, 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			tb := syncTestBase(t)
			marker := filepath.Join(t.TempDir(), "sync.calls")
			script := ""
			if c.list {
				script = "printf '%s\\n' \"$*\" >> '" + marker + "'\n" +
					"echo 'packages: chrome-headless-shell 157.0.8103.38 (/opt/trina/chrome-headless-shell/current/chrome-headless-shell)'\n"
			}
			launcher := "new launcher"
			if c.sameRoot {
				launcher = "old launcher"
			}
			dir, arch, k := listBundle(t, launcher, script)
			if c.sameRoot {
				// every root file of the bundle is installed already: none changes, only root/VERSION moves up
				for _, f := range []string{"mycel-ctl", packagesSh, "packages.json"} {
					b, err := os.ReadFile(filepath.Join(dir, "root", f))
					must(t, err)
					must(t, os.WriteFile(filepath.Join(tb.base, "root", f), b, 0o644))
				}
			}
			code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
			if code != 0 || r.Result != "ok" || r.RootUpdated == c.sameRoot || !r.AppUpdated {
				t.Fatalf("%d %+v", code, r)
			}
			b, _ := os.ReadFile(marker)
			var calls []string
			if s := strings.TrimSpace(string(b)); s != "" {
				calls = strings.Split(s, "\n")
			}
			notes := strings.Join(r.Notes, "\n")
			if len(calls) != c.calls || strings.Contains(notes, "chrome-headless-shell") != (c.calls > 0) {
				t.Fatalf("packages.sh calls %q, notes %v", calls, r.Notes)
			}
			if c.calls == 0 {
				return
			}
			if !strings.HasPrefix(calls[0], "sync --id mycel --base "+tb.base+" --bun ") || !strings.HasSuffix(calls[0], "/bundle/bin/bun") {
				t.Fatalf("packages.sh %q", calls[0])
			}
			if tb.file("root/"+packagesSh) != strings.TrimSpace(script) {
				t.Fatal("root/packages.sh is not the bundle's")
			}
		})
	}
}

// A failing packages.sh (no network, a broken mirror) is a note: the root files and the app are in, the update is ok.
func TestUpdateSystemPackagesFailureIsANote(t *testing.T) {
	tb := syncTestBase(t)
	_, arch, k := listBundle(t, "new launcher", "echo 'packages: downloading x failed' >&2\nexit 3\n")
	code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
	notes := strings.Join(r.Notes, "\n")
	if code != 0 || r.Result != "ok" || !r.RootUpdated || !r.AppUpdated ||
		!strings.Contains(notes, "downloading x failed") || !strings.Contains(notes, "packages.sh sync: exit status 3") {
		t.Fatalf("%d %+v", code, r)
	}
}

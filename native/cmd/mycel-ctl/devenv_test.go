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

// An update that brings new root/dev-env-srt/ files runs the new install-srt.sh once, with the install's id, when srt
// is on here (install-srt.sh's drop-in), after the app is switched; without the drop-in, or without new srt files, it
// runs nothing. A failure is a note, the update stays ok.
func TestUpdateRunsInstallSrtWhenSrtIsOn(t *testing.T) {
	for _, c := range []struct {
		name   string
		dropin string
		srt    bool
		fail   bool
		calls  int
	}{
		{"srt on, new srt files", "MYCEL_DEV_ENV=1\nMYCEL_DEV_ENV_RUNNER=srt\n", true, false, 1},
		{"srt on, install-srt fails", "MYCEL_DEV_ENV_RUNNER=srt\n", true, true, 1},
		{"srt off (no drop-in)", "", true, false, 0},
		{"srt on, no srt files in the release", "MYCEL_DEV_ENV_RUNNER=srt\n", false, false, 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			tb := syncTestBase(t)
			systemdUnitDir = t.TempDir()
			t.Cleanup(func() { systemdUnitDir = "/etc/systemd/system" })
			if c.dropin != "" {
				must(t, os.MkdirAll(filepath.Join(systemdUnitDir, "mycel-server.service.d"), 0o755))
				must(t, os.WriteFile(filepath.Join(systemdUnitDir, "mycel-server.service.d", "dev-env.conf"), []byte(c.dropin), 0o644))
			}
			marker := filepath.Join(t.TempDir(), "srt.calls")
			pub, priv, _ := ed25519.GenerateKey(rand.Reader)
			dir := signedBundle(t, "0.2.0", priv, "new launcher")
			if c.srt {
				must(t, os.MkdirAll(filepath.Join(dir, "root", devEnvRootDir), 0o755))
				script := "printf '%s|%s\\n' \"$*\" \"$(readlink '" + tb.base + "/app/current')\" >> '" + marker + "'\n"
				if c.fail {
					script += "echo 'install-srt: STOP: no network'; exit 1\n"
				}
				must(t, os.WriteFile(filepath.Join(dir, "root", devEnvRootDir, "install-srt.sh"), []byte(script), 0o644))
				must(t, bundle.WriteManifest(dir, "0.2.0", priv))
			}
			arch := filepath.Join(t.TempDir(), "0.2.0-linux-"+runtime.GOARCH+".tar.zst")
			mkArchive(t, dir, arch, nil)
			code, r := tb.update(t, "--bundle", arch, "--pubkey", base64.StdEncoding.EncodeToString(pub))
			if code != 0 || r.Result != "ok" || !r.AppUpdated {
				t.Fatalf("%d %+v", code, r)
			}
			got, notes := calls(marker), strings.Join(r.Notes, "\n")
			if len(got) != c.calls {
				t.Fatalf("install-srt.sh calls %q, notes %v", got, r.Notes)
			}
			if c.calls == 0 {
				return
			}
			if got[0] != "--id mycel|versions/0.2.0" {
				t.Fatalf("install-srt.sh %q (want its id, after the app switch)", got[0])
			}
			if c.fail != strings.Contains(notes, "install-srt: STOP: no network") || c.fail == strings.Contains(notes, "has this version's files") {
				t.Fatalf("notes %v", r.Notes)
			}
		})
	}
}

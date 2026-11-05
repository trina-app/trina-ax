package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func modesOf(t *testing.T, root string) map[string]os.FileMode {
	t.Helper()
	got := map[string]os.FileMode{}
	must(t, filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		got[rel] = info.Mode().Perm()
		return nil
	}))
	return got
}

func strictUmask(t *testing.T) {
	t.Helper()
	old := syscall.Umask(0o077)
	t.Cleanup(func() { syscall.Umask(old) })
}

// mycel-link runs `mycel-ctl update` with umask 077: the copy of a version folder must still be 755/644 so that the
// launcher (another account) can enter it.
func TestCopyTreeIgnoresUmask(t *testing.T) {
	strictUmask(t)
	src := filepath.Join(t.TempDir(), "src")
	must(t, os.MkdirAll(filepath.Join(src, "native/sub"), 0o700))
	must(t, os.WriteFile(filepath.Join(src, "native/mycel-launcher"), []byte("x"), 0o700))
	must(t, os.WriteFile(filepath.Join(src, "native/sub/data.json"), []byte("{}"), 0o600))
	dest := filepath.Join(t.TempDir(), "dest")
	must(t, copyTree(src, dest, account{os.Getuid(), os.Getgid()}))
	want := map[string]os.FileMode{
		".": 0o755, "native": 0o755, "native/sub": 0o755,
		"native/mycel-launcher": 0o755, "native/sub/data.json": 0o644,
	}
	got := modesOf(t, dest)
	for p, m := range want {
		if got[p] != m {
			t.Errorf("%s: mode %v, want %v", p, got[p], m)
		}
	}
}

func TestMkdirAll755IgnoresUmask(t *testing.T) {
	strictUmask(t)
	root := t.TempDir()
	must(t, os.Chmod(root, 0o711))
	must(t, mkdirAll755(filepath.Join(root, "a/b/c")))
	for _, p := range []string{"a", "a/b", "a/b/c"} {
		if st, err := os.Stat(filepath.Join(root, p)); err != nil || st.Mode().Perm() != 0o755 {
			t.Errorf("%s: %v %v", p, st, err)
		}
	}
	if st, _ := os.Stat(root); st.Mode().Perm() != 0o711 {
		t.Errorf("an existing folder changed: %v", st.Mode())
	}
}

func TestRepairTreeHeals0700(t *testing.T) {
	root := filepath.Join(t.TempDir(), "v")
	must(t, os.MkdirAll(filepath.Join(root, "native"), 0o700))
	must(t, os.Chmod(root, 0o700))
	must(t, os.WriteFile(filepath.Join(root, "native/mycel-launcher"), []byte("x"), 0o700))
	must(t, os.WriteFile(filepath.Join(root, "native/a.txt"), []byte("x"), 0o600))
	must(t, os.Symlink("a.txt", filepath.Join(root, "native/link")))
	must(t, repairTree(root, account{os.Getuid(), os.Getgid()}))
	got := modesOf(t, root)
	for p, m := range map[string]os.FileMode{".": 0o755, "native": 0o755, "native/mycel-launcher": 0o755, "native/a.txt": 0o644} {
		if got[p] != m {
			t.Errorf("%s: mode %v, want %v", p, got[p], m)
		}
	}
}

// the whole update under umask 077, then a version folder that an older mycel-ctl left 0700 is healed when the same
// version is installed again
func TestUpdateAppUnderStrictUmask(t *testing.T) {
	tb := newTestBase(t, "0.1.0")
	systemdRunDir = filepath.Join(t.TempDir(), "none")
	t.Cleanup(func() { systemdRunDir = "/run/systemd/system" })
	strictUmask(t)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	k := base64.StdEncoding.EncodeToString(pub)
	arch := filepath.Join(t.TempDir(), "0.2.0-linux-arm64.tar.zst")
	mkArchive(t, signedBundle(t, "0.2.0", priv, "new launcher"), arch, nil)
	hook := func(v string) {
		os.Remove(filepath.Join(tb.base, "app/current"))
		os.Symlink("versions/"+v, filepath.Join(tb.base, "app/current"))
		tb.health.Store(v)
	}
	updateHooks(t, tb, hook)
	if code, out, errs := tb.ctl("", "update", "--bundle", arch, "--pubkey", k, "--json"); code != 0 {
		t.Fatalf("%d %s %s", code, out, errs)
	}
	dest := filepath.Join(tb.base, "app/versions/0.2.0")
	checkModes := func(when string) {
		t.Helper()
		for p, m := range modesOf(t, dest) {
			if st, _ := os.Lstat(filepath.Join(dest, p)); st.IsDir() && m != 0o755 {
				t.Errorf("%s: folder %s has mode %v", when, p, m)
			} else if !st.IsDir() && m != 0o755 && m != 0o644 {
				t.Errorf("%s: file %s has mode %v", when, p, m)
			}
		}
	}
	checkModes("after the update")
	// break the tree like umask 077 did, go back to 0.1.0 and install 0.2.0 again
	must(t, filepath.WalkDir(dest, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return os.Chmod(p, 0o700)
		}
		return nil
	}))
	must(t, os.Remove(filepath.Join(tb.base, "app/current")))
	must(t, os.Symlink("versions/0.1.0", filepath.Join(tb.base, "app/current")))
	tb.health.Store("0.1.0")
	if code, out, errs := tb.ctl("", "update", "--bundle", arch, "--pubkey", k, "--json"); code != 0 {
		t.Fatalf("again: %d %s %s", code, out, errs)
	}
	checkModes("after the repair")
}

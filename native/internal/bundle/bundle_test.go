package bundle

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mkBundle(t *testing.T, v string, priv ed25519.PrivateKey) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), v)
	for p, c := range map[string]string{"bin/bun": "BUN", "server/src/main.js": "main", "root/mycel-ctl": "ctl"} {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, p)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, p), []byte(c), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := WriteManifest(dir, v, priv); err != nil {
		t.Fatal(err)
	}
	return dir
}

func key(t *testing.T) (string, ed25519.PrivateKey) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(pub), priv
}

func expectErr(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("want error containing %q, got %v", want, err)
	}
}

func TestVerifyDir(t *testing.T) {
	pub, priv := key(t)
	other, otherPriv := key(t)
	dir := mkBundle(t, "1.2.3", priv)
	if m, err := VerifyDir(dir, "1.2.3", Options{Keys: []string{pub}}); err != nil || m.Version != "1.2.3" {
		t.Fatalf("signed bundle: %v", err)
	}
	if _, err := VerifyDir(dir, "", Options{Keys: []string{pub}}); err != nil {
		t.Fatalf("any version: %v", err)
	}
	expectErr(t, func() error { _, e := VerifyDir(dir, "1.2.4", Options{Keys: []string{pub}}); return e }(), "manifest says version")
	expectErr(t, func() error { _, e := VerifyDir(dir, "", Options{Keys: []string{other}}); return e }(), "unknown key")
	// a signature by another key whose id matches is refused (wrong signature)
	dir2 := mkBundle(t, "1.2.3", otherPriv)
	os.WriteFile(filepath.Join(dir2, "more"), []byte("x"), 0o644)
	if err := WriteManifest(dir2, "1.2.3", otherPriv); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(dir2, "manifest.sig"), mustRead(t, filepath.Join(dir, "manifest.sig")), 0o644)
	expectErr(t, func() error { _, e := VerifyDir(dir2, "", Options{Keys: []string{pub}}); return e }(), "does not verify")
	// with no keys and allowUnsigned a present signature is not checked (bootstrap --allow-unsigned without --pubkey)
	if _, err := VerifyDir(dir, "", Options{AllowUnsigned: true}); err != nil {
		t.Fatal(err)
	}
	// tampered, extra, missing, symlink
	os.WriteFile(filepath.Join(dir, "bin/bun"), []byte("EVIL"), 0o755)
	expectErr(t, func() error { _, e := VerifyDir(dir, "", Options{Keys: []string{pub}}); return e }(), "file changed since release: bin/bun")
	os.WriteFile(filepath.Join(dir, "bin/bun"), []byte("BUN"), 0o755)
	os.WriteFile(filepath.Join(dir, "extra"), []byte("x"), 0o644)
	expectErr(t, func() error { _, e := VerifyDir(dir, "", Options{Keys: []string{pub}}); return e }(), "file not in manifest: extra")
	os.Remove(filepath.Join(dir, "extra"))
	os.Symlink("/etc/passwd", filepath.Join(dir, "link"))
	expectErr(t, func() error { _, e := VerifyDir(dir, "", Options{Keys: []string{pub}}); return e }(), "symlink in bundle: link")
	os.Remove(filepath.Join(dir, "link"))
	os.Remove(filepath.Join(dir, "server/src/main.js"))
	expectErr(t, func() error { _, e := VerifyDir(dir, "", Options{Keys: []string{pub}}); return e }(), "file missing: server/src/main.js")
}

func TestUnsigned(t *testing.T) {
	pub, _ := key(t)
	dir := mkBundle(t, "0.9.0", nil)
	expectErr(t, func() error { _, e := VerifyDir(dir, "", Options{Keys: []string{pub}}); return e }(), "manifest.sig missing")
	if _, err := VerifyDir(dir, "", Options{Keys: []string{pub}, AllowUnsigned: true}); err != nil {
		t.Fatal(err)
	}
}

func TestVerifySig(t *testing.T) {
	pub, priv := key(t)
	data := []byte(`{"version":"1.0.0"}`)
	sig := []byte(`{"keyId":"` + KeyID(mustB64(t, pub)) + `","sig":"` + base64.StdEncoding.EncodeToString(ed25519.Sign(priv, data)) + `"}`)
	if err := VerifySig(data, sig, []string{pub}); err != nil {
		t.Fatal(err)
	}
	if VerifySig([]byte(`{"version":"9.9.9"}`), sig, []string{pub}) == nil {
		t.Fatal("changed feed accepted")
	}
	if VerifySig(data, sig, nil) == nil {
		t.Fatal("no keys accepted a feed")
	}
	// the built-in keys are the release channel's (tests/unit/release-channel.test.ts checks they match it)
	if len(ReleaseKeys) == 0 {
		t.Fatal("no built-in release key")
	}
	seen := map[string]bool{}
	for _, k := range ReleaseKeys {
		if len(mustB64(t, k)) != 32 || seen[KeyID(mustB64(t, k))] {
			t.Fatalf("built-in release key %q is not a distinct 32-byte key", k)
		}
		seen[KeyID(mustB64(t, k))] = true
	}
}

func mustRead(t *testing.T, p string) []byte {
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func mustB64(t *testing.T, s string) []byte {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mycel/native/internal/bundle"
)

func TestValidVersion(t *testing.T) {
	for _, v := range []string{"0.1.0", "1.2.3-beta.1", "0.9.0-test.2", "2026.10.21+build_7"} {
		if !validVersion(v) {
			t.Errorf("%q should be a version", v)
		}
	}
	// state.json is written by the server account: a "previous" like ../../x must never become a path
	for _, v := range []string{"", ".", "..", "../x", "../../etc", "a/b", "/abs", "-x", ".hidden", "1.0\n"} {
		if validVersion(v) {
			t.Errorf("%q must not be accepted as a version", v)
		}
	}
}

// verifyVersion keeps its rules after the move to native/internal/bundle (shared with mycel-ctl).
func TestVerifyVersionSharedRules(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	app := t.TempDir()
	*appDir = app
	mk := func(folder, manifestVersion string, signed bool) {
		d := filepath.Join(app, "versions", folder)
		os.MkdirAll(filepath.Join(d, "bin"), 0o755)
		os.WriteFile(filepath.Join(d, "bin", "bun"), []byte("bun"), 0o755)
		var k ed25519.PrivateKey
		if signed {
			k = priv
		}
		if err := bundle.WriteManifest(d, manifestVersion, k); err != nil {
			t.Fatal(err)
		}
	}
	mk("1.0.0", "1.0.0", true)
	mk("1.0.1", "1.0.0", true)
	mk("0.9.0", "0.9.0", false)
	pubkeys = multi{base64.StdEncoding.EncodeToString(pub)}
	*allowUnsigned = false
	if err := verifyVersion("1.0.0"); err != nil {
		t.Fatal(err)
	}
	if err := verifyVersion("1.0.1"); err == nil || !strings.Contains(err.Error(), "manifest says version") {
		t.Fatalf("moved manifest: %v", err)
	}
	if err := verifyVersion("0.9.0"); err == nil || !strings.Contains(err.Error(), "manifest.sig missing") {
		t.Fatalf("unsigned: %v", err)
	}
	if err := verifyVersion("../x"); err == nil {
		t.Fatal("path accepted")
	}
	*allowUnsigned = true
	if err := verifyVersion("0.9.0"); err != nil {
		t.Fatal(err)
	}
	pubkeys = nil
	*allowUnsigned = false
}

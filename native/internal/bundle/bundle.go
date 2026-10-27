// Package bundle verifies a release version folder: manifest.json lists every file with its sha256 and size, and
// manifest.sig (Ed25519 over the exact manifest bytes, offline release key) proves it is ours. Shared by
// mycel-bootstrap (before every server start) and mycel-ctl (verify-bundle, update) so both refuse the same things;
// the server's own check is server/src/system/update.ts verifyBundleDir (same rules, TypeScript).
package bundle

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
)

// ReleaseKeys (the built-in release public keys) are in release_keys.go, written from the release channel.

// a version is a folder name in app/versions/ (shared/src/install.ts BundleManifest.version), never a path
var versionRe = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z.+_-]{0,49}$`)

// ValidVersion: usable as a folder name under app/versions/.
func ValidVersion(v string) bool { return versionRe.MatchString(v) && v != "." && v != ".." }

// File is one manifest entry.
type File struct {
	Sha256 string `json:"sha256"`
	Size   int64  `json:"size"`
	Mode   int    `json:"mode"`
}

// Manifest is manifest.json (shared/src/install.ts BundleManifest).
type Manifest struct {
	Format    int             `json:"format"`
	Version   string          `json:"version"`
	CreatedAt string          `json:"createdAt"`
	Files     map[string]File `json:"files"`
}

// KeyID is the first 8 bytes of sha256(public key), hex (server/src/system/update.ts keyId).
func KeyID(pub []byte) string { h := sha256.Sum256(pub); return hex.EncodeToString(h[:8]) }

// Options: Keys are base64 Ed25519 public keys; AllowUnsigned accepts a folder without manifest.sig (development and
// test installs), and with no keys at all also a signature it cannot check (integrity only).
type Options struct {
	Keys          []string
	AllowUnsigned bool
}

// VerifyDir checks a version folder: manifest format 1, the version (wantVersion, when not empty, must match the
// manifest), the signature, no links or special files, every file listed with the right size and sha256, no file
// missing. Returns the manifest.
func VerifyDir(dir, wantVersion string, o Options) (*Manifest, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return nil, fmt.Errorf("manifest: %v", err)
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil || m.Format != 1 {
		return nil, fmt.Errorf("manifest: not a format-1 manifest")
	}
	if wantVersion != "" && m.Version != wantVersion {
		return nil, fmt.Errorf("manifest says version %q, folder is %q", m.Version, wantVersion)
	}
	if !ValidVersion(m.Version) {
		return nil, fmt.Errorf("manifest: not a version name: %q", m.Version)
	}
	if err := VerifyManifestSig(dir, raw, o); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	err = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		rel = filepath.ToSlash(rel)
		if rel == "." || rel == "manifest.json" || rel == "manifest.sig" {
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return fmt.Errorf("symlink in bundle: %s", rel)
		}
		if d.IsDir() {
			return nil
		}
		if !d.Type().IsRegular() {
			return fmt.Errorf("not a regular file: %s", rel)
		}
		want, ok := m.Files[rel]
		if !ok {
			return fmt.Errorf("file not in manifest: %s", rel)
		}
		sum, n, err := HashFile(p)
		if err != nil {
			return err
		}
		if n != want.Size || sum != want.Sha256 {
			return fmt.Errorf("file changed since release: %s", rel)
		}
		seen[rel] = true
		return nil
	})
	if err != nil {
		return nil, err
	}
	for rel := range m.Files {
		if !seen[rel] {
			return nil, fmt.Errorf("file missing: %s", rel)
		}
	}
	return &m, nil
}

// HashFile returns the sha256 (hex) and size of a file.
func HashFile(p string) (string, int64, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

// VerifyManifestSig checks dir/manifest.sig over raw (the manifest bytes).
func VerifyManifestSig(dir string, raw []byte, o Options) error {
	sigRaw, err := os.ReadFile(filepath.Join(dir, "manifest.sig"))
	if errors.Is(err, fs.ErrNotExist) {
		if o.AllowUnsigned {
			return nil
		}
		return fmt.Errorf("manifest.sig missing (unsigned bundle)")
	}
	if err != nil {
		return err
	}
	return verifySig(raw, sigRaw, o, "manifest")
}

// VerifySig checks a {keyId, sig} signature file (shared/src/install.ts BundleSignature) over data, e.g. a release
// feed and its .sig. Unsigned is never accepted here.
func VerifySig(data, sigJSON []byte, keys []string) error {
	return verifySig(data, sigJSON, Options{Keys: keys}, "release feed")
}

func verifySig(data, sigRaw []byte, o Options, what string) error {
	var s struct {
		KeyID string `json:"keyId"`
		Sig   string `json:"sig"`
	}
	if json.Unmarshal(sigRaw, &s) != nil {
		return fmt.Errorf("%s.sig unreadable", what)
	}
	sig, err := base64.StdEncoding.DecodeString(s.Sig)
	if err != nil {
		return fmt.Errorf("%s.sig unreadable", what)
	}
	for _, k := range o.Keys {
		pub, err := base64.StdEncoding.DecodeString(k)
		if err != nil || len(pub) != ed25519.PublicKeySize || KeyID(pub) != s.KeyID {
			continue
		}
		if ed25519.Verify(pub, data, sig) {
			return nil
		}
		return fmt.Errorf("%s signature does not verify", what)
	}
	if len(o.Keys) == 0 && o.AllowUnsigned {
		return nil // no release key configured (test install): integrity only
	}
	return fmt.Errorf("%s signed by an unknown key %s", what, s.KeyID)
}

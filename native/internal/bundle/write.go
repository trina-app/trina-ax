package bundle

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// WriteManifest writes manifest.json for every regular file under dir and, with priv, manifest.sig. Release bundles
// are made by scripts/build-bundle.ts; this is for tests and local tooling that need a bundle the Go side accepts.
func WriteManifest(dir, version string, priv ed25519.PrivateKey) error {
	m := Manifest{Format: 1, Version: version, CreatedAt: time.Now().UTC().Format(time.RFC3339), Files: map[string]File{}}
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		rel = filepath.ToSlash(rel)
		if rel == "manifest.json" || rel == "manifest.sig" || !d.Type().IsRegular() {
			return nil
		}
		sum, n, err := HashFile(p)
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		m.Files[rel] = File{Sha256: sum, Size: n, Mode: int(info.Mode().Perm())}
		return nil
	})
	if err != nil {
		return err
	}
	raw, _ := json.MarshalIndent(m, "", " ")
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), raw, 0o644); err != nil {
		return err
	}
	if priv == nil {
		return nil
	}
	pub := priv.Public().(ed25519.PublicKey)
	sig, _ := json.Marshal(map[string]string{"keyId": KeyID(pub), "sig": base64.StdEncoding.EncodeToString(ed25519.Sign(priv, raw))})
	return os.WriteFile(filepath.Join(dir, "manifest.sig"), sig, 0o644)
}

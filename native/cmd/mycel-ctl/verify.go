package main

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"mycel/native/internal/bundle"
)

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

// VerifyResult is verify-bundle's JSON.
type VerifyResult struct {
	OK      bool   `json:"ok"`
	Path    string `json:"path"`
	Version string `json:"version,omitempty"`
	Signed  bool   `json:"signed"`
	KeyID   string `json:"keyId,omitempty"`
	Files   int    `json:"files,omitempty"`
	Error   string `json:"error,omitempty"`
}

func cmdVerifyBundle(e *env, args []string) (int, error) {
	pos, rest := positional(args)
	fs := flag.NewFlagSet("verify-bundle", flag.ContinueOnError)
	allowUnsigned := fs.Bool("allow-unsigned", false, "accept a bundle without manifest.sig (development bundles)")
	asJSON := fs.Bool("json", false, "JSON output")
	var keys multiFlag
	fs.Var(&keys, "pubkey", "extra release public key (base64 Ed25519), repeatable")
	if err := fs.Parse(rest); err != nil {
		return 2, usageError{err.Error()}
	}
	pos = append(pos, fs.Args()...)
	if len(pos) != 1 {
		return 2, usageError{"verify-bundle DIR|FILE"}
	}
	opts := bundle.Options{Keys: append(append([]string{}, bundle.ReleaseKeys...), keys...), AllowUnsigned: *allowUnsigned}
	r := verifyPath(pos[0], opts)
	if *asJSON {
		printJSON(e.stdout, r)
	} else if r.OK {
		how := "unsigned"
		if r.Signed {
			how = "signed by key " + r.KeyID
		}
		fmt.Fprintf(e.stdout, "ok %s (%d files, %s)\n", r.Version, r.Files, how)
	}
	if !r.OK {
		return 1, fmt.Errorf("%s", r.Error)
	}
	return 0, nil
}

// verifyPath verifies a version folder, or a .tar.zst unpacked into a private temp folder first.
func verifyPath(p string, o bundle.Options) VerifyResult {
	r := VerifyResult{Path: p}
	st, err := os.Stat(p)
	if err != nil {
		r.Error = err.Error()
		return r
	}
	dir, want := p, ""
	if st.IsDir() {
		if b := filepath.Base(filepath.Clean(p)); bundle.ValidVersion(b) && strings.ContainsAny(b, "0123456789") {
			want = b // app/<v>: the folder name must be the manifest's version (bootstrap rule)
		}
	} else {
		tmp, err := os.MkdirTemp("", "mycel-verify-")
		if err != nil {
			r.Error = err.Error()
			return r
		}
		defer os.RemoveAll(tmp)
		dir = filepath.Join(tmp, "b")
		if err := extractBundle(p, dir); err != nil {
			r.Error = err.Error()
			return r
		}
	}
	m, err := bundle.VerifyDir(dir, want, o)
	if err != nil {
		r.Error = err.Error()
		return r
	}
	r.OK, r.Version, r.Files = true, m.Version, len(m.Files)
	if b, err := os.ReadFile(filepath.Join(dir, "manifest.sig")); err == nil {
		var s struct {
			KeyID string `json:"keyId"`
		}
		if json.Unmarshal(b, &s) == nil && len(o.Keys) > 0 {
			r.Signed, r.KeyID = true, s.KeyID
		}
	}
	return r
}

var zstdCandidates = []string{"/usr/bin/zstd", "/bin/zstd"}

func zstdBin() (string, error) {
	for _, c := range zstdCandidates {
		if fileExists(c) {
			return c, nil
		}
	}
	if os.Geteuid() != 0 { // tests on a developer machine (Homebrew zstd); root never searches PATH
		if p, err := exec.LookPath("zstd"); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("zstd is not installed (apt-get install zstd)")
}

const (
	maxBundleBytes   = 8 << 30
	maxBundleEntries = 200_000
)

// extractBundle unpacks a release archive (.tar.zst made by packBundle: plain files and folders at the top) into a
// new folder dest. Only regular files and folders are accepted, with names that stay inside dest; modes keep only
// the owner's execute bit pattern (0755/0644). zstd decompresses; Go's archive/tar parses, so nothing in the archive
// can make the extraction follow a link or write elsewhere.
func extractBundle(file, dest string) error {
	zb, err := zstdBin()
	if err != nil {
		return err
	}
	if err := os.Mkdir(dest, 0o755); err != nil {
		return err
	}
	cmd := exec.Command(zb, "-dc", "--", file)
	cmd.Env = []string{"PATH=/usr/bin:/bin"}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	xerr := untar(out, dest)
	_, _ = io.Copy(io.Discard, out)
	werr := cmd.Wait()
	if xerr != nil {
		return xerr
	}
	if werr != nil {
		return fmt.Errorf("zstd: %v %s", werr, strings.TrimSpace(stderr.String()))
	}
	return nil
}

func untar(r io.Reader, dest string) error {
	tr := tar.NewReader(r)
	var total int64
	n := 0
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("archive: %v", err)
		}
		if n++; n > maxBundleEntries {
			return fmt.Errorf("archive: too many entries")
		}
		name := strings.TrimPrefix(h.Name, "./")
		clean := filepath.Clean(name)
		if name == "" || clean == "." {
			continue
		}
		if filepath.IsAbs(name) || clean == ".." || strings.HasPrefix(clean, "../") || strings.ContainsRune(name, 0) {
			return fmt.Errorf("archive: unsafe name %q", h.Name)
		}
		p := filepath.Join(dest, clean)
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(p, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			total += h.Size
			if h.Size < 0 || total > maxBundleBytes {
				return fmt.Errorf("archive: too large")
			}
			if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
				return err
			}
			mode := os.FileMode(0o644)
			if h.Mode&0o111 != 0 {
				mode = 0o755
			}
			f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, mode)
			if err != nil {
				return err
			}
			_, cerr := io.CopyN(f, tr, h.Size)
			if err := f.Close(); cerr == nil {
				cerr = err
			}
			if cerr != nil {
				return cerr
			}
		default:
			return fmt.Errorf("archive: %q is not a file or folder (type %q)", h.Name, string(h.Typeflag))
		}
	}
}

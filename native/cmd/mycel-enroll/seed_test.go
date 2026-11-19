package main

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// richSeed adds to the harness seed what a real kit has: nested folders with other modes, an executable with set-uid,
// links (relative, absolute, dangling, to a folder), a hard link, a file bigger than two read-ahead chunks, an empty
// file, a FIFO, old times and an xattr (when the temp file system takes user xattrs). It returns whether xattrs work.
func richSeed(t *testing.T, seed string) bool {
	t.Helper()
	nm := filepath.Join(seed, "app", "versions", "0.3.0", "node_modules", "a", "lib")
	must(t, os.MkdirAll(nm, 0o755))
	for i := 0; i < 40; i++ {
		must(t, os.WriteFile(filepath.Join(nm, fmt.Sprintf("f%02d.js", i)), bytes.Repeat([]byte{byte(i)}, 100*i+1), 0o644))
	}
	must(t, os.WriteFile(filepath.Join(seed, "root", "empty"), nil, 0o600))
	big := bytes.Repeat([]byte("0123456789abcdef"), (2*readAheadChunk+12345)/16)
	must(t, os.WriteFile(filepath.Join(seed, "root", "big.bin"), big, 0o755))
	must(t, os.Chmod(filepath.Join(seed, "root", "big.bin"), 0o4755))
	must(t, os.Link(filepath.Join(seed, "root", "mycel-ctl"), filepath.Join(seed, "root", "mycel-ctl.hard")))
	must(t, os.Symlink("../app/current/bin/bun", filepath.Join(seed, "root", "bun")))
	must(t, os.Symlink("/nonexistent/target", filepath.Join(seed, "root", "dangling")))
	must(t, os.Symlink("versions", filepath.Join(seed, "app", "vlink")))
	must(t, syscall.Mkfifo(filepath.Join(seed, "root", "fifo"), 0o640))
	must(t, os.MkdirAll(filepath.Join(seed, "data", "private"), 0o700))
	must(t, os.Chmod(filepath.Join(seed, "data"), 0o750))
	xattr := unix.Setxattr(filepath.Join(seed, "root", "mycel-ctl"), "user.ax.test", []byte("cap-like"), 0) == nil
	if runtime.GOOS == "linux" && os.Geteuid() == 0 {
		// as root (CI containers, the image): other owners and a file capability (cap_net_bind_service, VFS v2),
		// which a chown after it would clear
		capFile := filepath.Join(seed, "root", "big.bin")
		must(t, os.Chmod(capFile, 0o755))
		must(t, os.Lchown(filepath.Join(seed, "config"), 990, 990))
		must(t, os.Lchown(filepath.Join(seed, "root", "bun"), 990, 991))
		must(t, os.Chown(capFile, 990, 990))
		capv2 := []byte{0x01, 0, 0, 0x02, 1 << 2, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}
		if err := unix.Setxattr(capFile, "security.capability", capv2, 0); err != nil {
			t.Logf("no file capabilities here: %v", err)
		}
	}
	old := time.Date(2024, 3, 4, 5, 6, 7, 0, time.UTC)
	// times last, deepest first, so setting one does not change its folder's
	var all []string
	must(t, filepath.WalkDir(seed, func(p string, d fs.DirEntry, err error) error { all = append(all, p); return err }))
	sort.Sort(sort.Reverse(sort.StringSlice(all)))
	for _, p := range all {
		tv := []unix.Timeval{unix.NsecToTimeval(old.UnixNano()), unix.NsecToTimeval(old.UnixNano())}
		must(t, unix.Lutimes(p, tv))
	}
	return xattr
}

// treeOf describes every entry under root: type, mode, owner, size, content hash, link target, mtime, xattrs and which
// entries share an inode (hard links).
func treeOf(t *testing.T, root string, xattr bool) map[string]string {
	t.Helper()
	out := map[string]string{}
	inodes := map[uint64]string{}
	must(t, filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		if rel == seedMarker {
			t.Errorf("%s left in the tree", seedMarker)
		}
		fi, err := os.Lstat(p)
		if err != nil {
			return err
		}
		st := fi.Sys().(*syscall.Stat_t)
		desc := fmt.Sprintf("%v uid=%d gid=%d mtime=%d", fi.Mode(), st.Uid, st.Gid, fi.ModTime().Unix())
		switch {
		case fi.Mode()&os.ModeSymlink != 0:
			l, _ := os.Readlink(p)
			desc += " -> " + l
		case fi.Mode().IsRegular():
			b, err := os.ReadFile(p)
			if err != nil {
				return err
			}
			desc += fmt.Sprintf(" size=%d sum=%x", len(b), fnv(b))
			// hard links: GNU cp -a (the image's) keeps them, the BSD cp of a Mac test run does not
			if first, ok := inodes[uint64(st.Ino)]; ok && runtime.GOOS == "linux" {
				desc += " hardlink-of=" + first
			} else {
				inodes[uint64(st.Ino)] = rel
			}
		}
		if xattr && fi.Mode()&os.ModeSymlink == 0 && fi.Mode()&os.ModeNamedPipe == 0 {
			buf := make([]byte, 64)
			if n, err := unix.Getxattr(p, "user.ax.test", buf); err == nil {
				desc += " xattr=" + string(buf[:n])
			}
		}
		if runtime.GOOS == "linux" && fi.Mode().IsRegular() {
			buf := make([]byte, 64)
			if n, err := unix.Getxattr(p, "security.capability", buf); err == nil {
				desc += fmt.Sprintf(" cap=%x", buf[:n])
			}
		}
		out[rel] = desc
		return nil
	}))
	return out
}

func fnv(b []byte) uint64 {
	h := uint64(14695981039346656037)
	for _, c := range b {
		h ^= uint64(c)
		h *= 1099511628211
	}
	return h
}

func sameTree(t *testing.T, want, got map[string]string) {
	t.Helper()
	for k, w := range want {
		if g, ok := got[k]; !ok {
			t.Errorf("missing %s", k)
		} else if g != w {
			t.Errorf("%s:\n want %s\n  got %s", k, w, g)
		}
	}
	for k := range got {
		if _, ok := want[k]; !ok {
			t.Errorf("extra %s", k)
		}
	}
}

func TestReadAheadReadsEveryFileOnceAndFollowsNoLink(t *testing.T) {
	h := newHarness(t)
	richSeed(t, h.e.P.Seed)
	// a link out of the seed must not be read
	outside := filepath.Join(h.root, "outside")
	must(t, os.MkdirAll(outside, 0o755))
	must(t, os.WriteFile(filepath.Join(outside, "huge"), make([]byte, 1<<20), 0o644))
	must(t, os.Symlink(outside, filepath.Join(h.e.P.Seed, "out-dir")))
	must(t, os.Symlink(filepath.Join(outside, "huge"), filepath.Join(h.e.P.Seed, "out-file")))
	var files, size int64
	must(t, filepath.WalkDir(h.e.P.Seed, func(p string, d fs.DirEntry, err error) error {
		if d.Type().IsRegular() {
			fi, _ := d.Info()
			files++
			size += fi.Size()
		}
		return err
	}))
	for _, n := range []int{1, 3, 32} {
		done := make(chan readAheadStats)
		go func() { done <- readAhead(h.e.P.Seed, n) }()
		select {
		case st := <-done:
			if st.Files != files || st.Bytes != size || st.Errors != 0 {
				t.Fatalf("%d readers: %+v, want %d files %d bytes", n, st, files, size)
			}
		case <-time.After(20 * time.Second):
			t.Fatalf("%d readers: read-ahead hangs (the FIFO?)", n)
		}
	}
	// a folder it cannot list is counted, not fatal (as root everything is readable)
	if os.Geteuid() != 0 {
		locked := filepath.Join(h.e.P.Seed, "locked")
		must(t, os.MkdirAll(locked, 0o755))
		must(t, os.Chmod(locked, 0))
		defer os.Chmod(locked, 0o755)
		if st := readAhead(h.e.P.Seed, 4); st.Errors != 1 || st.Files != files {
			t.Fatalf("locked folder: %+v", st)
		}
	}
	if st := readAhead(filepath.Join(h.root, "missing"), 4); st.Errors != 1 || st.Files != 0 {
		t.Fatalf("missing root: %+v", st)
	}
}

func TestSeedCopiesTheTreeLikeCpA(t *testing.T) {
	h := newHarness(t)
	xattr := richSeed(t, h.e.P.Seed)
	if !xattr {
		t.Log("the temp file system takes no user xattrs: xattrs are not compared")
	}
	want := treeOf(t, h.e.P.Seed, xattr)
	must(t, h.e.seed())
	sameTree(t, want, treeOf(t, h.e.P.Base, xattr))
	if h.e.kitVersion != "0.3.0" || exists(filepath.Join(h.e.P.Base, seedMarker)) {
		t.Fatalf("kit %q, marker left: %v", h.e.kitVersion, exists(filepath.Join(h.e.P.Base, seedMarker)))
	}
	out := h.out.String()
	for _, s := range []string{"seed: start", "seed: read ahead ", "(32 readers, 0 errors)", "seed: copied in "} {
		if !strings.Contains(out, s) {
			t.Fatalf("log has no %q:\n%s", s, out)
		}
	}
	// a second run leaves the install alone
	must(t, h.e.seed())
	if len(h.run.named("cp")) != 1 {
		t.Fatal("a finished seed was copied again")
	}
}

func TestSeedRetriesAHalfCopy(t *testing.T) {
	h := newHarness(t)
	xattr := richSeed(t, h.e.P.Seed)
	want := treeOf(t, h.e.P.Seed, xattr)
	// the copy fails half way: the marker stays and the error is the step's
	h.run.failNames["cp"] = &CmdError{Name: "cp", Code: 1, Stderr: "No space left on device"}
	err := h.e.seed()
	var f *failure
	if !errors.As(err, &f) || f.Code != "seed_failed" || !exists(filepath.Join(h.e.P.Base, seedMarker)) {
		t.Fatalf("failed copy: %v", err)
	}
	// what a killed cp leaves: root/VERSION already there, a cut file, a link and a file where the seed has others
	base := h.e.P.Base
	must(t, os.MkdirAll(filepath.Join(base, "root"), 0o755))
	must(t, os.WriteFile(filepath.Join(base, "root", "VERSION"), []byte("0.3.0\n"), 0o644))
	must(t, os.WriteFile(filepath.Join(base, "root", "big.bin"), []byte("cut"), 0o600))
	must(t, os.Symlink("wrong", filepath.Join(base, "root", "bun")))
	must(t, os.MkdirAll(filepath.Join(base, "app"), 0o700))
	must(t, os.Symlink("elsewhere", filepath.Join(base, "app", "current")))
	delete(h.run.failNames, "cp")

	// reattach does not take a half copy for an install
	h.writeEnroll("reattach", "https://cp.invalid")
	h.run.labelDev = "/dev/sdb"
	if err := h.e.Main(); err == nil || h.status().Error.Code != "kit_incomplete" {
		t.Fatalf("reattach of a half copy: %v", err)
	}

	h.out.Reset()
	must(t, h.e.seed())
	if !strings.Contains(h.out.String(), "did not finish, copying again") || len(h.run.named("cp")) != 2 {
		t.Fatalf("no second copy:\n%s", h.out.String())
	}
	sameTree(t, want, treeOf(t, base, xattr))
}

func TestSeedReadersSetting(t *testing.T) {
	h := newHarness(t)
	h.env["AX_ENROLL_SEED_READERS"] = "0"
	must(t, h.e.seed())
	if strings.Contains(h.out.String(), "read ahead") || !strings.Contains(h.out.String(), "copied in") {
		t.Fatalf("readers 0 still read ahead:\n%s", h.out.String())
	}
	for v, want := range map[string]int{"4": 4, "256": 256, "x": defaultSeedReaders, "-1": defaultSeedReaders, "999": defaultSeedReaders} {
		h.env["AX_ENROLL_SEED_READERS"] = v
		if got := h.e.seedReaders(); got != want {
			t.Fatalf("%q: %d, want %d", v, got, want)
		}
	}
	delete(h.env, "AX_ENROLL_SEED_READERS")
	if h.e.seedReaders() != defaultSeedReaders {
		t.Fatal("default")
	}
}

// Package safebroker handles broker-only filesystem operations, never parser work.
// The broker supplies an already opened approved root on FD 3. No openat2 fallback.
package safebroker

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"io"
	"os"
	"path"
	"strings"
)

const resolve = unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_NO_XDEV

func Open(root int, rel string, flags int) (int, error) {
	if rel == "" || strings.HasPrefix(rel, "/") || path.Clean(rel) != rel || rel == ".." || strings.HasPrefix(rel, "../") {
		return -1, errors.New("invalid relative path")
	}
	return unix.Openat2(root, rel, &unix.OpenHow{Flags: uint64(flags | unix.O_CLOEXEC | unix.O_NOFOLLOW), Resolve: resolve})
}
func version(s unix.Stat_t) string {
	return fmt.Sprintf("%d:%d:%d:%d:%d:%d:%d", s.Dev, s.Ino, s.Size, s.Mtim.Sec, s.Mtim.Nsec, s.Ctim.Sec, s.Ctim.Nsec)
}
func Snapshot(root int, rel string, cap int64, out io.Writer) error {
	fd, e := Open(root, rel, unix.O_RDONLY|unix.O_NONBLOCK)
	if e != nil {
		return e
	}
	f := os.NewFile(uintptr(fd), "source")
	defer f.Close()
	var a, b unix.Stat_t
	if e = unix.Fstat(fd, &a); e != nil {
		return e
	}
	if a.Mode&unix.S_IFMT != unix.S_IFREG || a.Nlink != 1 || a.Size < 0 || a.Size > cap {
		return errors.New("unsafe source")
	}
	buf := make([]byte, a.Size)
	if _, e = io.ReadFull(f, buf); e != nil {
		return e
	}
	if e = unix.Fstat(fd, &b); e != nil {
		return e
	}
	if version(a) != version(b) {
		return errors.New("source changed")
	}
	// Reopen through the same root to reject moves/replacement during the copy.
	other, e := Open(root, rel, unix.O_RDONLY|unix.O_NONBLOCK)
	if e != nil {
		return e
	}
	defer unix.Close(other)
	if e = unix.Fstat(other, &b); e != nil {
		return e
	}
	if version(a) != version(b) {
		return errors.New("source moved")
	}
	h := sha256.Sum256(buf)
	if e = json.NewEncoder(out).Encode(map[string]any{"identity": version(a), "dev": a.Dev, "ino": a.Ino, "size": a.Size, "hash": hex.EncodeToString(h[:])}); e != nil {
		return e
	}
	_, e = out.Write(buf)
	return e
}

// Publish uses linkat, which atomically fails with EEXIST. A deterministic hidden
// temporary name lets the journal reconcile a crash on either side of linkat.
func Publish(root int, rel, job, hash string, input io.Reader) error {
	if len(job) != 36 || strings.ContainsAny(job, "/\\.") {
		return errors.New("invalid job")
	}
	dir, e := Open(root, path.Dir(rel), unix.O_RDONLY|unix.O_DIRECTORY)
	if e != nil {
		return e
	}
	defer unix.Close(dir)
	name := path.Base(rel)
	if name == "." || name == ".." {
		return errors.New("invalid destination")
	}
	tmp := ".mycel-tmp-safe-" + job
	fd, e := unix.Openat(dir, tmp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0400)
	if e != nil {
		return e
	}
	f := os.NewFile(uintptr(fd), tmp)
	h := sha256.New()
	n, e := io.Copy(io.MultiWriter(f, h), io.LimitReader(input, (32<<20)+1))
	if e == nil && (n > 32<<20 || hex.EncodeToString(h.Sum(nil)) != hash) {
		e = errors.New("artifact mismatch")
	}
	if e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e == nil {
		e = closeErr
	}
	if e != nil {
		_ = unix.Unlinkat(dir, tmp, 0)
		return e
	}
	if e = unix.Fsync(dir); e != nil {
		return e
	}
	// The parent must still be reachable by its approved path. A moved parent is
	// a failure; no source or destination pathname is followed after opening it.
	again, e := Open(root, path.Dir(rel), unix.O_RDONLY|unix.O_DIRECTORY)
	if e != nil {
		return e
	}
	var a, b unix.Stat_t
	_ = unix.Fstat(dir, &a)
	_ = unix.Fstat(again, &b)
	unix.Close(again)
	if a.Dev != b.Dev || a.Ino != b.Ino {
		return errors.New("parent moved")
	}
	e = unix.Linkat(dir, tmp, dir, name, 0)
	clean := unix.Unlinkat(dir, tmp, 0)
	sync := unix.Fsync(dir)
	if clean != nil {
		return clean
	}
	if sync != nil {
		return sync
	}
	return e
}
func Clean(root int, rel, job string) error {
	if len(job) != 36 || strings.ContainsAny(job, "/\\.") {
		return errors.New("invalid job")
	}
	dir, e := Open(root, path.Dir(rel), unix.O_RDONLY|unix.O_DIRECTORY)
	if e != nil {
		return e
	}
	defer unix.Close(dir)
	e = unix.Unlinkat(dir, ".mycel-tmp-safe-"+job, 0)
	if e != nil && !errors.Is(e, unix.ENOENT) {
		return e
	}
	return unix.Fsync(dir)
}

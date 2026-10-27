// Safe file operations inside a chat folder (security fix D27, spec 3.3.8; both macOS and Linux).
//
// The launcher runs as the engine account OUTSIDE the engine sandbox, and the chat folder is written by the engine. A
// compromised engine can plant symbolic links there: `.claude/projects/x/<sid>.jsonl -> <agent>/codex-auth/auth.json`
// made the session collection read the team's ChatGPT login (and the server then restored it into the chat for the
// engine to read), `.claude -> <other chat>` made `RemoveAll(<chat>/.claude/projects)` delete another chat's
// sessions and the session restore write into another chat. Every file operation of the launcher below a chat folder
// (or a --session-root) therefore goes through a dirRoot: the root is opened once, and every path below it is resolved
// component by component without following any link (Linux: openat2 RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS; macOS: openat
// O_NOFOLLOW per component). A link found where a folder is expected is never followed: reads treat it as missing,
// mkdirAll replaces it with a real folder (it is inside the engine's own folder), removals unlink the link itself.
package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/sys/unix"
)

// dirRoot is an open folder all relative paths are resolved beneath.
type dirRoot struct {
	fd   int
	path string
}

// openRoot opens a trusted folder (a chat folder the launcher checked, or a --session-root). The root itself may be
// reached through links in its parents (configuration, e.g. /tmp -> /private/tmp); nothing below it is.
func openRoot(p string) (*dirRoot, error) {
	fd, err := unix.Open(p, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: p, Err: err}
	}
	return &dirRoot{fd: fd, path: p}, nil
}

func (d *dirRoot) close() {
	if d != nil && d.fd >= 0 {
		_ = unix.Close(d.fd)
		d.fd = -1
	}
}

// splitRel checks a path relative to the root: not absolute, no "..", no empty components. "" and "." are the root.
func splitRel(rel string) ([]string, error) {
	if rel == "" || rel == "." {
		return nil, nil
	}
	if filepath.IsAbs(rel) || strings.ContainsRune(rel, 0) {
		return nil, fmt.Errorf("not a relative path: %q", rel)
	}
	parts := strings.Split(filepath.ToSlash(rel), "/")
	out := parts[:0]
	for _, p := range parts {
		switch p {
		case "", ".":
			continue
		case "..":
			return nil, fmt.Errorf("path leaves its folder: %q", rel)
		}
		out = append(out, p)
	}
	return out, nil
}

// walkOpen opens the components one by one from dirfd: every component with O_NOFOLLOW (a link fails with ELOOP or
// ENOTDIR), intermediate ones with O_DIRECTORY. Used directly on macOS and as the Linux fallback without openat2.
func walkOpen(dirfd int, parts []string, flags int, mode uint32) (int, error) {
	cur, owned := dirfd, false
	defer func() {
		if owned {
			_ = unix.Close(cur)
		}
	}()
	if len(parts) == 0 {
		fd, err := unix.Openat(dirfd, ".", flags|unix.O_CLOEXEC, mode)
		return fd, err
	}
	for i, p := range parts {
		last := i == len(parts)-1
		f := unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC
		var m uint32
		if last {
			f, m = flags|unix.O_NOFOLLOW|unix.O_CLOEXEC, mode
		}
		fd, err := unix.Openat(cur, p, f, m)
		if err != nil {
			return -1, err
		}
		if owned {
			_ = unix.Close(cur)
		}
		if last {
			owned = false
			return fd, nil
		}
		cur, owned = fd, true
	}
	return -1, unix.EINVAL // not reached
}

// open opens rel below the root without following any link (openBeneath is per platform).
func (d *dirRoot) open(rel string, flags int, mode uint32) (int, error) {
	parts, err := splitRel(rel)
	if err != nil {
		return -1, err
	}
	fd, err := openBeneath(d.fd, parts, flags, mode)
	if err != nil {
		return -1, &os.PathError{Op: "open", Path: rel, Err: err}
	}
	return fd, nil
}

// parent opens the folder that holds rel's last component and returns it with that name. rel must not be the root.
func (d *dirRoot) parent(rel string) (int, string, error) {
	parts, err := splitRel(rel)
	if err != nil {
		return -1, "", err
	}
	if len(parts) == 0 {
		return -1, "", fmt.Errorf("the folder itself has no parent here")
	}
	fd, err := openBeneath(d.fd, parts[:len(parts)-1], unix.O_RDONLY|unix.O_DIRECTORY, 0)
	if err != nil {
		return -1, "", &os.PathError{Op: "open", Path: strings.Join(parts[:len(parts)-1], "/"), Err: err}
	}
	return fd, parts[len(parts)-1], nil
}

// lstat returns rel's own metadata (a link is reported as a link).
func (d *dirRoot) lstat(rel string) (unix.Stat_t, error) {
	var st unix.Stat_t
	parts, err := splitRel(rel)
	if err != nil {
		return st, err
	}
	if len(parts) == 0 {
		return st, unix.Fstat(d.fd, &st)
	}
	pfd, name, err := d.parent(rel)
	if err != nil {
		return st, err
	}
	defer unix.Close(pfd)
	err = unix.Fstatat(pfd, name, &st, unix.AT_SYMLINK_NOFOLLOW)
	return st, err
}

func isDir(st unix.Stat_t) bool { return st.Mode&unix.S_IFMT == unix.S_IFDIR }
func isReg(st unix.Stat_t) bool { return st.Mode&unix.S_IFMT == unix.S_IFREG }

// mkdirAll creates rel and its parents (mode perm). A component that exists but is not a real folder (a planted link
// or file) is removed and replaced by a folder: everything here is the engine's own chat folder.
func (d *dirRoot) mkdirAll(rel string, perm uint32) error {
	parts, err := splitRel(rel)
	if err != nil {
		return err
	}
	cur := d.fd
	owned := false
	defer func() {
		if owned {
			_ = unix.Close(cur)
		}
	}()
	for _, p := range parts {
		fd, err := unix.Openat(cur, p, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err != nil {
			if !errors.Is(err, unix.ENOENT) {
				// a link (ELOOP / ENOTDIR on macOS with O_NOFOLLOW) or a file where a folder belongs
				var st unix.Stat_t
				if serr := unix.Fstatat(cur, p, &st, unix.AT_SYMLINK_NOFOLLOW); serr != nil || isDir(st) {
					return &os.PathError{Op: "mkdir", Path: rel, Err: err}
				}
				if uerr := unix.Unlinkat(cur, p, 0); uerr != nil {
					return &os.PathError{Op: "mkdir", Path: rel, Err: uerr}
				}
			}
			if merr := unix.Mkdirat(cur, p, perm); merr != nil && !errors.Is(merr, unix.EEXIST) {
				return &os.PathError{Op: "mkdir", Path: rel, Err: merr}
			}
			if fd, err = unix.Openat(cur, p, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0); err != nil {
				return &os.PathError{Op: "mkdir", Path: rel, Err: err}
			}
		}
		if owned {
			_ = unix.Close(cur)
		}
		cur, owned = fd, true
	}
	return nil
}

// readFile returns rel's contents when it is a regular file (not a link, one link count, at most max bytes).
func (d *dirRoot) readFile(rel string, max int64) ([]byte, error) {
	fd, err := d.open(rel, unix.O_RDONLY|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), rel)
	defer f.Close()
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return nil, err
	}
	if !isReg(st) || st.Nlink != 1 || st.Size > max {
		return nil, fmt.Errorf("%s is not a plain file", rel)
	}
	return io.ReadAll(io.LimitReader(f, max+1))
}

// writeNew replaces rel with a new file holding data (parents are created; whatever was at rel — a file or a link —
// is unlinked first, never followed; the new file is created O_EXCL|O_NOFOLLOW).
func (d *dirRoot) writeNew(rel string, data []byte, perm uint32) error {
	if dir := filepath.Dir(filepath.Clean(rel)); dir != "." {
		if err := d.mkdirAll(dir, 0o700); err != nil {
			return err
		}
	}
	pfd, name, err := d.parent(rel)
	if err != nil {
		return err
	}
	defer unix.Close(pfd)
	if err := unix.Unlinkat(pfd, name, 0); err != nil && !errors.Is(err, unix.ENOENT) {
		return &os.PathError{Op: "remove", Path: rel, Err: err}
	}
	fd, err := unix.Openat(pfd, name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, perm)
	if err != nil {
		return &os.PathError{Op: "create", Path: rel, Err: err}
	}
	f := os.NewFile(uintptr(fd), rel)
	_, werr := f.Write(data)
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	return werr
}

// remove unlinks rel (a file or a link; not a folder). Missing is not an error.
func (d *dirRoot) remove(rel string) error {
	pfd, name, err := d.parent(rel)
	if err != nil {
		if errors.Is(err, unix.ENOENT) {
			return nil
		}
		return err
	}
	defer unix.Close(pfd)
	if err := unix.Unlinkat(pfd, name, 0); err != nil && !errors.Is(err, unix.ENOENT) {
		return &os.PathError{Op: "remove", Path: rel, Err: err}
	}
	return nil
}

// removeAll removes rel and everything below it without following links (a link is removed as a link). rel "" or "."
// empties the root itself and keeps it. Missing is not an error.
func (d *dirRoot) removeAll(rel string) error {
	parts, err := splitRel(rel)
	if err != nil {
		return err
	}
	if len(parts) == 0 {
		return clearDirFd(d.fd, 0)
	}
	pfd, name, err := d.parent(rel)
	if err != nil {
		if errors.Is(err, unix.ENOENT) || errors.Is(err, unix.ENOTDIR) || errors.Is(err, unix.ELOOP) {
			return nil // a parent is missing or is a link: nothing of ours below it
		}
		return err
	}
	defer unix.Close(pfd)
	return removeAt(pfd, name, 0)
}

const maxRemoveDepth = 256

// removeAt removes name in dirfd: files and links with unlinkat, folders emptied first (opened O_NOFOLLOW).
func removeAt(dirfd int, name string, depth int) error {
	err := unix.Unlinkat(dirfd, name, 0)
	if err == nil || errors.Is(err, unix.ENOENT) {
		return nil
	}
	// EISDIR (Linux) / EPERM (macOS) for a folder
	fd, oerr := unix.Openat(dirfd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if oerr != nil {
		if errors.Is(oerr, unix.ENOENT) {
			return nil
		}
		if uerr := unix.Unlinkat(dirfd, name, 0); uerr == nil || errors.Is(uerr, unix.ENOENT) {
			return nil // swapped for a link or file in between
		}
		return oerr
	}
	cerr := clearDirFd(fd, depth+1)
	_ = unix.Close(fd)
	if cerr != nil {
		return cerr
	}
	if err := unix.Unlinkat(dirfd, name, unix.AT_REMOVEDIR); err != nil && !errors.Is(err, unix.ENOENT) {
		return err
	}
	return nil
}

// clearDirFd removes every entry of the open folder fd.
func clearDirFd(fd int, depth int) error {
	if depth > maxRemoveDepth {
		return fmt.Errorf("folder tree too deep")
	}
	for round := 0; round < 4; round++ {
		names, err := dirNames(fd)
		if err != nil {
			return err
		}
		if len(names) == 0 {
			return nil
		}
		var first error
		for _, n := range names {
			if err := removeAt(fd, n, depth); err != nil && first == nil {
				first = err
			}
		}
		if first != nil {
			return first
		}
	}
	return nil
}

// dirNames lists an open folder (without "." and ".."), sorted. The fd is duplicated: the caller keeps its own.
func dirNames(fd int) ([]string, error) {
	dup, err := unix.Dup(fd)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(dup), "dir")
	defer f.Close()
	if _, err := unix.Seek(dup, 0, 0); err != nil {
		return nil, err
	}
	names, err := f.Readdirnames(-1)
	if err != nil {
		return nil, err
	}
	sort.Strings(names)
	return names, nil
}

// subdirs lists the real folders (not links) directly in rel.
func (d *dirRoot) subdirs(rel string) ([]string, error) {
	fd, err := d.open(rel, unix.O_RDONLY|unix.O_DIRECTORY, 0)
	if err != nil {
		return nil, err
	}
	defer unix.Close(fd)
	names, err := dirNames(fd)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, n := range names {
		var st unix.Stat_t
		if unix.Fstatat(fd, n, &st, unix.AT_SYMLINK_NOFOLLOW) == nil && isDir(st) {
			out = append(out, n)
		}
	}
	return out, nil
}

// rootFor finds the trusted root a launcher-side path belongs to: the chat folder or one of the --session-root
// folders. Returns the root path and the path relative to it.
func rootFor(chat, p string) (root, rel string, ok bool) {
	p = filepath.Clean(p)
	cands := append([]string{chat}, sessRoots...)
	for _, r := range cands {
		r = filepath.Clean(r)
		if p == r {
			return r, ".", true
		}
		if inside(r, p) {
			rel, err := filepath.Rel(r, p)
			if err == nil {
				return r, rel, true
			}
		}
	}
	return "", "", false
}

// maxSessionBytes caps a collected session transcript (the server's request reader takes 64 MiB lines).
const maxSessionBytes = 48 << 20

// restoreSession writes a session transcript before a turn (sessionRestore), only below the chat folder or a
// --session-root, never through a link.
func restoreSession(chat, dir, name string, data []byte) error {
	root, rel, ok := rootFor(chat, dir)
	if !ok || name == "" || strings.ContainsAny(name, "/\\") || name == "." || name == ".." {
		return fmt.Errorf("bad session restore path")
	}
	if root != filepath.Clean(chat) {
		if err := os.MkdirAll(root, 0o700); err != nil { // a --session-root (launcher configuration)
			return err
		}
	}
	d, err := openRoot(root)
	if err != nil {
		return err
	}
	defer d.close()
	if err := d.mkdirAll(rel, 0o700); err != nil {
		return err
	}
	return d.writeNew(filepath.Join(rel, name), data, 0o600)
}

// collectSession reads the session transcript after a turn: <dir>/<name>, else <dir>/<sub>/<name> for a real
// subfolder <sub>. The file is removed; with removeDir, dir is removed too. Links are never followed.
func collectSession(chat, dir, name string, removeDir bool) ([]byte, error) {
	root, rel, ok := rootFor(chat, dir)
	if !ok || name == "" || strings.ContainsAny(name, "/\\") || name == "." || name == ".." {
		return nil, fmt.Errorf("bad session collect path")
	}
	d, err := openRoot(root)
	if err != nil {
		if errors.Is(err, unix.ENOENT) {
			return nil, nil
		}
		return nil, err
	}
	defer d.close()
	var found string
	if st, err := d.lstat(filepath.Join(rel, name)); err == nil && isReg(st) {
		found = filepath.Join(rel, name)
	} else if subs, err := d.subdirs(rel); err == nil {
		for _, s := range subs {
			if st, err := d.lstat(filepath.Join(rel, s, name)); err == nil && isReg(st) {
				found = filepath.Join(rel, s, name)
				break
			}
		}
	}
	var out []byte
	var rerr error
	if found != "" {
		out, rerr = d.readFile(found, maxSessionBytes)
		_ = d.remove(found)
	}
	if removeDir && rel != "." {
		_ = d.removeAll(rel)
	}
	return out, rerr
}

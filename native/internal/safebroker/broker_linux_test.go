package safebroker

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"unsafe"
)

func TestResolveAndVersion(t *testing.T) {
	root := t.TempDir()
	os.Mkdir(filepath.Join(root, "d"), 0700)
	os.WriteFile(filepath.Join(root, "d", "a"), []byte("source"), 0600)
	fd, e := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY, 0)
	if e != nil {
		t.Fatal(e)
	}
	defer unix.Close(fd)
	var out bytes.Buffer
	if e = Snapshot(fd, "d/a", 1024, &out); e != nil {
		t.Fatal(e)
	}
	os.Symlink("a", filepath.Join(root, "d", "link"))
	for _, rel := range []string{"d/link", "../outside", "/etc/passwd", "d/../d/a"} {
		if Snapshot(fd, rel, 1024, &bytes.Buffer{}) == nil {
			t.Fatal("accepted", rel)
		}
	}
	os.Rename(filepath.Join(root, "d", "a"), filepath.Join(root, "d", "moved"))
	if Snapshot(fd, "d/a", 1024, &bytes.Buffer{}) == nil {
		t.Fatal("accepted moved source")
	}
	os.WriteFile(filepath.Join(root, "d", "a"), []byte("replacement"), 0600)
	var after bytes.Buffer
	if e = Snapshot(fd, "d/a", 1024, &after); e != nil {
		t.Fatal(e)
	}
	if bytes.Equal(out.Bytes(), after.Bytes()) {
		t.Fatal("lost version")
	}
}
func TestPublishNoReplace(t *testing.T) {
	root := t.TempDir()
	fd, e := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY, 0)
	if e != nil {
		t.Fatal(e)
	}
	defer unix.Close(fd)
	b := []byte("artifact")
	h := fmt.Sprintf("%x", sha256.Sum256(b))
	job := "00000000-0000-0000-0000-000000000001"
	os.WriteFile(filepath.Join(root, "occupied"), []byte("independent writer"), 0600)
	if Publish(fd, "occupied", job, h, bytes.NewReader(b)) != unix.EEXIST {
		t.Fatal("must refuse replacement")
	}
	got, _ := os.ReadFile(filepath.Join(root, "occupied"))
	if string(got) != "independent writer" {
		t.Fatal("writer lost")
	}
	if e = Publish(fd, "new", job, h, bytes.NewReader(b)); e != nil {
		t.Fatal(e)
	}
	s, _ := os.Stat(filepath.Join(root, "new"))
	if s.Mode().Perm() != 0400 {
		t.Fatal(s.Mode())
	}
	if e = Clean(fd, "new", job); e != nil {
		t.Fatal(e)
	}
	if e = Clean(fd, "new", job); e != nil {
		t.Fatal(e)
	}
}

// ENOSYS is injected only in this child test process. There must be no openat fallback.
func TestOpenat2Unavailable(t *testing.T) {
	if os.Getenv("SAFE_BROKER_TEST_NO_OPENAT2") == "1" {
		root, e := unix.Open(os.Getenv("SAFE_BROKER_TEST_ROOT"), unix.O_RDONLY|unix.O_DIRECTORY, 0)
		if e != nil {
			os.Exit(2)
		}
		runtime.LockOSThread()
		filter := []unix.SockFilter{
			{Code: unix.BPF_LD | unix.BPF_W | unix.BPF_ABS, K: 0},
			{Code: unix.BPF_JMP | unix.BPF_JEQ | unix.BPF_K, K: uint32(unix.SYS_OPENAT2), Jf: 1},
			{Code: unix.BPF_RET | unix.BPF_K, K: unix.SECCOMP_RET_ERRNO | uint32(unix.ENOSYS)},
			{Code: unix.BPF_RET | unix.BPF_K, K: unix.SECCOMP_RET_ALLOW},
		}
		prog := unix.SockFprog{Len: uint16(len(filter)), Filter: &filter[0]}
		if unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != nil {
			os.Exit(3)
		}
		if unix.Prctl(unix.PR_SET_SECCOMP, unix.SECCOMP_MODE_FILTER, uintptr(unsafe.Pointer(&prog)), 0, 0) != nil {
			os.Exit(4)
		}
		_, e = Open(root, "source", unix.O_RDONLY)
		if !errors.Is(e, unix.ENOSYS) {
			os.Exit(5)
		}
		os.Exit(0)
	}
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "source"), []byte("synthetic"), 0600)
	cmd := exec.Command(os.Args[0], "-test.run=^TestOpenat2Unavailable$")
	cmd.Env = append(os.Environ(), "SAFE_BROKER_TEST_NO_OPENAT2=1", "SAFE_BROKER_TEST_ROOT="+root)
	if out, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("%v: %s", e, out)
	}
}

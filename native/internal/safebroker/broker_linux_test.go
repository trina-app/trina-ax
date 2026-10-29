package safebroker

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
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

func TestPublishIndependentWriterRace(t *testing.T) {
	if dst := os.Getenv("SAFE_BROKER_WRITER"); dst != "" {
		f, e := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			os.Exit(2)
		}
		if _, e = f.WriteString("independent writer"); e != nil {
			os.Exit(3)
		}
		if f.Close() != nil {
			os.Exit(4)
		}
		os.Exit(0)
	}
	root := t.TempDir()
	fd, e := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY, 0)
	if e != nil {
		t.Fatal(e)
	}
	defer unix.Close(fd)
	job := "00000000-0000-0000-0000-000000000002"
	input, feed := io.Pipe()
	defer input.Close()
	defer feed.Close()
	content := []byte("artifact")
	done := make(chan error, 1)
	go func() { done <- Publish(fd, "race", job, fmt.Sprintf("%x", sha256.Sum256(content)), input) }()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, e = os.Stat(filepath.Join(root, ".mycel-tmp-safe-"+job)); e == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("spool not created")
		}
		time.Sleep(time.Millisecond)
	}
	// The native publisher has already resolved the parent and opened its spool.
	// A separate OS process now claims the destination before the atomic link.
	writer := exec.Command(os.Args[0], "-test.run=^TestPublishIndependentWriterRace$")
	writer.Env = append(os.Environ(), "SAFE_BROKER_WRITER="+filepath.Join(root, "race"))
	if out, e := writer.CombinedOutput(); e != nil {
		t.Fatalf("writer: %v %s", e, out)
	}
	if _, e = feed.Write(content); e != nil {
		t.Fatal(e)
	}
	feed.Close()
	if e = <-done; !errors.Is(e, unix.EEXIST) {
		t.Fatalf("expected EEXIST, got %v", e)
	}
	got, _ := os.ReadFile(filepath.Join(root, "race"))
	if string(got) != "independent writer" {
		t.Fatal("overwrote writer")
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 1 {
		t.Fatal("temporary file leaked")
	}
}

// Only this test's synthetic owner is killed. Its guarded child must not survive
// to finish the held operation after server death, even with inherited stdin.
func TestBrokerParentDeath(t *testing.T) {
	switch os.Getenv("SAFE_PARENT_TEST") {
	case "child":
		expected, _ := strconv.Atoi(os.Getenv("SAFE_PARENT_PID"))
		if ParentGuard(expected) != nil {
			os.Exit(91)
		}
		fmt.Println(os.Getpid())
		time.Sleep(30 * time.Second)
		os.Exit(92)
	case "owner":
		cmd := exec.Command(os.Args[0], "-test.run=^TestBrokerParentDeath$")
		cmd.Env = append(os.Environ(), "SAFE_PARENT_TEST=child", fmt.Sprintf("SAFE_PARENT_PID=%d", os.Getpid()))
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if cmd.Start() != nil {
			os.Exit(93)
		}
		time.Sleep(30 * time.Second)
		os.Exit(94)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestBrokerParentDeath$")
	cmd.Env = append(os.Environ(), "SAFE_PARENT_TEST=owner")
	out, e := cmd.StdoutPipe()
	if e != nil {
		t.Fatal(e)
	}
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	defer cmd.Process.Kill()
	line, e := bufio.NewReader(out).ReadString('\n')
	if e != nil {
		t.Fatal(e)
	}
	child, e := strconv.Atoi(strings.TrimSpace(line))
	if e != nil {
		t.Fatal(e)
	}
	defer unix.Kill(child, unix.SIGKILL)
	if e = cmd.Process.Kill(); e != nil {
		t.Fatal(e)
	}
	_ = cmd.Wait()
	for i := 0; i < 100; i++ {
		status, e := os.ReadFile(fmt.Sprintf("/proc/%d/status", child))
		if os.IsNotExist(e) || strings.Contains(string(status), "State:\tZ") {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("guarded broker helper survived parent death")
}

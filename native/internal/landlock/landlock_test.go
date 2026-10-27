//go:build linux

package landlock

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"

	"golang.org/x/sys/unix"
)

const childEnv = "MYCEL_LANDLOCK_TEST_CHILD"

func TestMain(m *testing.M) {
	switch os.Getenv(childEnv) {
	case "":
		os.Exit(m.Run())
	case "exit":
		os.Exit(0)
	default:
		child()
	}
}

func copyFile(t *testing.T, src, dst string) {
	t.Helper()
	in, err := os.Open(src)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o755)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(out, in); err != nil {
		t.Fatal(err)
	}
	out.Close()
}

func errName(err error) string {
	if err == nil {
		return "ok"
	}
	var e unix.Errno
	if errors.As(err, &e) {
		return unix.ErrnoName(e)
	}
	return err.Error()
}

// child: restrict execution to $ALLOW (with the mode in $MODE), then run $A/h and $B/h (copies of this binary) from
// the same locked thread and report how each exec went.
func child() {
	runtime.LockOSThread()
	m, _ := ParseMode(os.Getenv("MODE"))
	res, err := RestrictExec(m, filepath.SplitList(os.Getenv("ALLOW")))
	out := map[string]any{"abi": res.ABI, "applied": res.Applied, "scoped": res.Scoped, "skipped": res.Skipped, "err": errName(err)}
	for _, k := range []string{"A", "B"} {
		cmd := exec.Command(filepath.Join(os.Getenv(k), "h"))
		cmd.Env = append(os.Environ(), childEnv+"=exit")
		err := cmd.Run()
		var pe *os.PathError
		if errors.As(err, &pe) {
			err = pe.Err
		}
		out["exec"+k] = errName(err)
	}
	b, _ := json.Marshal(out)
	os.Stdout.Write(b)
	os.Exit(0)
}

func run(t *testing.T, mode string, allow ...string) map[string]any {
	t.Helper()
	w := t.TempDir()
	a, b := filepath.Join(w, "a"), filepath.Join(w, "b")
	os.Mkdir(a, 0o755)
	os.Mkdir(b, 0o755)
	copyFile(t, os.Args[0], filepath.Join(a, "h"))
	copyFile(t, os.Args[0], filepath.Join(b, "h"))
	for i, p := range allow {
		switch p {
		case "A":
			allow[i] = a
		case "A/h":
			allow[i] = filepath.Join(a, "h")
		}
	}
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), childEnv+"=1", "MODE="+mode, "ALLOW="+joinList(allow), "A="+a, "B="+b)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("child: %v %s", err, out)
	}
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	return m
}

func joinList(p []string) string {
	s := ""
	for i, x := range p {
		if i > 0 {
			s += string(filepath.ListSeparator)
		}
		s += x
	}
	return s
}

func TestABIAndModes(t *testing.T) {
	abi := ABI()
	t.Logf("Landlock ABI %d", abi)
	if _, err := ParseMode("bogus"); err == nil {
		t.Fatal("bad mode accepted")
	}
	off := run(t, "off", "A")
	if off["execA"] != "ok" || off["execB"] != "ok" || off["applied"] != false {
		t.Fatalf("off: %v", off)
	}
	if abi < 1 {
		if r := run(t, "required", "A"); r["err"] == "ok" {
			t.Fatalf("required without Landlock accepted: %v", r)
		}
		t.Skip("no Landlock in this kernel")
	}
	// a folder allows everything below it, nothing else runs
	r := run(t, "required", "A")
	if r["err"] != "ok" || r["applied"] != true || r["execA"] != "ok" || r["execB"] != "EACCES" {
		t.Fatalf("required: %v", r)
	}
	// a single file
	r = run(t, "required", "A/h")
	if r["execA"] != "ok" || r["execB"] != "EACCES" {
		t.Fatalf("file rule: %v", r)
	}
	// nothing allowed: nothing runs
	if r = run(t, "best-effort"); r["execA"] != "EACCES" {
		t.Fatalf("empty allow list: %v", r)
	}
	// a missing path: best-effort skips it, required refuses
	if r = run(t, "best-effort", "A", "/nonexistent/x"); r["err"] != "ok" || r["execA"] != "ok" || r["execB"] != "EACCES" {
		t.Fatalf("best-effort with a missing path: %v", r)
	}
	if r = run(t, "required", "A", "/nonexistent/x"); r["err"] == "ok" {
		t.Fatalf("required with a missing path accepted: %v", r)
	}
	r = run(t, "required-scoped", "A")
	if abi >= 6 {
		if r["err"] != "ok" || r["scoped"] != true || r["execB"] != "EACCES" {
			t.Fatalf("required-scoped: %v", r)
		}
	} else if r["err"] == "ok" {
		t.Fatalf("required-scoped accepted on ABI %d: %v", abi, r)
	}
}

func TestStructSizes(t *testing.T) {
	for abi, n := range map[int]int{1: 8, 3: 8, 4: 16, 5: 16, 6: 24, 8: 24} {
		if got := len(rulesetAttr(abi, true)); got != n {
			t.Errorf("ABI %d: %d bytes, want %d", abi, got, n)
		}
	}
	if b := rulesetAttr(6, true); b[16] != 3 {
		t.Errorf("scoped bits %v", b)
	}
	if b := rulesetAttr(4, true); b[0] != 1 || len(b) != 16 {
		t.Errorf("ABI 4 %v", b)
	}
	if len(pathBeneathAttr(1, 7)) != 12 {
		t.Error("path_beneath must be the packed 12 bytes")
	}
}

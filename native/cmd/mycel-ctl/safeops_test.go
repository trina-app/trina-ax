package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"mycel/native/internal/bundle"
)

// QA 2026-10-30 B1: the slice bounds 1A requires, computed from the machine (envelope.ts ENVELOPE_MAX).
func TestSliceLimits(t *testing.T) {
	for _, c := range []struct {
		mem, cpus           int
		max, high, cpusWant int
	}{{3862, 2, 3350, 2582, 2}, {16384, 8, 4096, 3328, 4}, {4096, 0, 3584, 2816, 1}, {2304, 1, 1792, 1024, 1}} {
		l, err := computeSliceLimits(c.mem, c.cpus)
		if err != nil || l.MemoryMaxMiB != c.max || l.MemoryHighMiB != c.high || l.CPUs != c.cpusWant || l.Tasks != 512 {
			t.Errorf("%d MiB %d CPUs: %+v %v", c.mem, c.cpus, l, err)
		}
		if l.MemoryMaxMiB > 4096 || l.MemoryMaxMiB-l.MemoryHighMiB < 640 {
			t.Errorf("%+v breaks the envelope", l)
		}
	}
	if _, err := computeSliceLimits(2048, 2); err == nil || !strings.Contains(err.Error(), "at least 2304 MiB") {
		t.Fatalf("2 GB machine: %v", err)
	}
}

func TestSafeOpsFlagKeepsOtherLines(t *testing.T) {
	rootUID = os.Getuid()
	t.Cleanup(func() { rootUID = 0 })
	defaultsDir = t.TempDir()
	t.Cleanup(func() { defaultsDir = "/etc/default" })
	if safeOpsFlag("mycel") {
		t.Fatal("no file is on")
	}
	must(t, os.WriteFile(filepath.Join(defaultsDir, "mycel"), []byte("# enroll\nMYCEL_BACKUP_WINDOW_START_MIN=130\nMYCEL_SAFE_OPS_1A=0\n"), 0o644))
	if safeOpsFlag("mycel") {
		t.Fatal("0 is off")
	}
	must(t, setSafeOpsFlag("mycel", true))
	b, _ := os.ReadFile(filepath.Join(defaultsDir, "mycel"))
	if string(b) != "# enroll\nMYCEL_BACKUP_WINDOW_START_MIN=130\nMYCEL_SAFE_OPS_1A=1\n" || !safeOpsFlag("mycel") {
		t.Fatalf("on: %q", b)
	}
	must(t, setSafeOpsFlag("mycel", false))
	b, _ = os.ReadFile(filepath.Join(defaultsDir, "mycel"))
	if string(b) != "# enroll\nMYCEL_BACKUP_WINDOW_START_MIN=130\n" || safeOpsFlag("mycel") {
		t.Fatalf("off: %q", b)
	}
	// a file with only our line goes away when 1A is turned off
	must(t, setSafeOpsFlag("other", true))
	must(t, setSafeOpsFlag("other", false))
	if _, err := os.Stat(filepath.Join(defaultsDir, "other")); err == nil {
		t.Fatal("empty defaults file left behind")
	}
	// a file the server account could have written is not trusted
	must(t, os.WriteFile(filepath.Join(defaultsDir, "w"), []byte("MYCEL_SAFE_OPS_1A=1\n"), 0o666))
	must(t, os.Chmod(filepath.Join(defaultsDir, "w"), 0o666))
	if safeOpsFlag("w") {
		t.Fatal("world-writable defaults file trusted")
	}
}

// the real templates: both units in <id>.slice, the slice bounded only while 1A is on
func TestSliceTemplate(t *testing.T) {
	rootUID = os.Getuid()
	t.Cleanup(func() { rootUID = 0 })
	defaultsDir = t.TempDir()
	t.Cleanup(func() { defaultsDir = "/etc/default"; sliceResources = defaultSliceResources })
	sliceResources = func(*Install) (int, int) { return 3862, 2 }
	in := testInstall(t, "/var/lib/mycel")
	tmpl := filepath.Join("..", "..", "..", "scripts", "linux", "systemd")
	render := func() map[string]string {
		vals, err := unitValues(in)
		must(t, err)
		out := map[string]string{}
		for _, n := range []string{"slice.in", "server.service.in", "launcher.service.in"} {
			b, err := os.ReadFile(filepath.Join(tmpl, n))
			must(t, err)
			text, err := renderTemplate(string(b), vals)
			must(t, err)
			out[n] = text
		}
		return out
	}
	u := render()
	if !strings.Contains(u["server.service.in"], "\nSlice=mycel.slice\n") || !strings.Contains(u["launcher.service.in"], "\nSlice=mycel.slice\n") {
		t.Fatal("units not in mycel.slice")
	}
	if !strings.Contains(u["server.service.in"], "MYCEL_SAFE_OPS_BIN=/var/lib/mycel/root/safe-ops") {
		t.Fatal("server unit does not name root's 1A programs")
	}
	if strings.Contains(u["slice.in"], "MemoryMax=") || !strings.Contains(u["slice.in"], "# no limits: safe operations 1A is off") {
		t.Fatalf("1A off: %s", u["slice.in"])
	}
	must(t, os.WriteFile(filepath.Join(defaultsDir, "mycel"), []byte("MYCEL_SAFE_OPS_1A=1\n"), 0o644))
	u = render()
	if !strings.Contains(u["slice.in"], "\n[Slice]\nMemoryMax=3350M\nMemoryHigh=2582M\nMemorySwapMax=0\nTasksMax=512\nCPUQuota=200%\n") {
		t.Fatalf("1A on: %s", u["slice.in"])
	}
	if n, ok := unitName("mycel", "slice.in"); !ok || n != "mycel.slice" {
		t.Fatalf("slice unit name %s", n)
	}
	// a second install (--id mycel-test) gets its own top-level slice: "mycel-test.slice" would sit inside mycel.slice
	rootUID = os.Getuid()
	tdir, out := t.TempDir(), t.TempDir()
	for _, n := range []string{"slice.in", "server.service.in", "launcher.service.in"} {
		b, err := os.ReadFile(filepath.Join(tmpl, n))
		must(t, err)
		must(t, os.WriteFile(filepath.Join(tdir, n), b, 0o644))
	}
	in.ID = "mycel-test"
	names, _, err := renderUnits(in, tdir, out)
	must(t, err)
	if strings.Join(names, " ") != "mycel-test-launcher.service mycel-test-server.service mycel_test.slice" {
		t.Fatalf("units %v", names)
	}
	for _, n := range []string{"mycel-test-launcher.service", "mycel-test-server.service"} {
		b, _ := os.ReadFile(filepath.Join(out, n))
		if !strings.Contains(string(b), "\nSlice=mycel_test.slice\n") || strings.Contains(string(b), "Slice=mycel-test.slice") {
			t.Fatalf("%s: %s", n, b)
		}
	}
}

var defaultSliceResources = sliceResources

// safeOpsBase: an installed signed version 0.1.0 whose manifest lists the 1A programs, units and templates.
func safeOpsBase(t *testing.T, allowUnsigned bool) (*testBase, string, ed25519.PrivateKey) {
	tb := newTestBase(t, "0.1.0")
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	k := base64.StdEncoding.EncodeToString(pub)
	old := safeOpsKeys
	safeOpsKeys = append(append([]string{}, old...), k)
	systemdRunDir = t.TempDir()
	defaultsDir, cgroupRoot, systemdUnitDir = t.TempDir(), t.TempDir(), t.TempDir()
	sliceResources = func(*Install) (int, int) { return 4096, 2 }
	safeOpsLiveTurns = func(*env, *Install) (int, error) { return 0, nil }
	t.Cleanup(func() {
		safeOpsKeys = old
		systemdRunDir, defaultsDir, cgroupRoot, systemdUnitDir = "/run/systemd/system", "/etc/default", "/sys/fs/cgroup", "/etc/systemd/system"
		sliceResources = defaultSliceResources
	})
	v := filepath.Join(tb.base, "app", "versions", "0.1.0")
	for p, c := range map[string]string{"native/mycel-safeops": "safeops 0.1.0", "bin/pandoc": "pandoc 3.9"} {
		must(t, os.MkdirAll(filepath.Dir(filepath.Join(v, p)), 0o755))
		must(t, os.WriteFile(filepath.Join(v, p), []byte(c), 0o755))
	}
	if allowUnsigned {
		must(t, bundle.WriteManifest(v, "0.1.0", nil))
		b, _ := os.ReadFile(filepath.Join(tb.base, "root/install.json"))
		must(t, os.WriteFile(filepath.Join(tb.base, "root/install.json"), []byte(strings.Replace(string(b), `"allowUnsigned":false`, `"allowUnsigned":true`, 1)), 0o644))
	} else {
		must(t, bundle.WriteManifest(v, "0.1.0", priv))
	}
	must(t, os.MkdirAll(filepath.Join(tb.base, "root/systemd"), 0o755))
	for _, n := range []string{"slice.in", "server.service.in", "launcher.service.in"} {
		b, err := os.ReadFile(filepath.Join("..", "..", "..", "scripts", "linux", "systemd", n))
		must(t, err)
		must(t, os.WriteFile(filepath.Join(tb.base, "root/systemd", n), b, 0o644))
	}
	return tb, k, priv
}

func TestSafeOpsOnOff(t *testing.T) {
	tb, _, _ := safeOpsBase(t, false)
	must(t, os.WriteFile(filepath.Join(defaultsDir, "mycel"), []byte("MYCEL_BACKUP_WINDOW_START_MIN=130\n"), 0o644))
	code, out, errs := tb.ctl("", "safe-ops", "on", "--json")
	if code != 0 {
		t.Fatalf("on: %d %s %s", code, out, errs)
	}
	for _, n := range []string{"mycel-safeops", "pandoc"} {
		st, err := os.Stat(filepath.Join(tb.base, "root/safe-ops", n))
		if err != nil || st.Mode().Perm() != 0o755 {
			t.Fatalf("root copy %s: %v", n, err)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(tb.base, "root/safe-ops/pandoc")); string(b) != "pandoc 3.9" {
		t.Fatalf("pandoc copy %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(defaultsDir, "mycel")); string(b) != "MYCEL_BACKUP_WINDOW_START_MIN=130\nMYCEL_SAFE_OPS_1A=1\n" {
		t.Fatalf("defaults %q", b)
	}
	slice, _ := os.ReadFile(filepath.Join(systemdUnitDir, "mycel.slice"))
	if !strings.Contains(string(slice), "MemoryMax=3584M\nMemoryHigh=2816M\nMemorySwapMax=0\nTasksMax=512\nCPUQuota=200%") {
		t.Fatalf("slice %s", slice)
	}
	calls, _ := os.ReadFile(tb.sysCalls)
	if string(calls) != "daemon-reload\nstop mycel-server.service mycel-launcher.service\nstop mycel.slice\nstart mycel-launcher.service mycel-server.service\n" {
		t.Fatalf("systemctl calls\n%s", calls)
	}
	var s SafeOpsStatus
	must(t, json.Unmarshal([]byte(out), &s))
	// the fake cgroup tree has no slice: on, but not ready, and it says why
	if !s.On || s.Ready || !strings.Contains(strings.Join(s.Problems, ";"), "mycel.slice has no memory, task and CPU limits") {
		t.Fatalf("status %+v", s)
	}
	// the running slice as systemd makes it: ready
	sl := filepath.Join(cgroupRoot, "mycel.slice")
	for _, d := range []string{"mycel-server.service", "mycel-launcher.service"} {
		must(t, os.MkdirAll(filepath.Join(sl, d), 0o755))
	}
	for f, v := range map[string]string{"memory.max": "3758096384", "memory.high": "2952790016", "memory.swap.max": "0", "memory.current": "900000000", "pids.max": "512", "cpu.max": "200000 100000"} {
		must(t, os.WriteFile(filepath.Join(sl, f), []byte(v+"\n"), 0o644))
	}
	code, out, _ = tb.ctl("", "safe-ops", "status", "--json")
	must(t, json.Unmarshal([]byte(out), &s))
	if code != 0 || !s.Ready {
		t.Fatalf("status %d %s", code, out)
	}
	// off: flag and limits gone, other lines stay, restarted in a fresh slice
	os.Remove(tb.sysCalls)
	code, out, errs = tb.ctl("", "safe-ops", "off")
	if code != 0 || !strings.Contains(out, "chats that ran a 1A job stay") {
		t.Fatalf("off: %d %s %s", code, out, errs)
	}
	if b, _ := os.ReadFile(filepath.Join(defaultsDir, "mycel")); string(b) != "MYCEL_BACKUP_WINDOW_START_MIN=130\n" {
		t.Fatalf("defaults after off %q", b)
	}
	if slice, _ := os.ReadFile(filepath.Join(systemdUnitDir, "mycel.slice")); strings.Contains(string(slice), "MemoryMax") {
		t.Fatalf("slice after off %s", slice)
	}
	if calls, _ := os.ReadFile(tb.sysCalls); !strings.Contains(string(calls), "stop mycel.slice\n") {
		t.Fatalf("off calls %s", calls)
	}
}

func TestSafeOpsCopiesRefused(t *testing.T) {
	// a version folder changed by the server account: its bytes no longer match the signed manifest
	tb, _, _ := safeOpsBase(t, false)
	must(t, os.WriteFile(filepath.Join(tb.base, "app/versions/0.1.0/bin/pandoc"), []byte("pandoc 6.6"), 0o755))
	code, _, errs := tb.ctl("", "safe-ops", "on")
	if code != 1 || !strings.Contains(errs, "changed while it was copied") {
		t.Fatalf("tampered copy: %d %s", code, errs)
	}
	// a longer file (a sparse terabyte, say) is cut at the listed size, never copied whole as root
	must(t, os.WriteFile(filepath.Join(tb.base, "app/versions/0.1.0/bin/pandoc"), []byte("pandoc 3.9"+strings.Repeat("x", 1<<20)), 0o755))
	code, _, errs = tb.ctl("", "safe-ops", "on")
	if code != 1 || !strings.Contains(errs, "is not the size its release lists") {
		t.Fatalf("oversized copy: %d %s", code, errs)
	}
	if ents, _ := os.ReadDir(filepath.Join(tb.base, "root/safe-ops")); len(ents) > 1 {
		t.Fatalf("temp files left in root/safe-ops: %v", ents)
	}
	if _, err := os.Stat(filepath.Join(tb.base, "root/safe-ops/pandoc")); err == nil {
		t.Fatal("tampered pandoc installed")
	}
	if safeOpsFlag("mycel") {
		t.Fatal("flag set although the programs are not ready")
	}
	// an unsigned (development) install cannot prove the installed copy: the installer with a kit must do it
	tb2, _, _ := safeOpsBase(t, true)
	code, _, errs = tb2.ctl("", "safe-ops", "on")
	if code != 1 || !strings.Contains(errs, "install-linux.sh update --from <kit>") {
		t.Fatalf("unsigned: %d %s", code, errs)
	}
	// too little memory: refused before anything changes
	tb3, _, _ := safeOpsBase(t, false)
	sliceResources = func(*Install) (int, int) { return 2048, 2 }
	if code, _, errs := tb3.ctl("", "safe-ops", "on"); code != 1 || !strings.Contains(errs, "at least 2304 MiB") {
		t.Fatalf("small machine: %d %s", code, errs)
	}
	// no systemd: 1A needs the slice
	systemdRunDir = filepath.Join(t.TempDir(), "none")
	sliceResources = func(*Install) (int, int) { return 4096, 2 }
	if code, _, errs := tb3.ctl("", "safe-ops", "on"); code != 1 || !strings.Contains(errs, "need the systemd install") {
		t.Fatalf("no systemd: %d %s", code, errs)
	}
}

// `mycel-ctl update` installs root's copies of the 1A programs from the verified bundle, like the root files
func TestUpdateInstallsSafeOpsCopies(t *testing.T) {
	tb := newTestBase(t, "0.1.0")
	systemdRunDir = filepath.Join(t.TempDir(), "none")
	t.Cleanup(func() { systemdRunDir = "/run/systemd/system" })
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	k := base64.StdEncoding.EncodeToString(pub)
	dir := signedBundle(t, "0.2.0", nil, "new launcher")
	for p, c := range map[string]string{"native/mycel-safeops": "safeops 0.2.0", "bin/pandoc": "pandoc 0.2.0"} {
		must(t, os.MkdirAll(filepath.Dir(filepath.Join(dir, p)), 0o755))
		must(t, os.WriteFile(filepath.Join(dir, p), []byte(c), 0o755))
	}
	must(t, bundle.WriteManifest(dir, "0.2.0", priv))
	arch := filepath.Join(t.TempDir(), "0.2.0-linux-arm64.tar.zst")
	mkArchive(t, dir, arch, nil)
	updateHooks(t, tb, func(v string) {
		os.Remove(filepath.Join(tb.base, "app/current"))
		os.Symlink("versions/"+v, filepath.Join(tb.base, "app/current"))
		tb.health.Store(v)
	})
	code, out, errs := tb.ctl("", "update", "--bundle", arch, "--pubkey", k, "--json")
	if code != 0 {
		t.Fatalf("%d %s %s", code, out, errs)
	}
	for n, want := range map[string]string{"mycel-safeops": "safeops 0.2.0", "pandoc": "pandoc 0.2.0"} {
		b, err := os.ReadFile(filepath.Join(tb.base, "root/safe-ops", n))
		st, _ := os.Stat(filepath.Join(tb.base, "root/safe-ops", n))
		if err != nil || string(b) != want || st.Mode().Perm() != 0o755 {
			t.Fatalf("root/safe-ops/%s: %q %v", n, b, err)
		}
	}
}

// an administrator's umask 077 under sudo: root/safe-ops and the copies stay usable by the server account (755), and a
// copy the server account could not run is a problem, not "ok"
func TestSafeOpsCopiesUnderStrictUmask(t *testing.T) {
	tb, _, _ := safeOpsBase(t, false)
	old := syscall.Umask(0o077)
	t.Cleanup(func() { syscall.Umask(old) })
	if code, out, errs := tb.ctl("", "safe-ops", "on"); code != 0 {
		t.Fatalf("on: %d %s %s", code, out, errs)
	}
	for _, p := range []string{"root/safe-ops", "root/safe-ops/mycel-safeops", "root/safe-ops/pandoc"} {
		if st, err := os.Stat(filepath.Join(tb.base, p)); err != nil || st.Mode().Perm() != 0o755 {
			t.Fatalf("%s: %v %v", p, st.Mode(), err)
		}
	}
	in, err := loadInstall(tb.env())
	must(t, err)
	must(t, os.Chmod(filepath.Join(tb.base, "root/safe-ops/pandoc"), 0o700))
	if s := safeOpsStatus(tb.env(), in); !strings.Contains(strings.Join(s.Problems, ";"), "pandoc must be a root-owned executable (755)") {
		t.Fatalf("0700 copy: %+v", s.Problems)
	}
	must(t, os.Chmod(filepath.Join(tb.base, "root/safe-ops/pandoc"), 0o755))
	must(t, os.Chmod(filepath.Join(tb.base, "root/safe-ops"), 0o700))
	if s := safeOpsStatus(tb.env(), in); !strings.Contains(strings.Join(s.Problems, ";"), "readable and searchable by the server account") {
		t.Fatalf("0700 folder: %+v", s.Problems)
	}
	// the next `on` (or `mycel-ctl update`) repairs the folder's mode
	if code, out, errs := tb.ctl("", "safe-ops", "on"); code != 0 {
		t.Fatalf("on again: %d %s %s", code, out, errs)
	}
	if st, _ := os.Stat(filepath.Join(tb.base, "root/safe-ops")); st.Mode().Perm() != 0o755 {
		t.Fatalf("folder mode %v", st.Mode())
	}
}

// an install id that is one of systemd's own slices (system, user, machine, capsule) never gets a slice unit, a Slice=
// line or a `systemctl stop` of that slice: stopping system.slice would stop every service of the machine
func TestSystemSliceIDs(t *testing.T) {
	for _, id := range []string{"system", "user", "machine", "capsule"} {
		if _, ok := unitName(id, "slice.in"); ok {
			t.Fatalf("%s: slice unit rendered", id)
		}
	}
	if !ownSlice("mycel") || !ownSlice("system-test") {
		t.Fatal("ordinary ids have their own slice")
	}
	rootUID = os.Getuid()
	t.Cleanup(func() { rootUID = 0 })
	in := testInstall(t, "/var/lib/system")
	in.ID = "system"
	tmpl := filepath.Join("..", "..", "..", "scripts", "linux", "systemd")
	tdir, out := t.TempDir(), t.TempDir()
	for _, n := range []string{"slice.in", "server.service.in", "launcher.service.in"} {
		b, err := os.ReadFile(filepath.Join(tmpl, n))
		must(t, err)
		must(t, os.WriteFile(filepath.Join(tdir, n), b, 0o644))
	}
	names, _, err := renderUnits(in, tdir, out)
	must(t, err)
	if strings.Join(names, " ") != "system-launcher.service system-server.service" {
		t.Fatalf("units %v", names)
	}
	for _, n := range names {
		if b, _ := os.ReadFile(filepath.Join(out, n)); strings.Contains(string(b), "\nSlice=") {
			t.Fatalf("%s names a slice:\n%s", n, b)
		}
	}
	tb, _, _ := safeOpsBase(t, false)
	e := tb.env()
	inst, err := loadInstall(e)
	must(t, err)
	inst.ID = "system"
	must(t, restartInSlice(e, inst))
	if calls, _ := os.ReadFile(tb.sysCalls); strings.Contains(string(calls), ".slice") {
		t.Fatalf("systemctl calls %s", calls)
	}
}

// env: an environment on this test base with the fakes (for calling the helpers directly)
func (tb *testBase) env() *env {
	e := newEnv()
	e.base, e.nft, e.systemctl = tb.base, filepath.Join(tb.fakeBin, "nft"), filepath.Join(tb.fakeBin, "systemctl")
	e.stdout, e.stderr = io.Discard, io.Discard
	return e
}

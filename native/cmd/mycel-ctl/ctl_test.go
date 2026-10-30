package main

import (
	"archive/tar"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"mycel/native/internal/bundle"
	"mycel/native/internal/fwstatus"
)

// testBase builds <tmp>/base with root/, run/, app/versions/<from>, config/server.json, install.json and
// firewall.conf.json, all owned by the test's uid (which plays root: rootUID).
type testBase struct {
	t        *testing.T
	base     string
	port     int
	health   atomic.Value // version /api/health reports
	fakeBin  string
	sysCalls string
}

func newTestBase(t *testing.T, from string) *testBase {
	t.Helper()
	rootUID = os.Getuid()
	t.Cleanup(func() { rootUID = 0 })
	w, _ := filepath.EvalSymlinks(t.TempDir())
	tb := &testBase{t: t, base: filepath.Join(w, "base"), fakeBin: filepath.Join(w, "bin"), sysCalls: filepath.Join(w, "systemctl.calls")}
	for _, d := range []string{"root", "run", "app/versions/" + from + "/bin", "config", "data", "run-launcher"} {
		must(t, os.MkdirAll(filepath.Join(tb.base, d), 0o755))
	}
	must(t, os.WriteFile(filepath.Join(tb.base, "app/versions", from, "bin/bun"), []byte("old bun"), 0o755))
	must(t, os.Symlink("versions/"+from, filepath.Join(tb.base, "app/current")))
	must(t, os.WriteFile(filepath.Join(tb.base, "root/mycel-launcher"), []byte("old launcher"), 0o755))
	must(t, os.WriteFile(filepath.Join(tb.base, "root/VERSION"), []byte(from+"\n"), 0o644))
	// health endpoint
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	must(t, err)
	tb.port = ln.Addr().(*net.TCPAddr).Port
	tb.health.Store(from)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"ok":true,"version":%q}`, tb.health.Load().(string))
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	me, _ := user.Current()
	in := map[string]any{"format": 1, "id": "mycel", "base": tb.base, "serverUser": me.Username, "agentUser": "nobody", "port": tb.port, "proxyPort": 47821,
		"tlsPort": 0, "hosted": false, "autoUpdate": true, "allowUnsigned": false, "engines": []string{"claude"}, "version": from, "systemd": true}
	b, _ := json.Marshal(in)
	must(t, os.WriteFile(filepath.Join(tb.base, "root/install.json"), b, 0o644))
	must(t, os.WriteFile(filepath.Join(tb.base, "root/firewall.conf.json"),
		[]byte(`{"format":1,"id":"mycel","engineUid":990,"serverUid":989,"proxyPort":47821,"serverPort":47820,"deployment":"hosted","serverAllowPrivate":[]}`), 0o644))
	must(t, os.WriteFile(filepath.Join(tb.base, "config/server.json"), []byte(`{"update":{"channel":"stable","feedUrl":null}}`), 0o644))
	// fakes: nft (apply ok, list = the captured table), systemctl (records its arguments)
	must(t, os.MkdirAll(tb.fakeBin, 0o755))
	fixture, _ := filepath.Abs("testdata/nft-list-hosted.json")
	must(t, os.WriteFile(filepath.Join(tb.fakeBin, "nft"), []byte("#!/bin/sh\nif [ \"$1\" = -j ]; then cat '"+fixture+"'; exit 0; fi\nif [ \"$1\" = -f ]; then cat >/dev/null; [ -f '"+tb.fakeBin+"/nft-fail' ] && { echo 'Error: syntax'; exit 1; }; exit 0; fi\nexit 0\n"), 0o755))
	must(t, os.WriteFile(filepath.Join(tb.fakeBin, "systemctl"), []byte("#!/bin/sh\necho \"$*\" >> '"+tb.sysCalls+"'\n"), 0o755))
	return tb
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// ctl runs a subcommand with the fakes; returns exit code and stdout.
func (tb *testBase) ctl(stdin string, args ...string) (int, string, string) {
	e := newEnv()
	var out, errb bytes.Buffer
	e.stdout, e.stderr, e.stdin = &out, &errb, strings.NewReader(stdin)
	e.nft, e.systemctl = filepath.Join(tb.fakeBin, "nft"), filepath.Join(tb.fakeBin, "systemctl")
	full := append([]string{args[0], "--base", tb.base, "--nft", e.nft, "--systemctl", e.systemctl}, args[1:]...)
	if args[0] == "firewall" || args[0] == "safe-ops" {
		full = append([]string{args[0], args[1], "--base", tb.base, "--nft", e.nft, "--systemctl", e.systemctl}, args[2:]...)
	}
	cmd, rest := full[0], full[1:]
	var code int
	var err error
	switch cmd {
	case "firewall":
		code, err = cmdFirewall(e, rest)
	case "apply-plan":
		code, err = cmdApplyPlan(e, rest)
	case "update":
		code, err = cmdUpdate(e, rest)
	case "status":
		code, err = cmdStatus(e, rest)
	case "safe-ops":
		code, err = cmdSafeOps(e, rest)
	}
	if err != nil {
		fmt.Fprintln(&errb, err)
	}
	return code, out.String(), errb.String()
}

func TestFirewallApplyWritesStatus(t *testing.T) {
	tb := newTestBase(t, "0.1.0")
	code, out, errs := tb.ctl("", "firewall", "apply")
	if code != 0 {
		t.Fatalf("apply: %d %s %s", code, out, errs)
	}
	st, err := fwstatus.Read(filepath.Join(tb.base, "run/firewall.json"), os.Getuid())
	must(t, err)
	if err := st.Check(time.Now(), 990, 47821); err != nil || st.Rules != 10 || st.NftVersion != "1.1.3" || len(st.Sha256) != 64 {
		t.Fatalf("status %+v %v", st, err)
	}
	// nft refuses the rules: loaded false, exit 1, the launcher would refuse turns
	must(t, os.WriteFile(filepath.Join(tb.fakeBin, "nft-fail"), nil, 0o644))
	if code, _, _ := tb.ctl("", "firewall", "apply"); code != 1 {
		t.Fatalf("failed apply exit %d", code)
	}
	st, _ = fwstatus.Read(filepath.Join(tb.base, "run/firewall.json"), os.Getuid())
	if st.Loaded || st.Error == nil || !strings.Contains(*st.Error, "syntax") {
		t.Fatalf("%+v", st)
	}
	// a base folder others can write is refused before anything runs
	must(t, os.Chmod(filepath.Join(tb.base, "run"), 0o777))
	if code, _, errs := tb.ctl("", "firewall", "apply"); code != 1 || !strings.Contains(errs, "not writable") {
		t.Fatalf("writable run/: %d %s", code, errs)
	}
}

func TestApplyPlan(t *testing.T) {
	tb := newTestBase(t, "0.1.0")
	systemdRunDir = t.TempDir()
	t.Cleanup(func() { systemdRunDir = "/run/systemd/system" })
	plan := `{"format":1,"plan":"team","maxConcurrency":3,"memoryMiB":4096,"cpuCores":2,"diskGiB":50,"reserveMiB":768,"turnMemoryMaxMiB":null,"turnPidsMax":256,"turnDiskMaxMiB":1024,"readMaxMiB":128,"convMemoryMaxMiB":null,"localBackupRetentionDays":3,"updatedAt":"2026-10-22T00:00:00Z"}`
	code, out, errs := tb.ctl(plan, "apply-plan", "--json") // ax-hostd's tenant command passes --json
	if code != 0 {
		t.Fatalf("%d %s %s", code, out, errs)
	}
	calls, _ := os.ReadFile(tb.sysCalls)
	// the units' limits, then SIGHUP to the server unit's main process (the bootstrap passes it on): plan.json now
	want := "set-property mycel-launcher.service MemoryMax=3328M TasksMax=1088\nset-property mycel-server.service MemoryMax=1792M MemoryHigh=1536M\nkill --kill-whom=main --signal=SIGHUP mycel-server.service\n"
	if string(calls) != want {
		t.Fatalf("systemctl calls\n%s\nwant\n%s", calls, want)
	}
	b, _ := os.ReadFile(filepath.Join(tb.base, "root/plan.json"))
	if string(b) != plan {
		t.Fatal("plan.json not written as given")
	}
	if code, _, _ := tb.ctl(`{"format":1,"plan":"x","maxConcurrency":99,"memoryMiB":4096,"cpuCores":2,"diskGiB":50}`, "apply-plan"); code != 1 {
		t.Fatal("invalid plan accepted")
	}
	// no systemd: written, units skipped
	systemdRunDir = filepath.Join(t.TempDir(), "none")
	os.Remove(tb.sysCalls)
	if code, out, _ := tb.ctl(plan, "apply-plan"); code != 0 || !strings.Contains(out, "skipped") {
		t.Fatalf("%d %s", code, out)
	}
	if _, err := os.Stat(tb.sysCalls); err == nil {
		t.Fatal("systemctl called without systemd")
	}
}

// mkArchive makes <v>-linux-<arch>.tar.zst of a bundle folder (as scripts/build-bundle.ts packBundle does).
func mkArchive(t *testing.T, dir, out string, extra func(tw *tar.Writer)) {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	must(t, filepath.Walk(dir, func(p string, fi os.FileInfo, err error) error {
		rel, _ := filepath.Rel(dir, p)
		if rel == "." {
			return nil
		}
		h, _ := tar.FileInfoHeader(fi, "")
		h.Name = filepath.ToSlash(rel)
		if fi.IsDir() {
			h.Name += "/"
		}
		must(t, tw.WriteHeader(h))
		if fi.Mode().IsRegular() {
			b, _ := os.ReadFile(p)
			tw.Write(b)
		}
		return nil
	}))
	if extra != nil {
		extra(tw)
	}
	tw.Close()
	zb, err := zstdBin()
	if err != nil {
		t.Skip("no zstd")
	}
	cmd := exec.Command(zb, "-q", "-o", out)
	cmd.Stdin = &buf
	if o, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("zstd: %v %s", err, o)
	}
}

func signedBundle(t *testing.T, v string, priv ed25519.PrivateKey, launcher string) string {
	dir := filepath.Join(t.TempDir(), v)
	for p, c := range map[string]string{"bin/bun": "bun " + v, "server/src/main.js": "main", "root/mycel-launcher": launcher, "root/mycel-ctl": "ctl"} {
		must(t, os.MkdirAll(filepath.Dir(filepath.Join(dir, p)), 0o755))
		mode := os.FileMode(0o644)
		if strings.HasPrefix(p, "bin/") || strings.HasPrefix(p, "root/") {
			mode = 0o755
		}
		must(t, os.WriteFile(filepath.Join(dir, p), []byte(c), mode))
	}
	must(t, bundle.WriteManifest(dir, v, priv))
	return dir
}

func TestVerifyBundleArchive(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	k := base64.StdEncoding.EncodeToString(pub)
	dir := signedBundle(t, "0.2.0", priv, "new")
	arch := filepath.Join(t.TempDir(), "0.2.0-linux-arm64.tar.zst")
	mkArchive(t, dir, arch, nil)
	if r := verifyPath(arch, bundle.Options{Keys: []string{k}}); !r.OK || r.Version != "0.2.0" || !r.Signed {
		t.Fatalf("%+v", r)
	}
	if r := verifyPath(dir, bundle.Options{Keys: append([]string{}, bundle.ReleaseKeys...)}); r.OK || !strings.Contains(r.Error, "unknown key") {
		t.Fatalf("test key accepted by the release keys: %+v", r)
	}
	// a link member in the archive is refused at extraction
	bad := filepath.Join(t.TempDir(), "bad.tar.zst")
	mkArchive(t, dir, bad, func(tw *tar.Writer) {
		tw.WriteHeader(&tar.Header{Name: "evil", Typeflag: tar.TypeSymlink, Linkname: "/etc"})
	})
	if r := verifyPath(bad, bundle.Options{Keys: []string{k}}); r.OK || !strings.Contains(r.Error, "not a file or folder") {
		t.Fatalf("%+v", r)
	}
	bad2 := filepath.Join(t.TempDir(), "bad2.tar.zst")
	mkArchive(t, dir, bad2, func(tw *tar.Writer) {
		tw.WriteHeader(&tar.Header{Name: "../escape", Typeflag: tar.TypeReg, Size: 1, Mode: 0o644})
		tw.Write([]byte("x"))
	})
	if r := verifyPath(bad2, bundle.Options{Keys: []string{k}}); r.OK || !strings.Contains(r.Error, "unsafe name") {
		t.Fatalf("%+v", r)
	}
	// unsigned: refused unless --allow-unsigned
	ud := signedBundle(t, "0.2.1", nil, "new")
	if r := verifyPath(ud, bundle.Options{Keys: []string{k}}); r.OK {
		t.Fatal("unsigned accepted")
	}
	if r := verifyPath(ud, bundle.Options{Keys: []string{k}, AllowUnsigned: true}); !r.OK || r.Signed {
		t.Fatalf("%+v", r)
	}
}

func updateHooks(t *testing.T, tb *testBase, onSwitch func(v string)) {
	updateTestHook = func(u *updater) {
		u.liveTurns = func() (int, error) { return 0, nil }
		u.runAsSrv = func(args []string, _ []string) (string, error) {
			if args[0] != "switch" {
				return "", fmt.Errorf("unexpected %v", args)
			}
			onSwitch(args[1])
			return "", nil
		}
		u.restartSrv = func() error { return nil }
		u.healthTimeout = 3 * time.Second
	}
	t.Cleanup(func() { updateTestHook = nil })
}

func TestUpdateFromBundle(t *testing.T) {
	tb := newTestBase(t, "0.1.0")
	systemdRunDir = filepath.Join(t.TempDir(), "none")
	t.Cleanup(func() { systemdRunDir = "/run/systemd/system" })
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	k := base64.StdEncoding.EncodeToString(pub)
	arch := filepath.Join(t.TempDir(), "0.2.0-linux-arm64.tar.zst")
	mkArchive(t, signedBundle(t, "0.2.0", priv, "new launcher"), arch, nil)
	var switched string
	updateHooks(t, tb, func(v string) {
		switched = v
		os.Remove(filepath.Join(tb.base, "app/current"))
		os.Symlink("versions/"+v, filepath.Join(tb.base, "app/current"))
		tb.health.Store(v)
	})
	code, out, errs := tb.ctl("", "update", "--bundle", arch, "--pubkey", k, "--json")
	if code != 0 {
		t.Fatalf("%d %s %s", code, out, errs)
	}
	var r UpdateResult
	must(t, json.Unmarshal([]byte(out), &r))
	if r.Result != "ok" || r.From != "0.1.0" || r.To != "0.2.0" || !r.RootUpdated || !r.AppUpdated || switched != "0.2.0" {
		t.Fatalf("%+v", r)
	}
	if b, _ := os.ReadFile(filepath.Join(tb.base, "root/mycel-launcher")); string(b) != "new launcher" {
		t.Fatal("root file not replaced")
	}
	if b, _ := os.ReadFile(filepath.Join(tb.base, "root/VERSION")); string(b) != "0.2.0\n" {
		t.Fatal("root/VERSION")
	}
	if _, err := bundle.VerifyDir(filepath.Join(tb.base, "app/versions/0.2.0"), "0.2.0", bundle.Options{Keys: []string{k}}); err != nil {
		t.Fatalf("installed version folder: %v", err)
	}
	if _, err := os.Stat(filepath.Join(tb.base, "run/firewall.json")); err != nil {
		t.Fatal("firewall not re-applied after the root update")
	}
	// the same bundle again: nothing to do
	code, out, _ = tb.ctl("", "update", "--bundle", arch, "--pubkey", k, "--json")
	must(t, json.Unmarshal([]byte(out), &r))
	if code != 0 || r.RootUpdated || r.AppUpdated {
		t.Fatalf("second run %d %+v", code, r)
	}
}

func TestUpdateRefusals(t *testing.T) {
	tb := newTestBase(t, "0.1.0")
	systemdRunDir = filepath.Join(t.TempDir(), "none")
	t.Cleanup(func() { systemdRunDir = "/run/systemd/system" })
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	k := base64.StdEncoding.EncodeToString(pub)
	updateHooks(t, tb, func(v string) {
		// the bootstrap rolls back: state.json records it, health keeps answering the old version
		st := `{"format":1,"current":"0.1.0","previous":null,"pending":null,"pendingSince":null,"attempts":0,"history":[{"at":"x","from":"` + v + `","to":"0.1.0","result":"rolled_back","detail":"exited 3 times before it was healthy"}]}`
		os.WriteFile(filepath.Join(tb.base, "app/state.json"), []byte(st), 0o644)
	})
	// unsigned bundle on a signed install: verify_failed (20), nothing changed
	unsigned := filepath.Join(t.TempDir(), "u.tar.zst")
	mkArchive(t, signedBundle(t, "0.2.0", nil, "evil launcher"), unsigned, nil)
	code, out, _ := tb.ctl("", "update", "--bundle", unsigned, "--pubkey", k, "--json")
	var r UpdateResult
	json.Unmarshal([]byte(out), &r)
	if code != 20 || r.Result != "verify_failed" {
		t.Fatalf("unsigned: %d %+v", code, r)
	}
	if b, _ := os.ReadFile(filepath.Join(tb.base, "root/mycel-launcher")); string(b) != "old launcher" {
		t.Fatal("root file replaced by an unverified bundle")
	}
	// a roll-back by the bootstrap: rolled_back (10)
	good := filepath.Join(t.TempDir(), "g.tar.zst")
	mkArchive(t, signedBundle(t, "0.2.0", priv, "old launcher"), good, nil)
	code, out, _ = tb.ctl("", "update", "--bundle", good, "--pubkey", k, "--json")
	json.Unmarshal([]byte(out), &r)
	if code != 10 || r.Result != "rolled_back" || !strings.Contains(r.Detail, "exited 3 times") {
		t.Fatalf("roll-back: %d %+v", code, r)
	}
	// another update holds the lock: busy (30)
	unlock, err := lockUpdate(filepath.Join(tb.base, "root/.update.lock"))
	must(t, err)
	code, out, _ = tb.ctl("", "update", "--bundle", good, "--pubkey", k, "--json")
	unlock()
	json.Unmarshal([]byte(out), &r)
	if code != 30 || r.Result != "busy" {
		t.Fatalf("busy: %d %+v", code, r)
	}
	// root files newer than the bundle stay
	must(t, os.WriteFile(filepath.Join(tb.base, "root/VERSION"), []byte("9.0.0\n"), 0o644))
	newer := filepath.Join(t.TempDir(), "n.tar.zst")
	mkArchive(t, signedBundle(t, "0.2.0", priv, "older launcher"), newer, nil)
	code, out, _ = tb.ctl("", "update", "--bundle", newer, "--pubkey", k, "--json")
	json.Unmarshal([]byte(out), &r)
	if r.RootUpdated || len(r.Notes) != 1 || !strings.Contains(r.Notes[0], "newer") {
		t.Fatalf("newer root files: %d %s", code, out)
	}
}

func TestCompareVersions(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want int
	}{{"1.0.0", "1.0.0", 0}, {"1.0.0", "1.0.1", -1}, {"1.10.0", "1.9.0", 1}, {"1.0.0-rc.1", "1.0.0", -1}, {"1.0.0-rc.10", "1.0.0-rc.9", 1},
		{"1.0.0-1", "1.0.0-beta", -1}, {"1.0.0-beta.1", "1.0.0-beta", 1}, {"1.0.0+b7", "1.0.0", 0}} {
		if got := compareVersions(c.a, c.b); got != c.want {
			t.Errorf("%s vs %s = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestPreflightJudgement(t *testing.T) {
	root := t.TempDir()
	w := func(p, s string) {
		must(t, os.MkdirAll(filepath.Dir(filepath.Join(root, p)), 0o755))
		must(t, os.WriteFile(filepath.Join(root, p), []byte(s), 0o644))
	}
	w("/etc/os-release", "ID=debian\nVERSION_ID=\"13\"\n")
	w("/proc/sys/kernel/osrelease", "6.12.48+deb13-amd64\n")
	w("/proc/cpuinfo", "processor: 0\nflags\t\t: fpu sse4_2 avx2 fma f16c\n")
	w("/sys/fs/cgroup/cgroup.controllers", "cpuset cpu io memory pids\n")
	w("/proc/sys/kernel/yama/ptrace_scope", "1\n")
	w("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "0\n")
	must(t, os.MkdirAll(filepath.Join(root, "/run/systemd/system"), 0o755))
	must(t, os.Symlink("usr/lib", filepath.Join(root, "lib")))
	p := preflight(sysPaths{root: root}, true, "amd64", 6)
	if !p.OK || !p.CgroupDelegation || !p.MergedUsr || p.PtraceScope != 1 {
		t.Fatalf("good hosted host: %+v", p)
	}
	// hosted: Landlock ABI 4 and ptrace_scope 0 are problems; self-install: warnings
	w("/proc/sys/kernel/yama/ptrace_scope", "0\n")
	if p := preflight(sysPaths{root: root}, true, "amd64", 4); p.OK || len(p.Problems) != 2 {
		t.Fatalf("hosted with old kernel: %+v", p.Problems)
	}
	if p := preflight(sysPaths{root: root}, false, "amd64", 4); !p.OK || len(p.Warnings) < 2 {
		t.Fatalf("self-install with old kernel: %+v", p)
	}
	w("/etc/os-release", "ID=ubuntu\nVERSION_ID=\"22.04\"\n")
	w("/proc/cpuinfo", "flags: fpu\n")
	if p := preflight(sysPaths{root: root}, false, "amd64", 6); p.OK || len(p.Problems) != 2 {
		t.Fatalf("ubuntu 22.04 without sse4.2: %+v", p.Problems)
	}
	if versionAtLeast("0.6.1", "0.8.0") || !versionAtLeast("0.12.0", "0.8.0") || !versionAtLeast("0.8.0", "0.8.0") {
		t.Fatal("versionAtLeast")
	}
	_ = strconv.Itoa
}

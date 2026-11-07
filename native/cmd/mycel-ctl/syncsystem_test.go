package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"mycel/native/internal/bundle"
)

// syncTestBase is a test install whose update switches app/current like the server's admin.js would.
func syncTestBase(t *testing.T) *testBase {
	tb := newTestBase(t, "0.1.0")
	systemdRunDir = filepath.Join(t.TempDir(), "none")
	t.Cleanup(func() { systemdRunDir = "/run/systemd/system" })
	updateHooks(t, tb, func(v string) {
		os.Remove(filepath.Join(tb.base, "app/current"))
		os.Symlink("versions/"+v, filepath.Join(tb.base, "app/current"))
		tb.health.Store(v)
	})
	return tb
}

// listBundle is a signed 0.2.0 archive with root/packages.sh = script (none when script is "") and root/packages.json.
func listBundle(t *testing.T, launcher, script string) (dir, arch, key string) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	dir = signedBundle(t, "0.2.0", priv, launcher)
	if script != "" {
		must(t, os.WriteFile(filepath.Join(dir, "root", packagesSh), []byte(script), 0o644))
		must(t, os.WriteFile(filepath.Join(dir, "root", packagesList), []byte(`{"format":1}`), 0o644))
		must(t, bundle.WriteManifest(dir, "0.2.0", priv))
	}
	arch = filepath.Join(t.TempDir(), "0.2.0-linux-"+runtime.GOARCH+".tar.zst")
	mkArchive(t, dir, arch, nil)
	return dir, arch, base64.StdEncoding.EncodeToString(pub)
}

// recorder is a packages.sh that appends "<its arguments>|<app/current then>" to a file of the test.
func recorder(t *testing.T) (script, marker string) {
	marker = filepath.Join(t.TempDir(), "sync.calls")
	return "printf '%s|%s\\n' \"$*\" \"$(readlink \"$5/app/current\")\" >> '" + marker + "'\n" +
		"echo 'packages: chrome-headless-shell 157.0.8103.38 (/opt/trina/chrome-headless-shell/current/chrome-headless-shell)'\n", marker
}

func calls(marker string) []string {
	b, _ := os.ReadFile(marker)
	if s := strings.TrimSpace(string(b)); s != "" {
		return strings.Split(s, "\n")
	}
	return nil
}

// The list travels with the root files (root/packages.json and root/packages.sh): update runs `packages.sh sync` with
// the install's id and base and the verified bundle's bun once the root files AND the app are in (app/current names the
// new version by then), and its lines become notes. Also when the root files were right already. A bundle without the
// list runs nothing.
func TestUpdateSyncsSystemPackages(t *testing.T) {
	for _, c := range []struct {
		name     string
		list     bool
		sameRoot bool
		calls    int
	}{
		{"root files change", true, false, 1},
		{"root files right already", true, true, 1},
		{"a bundle without the list", false, false, 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			tb := syncTestBase(t)
			script, marker := recorder(t)
			if !c.list {
				script = ""
			}
			launcher := "new launcher"
			if c.sameRoot {
				launcher = "old launcher"
			}
			dir, arch, k := listBundle(t, launcher, script)
			if c.sameRoot {
				for _, f := range []string{"mycel-ctl", packagesSh, packagesList} {
					b, err := os.ReadFile(filepath.Join(dir, "root", f))
					must(t, err)
					must(t, os.WriteFile(filepath.Join(tb.base, "root", f), b, 0o644))
				}
			}
			code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
			if code != 0 || r.Result != "ok" || r.RootUpdated == c.sameRoot || !r.AppUpdated {
				t.Fatalf("%d %+v", code, r)
			}
			got, notes := calls(marker), strings.Join(r.Notes, "\n")
			if len(got) != c.calls || strings.Contains(notes, "chrome-headless-shell") != (c.calls > 0) {
				t.Fatalf("packages.sh calls %q, notes %v", got, r.Notes)
			}
			if c.calls == 0 {
				return
			}
			args, current, _ := strings.Cut(got[0], "|")
			if !strings.HasPrefix(args, "sync --id mycel --base "+tb.base+" --bun ") || !strings.HasSuffix(args, "/bundle/bin/bun") {
				t.Fatalf("packages.sh %q", args)
			}
			if current != "versions/0.2.0" {
				t.Fatalf("the sync ran before the app was switched (app/current %q)", current)
			}
		})
	}
}

// A failing packages.sh (no network, a broken mirror) is a note: the root files and the app are in, the update is ok.
func TestUpdateSystemPackagesFailureIsANote(t *testing.T) {
	tb := syncTestBase(t)
	_, arch, k := listBundle(t, "new launcher", "echo 'packages: downloading x failed' >&2\nexit 3\n")
	code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
	notes := strings.Join(r.Notes, "\n")
	if code != 0 || r.Result != "ok" || !r.RootUpdated || !r.AppUpdated ||
		!strings.Contains(notes, "downloading x failed") || !strings.Contains(notes, "packages.sh sync: exit status 3") {
		t.Fatalf("%d %+v", code, r)
	}
}

// A sync that hangs is stopped at its deadline with its whole process group (a download it started too), and the update
// goes on: a note, never a failure, never the app held up.
func TestUpdateSyncDeadlineStopsTheGroup(t *testing.T) {
	tb := syncTestBase(t)
	prevT, prevW := syncInlineTimeout, syncWaitDelay
	syncInlineTimeout, syncWaitDelay = 1500*time.Millisecond, 2*time.Second
	t.Cleanup(func() { syncInlineTimeout, syncWaitDelay = prevT, prevW })
	pidFile := filepath.Join(t.TempDir(), "child.pid")
	_, arch, k := listBundle(t, "new launcher", "sleep 60 &\necho $! > '"+pidFile+"'\nwait\n")
	start := time.Now()
	code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
	took := time.Since(start)
	if code != 0 || r.Result != "ok" || !r.AppUpdated || !strings.Contains(strings.Join(r.Notes, "\n"), "did not finish in 1.5s and was stopped") || took > 15*time.Second {
		t.Fatalf("%d %+v after %v", code, r, took)
	}
	b, err := os.ReadFile(pidFile)
	must(t, err)
	pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	time.Sleep(200 * time.Millisecond)
	if pid > 0 && syscall.Kill(pid, 0) == nil {
		syscall.Kill(pid, syscall.SIGKILL)
		t.Fatalf("the sync's child %d still runs", pid)
	}
	// it wrote no record, so mycel-ctl did: "incomplete" (tried again after syncRetry, not at every check)
	if s := readSynced(&env{base: tb.base}); s == nil || s.Result != "incomplete" || s.List != listSum(&env{base: tb.base}) || !strings.Contains(s.Detail, "did not finish in 1.5s") {
		t.Fatalf("record after a stopped sync: %+v", s)
	}
}

// A sync that ends without a record (the script failed before it wrote one, a full disk) gets "incomplete" from
// mycel-ctl; one that wrote its record keeps it.
func TestUpdateSyncWithoutARecord(t *testing.T) {
	tb := syncTestBase(t)
	_, arch, k := listBundle(t, "new launcher", "echo 'packages: cannot read the list' >&2\nexit 0\n")
	if code, r := tb.update(t, "--bundle", arch, "--pubkey", k); code != 0 || r.Result != "ok" {
		t.Fatalf("%d %+v", code, r)
	}
	e := &env{base: tb.base}
	if s := readSynced(e); s == nil || s.Result != "incomplete" || s.Detail != "packages.sh sync ended without a result" {
		t.Fatalf("%+v", s)
	}
	tb2 := syncTestBase(t)
	script := "printf '{\"format\":1,\"list\":\"x\",\"result\":\"blocked\",\"at\":\"2026-11-07T00:00:00Z\",\"detail\":\"missing: socat\"}\\n' > \"$5/root/packages.synced\"\n"
	_, arch, k = listBundle(t, "new launcher", script)
	if code, r := tb2.update(t, "--bundle", arch, "--pubkey", k); code != 0 || r.Result != "ok" {
		t.Fatalf("%d %+v", code, r)
	}
	if s := readSynced(&env{base: tb2.base}); s == nil || s.Result != "blocked" || s.Detail != "missing: socat" {
		t.Fatalf("the script's own record was replaced: %+v", s)
	}
}

// Only a bundle that verified lends root its bun: after a verify failure the sync reads the list's flat copy.
func TestUnverifiedBundleLendsNoBun(t *testing.T) {
	tb := syncTestBase(t)
	marker, _ := listRoot(t, tb, "")
	_, arch, _ := listBundle(t, "new launcher", "")
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	code, r := tb.update(t, "--bundle", arch, "--pubkey", base64.StdEncoding.EncodeToString(other))
	got := calls(marker)
	if code == 0 || r.Result != "verify_failed" || len(got) != 1 || strings.Contains(got[0], "--bun") {
		t.Fatalf("%d %+v calls %q", code, r, got)
	}
}

// apt and curl get this run's proxy settings, and nothing else of its environment.
func TestUpdateSyncGetsTheProxy(t *testing.T) {
	tb := syncTestBase(t)
	t.Setenv("https_proxy", "http://proxy.example:3128")
	t.Setenv("NO_PROXY", "127.0.0.1")
	t.Setenv("MYCEL_SOMETHING_ELSE", "x")
	out := filepath.Join(t.TempDir(), "env")
	_, arch, k := listBundle(t, "new launcher", "env | sort > '"+out+"'\n")
	if code, r := tb.update(t, "--bundle", arch, "--pubkey", k); code != 0 || r.Result != "ok" {
		t.Fatalf("%d %+v", code, r)
	}
	b, _ := os.ReadFile(out)
	env := string(b)
	if !strings.Contains(env, "https_proxy=http://proxy.example:3128\n") || !strings.Contains(env, "NO_PROXY=127.0.0.1\n") || strings.Contains(env, "MYCEL_SOMETHING_ELSE") || !strings.Contains(env, "PATH=/usr/sbin:/usr/bin:/sbin:/bin\n") {
		t.Fatalf("environment of packages.sh:\n%s", env)
	}
}

// listRoot puts the list and a recording packages.sh in root/ (what an older mycel-ctl leaves: it copied the root files
// of a release with the list and never synced). synced: the content of root/packages.synced ("" = none).
func listRoot(t *testing.T, tb *testBase, synced string) (marker, sum string) {
	script, marker := recorder(t)
	must(t, os.WriteFile(filepath.Join(tb.base, "root", packagesSh), []byte(script), 0o644))
	must(t, os.WriteFile(filepath.Join(tb.base, "root", packagesList), []byte(`{"format":1,"x":1}`), 0o644))
	h := sha256.Sum256([]byte(`{"format":1,"x":1}`))
	sum = hex.EncodeToString(h[:])
	p := filepath.Join(tb.base, "root", packagesSynced)
	os.Remove(p)
	if synced != "" {
		must(t, os.WriteFile(p, []byte(strings.ReplaceAll(synced, "SUM", sum)), 0o644))
	}
	return marker, sum
}

// The catch-up after an older mycel-ctl did the swap: the release is installed, so nothing is downloaded, but the list in
// root/ was never synced. The timer's run (--only-if-needs-root) and an administrator's plain update sync it, from the
// list's flat copy (no bundle, no --bun). A matching record, or an incomplete one younger than syncRetry, needs nothing.
func TestPendingSyncWithNothingToInstall(t *testing.T) {
	f := newFeedServer(t)
	f.channel("0.2.17", true)
	tb, switched := feedBase(t, f, "0.2.17", "0.2.17")
	recent := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339)
	old := time.Now().UTC().Add(-7 * time.Hour).Format(time.RFC3339)
	for _, c := range []struct {
		name, synced string
		syncs        bool
	}{
		{"never synced", "", true},
		{"another list synced", `{"format":1,"list":"abc","result":"ok","at":"2026-11-01T00:00:00Z"}`, true},
		{"this list synced", `{"format":1,"list":"SUM","result":"ok","at":"2026-11-01T00:00:00Z"}`, false},
		{"blocked: an administrator's own run tries again", `{"format":1,"list":"SUM","result":"blocked","at":"2026-11-01T00:00:00Z"}`, true},
		{"incomplete an hour ago", `{"format":1,"list":"SUM","result":"incomplete","at":"` + recent + `"}`, false},
		{"incomplete 7 hours ago", `{"format":1,"list":"SUM","result":"incomplete","at":"` + old + `"}`, true},
	} {
		for _, args := range [][]string{{"--only-if-needs-root"}, {}} {
			marker, _ := listRoot(t, tb, c.synced)
			code, r := tb.update(t, append(args, "--pubkey", f.key)...)
			got := calls(marker)
			if code != 0 || r.Result != "ok" || !r.Skipped || r.RootUpdated || r.AppUpdated || *switched != "" || f.downloaded() != 0 || (len(got) == 1) != c.syncs {
				t.Fatalf("%s %v: %d %+v calls %q downloads %d", c.name, args, code, r, got, f.downloaded())
			}
			if c.syncs && (!strings.HasPrefix(got[0], "sync --id mycel --base "+tb.base+"|") || !strings.Contains(strings.Join(r.Notes, "\n"), "packages: chrome-headless-shell")) {
				t.Fatalf("%s %v: %q %v", c.name, args, got, r.Notes)
			}
		}
	}
}

// The update timer's scheduled run: inside the window, a pending sync is root's work even when the release needs nothing
// (the gate says so in a note); outside the window it waits like any other root job.
func TestScheduledRunSyncsAPendingList(t *testing.T) {
	f := newFeedServer(t)
	f.channel("0.2.18", true)
	tb := schedBase(t, f)
	marker, _ := listRoot(t, tb, "")
	r := &schedRun{clock: at("2026-11-01T18:10:00Z"), window: "03:00-05:00", zone: "Asia/Seoul"}
	scheduledHooks(t, tb, r)
	code, res := tb.scheduled(t, f)
	if code != 0 || res.Result != "ok" || res.AppUpdated || res.RootUpdated || f.downloaded() != 0 || len(calls(marker)) != 1 ||
		!strings.Contains(strings.Join(res.Notes, "\n"), "system packages: the list in root/") {
		t.Fatalf("%d %+v calls %q", code, res, calls(marker))
	}
	f = newFeedServer(t)
	f.channel("0.2.18", true)
	tb = schedBase(t, f)
	marker, _ = listRoot(t, tb, "")
	r = &schedRun{clock: at("2026-11-01T08:10:00Z"), window: "03:00-05:00", zone: "Asia/Seoul"} // 17:10 in Seoul
	scheduledHooks(t, tb, r)
	if code, res := tb.scheduled(t, f); code != 0 || !res.Skipped || !strings.HasPrefix(res.Detail, "outside the update window") || len(calls(marker)) != 0 {
		t.Fatalf("outside the window: %d %+v calls %q", code, res, calls(marker))
	}
}

// A pending sync never makes root take a release the app takes by itself (review S2: two updaters switching versions
// garble state.json's previous): the timer leaves an app-only release to the app and syncs beside it, without a
// download. A blocked record waits for an administrator: the timer does not retry it.
func TestScheduledSyncLeavesAppReleasesToTheApp(t *testing.T) {
	f := newFeedServer(t)
	f.channel("0.2.19", false) // app-only, newer than the 0.2.18 that runs
	tb := schedBase(t, f)
	marker, _ := listRoot(t, tb, "")
	r := &schedRun{clock: at("2026-11-01T18:10:00Z"), window: "03:00-05:00", zone: "Asia/Seoul"}
	scheduledHooks(t, tb, r)
	code, res := tb.scheduled(t, f)
	if code != 0 || res.Result != "ok" || !res.Skipped || res.Detail != "release 0.2.19 does not change root files" || res.AppUpdated || res.RootUpdated ||
		r.switched != "" || f.downloaded() != 0 || len(calls(marker)) != 1 {
		t.Fatalf("%d %+v switched %q downloads %d calls %q", code, res, r.switched, f.downloaded(), calls(marker))
	}
	f = newFeedServer(t)
	f.channel("0.2.18", true)
	tb = schedBase(t, f)
	marker, _ = listRoot(t, tb, `{"format":1,"list":"SUM","result":"blocked","at":"2026-11-01T00:00:00Z"}`)
	scheduledHooks(t, tb, &schedRun{clock: at("2026-11-01T18:10:00Z"), window: "03:00-05:00", zone: "Asia/Seoul"})
	if code, res := tb.scheduled(t, f); code != 0 || !res.Skipped || len(calls(marker)) != 0 {
		t.Fatalf("blocked: %d %+v calls %q", code, res, calls(marker))
	}
	if rootJob(&ReleaseFeed{Version: "0.4.0", RootSince: "0.3.0"}, "0.4.0", "0.4.0") {
		t.Fatal("rootJob")
	}
}

// `mycel-ctl status` says where the sync stands.
func TestSyncStatusLine(t *testing.T) {
	tb := newTestBase(t, "0.1.0")
	e := &env{base: tb.base, now: time.Now}
	if line, _, _ := syncStatus(e, time.Now()); line != "" {
		t.Fatalf("a server from before the list: %q", line)
	}
	for _, c := range []struct{ synced, want string }{
		{"", "not synced to the list in root/ (the list in root/ ("},
		{`{"format":1,"list":"SUM","result":"ok","at":"2026-11-07T03:12:00Z","browser":"157.0.8103.38"}`, "synced 2026-11-07T03:12:00Z, chrome-headless-shell 157.0.8103.38"},
		{`{"format":1,"list":"SUM","result":"blocked","at":"2026-11-07T03:12:00Z","detail":"missing: unzip"}`, "needs an administrator (missing: unzip)"},
		{`{"format":1,"list":"SUM","result":"incomplete","at":"2026-11-07T03:12:00Z","detail":"downloading failed"}`, "incomplete at 2026-11-07T03:12:00Z (downloading failed); tried again after 6h0m0s"},
	} {
		listRoot(t, tb, c.synced)
		if line, _, _ := syncStatus(e, time.Now()); !strings.HasPrefix(line, c.want) {
			t.Fatalf("%q: %q", c.synced, line)
		}
	}
}

// syncUnitBase is a syncTestBase on "systemd": update starts the sync as a unit (startSyncUnit, stubbed: it records its
// arguments and starts nothing) instead of running packages.sh itself.
func syncUnitBase(t *testing.T, startErr error, startOut string) (*testBase, *[][]string) {
	tb := syncTestBase(t)
	prevUnit := syncAsUnit
	syncAsUnit = func(*updater) bool { return true }
	t.Cleanup(func() { syncAsUnit = prevUnit })
	started := &[][]string{}
	prev := startSyncUnit
	startSyncUnit = func(args []string) (string, error) {
		*started = append(*started, args)
		return startOut, startErr
	}
	t.Cleanup(func() { startSyncUnit = prev })
	return tb, started
}

// High 2 of the review of PR #164: with systemd the sync never runs inside the update command. A packages.sh that would
// take a minute does not delay the update, its result is "ok" with a note naming the unit, and the unit gets the
// installed mycel-ctl, the base and the proxy settings (systemd-run passes no environment), never a bun from the
// bundle folder the update removes.
func TestUpdateStartsTheSyncAsAUnit(t *testing.T) {
	tb, started := syncUnitBase(t, nil, "")
	t.Setenv("https_proxy", "http://proxy.example:3128")
	marker := filepath.Join(t.TempDir(), "ran")
	_, arch, k := listBundle(t, "new launcher", "touch '"+marker+"'\nsleep 60\n")
	start := time.Now()
	code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
	if took := time.Since(start); code != 0 || r.Result != "ok" || !r.AppUpdated || took > 20*time.Second {
		t.Fatalf("%d %+v after %v", code, r, took)
	}
	if fileExists(marker) {
		t.Fatal("packages.sh ran inside the update command")
	}
	if !strings.Contains(strings.Join(r.Notes, "\n"), "the sync runs in mycel-packages-sync.service after this update") || len(*started) != 1 {
		t.Fatalf("notes %v, started %q", r.Notes, *started)
	}
	args := strings.Join((*started)[0], " ")
	for _, want := range []string{"--unit=mycel-packages-sync ", "--collect", "--no-block", "--property=RuntimeMaxSec=", "--setenv=https_proxy=http://proxy.example:3128",
		" " + filepath.Join(tb.base, "root", "mycel-ctl") + " packages-sync --base " + tb.base} {
		if !strings.Contains(args, want) {
			t.Fatalf("systemd-run %s: no %q", args, want)
		}
	}
	if strings.Contains(args, "--bun") || strings.Contains(args, "--setenv=PATH=") {
		t.Fatalf("systemd-run %s", args)
	}
}

// One sync at a time: a unit that runs already stays (no second start, a note); a unit that cannot start is an
// "incomplete" record, so the timer tries again after syncRetry, and the update stays "ok".
func TestSyncUnitRunningOrNotStarting(t *testing.T) {
	tb, started := syncUnitBase(t, nil, "")
	must(t, os.WriteFile(filepath.Join(tb.fakeBin, "systemctl"), []byte("#!/bin/sh\n[ \"$1\" = is-active ] && [ \"$2\" = mycel-packages-sync.service ] && echo active\nexit 0\n"), 0o755))
	_, arch, k := listBundle(t, "new launcher", "exit 0\n")
	code, r := tb.update(t, "--bundle", arch, "--pubkey", k)
	if code != 0 || r.Result != "ok" || len(*started) != 0 || !strings.Contains(strings.Join(r.Notes, "\n"), "a sync runs already (mycel-packages-sync.service)") {
		t.Fatalf("%d %+v started %q", code, r, *started)
	}
	tb, started = syncUnitBase(t, os.ErrPermission, "Failed to connect to bus")
	_, arch, k = listBundle(t, "new launcher", "exit 0\n")
	code, r = tb.update(t, "--bundle", arch, "--pubkey", k)
	s := readSynced(&env{base: tb.base})
	if code != 0 || r.Result != "ok" || len(*started) != 1 || s == nil || s.Result != "incomplete" || !strings.Contains(s.Detail, "could not start mycel-packages-sync.service") {
		t.Fatalf("%d %+v record %+v", code, r, s)
	}
}

// The unit's command: packages.sh sync from a private copy of root/'s list and reader (an update that replaces root/
// meanwhile does not change the script bash reads), its lines on stdout (the journal); a second one at the same time
// ends at once without running anything.
func TestPackagesSyncCommand(t *testing.T) {
	tb := syncTestBase(t)
	marker := filepath.Join(t.TempDir(), "ran")
	script := "printf '%s\\n' \"$0\" >> '" + marker + "'\nls \"$(dirname \"$0\")\" >> '" + marker + "'\necho 'packages: chrome-headless-shell 157.0.8103.38'\n"
	must(t, os.WriteFile(filepath.Join(tb.base, "root", packagesSh), []byte(script), 0o644))
	must(t, os.WriteFile(filepath.Join(tb.base, "root", packagesList), []byte(`{"format":1}`), 0o644))
	run := func() (int, string) {
		e := newEnv()
		var out bytes.Buffer
		e.stdout, e.stderr = &out, &out
		code, err := cmdPackagesSync(e, []string{"--base", tb.base})
		if err != nil {
			t.Fatal(err)
		}
		return code, out.String()
	}
	must(t, os.MkdirAll(filepath.Join(tb.base, "root", ".packages-sync-left"), 0o700)) // a copy a stopped sync left
	code, out := run()
	b, _ := os.ReadFile(marker)
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if code != 0 || !strings.Contains(out, "packages: chrome-headless-shell 157.0.8103.38") || len(lines) != 3 ||
		strings.HasPrefix(lines[0], filepath.Join(tb.base, "root", packagesSh)) || lines[1] != packagesList || lines[2] != packagesSh {
		t.Fatalf("%d %q ran %q", code, out, lines)
	}
	if left, _ := filepath.Glob(filepath.Join(tb.base, "root", ".packages-sync-*")); len(left) != 0 {
		t.Fatalf("the private copy stays: %q", left)
	}
	unlock, err := lockUpdate(filepath.Join(tb.base, "root", ".packages-sync.lock"))
	must(t, err)
	defer unlock()
	os.Remove(marker)
	if code, out := run(); code != 0 || !strings.Contains(out, "another sync is running") || fileExists(marker) {
		t.Fatalf("a second sync: %d %q", code, out)
	}
}

// Medium 1 of the review: the record names the system it was made on. A reimage (a new machine-id) or an OS upgrade
// with the data disk kept makes the sync pending again; a record from before the field gets one catch-up sync.
func TestSyncRecordNamesTheSystem(t *testing.T) {
	tb := newTestBase(t, "0.1.0")
	dir := t.TempDir()
	prevM, prevO := machineIDPath, osReleasePath
	machineIDPath, osReleasePath = filepath.Join(dir, "machine-id"), filepath.Join(dir, "os-release")
	t.Cleanup(func() { machineIDPath, osReleasePath = prevM, prevO })
	must(t, os.WriteFile(osReleasePath, []byte("PRETTY_NAME=\"Debian GNU/Linux 13 (trixie)\"\nID=debian\nVERSION_ID=\"13\"\n"), 0o644))
	must(t, os.WriteFile(machineIDPath, []byte("0123456789abcdef0123456789abcdef\n"), 0o444))
	if got := osIdentity(); got != "debian-13/0123456789abcdef0123456789abcdef" {
		t.Fatalf("osIdentity %q", got)
	}
	e := &env{base: tb.base, now: time.Now}
	for _, c := range []struct {
		os      string
		pending bool
	}{
		{"debian-13/0123456789abcdef0123456789abcdef", false},
		{"debian-13/ffffffffffffffffffffffffffffffff", true}, // a reimage: the image's clone got a new machine-id
		{"debian-12/0123456789abcdef0123456789abcdef", true}, // an OS upgrade
		{"", true}, // a record from before the field
	} {
		listRoot(t, tb, `{"format":1,"list":"SUM","result":"ok","at":"2026-11-01T00:00:00Z","os":"`+c.os+`"}`)
		if p, why := syncPending(e, time.Now(), false); p != c.pending || (p && !strings.Contains(why, "another system")) {
			t.Fatalf("%q: %v %q", c.os, p, why)
		}
		// mycel-ctl status says the same
		if line, _, _ := syncStatus(e, time.Now()); strings.HasPrefix(line, "not synced") != c.pending {
			t.Fatalf("%q: status %q", c.os, line)
		}
	}
}

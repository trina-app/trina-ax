package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fakeLauncher answers {"op":"sandbox-check"} on a socket of its own, as the engine account sees the version app/current
// points to: neither its owner nor its group (the launcher runs as axagent, the version belongs to axserver). Like
// bwrap binding <app>/current/native/mycel-bridge, every folder on the way needs search by others and the bridge read
// and execute by others. mode: "" checks like that; "old" answers like a launcher that does not know the request;
// "host" answers like a launcher whose bwrap is broken on this machine; "timeout" like one whose launch did not end.
type fakeLauncher struct {
	asked atomic.Int32
}

func startFakeLauncher(t *testing.T, f *fakeInstall, mode string) *fakeLauncher {
	t.Helper()
	dir, err := os.MkdirTemp("", "lsk") // short: a unix socket path has at most 104 bytes on macOS
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "l.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	*launcherSock = sock
	fl := &fakeLauncher{}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				line, _ := bufio.NewReader(c).ReadBytes('\n')
				var req struct {
					Op string `json:"op"`
				}
				_ = json.Unmarshal(line, &req)
				if mode == "old" || req.Op != "sandbox-check" {
					c.Write([]byte(`{"ev":"error","message":"bad request"}` + "\n"))
					return
				}
				fl.asked.Add(1)
				ans := map[string]any{"ev": "sandbox-check", "ok": true}
				if mode == "host" {
					ans["skipped"], ans["hostProblem"] = "bwrap: setting up uid map: Permission denied (exit status 1)", true
				} else if mode == "timeout" {
					ans["skipped"] = "the engine sandbox did not end within 15s"
				} else if why := otherAccountReaches(f.app); why != "" {
					ans = map[string]any{"ev": "sandbox-check", "ok": false, "error": why}
				}
				b, _ := json.Marshal(ans)
				c.Write(append(b, '\n'))
			}()
		}
	}()
	return fl
}

// otherAccountReaches: "" when an account that is neither owner nor group can reach and run app/current's bridge,
// else bwrap's message for it
func otherAccountReaches(app string) string {
	bridge := filepath.Join(app, "current", "native", "mycel-bridge")
	real, err := filepath.EvalSymlinks(bridge)
	if err != nil {
		return fmt.Sprintf("bwrap: Can't find source path %s: %v", bridge, err)
	}
	appReal, _ := filepath.EvalSymlinks(app) // macOS: /var is /private/var
	rel, _ := filepath.Rel(appReal, real)
	cur := appReal
	for _, part := range strings.Split(filepath.Dir(rel), string(filepath.Separator)) {
		cur = filepath.Join(cur, part)
		if st, err := os.Stat(cur); err != nil || st.Mode().Perm()&0o001 == 0 {
			return fmt.Sprintf("bwrap: Can't find source path %s: Permission denied", bridge)
		}
	}
	if st, err := os.Stat(real); err != nil || st.Mode().Perm()&0o005 != 0o005 {
		return fmt.Sprintf("bwrap: Can't find source path %s: Permission denied", bridge)
	}
	return ""
}

// umask027 gives a version folder the modes the 0.5.7 self-update left on 2026-11-16 (extracted with umask 027):
// folders and programs 0750, other files 0640
func umask027(t *testing.T, dir string) {
	t.Helper()
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		return os.Chmod(p, info.Mode().Perm()&^0o027)
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = filepath.WalkDir(dir, func(p string, _ fs.DirEntry, _ error) error { return os.Chmod(p, 0o755) })
	})
}

// QA TC-3523: the new version answers /api/health but the engine account cannot reach its files. The bootstrap rolls
// back, says why in plain words, and the version before runs again.
func TestEngineCheckFailureRollsBack(t *testing.T) {
	f := newFakeInstall(t)
	bootOS = "linux"
	f.version("1.0.0", f.healthyBody("1.0.0"))
	f.version("1.1.0", f.healthyBody("1.1.0"))
	umask027(t, filepath.Join(f.app, "versions", "1.1.0"))
	fl := startFakeLauncher(t, f, "")
	f.updating("1.0.0", "1.1.0")
	stop := f.start()
	st := f.waitFor("roll-back", func(st appState) bool { return len(st.History) == 1 })
	if got := results(st); got != "rolled_back:1.1.0->1.0.0" {
		t.Fatalf("history %s", got)
	}
	d := str(st.History[0].Detail)
	if !strings.Contains(d, "the AI engine cannot start with this version") || !strings.Contains(d, "Can't find source path") || !strings.Contains(d, "Permission denied") {
		t.Fatalf("detail %q", d)
	}
	if str(st.Current) != "1.0.0" || st.Previous != nil || st.Pending != nil {
		t.Fatalf("state %+v", st)
	}
	if cur, _ := currentVersion(); cur != "1.0.0" {
		t.Fatalf("app/current %s", cur)
	}
	// the version before is not pending: it starts without a check and stays
	waitStarts(t, f, "1.1.0 1.0.0")
	if code := stop(); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if n := fl.asked.Load(); n != 1 {
		t.Fatalf("launcher asked %d times", n)
	}
	if st := f.state(); len(st.History) != 1 {
		t.Fatalf("history after: %s", results(st))
	}
}

// A good version passes the check and stays; a version whose launcher is older than the bootstrap (it does not know
// the request) stays too: no answer is no proof against the version.
func TestEngineCheckGoodVersionStays(t *testing.T) {
	for _, old := range []bool{false, true} {
		t.Run(fmt.Sprintf("old launcher %v", old), func(t *testing.T) {
			f := newFakeInstall(t)
			bootOS = "linux"
			f.version("1.0.0", f.healthyBody("1.0.0"))
			f.version("1.1.0", f.healthyBody("1.1.0"))
			fl := startFakeLauncher(t, f, map[bool]string{true: "old"}[old])
			f.updating("1.0.0", "1.1.0")
			stop := f.start()
			st := f.waitFor("ok", func(st appState) bool { return len(st.History) == 1 })
			stop()
			if got := results(st); got != "ok:1.0.0->1.1.0" {
				t.Fatalf("history %s (%s)", got, str(st.History[0].Detail))
			}
			if str(st.Current) != "1.1.0" || str(st.Previous) != "1.0.0" || st.Pending != nil {
				t.Fatalf("state %+v", st)
			}
			if want := map[bool]int32{false: 1, true: 0}[old]; fl.asked.Load() != want {
				t.Fatalf("launcher asked %d times", fl.asked.Load())
			}
		})
	}
}

// Not Linux (an office Mac, development): no check is asked, a version the launcher would refuse stays as before.
// Linux without a launcher answering: skipped, kept.
func TestEngineCheckNoOpOffLinux(t *testing.T) {
	for _, c := range []struct {
		name, os string
		launcher bool
	}{{"darwin", "darwin", true}, {"windows", "windows", true}, {"linux without a launcher", "linux", false}} {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeInstall(t)
			bootOS = c.os
			f.version("1.0.0", f.healthyBody("1.0.0"))
			f.version("1.1.0", f.healthyBody("1.1.0"))
			umask027(t, filepath.Join(f.app, "versions", "1.1.0"))
			var fl *fakeLauncher
			if c.launcher {
				fl = startFakeLauncher(t, f, "")
			} else {
				*launcherSock = filepath.Join(t.TempDir(), "none.sock")
			}
			f.updating("1.0.0", "1.1.0")
			stop := f.start()
			st := f.waitFor("ok", func(st appState) bool { return len(st.History) == 1 })
			stop()
			if got := results(st); got != "ok:1.0.0->1.1.0" {
				t.Fatalf("history %s", got)
			}
			if fl != nil && fl.asked.Load() != 0 {
				t.Fatalf("launcher asked %d times", fl.asked.Load())
			}
		})
	}
}

func waitStarts(t *testing.T, f *fakeInstall, want string) {
	t.Helper()
	for i := 0; i < 500; i++ {
		if strings.Join(f.startList(), " ") == want {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("starts %v, want %s", f.startList(), want)
}

// A fault of this machine (bwrap broken by an OS upgrade, the helper, Landlock) breaks the version before as well: the
// new version stays, and its history entry says what is wrong (Admin › System's warning). A launch that did not end in
// time (a loaded machine) keeps it with no note. Both versions here have modes the engine could not use: only the
// launcher's verdict counts.
func TestEngineCheckHostFaultKeepsTheVersion(t *testing.T) {
	for _, mode := range []string{"host", "timeout"} {
		t.Run(mode, func(t *testing.T) {
			f := newFakeInstall(t)
			bootOS = "linux"
			f.version("1.0.0", f.healthyBody("1.0.0"))
			f.version("1.1.0", f.healthyBody("1.1.0"))
			umask027(t, filepath.Join(f.app, "versions", "1.1.0"))
			fl := startFakeLauncher(t, f, mode)
			f.updating("1.0.0", "1.1.0")
			stop := f.start()
			st := f.waitFor("ok", func(st appState) bool { return len(st.History) == 1 })
			stop()
			if got := results(st); got != "ok:1.0.0->1.1.0" {
				t.Fatalf("history %s (%s)", got, str(st.History[0].Detail))
			}
			if str(st.Current) != "1.1.0" || str(st.Previous) != "1.0.0" || st.Pending != nil || fl.asked.Load() != 1 {
				t.Fatalf("state %+v, asked %d", st, fl.asked.Load())
			}
			d := str(st.History[0].Detail)
			if mode == "host" && d != engineHostDetail+"bwrap: setting up uid map: Permission denied (exit status 1)" {
				t.Fatalf("detail %q", d)
			}
			if mode == "timeout" && d != "" {
				t.Fatalf("detail %q", d)
			}
		})
	}
}

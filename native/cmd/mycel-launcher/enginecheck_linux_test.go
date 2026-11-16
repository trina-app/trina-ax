package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// checkInstall: <base>/app/versions/<v>/native/mycel-bridge behind app/current, the launcher flags pointed at it, and
// the agent root. bridge is the program copied in as the bridge.
func checkInstall(t *testing.T, bridge string) (base, versionDir string) {
	t.Helper()
	base = t.TempDir()
	versionDir = filepath.Join(base, "app", "versions", "0.5.7")
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(versionDir, "native"), 0o755))
	b, err := os.ReadFile(bridge)
	must(err)
	must(os.WriteFile(filepath.Join(versionDir, "native", "mycel-bridge"), b, 0o755))
	must(os.Symlink(filepath.Join("versions", "0.5.7"), filepath.Join(base, "app", "current")))
	must(os.MkdirAll(filepath.Join(base, "agent"), 0o700))
	saved := struct {
		bridge, agent, bwrap, helper, etc, ca, sock, landlock string
		port                                                  int
		lxBwrap                                               bool
		libs                                                  []libMount
		usrLib64                                              bool
	}{*bridgePath, *agentRoot, *bwrapBin, *sandboxHelper, *sandboxEtc, *caBundle, *toolsSock, *landlockMode, *proxyPort, lx.bwrap, lx.libs, lx.usrLib64}
	t.Cleanup(func() {
		*bridgePath, *agentRoot, *bwrapBin, *sandboxHelper, *sandboxEtc, *caBundle, *toolsSock, *landlockMode = saved.bridge, saved.agent, saved.bwrap, saved.helper, saved.etc, saved.ca, saved.sock, saved.landlock
		*proxyPort, lx.bwrap, lx.libs, lx.usrLib64 = saved.port, saved.lxBwrap, saved.libs, saved.usrLib64
	})
	*bridgePath = filepath.Join(base, "app", "current", "native", "mycel-bridge")
	*agentRoot = filepath.Join(base, "agent")
	lx.bwrap = false
	return base, versionDir
}

// folders 0750, files 0640, the bridge too. The test runs as one account, so a lost execute right stands for what the
// engine account met on 2026-11-16 (a folder of another account it could not enter); that view is in the bootstrap's
// test (mycel-bootstrap/enginecheck_test.go) and in docker/test.sh with the real accounts.
func breakModes(t *testing.T, dir string) {
	t.Helper()
	err := filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return os.Chmod(p, 0o750)
		}
		return os.Chmod(p, 0o640)
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, _ error) error { return os.Chmod(p, 0o755) })
	})
}

// Linux without bwrap (--sandbox none): the bridge is started directly, as a turn does. A good version passes, one
// whose files lost their modes fails with the reason, and the check folder is gone afterwards.
func TestEngineCheckDirect(t *testing.T) {
	_, vdir := checkInstall(t, "/bin/true")
	if skipped, err := engineCheck(); err != nil || skipped != "" {
		t.Fatalf("good version: %q %v", skipped, err)
	}
	if _, err := os.Stat(filepath.Join(*agentRoot, checkFolderName)); !os.IsNotExist(err) {
		t.Fatalf("check folder left behind: %v", err)
	}
	breakModes(t, vdir)
	_, err := engineCheck()
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "permission denied") {
		t.Fatalf("0750/0640 version: %v", err)
	}
	// a request for the check folder is never a chat
	if _, err := chatFolder(checkFolderName); err == nil {
		t.Fatal("the check folder is a chat folder")
	}
}

// --sandbox bwrap: the real bubblewrap launch of a turn (buildBwrapArgs, mycel-sandbox exec) with the real bridge.
// Runs where unprivileged bubblewrap works (CI's Linux job allows it); skipped elsewhere.
func TestEngineCheckBwrap(t *testing.T) {
	bw, err := exec.LookPath("bwrap")
	if err != nil {
		t.Skip("no bwrap")
	}
	// the namespaces of the launch below (no network namespace: --proxy-port 0)
	probe := []string{"--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--disable-userns", "--ro-bind", "/", "/", "true"}
	if out, err := exec.Command(bw, probe...).CombinedOutput(); err != nil {
		t.Skipf("unprivileged bwrap does not work here: %v %s", err, out)
	}
	bin := t.TempDir()
	for _, c := range []string{"mycel-bridge", "mycel-sandbox"} {
		b := exec.Command("go", "build", "-o", filepath.Join(bin, c), "../"+c)
		b.Env = append(os.Environ(), "CGO_ENABLED=0")
		if out, err := b.CombinedOutput(); err != nil {
			t.Fatalf("build %s: %v %s", c, err, out)
		}
	}
	base, vdir := checkInstall(t, filepath.Join(bin, "mycel-bridge"))
	etc := filepath.Join(base, "root", "sandbox-etc")
	if err := os.MkdirAll(filepath.Join(etc, "empty.d"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"passwd", "group", "hosts", "nsswitch.conf", "empty", "ca.pem"} {
		if err := os.WriteFile(filepath.Join(etc, f), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	sock := filepath.Join(base, "tools.sock")
	if err := os.WriteFile(sock, nil, 0o600); err != nil { // bound only; nothing connects in the check
		t.Fatal(err)
	}
	*bwrapBin, *sandboxHelper, *sandboxEtc, *caBundle, *toolsSock = bw, filepath.Join(bin, "mycel-sandbox"), etc, filepath.Join(etc, "ca.pem"), sock
	*landlockMode, *proxyPort = "best-effort", 0
	lx.bwrap = true
	lx.libs, lx.usrLib64 = hostLibMounts()

	if skipped, err := engineCheck(); err != nil || skipped != "" {
		t.Fatalf("good version: %q %v", skipped, err)
	}
	breakModes(t, vdir)
	if _, err := engineCheck(); err == nil {
		t.Fatal("0750/0640 version passed the bubblewrap check")
	} else {
		t.Logf("0750/0640 version: %v", err)
	}
}

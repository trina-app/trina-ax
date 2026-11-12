package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// QA TC-340: a reset while an update replaced the root programs left some of them new and root/VERSION old, and
// status said only "root files 0.4.0".
func TestStatusSaysAnUpdateDidNotFinish(t *testing.T) {
	tb := newTestBase(t, "0.4.0")
	kit := filepath.Join(tb.base, "app/versions/0.4.0/root")
	must(t, os.MkdirAll(kit, 0o755))
	must(t, os.MkdirAll(filepath.Join(kit, "systemd"), 0o755))
	must(t, os.MkdirAll(filepath.Join(tb.base, "root/systemd"), 0o755))
	// in the kit, not installed: not counted
	must(t, os.WriteFile(filepath.Join(kit, "apparmor-bwrap.in"), []byte("x"), 0o644))
	for _, n := range []string{"mycel-launcher", "mycel-ctl", "set-claude-token", "systemd/server.service.in"} {
		must(t, os.WriteFile(filepath.Join(kit, n), []byte("0.4.0 "+n), 0o755))
		must(t, os.WriteFile(filepath.Join(tb.base, "root", n), []byte("0.4.0 "+n), 0o755))
	}
	if _, out, _ := tb.ctl("", "status"); strings.Contains(out, "DID NOT FINISH") {
		t.Fatalf("root programs match, but:\n%s", out)
	}
	must(t, os.WriteFile(filepath.Join(tb.base, "root/mycel-launcher"), []byte("0.5.0 mycel-launcher"), 0o755))
	code, out, _ := tb.ctl("", "status")
	if code != 0 || !strings.Contains(out, "AN UPDATE DID NOT FINISH: some root files (mycel-launcher) are not those of 0.4.0, the version in root/VERSION. Run the update again: sudo mycel-ctl update") {
		t.Fatalf("%d\n%s", code, out)
	}
	code, out, _ = tb.ctl("", "status", "--detail", "--json")
	var st Status
	if code != 0 || json.Unmarshal([]byte(out), &st) != nil || len(st.RootUnfinished) != 1 || st.RootUnfinished[0] != "mycel-launcher" {
		t.Fatalf("json: %d %s", code, out)
	}
	// a script and a unit template count too, in the kit's order
	must(t, os.WriteFile(filepath.Join(tb.base, "root/systemd/server.service.in"), []byte("0.5.0 unit"), 0o644))
	if _, out, _ := tb.ctl("", "status"); !strings.Contains(out, "(mycel-launcher, systemd/server.service.in)") || !strings.Contains(out, "install-linux.sh update --from .") {
		t.Fatalf("unit template:\n%s", out)
	}
	must(t, os.WriteFile(filepath.Join(tb.base, "root/systemd/server.service.in"), []byte("0.4.0 systemd/server.service.in"), 0o644))
	// a link or a FIFO in the server-owned version folder is not followed or read (a FIFO would block)
	must(t, os.Remove(filepath.Join(kit, "mycel-ctl")))
	must(t, syscall.Mkfifo(filepath.Join(kit, "mycel-ctl"), 0o644))
	must(t, os.Remove(filepath.Join(kit, "set-claude-token")))
	must(t, os.Symlink(filepath.Join(tb.base, "root/mycel-launcher"), filepath.Join(kit, "set-claude-token")))
	if code, out, _ := tb.ctl("", "status"); code != 0 || !strings.Contains(out, "some root files (mycel-launcher) are not") {
		t.Fatalf("fifo/link:\n%d %s", code, out)
	}
	// while an update holds the lock it is not "did not finish"
	unlock, err := lockUpdate(filepath.Join(tb.base, "root/.update.lock"))
	must(t, err)
	_, out, _ = tb.ctl("", "status")
	unlock()
	if strings.Contains(out, "DID NOT FINISH") || !strings.Contains(out, "an update is running now") {
		t.Fatalf("update running, but:\n%s", out)
	}
	// no version folder for root/VERSION (pruned): nothing to compare, nothing said
	must(t, os.WriteFile(filepath.Join(tb.base, "root/VERSION"), []byte("0.3.9\n"), 0o644))
	if _, out, _ := tb.ctl("", "status"); strings.Contains(out, "DID NOT FINISH") {
		t.Fatalf("no version folder, but:\n%s", out)
	}
}

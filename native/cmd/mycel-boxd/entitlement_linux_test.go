package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// the server account must not be able to change the plan caps: boxd reads them only from root's files
func TestLoadEntitlement(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "root")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "dev-env.json")
	planFile := filepath.Join(dir, "plan.json")
	os.WriteFile(file, []byte(`{"format":1,"plan":"team","maxRunning":1,"cpus":1,"memoryMiB":2560,"pids":512,"diskGiB":4}`), 0o644)
	os.WriteFile(planFile, []byte(`{"format":1,"plan":"basic","maxConcurrency":2,"memoryMiB":4096,"cpuCores":2,"diskGiB":80}`), 0o644)
	if os.Geteuid() != 0 {
		// the test's own files are not root's
		if _, _, err := loadEntitlement(file); err == nil || !strings.Contains(err.Error(), "must belong to root") {
			t.Error("files of another account", err)
		}
		t.Skip("the rest needs root")
	}
	os.Rename(file, file+".off")
	if _, _, err := loadEntitlement(file); err == nil || !strings.Contains(err.Error(), "does not include") {
		t.Error("no file", err)
	}
	os.Rename(file+".off", file)
	e, planMiB, err := loadEntitlement(file)
	if err != nil || e.MemoryMiB != 2560 || planMiB != 4096 {
		t.Fatal(e, planMiB, err)
	}
	for _, p := range []string{dir, file, planFile} {
		st, _ := os.Stat(p)
		os.Chmod(p, st.Mode().Perm()|0o020)
		if _, _, err := loadEntitlement(file); err == nil || !strings.Contains(err.Error(), "must belong to root") {
			t.Error("group may write", p, err)
		}
		os.Chmod(p, st.Mode().Perm())
	}
	os.Chown(file, 65534, 65534)
	if _, _, err := loadEntitlement(file); err == nil || !strings.Contains(err.Error(), "must belong to root") {
		t.Error("file of another account", err)
	}
	os.Chown(file, 0, 0)
	os.Rename(file, file+".real")
	os.Symlink(file+".real", file)
	if _, _, err := loadEntitlement(file); err == nil || !strings.Contains(err.Error(), "must belong to root") {
		t.Error("a link", err)
	}
	os.Remove(file)
	os.Rename(file+".real", file)
	os.Remove(planFile)
	if _, _, err := loadEntitlement(file); err == nil || !strings.Contains(err.Error(), "cannot read") {
		t.Error("no plan.json", err)
	}
}

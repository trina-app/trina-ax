package fwstatus

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWriteReadCheck(t *testing.T) {
	p := filepath.Join(t.TempDir(), "firewall.json")
	now := time.Now().UTC()
	s := &Status{Format: 1, At: now.Format(time.RFC3339Nano), Backend: "nftables", Table: "inet mycel", Loaded: true, Rules: 7, EngineUID: 990, ProxyPort: 47821}
	if err := Write(p, s); err != nil {
		t.Fatal(err)
	}
	r, err := Read(p, os.Getuid())
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Check(now, 990, 47821); err != nil {
		t.Fatal(err)
	}
	if r.Check(now.Add(11*time.Minute), 990, 47821) == nil {
		t.Fatal("stale accepted")
	}
	if r.Check(now, 991, 47821) == nil || r.Check(now, 990, 1) == nil {
		t.Fatal("wrong uid/port accepted")
	}
	r.Loaded = false
	if r.Check(now, 990, 47821) == nil {
		t.Fatal("not loaded accepted")
	}
	if _, err := Read(p, os.Getuid()+1); err == nil {
		t.Fatal("wrong owner accepted")
	}
	os.Chmod(p, 0o666)
	if _, err := Read(p, os.Getuid()); err == nil {
		t.Fatal("writable by others accepted")
	}
	l := filepath.Join(filepath.Dir(p), "link.json")
	os.Symlink(p, l)
	if _, err := Read(l, -1); err == nil {
		t.Fatal("link followed")
	}
}

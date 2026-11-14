package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// data-grow: findmnt and resize2fs are stubbed; the sizes come from the real statfs of the test base (unchanged, so
// grown is false: resize2fs is a no-op when the file system already fills the device).
func TestTenantDataGrow(t *testing.T) {
	tb := newTestBase(t, "0.3.0")
	calls := filepath.Join(tb.fakeBin, "resize2fs.calls")
	stub := func(name, body string) string {
		p := filepath.Join(tb.fakeBin, name)
		must(t, os.WriteFile(p, []byte("#!/bin/sh\n"+body+"\n"), 0o755))
		return p
	}
	oldF, oldR := findmntBin, resize2fsBin
	t.Cleanup(func() { findmntBin, resize2fsBin = oldF, oldR })
	findmntBin = stub("findmnt", `[ "$1 $2 $3 $4 $5" = "-n -o SOURCE --target `+tb.base+`" ] || { echo bad args >&2; exit 9; }; echo /dev/nvme1n1`)
	resize2fsBin = stub("resize2fs", `echo "$@" >> '`+calls+`'; [ -f '`+tb.fakeBin+`/resize-fail' ] && { echo 'resize2fs: Device or resource busy' >&2; exit 1; }; echo 'The filesystem is already 5242880 (4k) blocks long.  Nothing to do!'`)

	code, out, errs := tb.tctl("", "data-grow", "--json")
	if code != 0 {
		t.Fatalf("%d %q %s", code, out, errs)
	}
	var r struct {
		Grown       *bool   `json:"grown"`
		BeforeBytes *uint64 `json:"beforeBytes"`
		AfterBytes  *uint64 `json:"afterBytes"`
	}
	if err := json.Unmarshal([]byte(out), &r); err != nil || r.Grown == nil || r.BeforeBytes == nil || r.AfterBytes == nil {
		t.Fatalf("output %q: %v", out, err)
	}
	if *r.Grown || *r.BeforeBytes == 0 || *r.AfterBytes != *r.BeforeBytes {
		t.Fatalf("same size must not be grown: %q", out)
	}
	if b, _ := os.ReadFile(calls); strings.TrimSpace(string(b)) != "/dev/nvme1n1" {
		t.Fatalf("resize2fs calls %q", b)
	}

	// resize2fs fails: non-zero exit, nothing on stdout, the reason on stderr
	must(t, os.WriteFile(filepath.Join(tb.fakeBin, "resize-fail"), nil, 0o644))
	if code, out, errs := tb.tctl("", "data-grow", "--json"); code == 0 || out != "" || !strings.Contains(errs, "resource busy") {
		t.Fatalf("a failed resize2fs: %d %q %q", code, out, errs)
	}
	must(t, os.Remove(filepath.Join(tb.fakeBin, "resize-fail")))

	// not a block device (a bind mount, a tmpfs): resize2fs is never run
	must(t, os.Remove(calls))
	for _, src := range []string{"tmpfs", "/dev/nvme1n1[/data]", ""} {
		findmntBin = stub("findmnt", "echo '"+src+"'")
		if code, out, _ := tb.tctl("", "data-grow", "--json"); code == 0 || out != "" {
			t.Fatalf("source %q: %d %q", src, code, out)
		}
	}
	if _, err := os.Stat(calls); err == nil {
		t.Fatal("resize2fs ran on a source that is not a block device")
	}
	// no arguments
	if code, _, _ := tb.tctl("", "data-grow", "--json", "extra"); code != 2 {
		t.Fatalf("an extra argument is a usage error: %d", code)
	}
}

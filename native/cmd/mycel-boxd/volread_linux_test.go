package main

import (
	"bytes"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// a box writes the volume and boxd is root: each planted thing below must not reach a file outside the volume
func TestReadBoxFile(t *testing.T) {
	top := t.TempDir()
	vol := filepath.Join(top, "volume")
	logs := filepath.Join(vol, "cache", "logs")
	if err := os.MkdirAll(logs, 0o700); err != nil {
		t.Fatal(err)
	}
	host := filepath.Join(top, "host-secret")
	os.WriteFile(host, []byte("7"), 0o600)
	write := func(n, s string) {
		if err := os.WriteFile(filepath.Join(logs, n), []byte(s), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	read := func(n string) ([]byte, error) { return readBoxFile(vol, "cache/logs/"+n, 32, false) }

	write("ok.exit", "3\n")
	if b, err := read("ok.exit"); err != nil || string(b) != "3\n" {
		t.Error(string(b), err)
	}
	if _, err := read("missing.exit"); err == nil {
		t.Error("a missing file read")
	}

	// a link at the last part, absolute and relative
	os.Symlink(host, filepath.Join(logs, "abs.exit"))
	os.Symlink("../../../host-secret", filepath.Join(logs, "rel.exit"))
	for _, n := range []string{"abs.exit", "rel.exit"} {
		if b, err := read(n); err == nil {
			t.Errorf("%s: read through a link: %q", n, b)
		}
	}

	// a link higher up: the logs folder is the link
	vol2 := filepath.Join(top, "volume2")
	os.MkdirAll(filepath.Join(vol2, "cache"), 0o700)
	outside := filepath.Join(top, "outside")
	os.MkdirAll(outside, 0o700)
	os.WriteFile(filepath.Join(outside, "x.exit"), []byte("7"), 0o600)
	os.Symlink(outside, filepath.Join(vol2, "cache", "logs"))
	if b, err := readBoxFile(vol2, "cache/logs/x.exit", 32, false); err == nil {
		t.Errorf("read through a linked folder: %q", b)
	}

	// the volume path itself must not be a link
	link := filepath.Join(top, "volume-link")
	os.Symlink(vol, link)
	if _, err := readBoxFile(link, "cache/logs/ok.exit", 32, false); err == nil {
		t.Error("read through a linked volume")
	}

	if _, err := read("../../../host-secret"); err == nil {
		t.Error("read outside the volume with ..")
	}

	// a folder and a FIFO: no read, and no wait for a writer
	os.Mkdir(filepath.Join(logs, "dir.exit"), 0o700)
	if _, err := read("dir.exit"); err == nil {
		t.Error("read a folder")
	}
	if err := syscall.Mkfifo(filepath.Join(logs, "fifo.exit"), 0o600); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := read("fifo.exit"); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Error("read a FIFO")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("boxd waits on a FIFO")
	}

	// the size cap, from the start and from the end
	big := bytes.Repeat([]byte("a"), 100)
	big = append(big, "END"...)
	write("big.log", string(big))
	if b, err := readBoxFile(vol, "cache/logs/big.log", 8, true); err != nil || string(b) != "aaaaaEND" {
		t.Error(string(b), err)
	}
	if b, err := readBoxFile(vol, "cache/logs/big.log", 8, false); err != nil || len(b) != 8 || b[7] != 'a' {
		t.Error(string(b), err)
	}
}

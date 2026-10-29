package safebroker

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
	"testing"
)

func TestResolveAndVersion(t *testing.T) {
	root := t.TempDir()
	os.Mkdir(filepath.Join(root, "d"), 0700)
	os.WriteFile(filepath.Join(root, "d", "a"), []byte("source"), 0600)
	fd, e := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY, 0)
	if e != nil {
		t.Fatal(e)
	}
	defer unix.Close(fd)
	var out bytes.Buffer
	if e = Snapshot(fd, "d/a", 1024, &out); e != nil {
		t.Fatal(e)
	}
	os.Symlink("a", filepath.Join(root, "d", "link"))
	for _, rel := range []string{"d/link", "../outside", "/etc/passwd", "d/../d/a"} {
		if Snapshot(fd, rel, 1024, &bytes.Buffer{}) == nil {
			t.Fatal("accepted", rel)
		}
	}
	os.Rename(filepath.Join(root, "d", "a"), filepath.Join(root, "d", "moved"))
	if Snapshot(fd, "d/a", 1024, &bytes.Buffer{}) == nil {
		t.Fatal("accepted moved source")
	}
	os.WriteFile(filepath.Join(root, "d", "a"), []byte("replacement"), 0600)
	var after bytes.Buffer
	if e = Snapshot(fd, "d/a", 1024, &after); e != nil {
		t.Fatal(e)
	}
	if bytes.Equal(out.Bytes(), after.Bytes()) {
		t.Fatal("lost version")
	}
}
func TestPublishNoReplace(t *testing.T) {
	root := t.TempDir()
	fd, e := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY, 0)
	if e != nil {
		t.Fatal(e)
	}
	defer unix.Close(fd)
	b := []byte("artifact")
	h := fmt.Sprintf("%x", sha256.Sum256(b))
	job := "00000000-0000-0000-0000-000000000001"
	os.WriteFile(filepath.Join(root, "occupied"), []byte("independent writer"), 0600)
	if Publish(fd, "occupied", job, h, bytes.NewReader(b)) != unix.EEXIST {
		t.Fatal("must refuse replacement")
	}
	got, _ := os.ReadFile(filepath.Join(root, "occupied"))
	if string(got) != "independent writer" {
		t.Fatal("writer lost")
	}
	if e = Publish(fd, "new", job, h, bytes.NewReader(b)); e != nil {
		t.Fatal(e)
	}
	s, _ := os.Stat(filepath.Join(root, "new"))
	if s.Mode().Perm() != 0400 {
		t.Fatal(s.Mode())
	}
	if e = Clean(fd, "new", job); e != nil {
		t.Fatal(e)
	}
	if e = Clean(fd, "new", job); e != nil {
		t.Fatal(e)
	}
}

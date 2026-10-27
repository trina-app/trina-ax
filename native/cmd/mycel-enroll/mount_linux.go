package main

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

// isMountpoint: path is the mount point of a mount (/proc/self/mountinfo field 5, octal escapes decoded). Bind mounts
// and docker volumes count, which is what the dev driver relies on.
func isMountpoint(path string) bool {
	path = filepath.Clean(path)
	f, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) > 4 && unescapeMountinfo(fields[4]) == path {
			return true
		}
	}
	return false
}

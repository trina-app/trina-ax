//go:build !linux

package main

import (
	"path/filepath"
	"syscall"
)

// isMountpoint (non-Linux, development builds only): the path sits on another device than its parent.
func isMountpoint(path string) bool {
	var a, b syscall.Stat_t
	if err := syscall.Stat(path, &a); err != nil {
		return false
	}
	if err := syscall.Stat(filepath.Dir(filepath.Clean(path)), &b); err != nil {
		return false
	}
	return a.Dev != b.Dev
}

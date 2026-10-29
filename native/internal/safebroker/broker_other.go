//go:build !linux

package safebroker

import (
	"errors"
	"io"
)

func Snapshot(root int, rel string, cap int64, out io.Writer) error {
	return errors.New("Linux openat2 required")
}
func Publish(root int, rel, job, hash string, input io.Reader) error {
	return errors.New("qualified Linux required")
}
func Clean(root int, rel, job string) error { return errors.New("qualified Linux required") }

func ParentGuard(expected int) error { return errors.New("qualified Linux required") }

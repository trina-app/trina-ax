//go:build !linux

package main

import "errors"

var errLinux = errors.New("project boxes run on Linux only")

func setup() error { return errLinux }
func statusEv() map[string]any {
	return map[string]any{"ev": "status", "available": false, "reason": errLinux.Error(), "boxes": []any{}}
}
func ensure(*request) (map[string]any, error)                  { return nil, errLinux }
func stop(string, bool) error                                  { return errLinux }
func execIn(*request, <-chan struct{}) (map[string]any, error) { return nil, errLinux }
func processes(string) ([]procInfo, error)                     { return nil, errLinux }
func preview(string, int) (string, error)                      { return "", errLinux }
func netlog(string) ([]string, error)                          { return nil, errLinux }

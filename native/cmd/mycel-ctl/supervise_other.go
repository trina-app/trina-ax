//go:build !linux

package main

import "fmt"

func cmdSupervise(e *env, args []string) (int, error) {
	return 2, fmt.Errorf("supervise is Linux only")
}

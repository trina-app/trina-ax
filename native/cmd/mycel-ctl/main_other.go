//go:build !linux

// mycel-ctl is Linux only (linux-runtime spec); on other systems it only says so.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "mycel-ctl: Linux only")
	os.Exit(2)
}

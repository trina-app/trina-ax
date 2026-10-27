//go:build !linux

// mycel-sandbox is Linux only (linux-runtime spec); on other systems it only says so.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "mycel-sandbox: Linux only")
	os.Exit(2)
}

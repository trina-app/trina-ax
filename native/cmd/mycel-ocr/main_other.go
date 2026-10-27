//go:build !linux

// mycel-ocr is Linux only (linux-runtime spec); on other systems it only says so.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "mycel-ocr: Linux only")
	os.Exit(2)
}

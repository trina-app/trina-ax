// Fixed helper, launched only inside the qualified converter sandbox.
package main

import (
	"bytes"
	"errors"
	"fmt"
	"mycel/native/internal/safebroker"
	"mycel/native/internal/safeops"
	"os"
	"os/exec"
	"strconv"
	"syscall"
)

func main() {
	if len(os.Args) > 2 {
		var err error
		switch os.Args[1] {
		case "snapshot":
			if len(os.Args) != 4 {
				os.Exit(2)
			}
			cap, e := strconv.ParseInt(os.Args[3], 10, 64)
			if e != nil || cap < 0 || cap > 32<<20 {
				os.Exit(2)
			}
			err = safebroker.Snapshot(3, os.Args[2], cap, os.Stdout)
		case "publish":
			if len(os.Args) != 5 {
				os.Exit(2)
			}
			err = safebroker.Publish(3, os.Args[2], os.Args[3], os.Args[4], os.Stdin)
		case "clean":
			if len(os.Args) != 4 {
				os.Exit(2)
			}
			err = safebroker.Clean(3, os.Args[2], os.Args[3])
		default:
			os.Exit(2)
		}
		if errors.Is(err, syscall.EEXIST) {
			os.Exit(4)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "safe filesystem operation refused")
			os.Exit(3)
		}
		return
	}

	if len(os.Args) != 2 {
		os.Exit(2)
	}
	mode := os.Args[1]
	limit := int64(safeops.InputMax)
	if mode == "pptx" {
		limit = 32 << 20
	}
	b, err := safeops.ReadBounded(os.Stdin, limit)
	var out []byte
	if err == nil {
		switch mode {
		case "png", "jpeg", "webp":
			out, err = safeops.Image(b, mode)
		case "heic":
			// libheif is the existing HEIC decoder, with a private, hard-bounded tmpfs.
			if len(b) < 16 || string(b[4:8]) != "ftyp" || !bytes.Contains([]byte("heic heix hevc hevx mif1 msf1"), b[8:12]) {
				err = fmt.Errorf("format mismatch")
				break
			}
			err = os.WriteFile("/work/in.heic", b, 0600)
			if err != nil {
				break
			}
			cmd := exec.Command("/codec/heif-dec", "--quiet", "/work/in.heic", "/work/out.png")
			if err = cmd.Run(); err != nil {
				break
			}
			var f *os.File
			f, err = os.Open("/work/out.png")
			if err != nil {
				break
			} // multiple top-level images are deliberately refused
			b, err = safeops.ReadBounded(f, 64<<20)
			f.Close()
			if err == nil {
				out, err = safeops.Intermediate(b)
			}
		case "pptx":
			out, err = safeops.Deck(b)
		default:
			err = fmt.Errorf("unsupported operation")
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "safe operation refused")
		os.Exit(3)
	}
	if _, err = os.Stdout.Write(out); err != nil {
		os.Exit(1)
	}
}

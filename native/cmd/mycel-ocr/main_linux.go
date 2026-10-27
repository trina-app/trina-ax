//go:build linux

// mycel-ocr (Linux): text of a PDF or an image read from stdin, for read/grep (server/src/files/extract.ts). Same
// contract as the macOS Swift version (native/ocr/main.swift), different engine: poppler (pdfinfo, pdftotext,
// pdftoppm) and tesseract with Korean + English (linux-runtime spec 3.7.1, D14). PDF pages that have a text layer keep
// it; only pages with fewer than 20 non-space characters are rendered and recognized, so a scanned page inside a
// normal PDF still reads. Runs inside the converter sandbox (tools/isolate.ts: bwrap, only the work folder writable;
// temp files go to $TMPDIR = that folder). No network, nothing kept.
//
//	mycel-ocr [--max-pages N]  < file
//
// Output: UTF-8 text, pages separated by an empty line. Exit 2: not a PDF or an image. Exit 1: failure (reason on
// stderr).
package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	maxInput = 200 << 20 // the server's read limit for one file
	// renderDPI: the Swift version draws pages at 2x (about 144 dpi); spike S5 (2026-10-22) kept it for tesseract
	renderDPI = 144
	stepLimit = 60 * time.Second // one tool run (one page's recognition, one conversion)
	// pdfBudget: server/src/files/extract.ts kills a PDF read after 240 s and then nothing is shown; stopping the
	// recognition in time keeps the pages read so far (a slow virtual CPU, a long scan)
	pdfBudget = 200 * time.Second
)

// tools are absolute: the sandbox's PATH is minimal and a PATH lookup could pick a file from the work folder
var (
	pdfinfoBin   = "/usr/bin/pdfinfo"
	pdftotextBin = "/usr/bin/pdftotext"
	pdftoppmBin  = "/usr/bin/pdftoppm"
	tesseractBin = "/usr/bin/tesseract"
	ffmpegBin    = "/usr/bin/ffmpeg"
	heifDecBin   = "/usr/bin/heif-dec"
)

type exitErr struct {
	code int
	msg  string
}

func (e *exitErr) Error() string { return e.msg }

func failf(code int, format string, a ...any) error {
	return &exitErr{code: code, msg: fmt.Sprintf(format, a...)}
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	maxPages := 50 // Linux default (tesseract is slower per page than Vision); the server passes its own value
	budget := pdfBudget
	for i := 0; i < len(args); i++ {
		if i+1 >= len(args) {
			break
		}
		switch args[i] {
		case "--max-pages":
			if n, err := strconv.Atoi(args[i+1]); err == nil && n > 0 {
				maxPages = n
			}
			i++
		case "--time-budget-ms": // tests
			if n, err := strconv.Atoi(args[i+1]); err == nil && n >= 0 {
				budget = time.Duration(n) * time.Millisecond
			}
			i++
		}
	}
	text, err := recognizeInput(stdin, maxPages, time.Now().Add(budget))
	if err != nil {
		var e *exitErr
		if errors.As(err, &e) {
			fmt.Fprintln(stderr, e.msg)
			return e.code
		}
		fmt.Fprintln(stderr, err.Error())
		return 1
	}
	if _, err := io.WriteString(stdout, text); err != nil {
		return 1
	}
	return 0
}

func recognizeInput(stdin io.Reader, maxPages int, deadline time.Time) (string, error) {
	data, err := io.ReadAll(io.LimitReader(stdin, maxInput+1))
	if err != nil {
		return "", failf(1, "could not read the input: %v", err)
	}
	if len(data) > maxInput {
		return "", failf(1, "the file is larger than %d MB", maxInput>>20)
	}
	k := sniff(data)
	if k == kindUnknown {
		return "", failf(2, "not a PDF or an image")
	}
	w, err := os.MkdirTemp("", "ocr-")
	if err != nil {
		return "", failf(1, "no work folder: %v", err)
	}
	defer os.RemoveAll(w)
	in := filepath.Join(w, "in")
	if err := os.WriteFile(in, data, 0o600); err != nil {
		return "", failf(1, "could not write the work file: %v", err)
	}
	data = nil
	if k == kindPDF {
		return readPDF(w, in, maxPages, deadline)
	}
	return readImage(w, in, k)
}

// tool runs one helper with a minimal environment, a time limit, and SIGKILL when this program dies (the server's
// own limit kills only us). Returns stdout; stderr goes into the error.
func tool(w string, bin string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), stepLimit)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = w
	cmd.Env = []string{"PATH=/usr/bin:/bin", "LANG=C.UTF-8", "LC_ALL=C.UTF-8", "HOME=" + w, "TMPDIR=" + w,
		"OMP_THREAD_LIMIT=1"} // one thread per tesseract: the tenant's converters share min(2, cores) (spec 3.8.3)
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		return "", fmt.Errorf("%s took longer than %v", filepath.Base(bin), stepLimit)
	}
	if err != nil {
		msg := strings.TrimSpace(errb.String())
		if len(msg) > 300 {
			msg = msg[:300]
		}
		if msg == "" {
			msg = err.Error()
		}
		return out.String(), fmt.Errorf("%s: %s", filepath.Base(bin), msg)
	}
	return out.String(), nil
}

func need(bin string) error {
	if _, err := os.Stat(bin); err != nil {
		return failf(1, "%s is not installed on the server", filepath.Base(bin))
	}
	return nil
}

func passwordProblem(err error) bool {
	return err != nil && strings.Contains(err.Error(), "Incorrect password")
}

func readPDF(w, in string, maxPages int, deadline time.Time) (string, error) {
	for _, b := range []string{pdfinfoBin, pdftotextBin, pdftoppmBin, tesseractBin} {
		if err := need(b); err != nil {
			return "", err
		}
	}
	// -f/-l make pdfinfo list every page's size (rendering needs it)
	infoOut, err := tool(w, pdfinfoBin, "-f", "1", "-l", strconv.Itoa(maxPages), in)
	if passwordProblem(err) {
		return "", failf(1, "the PDF is password-protected")
	}
	if err != nil {
		return "", failf(2, "not a PDF or an image") // like the Swift version: an unreadable PDF is not a PDF
	}
	info, err := parsePdfinfo(infoOut)
	if err != nil {
		return "", failf(2, "not a PDF or an image")
	}
	n := min(info.pages, maxPages)
	var out []string
	notRead := info.pages - n
	if n > 0 {
		txt, err := tool(w, pdftotextBin, "-enc", "UTF-8", "-layout", "-f", "1", "-l", strconv.Itoa(n), in, "-")
		if passwordProblem(err) {
			return "", failf(1, "the PDF is password-protected")
		}
		if err != nil {
			return "", failf(1, "could not read the PDF text: %v", err)
		}
		for i, layer := range splitPages(txt, n) {
			page := i + 1
			if nonSpace(layer) >= 20 {
				out = append(out, strings.TrimRight(layer, " \t\r\n"))
				continue
			}
			if time.Now().After(deadline) { // out of time: what was read so far, and how much was not
				notRead = info.pages - i
				break
			}
			size, ok := info.sizes[page]
			if !ok && n == 1 {
				size = info.sizes[0]
			}
			text, err := ocrPage(w, in, page, size)
			if err != nil {
				return "", err
			}
			out = append(out, text)
		}
	}
	if notRead > 0 {
		out = append(out, moreNotRead(notRead))
	}
	return strings.Join(out, "\n\n"), nil
}

// ocrPage renders one page on white (pdftoppm's default paper) and recognizes it.
func ocrPage(w, in string, page int, size [2]float64) (string, error) {
	png := filepath.Join(w, "p")
	_ = os.Remove(png + ".png")
	args := append(renderArgs(size, renderDPI), "-f", strconv.Itoa(page), "-l", strconv.Itoa(page), "-png", "-singlefile", in, png)
	if _, err := tool(w, pdftoppmBin, args...); err != nil {
		return "", failf(1, "could not render page %d: %v", page, err)
	}
	defer os.Remove(png + ".png")
	return recognize(w, png+".png")
}

func recognize(w, img string) (string, error) {
	// page_separator: tesseract ends its text with a form feed by default
	out, err := tool(w, tesseractBin, img, "stdout", "-l", "kor+eng", "--psm", "3", "-c", "page_separator=")
	if err != nil {
		return "", failf(1, "text recognition failed: %v", err)
	}
	return strings.TrimRight(out, " \t\r\n\f"), nil
}

// readImage recognizes a picture. A JPEG with an EXIF orientation (a phone photo taken sideways) is turned upright
// by ffmpeg first (it applies the orientation; tesseract does not). HEIC goes through libheif's heif-dec: ffmpeg 7.1
// returns only the first 512x512 tile of the tiled HEIC images phones write. Anything tesseract cannot read is tried
// once more through ffmpeg; when that fails too it is not an image we can read (exit 2, like the Swift version).
func readImage(w, in string, k kind) (string, error) {
	if err := need(tesseractBin); err != nil {
		return "", err
	}
	conv := filepath.Join(w, "c.png")
	switch {
	case k == kindHEIC:
		if err := need(heifDecBin); err != nil {
			return "", err
		}
		p, err := heifToPNG(w, in)
		if err != nil {
			return "", failf(2, "not a PDF or an image")
		}
		return recognize(w, p)
	case k == kindJPEG && orientationOf(in) != 1:
		if err := need(ffmpegBin); err != nil {
			return "", err
		}
		if _, err := tool(w, ffmpegBin, "-nostdin", "-v", "error", "-i", in, "-frames:v", "1", "-y", conv); err != nil {
			return "", failf(2, "not a PDF or an image")
		}
		return recognize(w, conv)
	}
	text, err := recognize(w, in)
	if err == nil {
		return text, nil
	}
	if need(ffmpegBin) != nil {
		return "", failf(2, "not a PDF or an image")
	}
	if _, ferr := tool(w, ffmpegBin, "-nostdin", "-v", "error", "-i", in, "-frames:v", "1", "-y", conv); ferr != nil {
		return "", failf(2, "not a PDF or an image")
	}
	return recognize(w, conv)
}

func orientationOf(p string) int {
	f, err := os.Open(p)
	if err != nil {
		return 1
	}
	defer f.Close()
	head := make([]byte, 256<<10) // EXIF sits in APP1 near the start
	n, _ := io.ReadFull(f, head)
	return exifOrientation(head[:n])
}

// heifToPNG decodes the primary image (libheif applies the rotation and mirroring the file asks for). A file with
// several top-level images is written as h-1.png, h-2.png …: the first one is taken.
func heifToPNG(w, in string) (string, error) {
	out := filepath.Join(w, "h.png")
	if _, err := tool(w, heifDecBin, "--quiet", "--codec-threads", "1", in, out); err != nil {
		return "", err
	}
	if _, err := os.Stat(out); err == nil {
		return out, nil
	}
	ms, _ := filepath.Glob(filepath.Join(w, "h-*.png"))
	sort.Strings(ms)
	if len(ms) == 0 {
		return "", fmt.Errorf("heif-dec wrote no image")
	}
	return ms[0], nil
}

//go:build linux

package main

import (
	"bytes"
	"os"
	"regexp"
	"strings"
	"testing"
)

// The real tools (poppler, tesseract kor+eng, ffmpeg, heif-dec): run with `bash tests/fixtures/ocr/make.sh test --docker`.
func ocrRun(t *testing.T, fixture string, args ...string) (string, string, int) {
	t.Helper()
	var out, errb bytes.Buffer
	code := run(args, bytes.NewReader(readFixture(t, fixture)), &out, &errb)
	return out.String(), errb.String(), code
}

var ws = regexp.MustCompile(`\s+`)

func squash(s string) string { return ws.ReplaceAllString(s, "") }

func needTools(t *testing.T) {
	for _, b := range []string{pdfinfoBin, pdftotextBin, pdftoppmBin, tesseractBin, ffmpegBin, heifDecBin} {
		if _, err := os.Stat(b); err != nil {
			t.Skip("needs " + b + " (bash tests/fixtures/ocr/make.sh test --docker)")
		}
	}
	if _, err := os.Stat("/usr/share/tesseract-ocr/5/tessdata/kor.traineddata"); err != nil {
		t.Skip("needs tesseract-ocr-kor")
	}
}

func expectPage(t *testing.T, name, got string) {
	t.Helper()
	s := squash(got)
	for _, want := range []string{"진료예약안내", "오전9시부터오후6시까지", "Invoice2026-10-21"} {
		if !strings.Contains(s, want) {
			t.Errorf("%s: %q missing in %q", name, want, got)
		}
	}
}

func TestLinuxOCR(t *testing.T) {
	needTools(t)
	for _, f := range []string{"scan.pdf", "page.png", "trans.png", "rot6.jpg", "photo.heic"} {
		out, errs, code := ocrRun(t, f)
		if code != 0 {
			t.Errorf("%s: exit %d %s", f, code, errs)
			continue
		}
		expectPage(t, f, out)
	}
}

func TestLinuxPDFTextLayerAndMixed(t *testing.T) {
	needTools(t)
	out, errs, code := ocrRun(t, "text.pdf")
	if code != 0 || !strings.Contains(out, "평일 오전 9시부터 오후 6시까지 받습니다") {
		t.Fatalf("text layer: %d %q %s", code, out, errs)
	}
	// page 1 keeps its text layer, page 2 (scanned) is recognized; pages separated by one empty line
	out, errs, code = ocrRun(t, "mixed.pdf")
	if code != 0 {
		t.Fatalf("mixed: %d %s", code, errs)
	}
	parts := strings.Split(out, "\n\n")
	if len(parts) < 2 || !strings.Contains(parts[0], "평일 오전 9시부터 오후 6시까지 받습니다") {
		t.Fatalf("mixed page 1: %q", out)
	}
	expectPage(t, "mixed page 2", strings.Join(parts[1:], "\n\n"))
	if strings.Contains(out, "\n\n\n") || strings.Contains(out, "\f") {
		t.Fatalf("page separation: %q", out)
	}
}

func TestLinuxMaxPages(t *testing.T) {
	needTools(t)
	out, _, code := ocrRun(t, "many.pdf", "--max-pages", "2")
	if code != 0 || !strings.Contains(out, "문서의 2쪽") || strings.Contains(out, "문서의 3쪽") || !strings.HasSuffix(out, "\n\n[… 1 more pages not read]") {
		t.Fatalf("%d %q", code, out)
	}
}

func TestLinuxTimeBudget(t *testing.T) {
	needTools(t)
	// page 1 has a text layer and is kept; page 2 needs recognition, which is past the budget
	out, _, code := ocrRun(t, "mixed.pdf", "--time-budget-ms", "0")
	if code != 0 || !strings.Contains(out, "평일 오전 9시부터 오후 6시까지 받습니다") || !strings.HasSuffix(out, "\n\n[… 1 more pages not read]") {
		t.Fatalf("%d %q", code, out)
	}
}

func TestLinuxFailures(t *testing.T) {
	needTools(t)
	if _, errs, code := ocrRun(t, "enc.pdf"); code != 1 || !strings.Contains(errs, "the PDF is password-protected") {
		t.Fatalf("encrypted: %d %q", code, errs)
	}
	if _, errs, code := ocrRun(t, "notes.txt"); code != 2 || !strings.Contains(errs, "not a PDF or an image") {
		t.Fatalf("text: %d %q", code, errs)
	}
	// a broken PDF and a broken image are "not a PDF or an image" too (like the Swift version)
	for _, b := range [][]byte{[]byte("%PDF-1.7\nnot really\n"), append([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'}, []byte("garbage")...),
		append([]byte{0xFF, 0xD8, 0xFF, 0xE1, 0, 0x22}, []byte("Exif\x00\x00II*\x00\x08\x00\x00\x00\x01\x00\x12\x01\x03\x00\x01\x00\x00\x00\x06\x00\x00\x00garbage")...),
		[]byte("\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic broken")} {
		var out, errb bytes.Buffer
		if code := run(nil, bytes.NewReader(b), &out, &errb); code != 2 {
			t.Errorf("%q: exit %d %s", b[:12], code, errb.String())
		}
	}
}

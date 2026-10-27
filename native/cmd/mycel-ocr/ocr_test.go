package main

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

const fixtures = "../../../tests/fixtures/ocr"

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(fixtures, name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestSniff(t *testing.T) {
	for name, want := range map[string]kind{
		"text.pdf": kindPDF, "scan.pdf": kindPDF, "enc.pdf": kindPDF, "page.png": kindImage, "trans.png": kindImage,
		"rot6.jpg": kindJPEG, "photo.heic": kindHEIC, "notes.txt": kindUnknown,
	} {
		if got := sniff(readFixture(t, name)); got != want {
			t.Errorf("%s: got %v want %v", name, got, want)
		}
	}
	for _, b := range [][]byte{nil, []byte("BM"), []byte("hello"), []byte("\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom")} {
		if sniff(b) != kindUnknown {
			t.Errorf("%q sniffed as an image", b)
		}
	}
	bmp := make([]byte, 54)
	copy(bmp, "BM")
	binary.LittleEndian.PutUint32(bmp[14:], 40)
	if sniff(bmp) != kindImage {
		t.Error("a BMP header was not recognized")
	}
	if sniff([]byte("RIFF\x00\x00\x00\x00WEBPVP8 ")) != kindImage || sniff([]byte("GIF89a....")) != kindImage {
		t.Error("WebP/GIF not recognized")
	}
}

func TestExifOrientation(t *testing.T) {
	if o := exifOrientation(readFixture(t, "rot6.jpg")); o != 6 {
		t.Fatalf("rot6.jpg orientation %d", o)
	}
	if o := exifOrientation([]byte{0xFF, 0xD8, 0xFF, 0xDA, 0, 2}); o != 1 {
		t.Fatalf("no EXIF: %d", o)
	}
	// truncated / hostile segment lengths must not panic
	for _, b := range [][]byte{{0xFF, 0xD8}, {0xFF, 0xD8, 0xFF, 0xE1, 0xFF, 0xFF}, {0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x10, 'E', 'x', 'i', 'f', 0, 0, 'I', 'I', 42, 0, 0xFF, 0xFF, 0xFF, 0x7F}} {
		_ = exifOrientation(b)
	}
}

func TestPdfinfoAndPages(t *testing.T) {
	info, err := parsePdfinfo("Title: x\nPages:           2\nPage    1 size:  595.276 x 841.89 pts (A4)\nPage    1 rot:   0\nPage    2 size:  3000 x 4000 pts\n")
	if err != nil || info.pages != 2 || info.sizes[1] != [2]float64{595.276, 841.89} || info.sizes[2] != [2]float64{3000, 4000} {
		t.Fatalf("%+v %v", info, err)
	}
	if _, err := parsePdfinfo("Syntax Error\n"); err == nil {
		t.Fatal("no page count accepted")
	}
	if a := renderArgs(info.sizes[1], 144); a[0] != "-r" || a[1] != "144" {
		t.Fatalf("A4 at 144 dpi: %v", a)
	}
	if a := renderArgs(info.sizes[2], 144); a[0] != "-scale-to" || a[1] != "4000" {
		t.Fatalf("a large page is capped at 4000 px: %v", a)
	}
	p := splitPages("one\fthree\f", 3)
	if len(p) != 3 || p[0] != "one" || p[1] != "three" || p[2] != "" {
		t.Fatalf("%q", p)
	}
	if nonSpace(" 가 나\n\tb ") != 3 {
		t.Fatal("nonSpace")
	}
	if moreNotRead(3) != "[… 3 more pages not read]" {
		t.Fatal(moreNotRead(3))
	}
}

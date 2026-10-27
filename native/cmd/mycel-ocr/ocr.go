// Helpers of the Linux mycel-ocr (main_linux.go) that need no external tool, kept free of build tags so their tests
// also run on a Mac. The macOS mycel-ocr is the Swift program native/ocr/main.swift; both keep the same contract.
package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"strconv"
	"strings"
	"unicode"
)

type kind int

const (
	kindUnknown kind = iota
	kindPDF
	kindImage
	kindHEIC
	kindJPEG
)

// heifBrands: ftyp brands of HEIF still images (iPhone photos are "heic" with "mif1" compatible).
var heifBrands = map[string]bool{"heic": true, "heix": true, "mif1": true, "msf1": true}

// sniff decides by content, never by name: the server passes the bytes of whatever file the AI or a person chose.
func sniff(b []byte) kind {
	switch {
	case bytes.HasPrefix(b, []byte("%PDF")): // like the Swift version: the header must come first
		return kindPDF
	case bytes.HasPrefix(b, []byte{0xFF, 0xD8, 0xFF}):
		return kindJPEG
	case bytes.HasPrefix(b, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'}),
		bytes.HasPrefix(b, []byte("II*\x00")), bytes.HasPrefix(b, []byte("MM\x00*")),
		bytes.HasPrefix(b, []byte("GIF87a")), bytes.HasPrefix(b, []byte("GIF89a")),
		len(b) >= 12 && bytes.Equal(b[0:4], []byte("RIFF")) && bytes.Equal(b[8:12], []byte("WEBP")):
		return kindImage
	case isBMP(b):
		return kindImage
	case isHEIF(b):
		return kindHEIC
	}
	return kindUnknown
}

// isBMP also checks the DIB header size: "BM" alone is the start of plenty of text files.
func isBMP(b []byte) bool {
	if len(b) < 18 || b[0] != 'B' || b[1] != 'M' {
		return false
	}
	switch binary.LittleEndian.Uint32(b[14:18]) {
	case 12, 40, 52, 56, 64, 108, 124:
		return true
	}
	return false
}

// isHEIF: an ISO base media file whose first box is ftyp with a HEIF still-image brand (major or compatible).
func isHEIF(b []byte) bool {
	if len(b) < 16 || !bytes.Equal(b[4:8], []byte("ftyp")) {
		return false
	}
	size := int(binary.BigEndian.Uint32(b[0:4]))
	if size < 16 || size > len(b) || size > 4096 {
		size = min(len(b), 4096)
	}
	if heifBrands[string(b[8:12])] {
		return true
	}
	for i := 16; i+4 <= size; i += 4 { // compatible brands follow major brand + minor version
		if heifBrands[string(b[i:i+4])] {
			return true
		}
	}
	return false
}

// exifOrientation returns the EXIF Orientation tag (1–8) of a JPEG, 1 when there is none or it cannot be read.
// tesseract ignores it; a phone photo taken sideways must be turned before recognition (the Swift version passes it
// to Vision).
func exifOrientation(b []byte) int {
	if len(b) < 4 || b[0] != 0xFF || b[1] != 0xD8 {
		return 1
	}
	i := 2
	for i+4 <= len(b) {
		if b[i] != 0xFF {
			return 1
		}
		marker := b[i+1]
		if marker == 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker == 0x01 || marker == 0xFF {
			i++
			continue
		}
		if marker == 0xDA || marker == 0xD9 { // image data starts: no EXIF before it
			return 1
		}
		segLen := int(binary.BigEndian.Uint16(b[i+2 : i+4]))
		if segLen < 2 || i+2+segLen > len(b) {
			return 1
		}
		seg := b[i+4 : i+2+segLen]
		if marker == 0xE1 && len(seg) > 14 && bytes.Equal(seg[:6], []byte("Exif\x00\x00")) {
			if o := tiffOrientation(seg[6:]); o >= 1 && o <= 8 {
				return o
			}
			return 1
		}
		i += 2 + segLen
	}
	return 1
}

func tiffOrientation(t []byte) int {
	if len(t) < 8 {
		return 0
	}
	var bo binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 0
	}
	off := int(bo.Uint32(t[4:8]))
	if off < 8 || off+2 > len(t) {
		return 0
	}
	n := int(bo.Uint16(t[off : off+2]))
	for k := 0; k < n && k < 512; k++ {
		e := off + 2 + 12*k
		if e+12 > len(t) {
			return 0
		}
		if bo.Uint16(t[e:e+2]) == 0x0112 && bo.Uint16(t[e+2:e+4]) == 3 { // Orientation, SHORT
			return int(bo.Uint16(t[e+8 : e+10]))
		}
	}
	return 0
}

// nonSpace counts the characters that are not white space: a page with fewer than 20 has no usable text layer and
// is recognized instead (the same rule as the Swift version and server/src/files/extract.ts looksScanned).
func nonSpace(s string) int {
	n := 0
	for _, r := range s {
		if !unicode.IsSpace(r) {
			n++
		}
	}
	return n
}

// splitPages splits pdftotext output (every page ends with a form feed) into want pages.
func splitPages(text string, want int) []string {
	pages := strings.Split(text, "\f")
	if len(pages) > 0 && strings.TrimSpace(pages[len(pages)-1]) == "" {
		pages = pages[:len(pages)-1]
	}
	for len(pages) < want {
		pages = append(pages, "")
	}
	return pages[:want]
}

// pdfInfo is what pdfinfo says about the document: the page count and the size of each listed page (points).
type pdfInfo struct {
	pages int
	sizes map[int][2]float64
}

// parsePdfinfo reads `pdfinfo -f 1 -l N` output ("Pages: 12", "Page    3 size: 595.276 x 841.89 pts (A4)").
func parsePdfinfo(out string) (pdfInfo, error) {
	info := pdfInfo{sizes: map[int][2]float64{}}
	found := false
	for _, l := range strings.Split(out, "\n") {
		f := strings.Fields(l)
		switch {
		case len(f) >= 2 && f[0] == "Pages:":
			n, err := strconv.Atoi(f[1])
			if err != nil || n < 0 {
				return info, fmt.Errorf("bad page count %q", f[1])
			}
			info.pages, found = n, true
		case len(f) >= 6 && f[0] == "Page" && f[2] == "size:" && f[4] == "x":
			i, err1 := strconv.Atoi(f[1])
			w, err2 := strconv.ParseFloat(f[3], 64)
			h, err3 := strconv.ParseFloat(f[5], 64)
			if err1 == nil && err2 == nil && err3 == nil {
				info.sizes[i] = [2]float64{w, h}
			}
		case len(f) >= 5 && f[0] == "Page" && f[1] == "size:" && f[3] == "x": // a one-page range prints no number
			w, err2 := strconv.ParseFloat(f[2], 64)
			h, err3 := strconv.ParseFloat(f[4], 64)
			if err2 == nil && err3 == nil {
				info.sizes[0] = [2]float64{w, h}
			}
		}
	}
	if !found {
		return info, fmt.Errorf("no page count")
	}
	return info, nil
}

// renderArgs are pdftoppm's size options for one page: dpi dots per inch (the Swift version draws at 2x = 144),
// capped at 4000 px on the long side. pdftoppm's -scale-to overrides -r, so it is given only for pages that would
// exceed the cap.
func renderArgs(size [2]float64, dpi int) []string {
	long := max(size[0], size[1])
	if long > 0 && long*float64(dpi)/72 > 4000 {
		return []string{"-scale-to", "4000"}
	}
	return []string{"-r", strconv.Itoa(dpi)}
}

// moreNotRead is the last paragraph when a PDF has more pages than --max-pages (same text as the Swift version).
func moreNotRead(n int) string { return fmt.Sprintf("[… %d more pages not read]", n) }

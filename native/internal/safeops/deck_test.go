package safeops

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"
)

func packageBytes(parts map[string][]byte) []byte {
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	for n, p := range parts {
		w, _ := z.Create(n)
		w.Write(p)
	}
	z.Close()
	return b.Bytes()
}
func TestDeckRejectsBombsAndActiveParts(t *testing.T) {
	for name, parts := range map[string]map[string][]byte{
		"expansion":           {"ppt/slides/slide1.xml": []byte(strings.Repeat("x", 9<<20))},
		"xml-depth":           {"ppt/presentation.xml": []byte(strings.Repeat("<x>", 65) + strings.Repeat("</x>", 65))},
		"DTD":                 {"ppt/presentation.xml": []byte("<!DOCTYPE x><x/>")},
		"traversal":           {"../outside": []byte("x")},
		"media-backslash":     {`ppt/media/..\..\escape.png`: testPNG(1, 1)},
		"media-encoded-path":  {"ppt/media/%2e%2e%2fescape.png": testPNG(1, 1)},
		"media-stream":        {"ppt/media/image:stream.png": testPNG(1, 1)},
		"media-control":       {"ppt/media/image\x01.png": testPNG(1, 1)},
		"active":              {"ppt/vbaProject.bin": []byte("x")},
		"embedded-image-bomb": {"ppt/media/image1.png": testPNG(8000, 4001)},
	} {
		t.Run(name, func(t *testing.T) {
			valid := validDeckParts()
			if _, err := Deck(packageBytes(valid)); err != nil {
				t.Fatal("invalid positive control", err)
			}
			for k, v := range parts {
				valid[k] = v
			}
			if _, e := Deck(packageBytes(valid)); e == nil {
				t.Fatal("accepted")
			}
		})
	}
}

func validDeckParts() map[string][]byte {
	return map[string][]byte{
		"[Content_Types].xml":               []byte("<Types/>"),
		"ppt/presentation.xml":              []byte(`<p:presentation xmlns:p="p" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="r1"/></p:sldIdLst></p:presentation>`),
		"ppt/_rels/presentation.xml.rels":   []byte(`<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`),
		"ppt/slides/slide1.xml":             []byte("<sld/>"),
		"ppt/slides/_rels/slide1.xml.rels":  []byte(`<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`),
		"ppt/slideLayouts/slideLayout1.xml": []byte(`<sldLayout><cSld name="Title and Content"/></sldLayout>`),
	}
}

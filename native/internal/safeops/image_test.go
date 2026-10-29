package safeops

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"
)

func testPNG(w, h int) []byte {
	im := image.NewRGBA(image.Rect(0, 0, w, h))
	im.Set(0, 0, color.RGBA{255, 0, 0, 255})
	var b bytes.Buffer
	_ = png.Encode(&b, im)
	return b.Bytes()
}
func TestImageLimits(t *testing.T) {
	b := testPNG(10, 10)
	cases := []struct {
		name, format string
		b            []byte
	}{
		{"corrupt", "png", []byte("bad")}, {"mismatch", "jpeg", b}, {"truncated", "png", b[:len(b)/2]},
		{"bytes", "png", make([]byte, InputMax+1)},
	}
	bomb := append([]byte{}, b...)
	binary.BigEndian.PutUint32(bomb[16:], 100000)
	binary.BigEndian.PutUint32(bomb[20:], 100000)
	binary.BigEndian.PutUint32(bomb[29:], crc32.ChecksumIEEE(bomb[12:29]))
	cases = append(cases, struct {
		name, format string
		b            []byte
	}{"pixel bomb", "png", bomb})
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, e := Image(c.b, c.format); e == nil {
				t.Fatal("accepted")
			}
		})
	}
}
func TestResizeAndMetadata(t *testing.T) {
	b := testPNG(4000, 1)
	out, e := Image(b, "png")
	if e != nil {
		t.Fatal(e)
	}
	c, e := jpeg.DecodeConfig(bytes.NewReader(out))
	if e != nil || c.Width != 1536 || c.Height != 1 {
		t.Fatalf("%+v %v", c, e)
	}
	var j bytes.Buffer
	_ = jpeg.Encode(&j, image.NewRGBA(image.Rect(0, 0, 8, 8)), nil)
	// Synthetic EXIF/GPS APP1 marker: it must never be copied to the delivered image.
	meta := []byte("Exif\x00\x00synthetic GPS latitude")
	segment := []byte{0xff, 0xe1, 0, byte(len(meta) + 2)}
	input := append(append(append([]byte{}, j.Bytes()[:2]...), segment...), meta...)
	input = append(input, j.Bytes()[2:]...)
	clean, e := Image(input, "jpeg")
	if e != nil {
		t.Fatal(e)
	}
	if bytes.Contains(clean, []byte("Exif")) || bytes.Contains(clean, []byte("GPS")) {
		t.Fatal("metadata escaped")
	}
}

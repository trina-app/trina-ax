package safeops

import (
	"bytes"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/image/bmp"
	"golang.org/x/image/tiff"
)

func encodePNG(t *testing.T, im image.Image) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&b, im); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func visionConfig(t *testing.T, out []byte) image.Config {
	t.Helper()
	if len(out) < 3 || out[0] != 0xff || out[1] != 0xd8 || out[2] != 0xff {
		t.Fatal("not a JPEG")
	}
	if len(out) > VisionOutputMax {
		t.Fatalf("%d bytes", len(out))
	}
	c, err := jpeg.DecodeConfig(bytes.NewReader(out))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestVisionFormatsAndSize(t *testing.T) {
	small := image.NewRGBA(image.Rect(0, 0, 40, 30))
	for y := 0; y < 30; y++ {
		for x := 0; x < 40; x++ {
			small.Set(x, y, color.RGBA{uint8(x * 6), uint8(y * 8), 90, 255})
		}
	}
	var gifB, bmpB, tiffB, jpegB bytes.Buffer
	pal := image.NewPaletted(small.Bounds(), []color.Color{color.Black, color.White})
	if err := gif.EncodeAll(&gifB, &gif.GIF{Image: []*image.Paletted{pal, pal}, Delay: []int{1, 1}}); err != nil {
		t.Fatal(err)
	}
	if err := bmp.Encode(&bmpB, small); err != nil {
		t.Fatal(err)
	}
	if err := tiff.Encode(&tiffB, small, &tiff.Options{Compression: tiff.Deflate}); err != nil {
		t.Fatal(err)
	}
	if err := jpeg.Encode(&jpegB, small, nil); err != nil {
		t.Fatal(err)
	}
	for name, b := range map[string][]byte{"png": encodePNG(t, small), "gif (animated: first frame)": gifB.Bytes(), "bmp": bmpB.Bytes(), "tiff": tiffB.Bytes(), "jpeg": jpegB.Bytes()} {
		t.Run(name, func(t *testing.T) {
			out, err := Vision(b)
			if err != nil {
				t.Fatal(err)
			}
			if c := visionConfig(t, out); c.Width != 40 || c.Height != 30 {
				t.Fatalf("small images keep their size: %+v", c)
			}
		})
	}
	// the longest side is capped, the aspect kept (both orientations)
	for _, size := range [][4]int{{4000, 1000, VisionSideMax, 392}, {1000, 4000, 392, VisionSideMax}} {
		out, err := Vision(encodePNG(t, image.NewGray(image.Rect(0, 0, size[0], size[1]))))
		if err != nil {
			t.Fatal(err)
		}
		if c := visionConfig(t, out); c.Width != size[2] || c.Height != size[3] {
			t.Fatalf("%v -> %+v", size, c)
		}
	}
}

func TestVisionTransparencyOnWhite(t *testing.T) {
	// black text only in the alpha channel would be invisible on black
	im := image.NewNRGBA(image.Rect(0, 0, 20, 20))
	im.Set(5, 5, color.NRGBA{0, 0, 0, 255})
	out, err := Vision(encodePNG(t, im))
	if err != nil {
		t.Fatal(err)
	}
	dec, err := jpeg.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatal(err)
	}
	if r, g, b, _ := dec.At(15, 15).RGBA(); r>>8 < 240 || g>>8 < 240 || b>>8 < 240 {
		t.Fatalf("transparent area is not white: %d %d %d", r>>8, g>>8, b>>8)
	}
}

// jpegWith puts extra marker segments right after SOI (EXIF/GPS, XMP, ICC, a comment).
func jpegWith(t *testing.T, im image.Image, segments ...[]byte) []byte {
	t.Helper()
	var j bytes.Buffer
	if err := jpeg.Encode(&j, im, nil); err != nil {
		t.Fatal(err)
	}
	out := append([]byte{}, j.Bytes()[:2]...)
	for _, s := range segments {
		out = append(out, s...)
	}
	return append(out, j.Bytes()[2:]...)
}

func segment(marker byte, payload []byte) []byte {
	s := []byte{0xff, marker, 0, 0}
	binary.BigEndian.PutUint16(s[2:], uint16(len(payload)+2))
	return append(s, payload...)
}

// exifOrientation is a minimal big-endian TIFF block with one entry: Orientation (0x112) = o, and a GPS-looking tail.
func exifOrientation(o uint16) []byte {
	t := []byte("MM\x00\x2a\x00\x00\x00\x08\x00\x01\x01\x12\x00\x03\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00")
	binary.BigEndian.PutUint16(t[18:], o)
	return append(append([]byte("Exif\x00\x00"), t...), []byte("GPSLatitude 37.5665 N synthetic")...)
}

func TestVisionStripsMetadata(t *testing.T) {
	im := image.NewRGBA(image.Rect(0, 0, 16, 8))
	input := jpegWith(t, im,
		segment(0xe1, exifOrientation(1)),
		segment(0xe1, []byte("http://ns.adobe.com/xap/1.0/\x00<x:xmpmeta>synthetic-xmp-owner</x:xmpmeta>")),
		segment(0xe2, append([]byte("ICC_PROFILE\x00\x01\x01"), bytes.Repeat([]byte{7}, 64)...)),
		segment(0xfe, []byte("synthetic comment with a phone serial")),
	)
	out, err := Vision(input)
	if err != nil {
		t.Fatal(err)
	}
	for _, leak := range []string{"Exif", "GPS", "xmpmeta", "synthetic", "ICC_PROFILE", "serial"} {
		if bytes.Contains(out, []byte(leak)) {
			t.Fatalf("metadata %q reached the output", leak)
		}
	}
	// only SOI, APP0 JFIF (none from Go), DQT, SOF, DHT, SOS ... : no APPn above APP0 and no COM marker
	for p := 2; p+4 <= len(out); {
		m := out[p+1]
		if m == 0xda {
			break
		}
		if (m >= 0xe1 && m <= 0xef) || m == 0xfe {
			t.Fatalf("marker %#x in the output", m)
		}
		p += 2 + int(binary.BigEndian.Uint16(out[p+2:]))
	}
}

func TestVisionAppliesOrientation(t *testing.T) {
	im := image.NewRGBA(image.Rect(0, 0, 40, 20)) // stored landscape; EXIF 6 shows it portrait
	out, err := Vision(jpegWith(t, im, segment(0xe1, exifOrientation(6))))
	if err != nil {
		t.Fatal(err)
	}
	if c := visionConfig(t, out); c.Width != 20 || c.Height != 40 {
		t.Fatalf("orientation not applied: %+v", c)
	}
	// the committed sideways phone photo fixture: 284x1417 stored, EXIF 6, shown 1417x284
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "tests", "fixtures", "ocr", "rot6.jpg"))
	if err != nil {
		t.Skip(err)
	}
	out, err = Vision(b)
	if err != nil {
		t.Fatal(err)
	}
	if c := visionConfig(t, out); c.Width != 1417 || c.Height != 284 {
		t.Fatalf("fixture: %+v", c)
	}
}

func TestVisionRefusals(t *testing.T) {
	ok := encodePNG(t, image.NewRGBA(image.Rect(0, 0, 10, 10)))
	bomb := append([]byte{}, ok...)
	binary.BigEndian.PutUint32(bomb[16:], 100000)
	binary.BigEndian.PutUint32(bomb[20:], 100000)
	binary.BigEndian.PutUint32(bomb[29:], crc32.ChecksumIEEE(bomb[12:29]))
	cases := []struct {
		name string
		b    []byte
		want error
	}{
		{"text that starts like a BMP", []byte("BM 정비 기록\n"), ErrVisionFormat},
		{"text", []byte("hello, this is plain text"), ErrVisionFormat},
		{"truncated", ok[:len(ok)/2], ErrVisionCorrupt},
		{"declared 100000x100000 (pixel bomb)", bomb, ErrVisionPixels},
		{"over the byte limit", make([]byte, VisionInputMax+1), ErrVisionBytes},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := Vision(c.b)
			if !errors.Is(err, c.want) {
				t.Fatalf("got %v, want %v", err, c.want)
			}
		})
	}
}

// A real decompression bomb: tiny on disk, tens of millions of pixels. Within the pixel limit it is decoded and
// scaled in bounded time; above it nothing is decoded.
func TestVisionDecompressionBomb(t *testing.T) {
	if testing.Short() {
		t.Skip("large images")
	}
	inside := encodePNG(t, image.NewGray(image.Rect(0, 0, 7000, 7000)))
	if len(inside) > 1<<20 {
		t.Fatalf("bomb fixture is %d bytes", len(inside))
	}
	start := time.Now()
	out, err := Vision(inside)
	if err != nil {
		t.Fatal(err)
	}
	if c := visionConfig(t, out); c.Width != VisionSideMax || c.Height != VisionSideMax {
		t.Fatalf("%+v", c)
	}
	if d := time.Since(start); d > 15*time.Second {
		t.Fatalf("took %v", d)
	}
	outside := encodePNG(t, image.NewGray(image.Rect(0, 0, 8000, 7000)))
	start = time.Now()
	if _, err := Vision(outside); !errors.Is(err, ErrVisionPixels) {
		t.Fatalf("56 MP accepted: %v", err)
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("refusal decoded pixels: %v", d)
	}
}

func TestVisionOutputLimit(t *testing.T) {
	// noise is the worst case for JPEG: the quality steps down, and the result is never over the limit
	im := image.NewRGBA(image.Rect(0, 0, VisionSideMax, VisionSideMax))
	r := rand.New(rand.NewSource(1))
	r.Read(im.Pix)
	for i := 3; i < len(im.Pix); i += 4 {
		im.Pix[i] = 255
	}
	out, err := Vision(encodePNG(t, im))
	if err != nil {
		if !errors.Is(err, ErrVisionOutput) {
			t.Fatal(err)
		}
		return
	}
	visionConfig(t, out)
}

// riffWebP builds a WebP container from raw chunks (id, payload), padded to even lengths.
func riffWebP(chunks ...[2][]byte) []byte {
	body := []byte("WEBP")
	for _, c := range chunks {
		h := append([]byte{}, c[0]...)
		h = binary.LittleEndian.AppendUint32(h, uint32(len(c[1])))
		body = append(append(body, h...), c[1]...)
		if len(c[1])%2 == 1 {
			body = append(body, 0)
		}
	}
	return append(binary.LittleEndian.AppendUint32([]byte("RIFF"), uint32(len(body))), body...)
}

// Review of feat/vision-read: image.DecodeConfig reports a VP8X canvas, but x/image/webp decodes the lossless frame at
// its own declared size before comparing; a 2 KB file could make the normalizer decode 268 MP. The frame is checked
// first.
func TestVisionWebPFrameLargerThanCanvas(t *testing.T) {
	canvas := []byte{0, 0, 0, 0, 99, 0, 0, 99, 0, 0} // 100x100
	frame := func(w, h uint32) []byte {
		return append(binary.LittleEndian.AppendUint32([]byte{0x2f}, (w-1)|(h-1)<<14), bytes.Repeat([]byte{0x55}, 64)...)
	}
	b := riffWebP([2][]byte{[]byte("VP8X"), canvas}, [2][]byte{[]byte("EXIF"), []byte("odd")}, [2][]byte{[]byte("VP8L"), frame(16384, 16384)})
	if c, f, err := image.DecodeConfig(bytes.NewReader(b)); err != nil || f != "webp" || c.Width != 100 {
		t.Fatalf("fixture: %v %v %+v", f, err, c)
	}
	if w, h, ok := webpLosslessSize(b); !ok || w != 16384 || h != 16384 {
		t.Fatalf("frame size %d %d %v", w, h, ok)
	}
	if _, err := Vision(b); !errors.Is(err, ErrVisionPixels) {
		t.Fatalf("got %v, want the pixel limit before decoding", err)
	}
	// a frame within the limits goes on to the decoder (this one is not a valid bitstream)
	small := riffWebP([2][]byte{[]byte("VP8X"), canvas}, [2][]byte{[]byte("VP8L"), frame(100, 100)})
	if _, err := Vision(small); !errors.Is(err, ErrVisionCorrupt) {
		t.Fatalf("got %v", err)
	}
}

// A strip a few pixels wide and tens of thousands tall: the scaler's work buffers grow with the input height, so the
// longest input side is capped (a 1x50,000,000 PNG of 97 KB took 2.5 GB before).
func TestVisionLongSideCap(t *testing.T) {
	if _, err := Vision(encodePNG(t, image.NewGray(image.Rect(0, 0, 2, VisionSideInMax+1)))); !errors.Is(err, ErrVisionPixels) {
		t.Fatalf("got %v", err)
	}
	out, err := Vision(encodePNG(t, image.NewGray(image.Rect(0, 0, 2, VisionSideInMax))))
	if err != nil {
		t.Fatal(err)
	}
	if c := visionConfig(t, out); c.Width != 1 || c.Height != VisionSideMax {
		t.Fatalf("%+v", c)
	}
}

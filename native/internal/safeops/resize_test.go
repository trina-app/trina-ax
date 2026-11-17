package safeops

import (
	"bytes"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// a photo-like picture: smooth colours plus noise, so JPEG sizes behave like a camera's
func photo(w, h int, seed int64) *image.RGBA {
	r := rand.New(rand.NewSource(seed))
	im := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			n := uint8(r.Intn(40))
			im.Set(x, y, color.RGBA{uint8(x*255/w) ^ n, uint8(y*255/h) ^ n, 120 + n, 255})
		}
	}
	return im
}

func encJPEG(t *testing.T, im image.Image, q int) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := jpeg.Encode(&b, im, &jpeg.Options{Quality: q}); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// withExif puts an APP1 Exif segment right after SOI: IFD0 with Orientation (0x0112) and a GPS IFD pointer
// (0x8825) to a GPS IFD holding GPSLatitudeRef "N" and a recognisable maker string.
func withExif(jpg []byte, orient int) []byte {
	le := binary.LittleEndian
	t := []byte("II\x2a\x00\x08\x00\x00\x00")
	ifd0 := make([]byte, 2+2*12+4)
	le.PutUint16(ifd0, 2)
	e := ifd0[2:]
	le.PutUint16(e, 0x0112)
	le.PutUint16(e[2:], 3)
	le.PutUint32(e[4:], 1)
	le.PutUint16(e[8:], uint16(orient))
	e = ifd0[14:]
	le.PutUint16(e, 0x8825)
	le.PutUint16(e[2:], 4)
	le.PutUint32(e[4:], 1)
	le.PutUint32(e[8:], uint32(8+len(ifd0)))
	gps := make([]byte, 2+12+4)
	le.PutUint16(gps, 1)
	le.PutUint16(gps[2:], 1) // GPSLatitudeRef
	le.PutUint16(gps[4:], 2)
	le.PutUint32(gps[6:], 2)
	copy(gps[10:], "N\x00")
	t = append(append(append(t, ifd0...), gps...), []byte("GPS-SECRET-PLACE")...)
	seg := append([]byte("Exif\x00\x00"), t...)
	app1 := []byte{0xff, 0xe1, 0, 0}
	binary.BigEndian.PutUint16(app1[2:], uint16(len(seg)+2))
	out := append([]byte{0xff, 0xd8}, app1...)
	out = append(out, seg...)
	return append(out, jpg[2:]...)
}

func config(t *testing.T, b []byte) (image.Config, string) {
	t.Helper()
	c, f, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	return c, f
}

func TestResizeLongestSideAndWidth(t *testing.T) {
	land := encJPEG(t, photo(400, 300, 1), 90)
	out, err := Resize(land, ResizeSpec{Side: 200})
	if err != nil {
		t.Fatal(err)
	}
	if c, f := config(t, out); f != "jpeg" || c.Width != 200 || c.Height != 150 {
		t.Fatalf("longest side 200: %s %dx%d", f, c.Width, c.Height)
	}
	// width on a portrait picture: the width is capped, not the longest side
	port := encJPEG(t, photo(300, 400, 2), 90)
	out, err = Resize(port, ResizeSpec{Width: 150})
	if err != nil {
		t.Fatal(err)
	}
	if c, _ := config(t, out); c.Width != 150 || c.Height != 200 {
		t.Fatalf("width 150: %dx%d", c.Width, c.Height)
	}
	// half
	out, err = Resize(land, ResizeSpec{Permille: 500})
	if err != nil {
		t.Fatal(err)
	}
	if c, _ := config(t, out); c.Width != 200 || c.Height != 150 {
		t.Fatalf("half: %dx%d", c.Width, c.Height)
	}
	// a strong reduction (halving steps, then the final scale)
	big := encJPEG(t, photo(3000, 2000, 3), 85)
	out, err = Resize(big, ResizeSpec{Side: 600})
	if err != nil {
		t.Fatal(err)
	}
	if c, _ := config(t, out); c.Width != 600 || c.Height != 400 {
		t.Fatalf("3000x2000 to 600: %dx%d", c.Width, c.Height)
	}
}

func TestResizeNeverUpscales(t *testing.T) {
	b := encJPEG(t, photo(400, 300, 4), 90)
	if _, err := Resize(b, ResizeSpec{Side: 1000}); !errors.Is(err, ErrResizeUnchanged) {
		t.Fatalf("a larger target leaves the picture as it is: %v", err)
	}
	if _, err := Resize(b, ResizeSpec{Width: 400}); !errors.Is(err, ErrResizeUnchanged) {
		t.Fatalf("the same width: %v", err)
	}
	// already under the target size, no size given
	if _, err := Resize(b, ResizeSpec{MaxBytes: len(b) + 1}); !errors.Is(err, ErrResizeUnchanged) {
		t.Fatalf("already small enough: %v", err)
	}
	// a target size with a larger side: only the bytes count
	out, err := Resize(b, ResizeSpec{Side: 5000, MaxBytes: len(b) / 3})
	if err != nil {
		t.Fatal(err)
	}
	if len(out) > len(b)/3 {
		t.Fatalf("%d bytes over %d", len(out), len(b)/3)
	}
	if c, _ := config(t, out); c.Width > 400 || c.Height > 300 {
		t.Fatalf("grew: %dx%d", c.Width, c.Height)
	}
}

func TestResizeTargetBytes(t *testing.T) {
	b := encJPEG(t, photo(1600, 1200, 5), 95)
	for _, max := range []int{400_000, 120_000, 40_000} {
		out, err := Resize(b, ResizeSpec{MaxBytes: max})
		if err != nil {
			t.Fatalf("%d: %v", max, err)
		}
		if len(out) > max {
			t.Fatalf("%d bytes over %d", len(out), max)
		}
		c, _ := config(t, out)
		if c.Width*3 != c.Height*4 && abs(c.Width*3-c.Height*4) > 4 {
			t.Fatalf("aspect lost: %dx%d", c.Width, c.Height)
		}
	}
	// a PNG keeps PNG and still reaches the size by getting smaller
	p := encodePNG(t, photo(800, 600, 6))
	out, err := Resize(p, ResizeSpec{MaxBytes: len(p) / 4})
	if err != nil {
		t.Fatal(err)
	}
	if c, f := config(t, out); f != "png" || len(out) > len(p)/4 || c.Width >= 800 {
		t.Fatalf("png target: %s %d bytes %dx%d", f, len(out), c.Width, c.Height)
	}
	// impossible: refused with the fixed reason, never a bigger file
	// (pure noise as a PNG: 160 px wide is still far over 10 KB)
	noise := image.NewRGBA(image.Rect(0, 0, 1600, 1200))
	rand.New(rand.NewSource(9)).Read(noise.Pix)
	for i := 3; i < len(noise.Pix); i += 4 {
		noise.Pix[i] = 255
	}
	if _, err := Resize(encodePNG(t, noise), ResizeSpec{MaxBytes: ResizeMaxBytesMin}); !errors.Is(err, ErrResizeTarget) {
		t.Fatalf("10 KB of noise: %v", err)
	}
	if _, err := Resize(b, ResizeSpec{MaxBytes: 200}); !errors.Is(err, ErrResizeSpec) {
		t.Fatalf("under the smallest target: %v", err)
	}
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

func TestResizeOrientationAndMetadata(t *testing.T) {
	// stored landscape 400x200 with orientation 6 (a phone's portrait photo): shown 200x400
	src := photo(400, 200, 7)
	for x := 0; x < 40; x++ { // a red block at the stored top-left; orientation 6 shows it at the top-right
		for y := 0; y < 40; y++ {
			src.Set(x, y, color.RGBA{255, 0, 0, 255})
		}
	}
	b := withExif(encJPEG(t, src, 92), 6)
	if !bytes.Contains(b, []byte("GPS-SECRET-PLACE")) || orientation(b) != 6 {
		t.Fatal("fixture")
	}
	out, err := Resize(b, ResizeSpec{Side: 200})
	if err != nil {
		t.Fatal(err)
	}
	c, _ := config(t, out)
	if c.Width != 100 || c.Height != 200 {
		t.Fatalf("upright: %dx%d", c.Width, c.Height)
	}
	if bytes.Contains(out, []byte("Exif")) || bytes.Contains(out, []byte("GPS-SECRET-PLACE")) || orientation(out) != 1 {
		t.Fatal("photo details reached the copy")
	}
	im, err := jpeg.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatal(err)
	}
	r, g, _, _ := im.At(95, 4).RGBA()
	if r>>8 < 180 || g>>8 > 90 {
		t.Fatalf("the red corner is not at the shown top-right: %d %d", r>>8, g>>8)
	}
}

func TestResizeTransparencyAndWebp(t *testing.T) {
	im := image.NewNRGBA(image.Rect(0, 0, 200, 100))
	for y := 0; y < 100; y++ {
		for x := 0; x < 200; x++ {
			a := uint8(255)
			if x < 100 {
				a = 0
			}
			im.Set(x, y, color.NRGBA{200, 30, 30, a})
		}
	}
	var pb bytes.Buffer
	if err := png.Encode(&pb, im); err != nil {
		t.Fatal(err)
	}
	out, err := Resize(pb.Bytes(), ResizeSpec{Side: 100})
	if err != nil {
		t.Fatal(err)
	}
	dec, f, err := image.Decode(bytes.NewReader(out))
	if err != nil || f != "png" {
		t.Fatalf("png stays png: %s %v", f, err)
	}
	if _, _, _, a := dec.At(10, 10).RGBA(); a != 0 {
		t.Fatal("see-through pixels kept")
	}
	if _, _, _, a := dec.At(90, 10).RGBA(); a>>8 != 255 {
		t.Fatal("solid pixels kept")
	}
	// a WebP from the repository's docs comes out as a JPEG (no WebP encoder) at the asked size
	w, err := os.ReadFile(filepath.Join("..", "..", "..", "docs", "site", "images", "admin", "home.webp"))
	if err != nil {
		t.Skip("no WebP sample")
	}
	wc, _ := config(t, w)
	out, err = Resize(w, ResizeSpec{Permille: 500})
	if err != nil {
		t.Fatal(err)
	}
	if c, f := config(t, out); (f != "jpeg" && f != "png") || c.Width != max(1, wc.Width*500/1000) {
		t.Fatalf("webp: %s %dx%d from %dx%d", f, c.Width, c.Height, wc.Width, wc.Height)
	}
}

func TestResizeRefusals(t *testing.T) {
	// a declared size over the pixel limit is refused before any pixel is decoded (a decompression bomb: a few KB)
	ihdr := func(w, h uint32) []byte {
		var b bytes.Buffer
		b.Write([]byte("\x89PNG\r\n\x1a\n"))
		d := make([]byte, 13)
		binary.BigEndian.PutUint32(d, w)
		binary.BigEndian.PutUint32(d[4:], h)
		d[8], d[9] = 8, 2
		writeChunk(&b, "IHDR", d)
		writeChunk(&b, "IDAT", []byte{0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01})
		writeChunk(&b, "IEND", nil)
		return b.Bytes()
	}
	for _, s := range [][2]uint32{{20000, 20000}, {1, 60_000_000}, {70000, 2}} {
		if _, err := Resize(ihdr(s[0], s[1]), ResizeSpec{Side: 100}); !errors.Is(err, ErrResizePixels) {
			t.Fatalf("%v: %v", s, err)
		}
	}
	if _, err := Resize([]byte("GIF89a\x01\x00\x01\x00\x00\x00\x00;"), ResizeSpec{Side: 10}); !errors.Is(err, ErrResizeFormat) {
		t.Fatalf("gif: %v", err)
	}
	if _, err := Resize([]byte("not an image at all"), ResizeSpec{Side: 10}); !errors.Is(err, ErrResizeFormat) {
		t.Fatalf("text: %v", err)
	}
	b := encJPEG(t, photo(64, 64, 8), 90)
	if _, err := Resize(b[:len(b)/2], ResizeSpec{Side: 10}); !errors.Is(err, ErrResizeCorrupt) {
		t.Fatalf("cut jpeg: %v", err)
	}
	// an animated PNG (acTL before IDAT)
	var ap bytes.Buffer
	ap.Write([]byte("\x89PNG\r\n\x1a\n"))
	d := make([]byte, 13)
	binary.BigEndian.PutUint32(d, 4)
	binary.BigEndian.PutUint32(d[4:], 4)
	d[8], d[9] = 8, 2
	writeChunk(&ap, "IHDR", d)
	writeChunk(&ap, "acTL", make([]byte, 8))
	writeChunk(&ap, "IEND", nil)
	if _, err := Resize(ap.Bytes(), ResizeSpec{Side: 2}); !errors.Is(err, ErrResizeAnimated) {
		t.Fatalf("apng: %v", err)
	}
	// no control at all, or a nonsense one
	for _, s := range []ResizeSpec{{}, {Side: -1}, {Permille: 1000}, {MaxBytes: -5}} {
		if _, err := Resize(b, s); !errors.Is(err, ErrResizeSpec) {
			t.Fatalf("%+v: %v", s, err)
		}
	}
}

func writeChunk(b *bytes.Buffer, name string, data []byte) {
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], uint32(len(data)))
	b.Write(n[:])
	td := append([]byte(name), data...)
	b.Write(td)
	binary.BigEndian.PutUint32(n[:], crc32.ChecksumIEEE(td))
	b.Write(n[:])
}

// a 49 MP grey PNG is a few hundred KB: decoded within the time and the memory the server gives the helper, and a
// 56 MP one is refused before decoding
func TestResizeDecompressionBomb(t *testing.T) {
	if testing.Short() {
		t.Skip("large images")
	}
	inside := encodePNG(t, image.NewGray(image.Rect(0, 0, 7000, 7000)))
	start := time.Now()
	out, err := Resize(inside, ResizeSpec{Permille: 900})
	if err != nil {
		t.Fatal(err)
	}
	if c, _ := config(t, out); c.Width != 6300 || c.Height != 6300 {
		t.Fatalf("%+v", c)
	}
	if d := time.Since(start); d > 30*time.Second {
		t.Fatalf("took %v", d)
	}
	start = time.Now()
	if _, err := Resize(encodePNG(t, image.NewGray(image.Rect(0, 0, 8000, 7000))), ResizeSpec{Side: 100}); !errors.Is(err, ErrResizePixels) {
		t.Fatalf("56 MP accepted: %v", err)
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("refusal decoded pixels: %v", d)
	}
	// a WebP whose lossless frame declares more than its canvas (feat/vision-read review)
	canvas := []byte{0, 0, 0, 0, 99, 0, 0, 99, 0, 0}
	frame := append(binary.LittleEndian.AppendUint32([]byte{0x2f}, (16384-1)|(16384-1)<<14), bytes.Repeat([]byte{0x55}, 64)...)
	if _, err := Resize(riffWebP([2][]byte{[]byte("VP8X"), canvas}, [2][]byte{[]byte("VP8L"), frame}), ResizeSpec{Side: 10}); !errors.Is(err, ErrResizePixels) {
		t.Fatalf("webp frame: %v", err)
	}
}

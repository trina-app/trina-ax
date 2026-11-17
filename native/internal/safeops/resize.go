package safeops

// Resize: smaller copies of photos the person asked for (server/src/tools/resize-images.ts, resize_images). It runs in
// the converter isolation like vision (bwrap + converter cgroup on Linux, sandbox-exec on macOS), reads the untrusted
// bytes from stdin and writes one new image built from decoded pixels only: no EXIF, GPS, XMP, ICC profile, comment
// or any other input metadata reaches the copy. The declared size is checked before any pixel is decoded, as in
// Vision. JPEG stays JPEG, PNG stays PNG; a WebP becomes a JPEG, or a PNG when it has see-through pixels (x/image has
// no WebP encoder). The EXIF orientation of a JPEG is applied, so the copy shows upright without it. Never larger
// than the original in pixels. Refusals are fixed reason lines, never text derived from the input.

import (
	"bytes"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"math"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const (
	// ResizeInputMax is the largest compressed input (a 48 MP phone JPEG is about 20 MiB).
	ResizeInputMax = 32 << 20
	// ResizeOutputMax is the largest copy written (a 48 MP PNG can be larger: it is refused).
	ResizeOutputMax = 48 << 20
	// ResizeMaxBytesMin is the smallest target size accepted (smaller is not a photo any more).
	ResizeMaxBytesMin = 10 << 10
	// resizeKernelBudget is the most (output width x input height) pixels the Catmull-Rom scaler may hold as
	// float64 RGBA (32 bytes each, x/image/draw's temporary image): 12 M pixels is 384 MiB. A larger mild reduction
	// uses bilinear sampling, which keeps no temporary image.
	resizeKernelBudget = 12_000_000
	// resizeMinSide: a size target never makes the longest side smaller than this; past it the target is refused.
	resizeMinSide = 160
)

// ResizeSpec is what the person asked for. At least one of the four is set; Side and Width cap the picture as shown
// (after its orientation), Permille scales both sides (500 is half), MaxBytes is the most bytes the copy may have.
type ResizeSpec struct {
	Side, Width, Permille, MaxBytes int
}

var (
	ErrResizeFormat    = errors.New("resize: unsupported format")
	ErrResizeCorrupt   = errors.New("resize: corrupt image")
	ErrResizePixels    = errors.New("resize: pixel limit")
	ErrResizeBytes     = errors.New("resize: byte limit")
	ErrResizeAnimated  = errors.New("resize: animated")
	ErrResizeTarget    = errors.New("resize: size target")
	ErrResizeUnchanged = errors.New("resize: unchanged")
	ErrResizeOutput    = errors.New("resize: output limit")
	ErrResizeSpec      = errors.New("resize: bad request")
)

var resizeFormats = map[string]bool{"png": true, "jpeg": true, "webp": true}
var resizeQualities = []int{85, 78, 70, 62, 55}

func (s ResizeSpec) valid() bool {
	if s.Side < 0 || s.Width < 0 || s.Permille < 0 || s.MaxBytes < 0 || s.Side > VisionSideInMax || s.Width > VisionSideInMax {
		return false
	}
	if s.Permille != 0 && (s.Permille < 10 || s.Permille >= 1000) {
		return false
	}
	if s.MaxBytes != 0 && s.MaxBytes < ResizeMaxBytesMin {
		return false
	}
	return s.Side != 0 || s.Width != 0 || s.Permille != 0 || s.MaxBytes != 0
}

// Resize decodes one JPEG, PNG or WebP (format from the content, not the file name) and returns the smaller copy.
func Resize(b []byte, s ResizeSpec) ([]byte, error) {
	if !s.valid() {
		return nil, ErrResizeSpec
	}
	if len(b) > ResizeInputMax {
		return nil, ErrResizeBytes
	}
	c, format, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		if errors.Is(err, image.ErrFormat) {
			return nil, ErrResizeFormat
		}
		return nil, ErrResizeCorrupt
	}
	if !resizeFormats[format] {
		return nil, ErrResizeFormat
	}
	if !visionSize(c.Width, c.Height) {
		return nil, ErrResizePixels
	}
	if format == "webp" {
		if w, h, ok := webpLosslessSize(b); ok && !visionSize(w, h) {
			return nil, ErrResizePixels
		}
		if webpAnimated(b) {
			return nil, ErrResizeAnimated
		}
	}
	if format == "png" && pngAnimated(b) {
		return nil, ErrResizeAnimated
	}
	im, _, err := image.Decode(bytes.NewReader(b))
	if err != nil {
		return nil, ErrResizeCorrupt
	}
	sw, sh := im.Bounds().Dx(), im.Bounds().Dy()
	if !visionSize(sw, sh) {
		return nil, ErrResizePixels
	}
	o := 1
	if format == "jpeg" {
		o = orientation(b)
	}
	// the size as shown: orientations 5-8 turn the picture a quarter
	vw, vh := sw, sh
	if o >= 5 {
		vw, vh = sh, sw
	}
	tw, th := resizeTarget(vw, vh, s)
	if tw == vw && th == vh && (s.MaxBytes == 0 || len(b) <= s.MaxBytes) {
		return nil, ErrResizeUnchanged
	}
	// premultiplied RGBA once (draw's fast paths for YCbCr, Gray, NRGBA ...): halving and scaling average it
	src := image.NewRGBA(image.Rect(0, 0, sw, sh))
	draw.Draw(src, src.Bounds(), im, im.Bounds().Min, draw.Src)
	im = nil
	alpha := !src.Opaque()
	out := "jpeg"
	if format == "png" || (format == "webp" && alpha) {
		out = "png"
	}
	for round := 0; round < 12; round++ {
		enc, err := encodeScaled(src, o, tw, th, out, s.MaxBytes)
		if err != nil {
			return nil, err
		}
		if s.MaxBytes == 0 || len(enc) <= s.MaxBytes {
			if len(enc) > ResizeOutputMax {
				return nil, ErrResizeOutput
			}
			return enc, nil
		}
		// over the target: smaller by the square root of the byte ratio (bytes follow the pixel count), at least 8%
		// and at most half per round
		f := math.Sqrt(float64(s.MaxBytes)/float64(len(enc))) * 0.95
		f = math.Max(0.5, math.Min(0.92, f))
		nw, nh := max(1, int(float64(tw)*f)), max(1, int(float64(th)*f))
		if max(nw, nh) < resizeMinSide {
			return nil, ErrResizeTarget
		}
		tw, th = nw, nh
	}
	return nil, ErrResizeTarget
}

// resizeTarget: the shown size after every cap, never larger than the shown size, aspect kept.
func resizeTarget(w, h int, s ResizeSpec) (int, int) {
	f := 1.0
	if s.Permille > 0 {
		f = float64(s.Permille) / 1000
	}
	if s.Side > 0 {
		f = math.Min(f, float64(s.Side)/float64(max(w, h)))
	}
	if s.Width > 0 {
		f = math.Min(f, float64(s.Width)/float64(w))
	}
	if f >= 1 {
		return w, h
	}
	tw, th := int(math.Round(float64(w)*f)), int(math.Round(float64(h)*f))
	// a capped side lands exactly on the asked number (rounding of the other side may not)
	if s.Side > 0 && float64(s.Side)/float64(max(w, h)) == f {
		if w >= h {
			tw = s.Side
		} else {
			th = s.Side
		}
	}
	if s.Width > 0 && float64(s.Width)/float64(w) == f {
		tw = s.Width
	}
	return max(1, min(tw, w)), max(1, min(th, h))
}

// encodeScaled scales src (stored orientation) to the shown size tw x th, turns it upright and encodes it. A JPEG with
// a target size steps its quality down before the caller makes the picture smaller.
func encodeScaled(src *image.RGBA, o, tw, th int, out string, maxBytes int) ([]byte, error) {
	// the size in the stored orientation
	dw, dh := tw, th
	if o >= 5 {
		dw, dh = th, tw
	}
	cur := src
	// halving with a 2x2 box first: good quality for strong reductions, little memory
	for cur.Bounds().Dx()/2 >= dw && cur.Bounds().Dy()/2 >= dh && cur.Bounds().Dx() >= 2 && cur.Bounds().Dy() >= 2 {
		cur = halve(cur)
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	if cur.Bounds().Dx() == dw && cur.Bounds().Dy() == dh {
		copy(dst.Pix, cur.Pix)
	} else if dw*cur.Bounds().Dy() <= resizeKernelBudget {
		draw.CatmullRom.Scale(dst, dst.Bounds(), cur, cur.Bounds(), draw.Src, nil)
	} else {
		draw.ApproxBiLinear.Scale(dst, dst.Bounds(), cur, cur.Bounds(), draw.Src, nil)
	}
	var pic image.Image = dst
	if o != 1 {
		r := rotated{dst, o}
		turned := image.NewRGBA(r.Bounds())
		draw.Draw(turned, turned.Bounds(), r, image.Point{}, draw.Src)
		pic = turned
	}
	var buf bytes.Buffer
	if out == "png" {
		if err := (&png.Encoder{CompressionLevel: png.BestCompression}).Encode(&buf, pic); err != nil {
			return nil, ErrResizeCorrupt
		}
		return buf.Bytes(), nil
	}
	// transparency on white for a JPEG (a JPEG has none)
	flat := image.NewRGBA(pic.Bounds())
	draw.Draw(flat, flat.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.Draw(flat, flat.Bounds(), pic, image.Point{}, draw.Over)
	var smallest []byte
	for _, q := range resizeQualities {
		buf.Reset()
		if err := jpeg.Encode(&buf, flat, &jpeg.Options{Quality: q}); err != nil {
			return nil, ErrResizeCorrupt
		}
		if smallest == nil || buf.Len() < len(smallest) {
			smallest = append([]byte(nil), buf.Bytes()...)
		}
		if maxBytes == 0 || buf.Len() <= maxBytes {
			return smallest, nil
		}
	}
	return smallest, nil
}

// halve averages each 2x2 block of premultiplied pixels (an odd last row or column is dropped).
func halve(s *image.RGBA) *image.RGBA {
	w, h := s.Bounds().Dx()/2, s.Bounds().Dy()/2
	d := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		r0 := s.Pix[(2*y)*s.Stride:]
		r1 := s.Pix[(2*y+1)*s.Stride:]
		o := d.Pix[y*d.Stride:]
		for x := 0; x < w; x++ {
			i := 8 * x
			for c := 0; c < 4; c++ {
				o[4*x+c] = uint8((uint32(r0[i+c]) + uint32(r0[i+4+c]) + uint32(r1[i+c]) + uint32(r1[i+4+c]) + 2) / 4)
			}
		}
	}
	return d
}

// pngAnimated: an acTL chunk before the first IDAT (an animated PNG; Go would decode only its default image).
func pngAnimated(b []byte) bool {
	for p := 8; p+8 <= len(b); {
		n := uint64(binary.BigEndian.Uint32(b[p:]))
		switch string(b[p+4 : p+8]) {
		case "acTL":
			return true
		case "IDAT", "IEND":
			return false
		}
		if n > uint64(len(b)) {
			return false
		}
		p += 12 + int(n)
	}
	return false
}

// webpAnimated: the VP8X animation flag or an ANIM chunk.
func webpAnimated(b []byte) bool {
	if len(b) >= 21 && string(b[12:16]) == "VP8X" && b[20]&0x02 != 0 {
		return true
	}
	return bytes.Contains(b[:min(len(b), 4096)], []byte("ANIM"))
}

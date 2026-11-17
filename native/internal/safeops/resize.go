package safeops

// Resize: smaller copies of photos the person asked for (server/src/tools/resize-images.ts, resize_images). It runs in
// the converter isolation like vision (bwrap + converter cgroup on Linux, sandbox-exec on macOS), reads the untrusted
// bytes from stdin and writes one new image built from decoded pixels. The photo's details (EXIF with time, camera and
// location, XMP, ICC profile) are carried over by default, edited in place (meta.go); on request the location or all
// of them are left out. Nothing else of the input (comments, other segments) reaches the copy. The declared size is
// checked before any pixel is decoded, as in Vision. JPEG stays JPEG, PNG stays PNG; a WebP becomes a JPEG, or a PNG
// when it has see-through pixels (x/image has no WebP encoder); Format asks for JPEG or PNG instead. The EXIF
// orientation of a JPEG is applied and reset to 1, so the copy shows upright everywhere; Upright says the pixels are
// upright already (a HEIC decoded by the server: Debian 12's heif-convert turns the pixels and keeps the tag). Never
// larger than the original in pixels. Refusals are fixed reason lines, never text derived from the input.

import (
	"bytes"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"math"
	"runtime/debug"

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

// ResizeSpec is what the person asked for. At least one of the four sizes is set; Side and Width cap the picture as
// shown (after its orientation), Permille scales both sides (500 is half), MaxBytes is the most bytes the copy may
// have. Details is DetailsKeep, DetailsNoLocation or DetailsNone (meta.go); Format 0 keeps the input's format (WebP:
// JPEG or PNG), 1 asks for JPEG, 2 for PNG; Upright: the pixels are upright already, the orientation tag is ignored.
type ResizeSpec struct {
	Side, Width, Permille, MaxBytes int
	Details, Format                 int
	Upright                         bool
}

// ResizeOptions packs Details, Format and Upright into the helper's fifth number: details + 4*format + 16*upright.
func ResizeOptions(n int) (details, format int, upright, ok bool) {
	if n < 0 || n > 31 {
		return 0, 0, false, false
	}
	details, format, upright = n&3, (n>>2)&3, n&16 != 0
	return details, format, upright, details <= DetailsNone && format <= 2
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
	if s.Details < 0 || s.Details > DetailsNone || s.Format < 0 || s.Format > 2 {
		return false
	}
	return s.Side != 0 || s.Width != 0 || s.Permille != 0 || s.MaxBytes != 0
}

// Resize decodes one JPEG, PNG or WebP (format from the content, not the file name) and returns the smaller copy.
func Resize(b []byte, s ResizeSpec) ([]byte, error) {
	out, _, err := ResizeWithInfo(b, s)
	return out, err
}

// ResizeWithInfo is Resize that also says what happened to the photo's details.
func ResizeWithInfo(b []byte, s ResizeSpec) ([]byte, ResizeInfo, error) {
	var info ResizeInfo
	if !s.valid() {
		return nil, info, ErrResizeSpec
	}
	if len(b) > ResizeInputMax {
		return nil, info, ErrResizeBytes
	}
	c, format, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		if errors.Is(err, image.ErrFormat) {
			return nil, info, ErrResizeFormat
		}
		return nil, info, ErrResizeCorrupt
	}
	if !resizeFormats[format] {
		return nil, info, ErrResizeFormat
	}
	if !visionSize(c.Width, c.Height) {
		return nil, info, ErrResizePixels
	}
	if format == "webp" {
		if w, h, ok := webpLosslessSize(b); ok && !visionSize(w, h) {
			return nil, info, ErrResizePixels
		}
		if webpAnimated(b) {
			return nil, info, ErrResizeAnimated
		}
	}
	if format == "png" && pngAnimated(b) {
		return nil, info, ErrResizeAnimated
	}
	im, _, err := image.Decode(bytes.NewReader(b))
	if err != nil {
		return nil, info, ErrResizeCorrupt
	}
	sw, sh := im.Bounds().Dx(), im.Bounds().Dy()
	if !visionSize(sw, sh) {
		return nil, info, ErrResizePixels
	}
	// the details are read first: the orientation comes from the same EXIF block the copy carries (a PNG or WebP can
	// have one too), so the pixels are turned exactly when the tag is reset
	meta := readMeta(b, format)
	o := 1
	if !s.Upright {
		o = tiffOrientation(meta.exif)
	}
	// the size as shown: orientations 5-8 turn the picture a quarter
	vw, vh := sw, sh
	if o >= 5 {
		vw, vh = sh, sw
	}
	tw, th := resizeTarget(vw, vh, s)
	// a copy in another format is made even at the same size (a HEIC as JPEG, "as PNG")
	if tw == vw && th == vh && (s.MaxBytes == 0 || len(b) <= s.MaxBytes) && s.Format == 0 {
		return nil, info, ErrResizeUnchanged
	}
	// premultiplied RGBA once (draw's fast paths for YCbCr, Gray, NRGBA ...): halving and scaling average it
	src := image.NewRGBA(image.Rect(0, 0, sw, sh))
	draw.Draw(src, src.Bounds(), im, im.Bounds().Min, draw.Src)
	// the decoded picture is not needed any more: give its memory back before scaling (a 50 MP photo held twice went
	// over the converters' memory limit in the review)
	im = nil
	debug.FreeOSMemory()
	alpha := !src.Opaque()
	out := "jpeg"
	if format == "png" || (format == "webp" && alpha) {
		out = "png"
	}
	switch s.Format {
	case 1:
		out = "jpeg"
	case 2:
		out = "png"
	}
	bw, bh := tw, th
	f := 1.0
	for round := 0; round < 12; round++ {
		m, mi := meta.prepare(s.Details, tw, th, out)
		info = mi
		budget := s.MaxBytes
		if budget > 0 {
			// the details count toward the target size
			if budget -= metaSize(out, m); budget < ResizeMaxBytesMin/2 {
				return nil, info, ErrResizeTarget
			}
		}
		enc, err := encodeScaled(src, o, tw, th, out, budget)
		if err != nil {
			return nil, info, err
		}
		if budget == 0 || len(enc) <= budget {
			enc = withMeta(enc, out, m)
			if len(enc) > ResizeOutputMax {
				return nil, info, ErrResizeOutput
			}
			return enc, info, nil
		}
		// over the target: smaller by the square root of the byte ratio (bytes follow the pixel count), at least 8%
		// and at most half per round
		// (one factor for both sides, from the first size, so the aspect ratio does not drift over the rounds)
		step := math.Sqrt(float64(budget)/float64(len(enc))) * 0.95
		f *= math.Max(0.5, math.Min(0.92, step))
		nw, nh := max(1, int(math.Round(float64(bw)*f))), max(1, int(math.Round(float64(bh)*f)))
		if max(nw, nh) < resizeMinSide {
			return nil, info, ErrResizeTarget
		}
		tw, th = nw, nh
	}
	return nil, info, ErrResizeTarget
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
		dst = nil
	}
	var buf bytes.Buffer
	if out == "png" {
		// the default level: BestCompression took 27 s on a 12 MP picture for 3% fewer bytes (review), past the time limit
		if err := (&png.Encoder{CompressionLevel: png.DefaultCompression}).Encode(&buf, pic); err != nil {
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

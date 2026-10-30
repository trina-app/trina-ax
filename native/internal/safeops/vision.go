package safeops

// Vision: the image the AI sees when it reads a photo, screenshot or scanned PDF page (server/src/files/vision.ts).
// It runs in the converter isolation like the other converters (bwrap + converter cgroup on Linux, sandbox-exec on
// macOS), reads the untrusted bytes from stdin and writes one new baseline JPEG built from decoded pixels only:
// no EXIF, GPS, XMP, ICC profile, comment or any other input metadata can reach the output. Animated images give
// their first frame. Decoders are Go's (memory safe); the declared size is checked before any pixel is decoded.

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"

	_ "golang.org/x/image/bmp"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
)

const (
	// VisionInputMax is the largest compressed input (a 48 MP phone JPEG is about 20 MiB).
	VisionInputMax = 32 << 20
	// VisionPixelMax is the largest declared image (a 48 MP phone photo is 8064x6048).
	VisionPixelMax = 50_000_000
	// VisionSideMax is the longest side of the output, Anthropic's recommended size: larger images are only
	// scaled down again by the model provider, after costing more bytes.
	VisionSideMax = 1568
	// VisionOutputMax is the largest JPEG written; quality steps down until the image fits.
	VisionOutputMax = 1 << 20
)

// Fixed refusal reasons: the server maps them to its own messages (never text derived from the input).
var (
	ErrVisionFormat  = errors.New("vision: unsupported format")
	ErrVisionCorrupt = errors.New("vision: corrupt image")
	ErrVisionPixels  = errors.New("vision: pixel limit")
	ErrVisionBytes   = errors.New("vision: byte limit")
	ErrVisionOutput  = errors.New("vision: output limit")
)

var visionFormats = map[string]bool{"png": true, "jpeg": true, "gif": true, "webp": true, "bmp": true, "tiff": true}
var visionQualities = []int{85, 75, 65, 55, 45}

// Vision decodes one image (format detected from the content, not the file name) and returns the normalized JPEG.
func Vision(b []byte) ([]byte, error) {
	if len(b) > VisionInputMax {
		return nil, ErrVisionBytes
	}
	c, format, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		if errors.Is(err, image.ErrFormat) {
			return nil, ErrVisionFormat
		}
		return nil, ErrVisionCorrupt
	}
	if !visionFormats[format] {
		return nil, ErrVisionFormat
	}
	if c.Width < 1 || c.Height < 1 || c.Width > VisionPixelMax/c.Height {
		return nil, ErrVisionPixels
	}
	im, _, err := image.Decode(bytes.NewReader(b))
	if err != nil {
		return nil, ErrVisionCorrupt
	}
	// a frame may be smaller than the declared screen; never larger than what was checked above
	bw, bh := im.Bounds().Dx(), im.Bounds().Dy()
	if bw < 1 || bh < 1 || bw > VisionPixelMax/bh {
		return nil, ErrVisionPixels
	}
	o := 1
	if format == "jpeg" {
		o = orientation(b)
	}
	// Scale first in the stored orientation (the fast concrete-type paths of x/image/draw), then turn the small
	// result: the EXIF orientation of a phone photo applies to what is shown.
	tw, th := fit(bw, bh)
	dst := image.NewRGBA(image.Rect(0, 0, tw, th))
	draw.Draw(dst, dst.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src) // transparency on white
	draw.CatmullRom.Scale(dst, dst.Bounds(), im, im.Bounds(), draw.Over, nil)
	var out image.Image = dst
	if o != 1 {
		r := rotated{dst, o}
		turned := image.NewRGBA(r.Bounds())
		draw.Draw(turned, turned.Bounds(), r, image.Point{}, draw.Src)
		out = turned
	}
	for _, q := range visionQualities {
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, out, &jpeg.Options{Quality: q}); err != nil {
			return nil, ErrVisionCorrupt
		}
		if buf.Len() <= VisionOutputMax {
			return buf.Bytes(), nil
		}
	}
	return nil, ErrVisionOutput
}

// fit gives the scaled size in the stored orientation: the longest side at most VisionSideMax (turning the image
// later swaps width and height, not the longest side). Smaller images keep their size.
func fit(w, h int) (int, int) {
	if max(w, h) <= VisionSideMax {
		return w, h
	}
	if w >= h {
		return VisionSideMax, max(1, int(int64(h)*VisionSideMax/int64(w)))
	}
	return max(1, int(int64(w)*VisionSideMax/int64(h))), VisionSideMax
}

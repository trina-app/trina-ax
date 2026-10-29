// Package safeops implements fixed byte transformations. It never accepts a command, script or host path.
package safeops

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	_ "image/png"
	"io"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const InputMax = 8 << 20
const OutputMax = 1 << 20
const PixelMax = 32_000_000
const SideMax = 1536

func ReadBounded(r io.Reader, max int64) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(r, max+1))
	if err != nil || int64(len(b)) > max {
		return nil, fmt.Errorf("byte limit")
	}
	return b, nil
}

// DecodeConfig is intentionally before Decode. No EXIF, GPS, ICC, comments, or other input
// metadata is copied to the new RGB JPEG. Animation is refused (PNG acTL / WebP ANIM).
func Image(b []byte, format string) ([]byte, error) {
	if len(b) > InputMax {
		return nil, fmt.Errorf("byte limit")
	}
	return imageBytes(b, format)
}

// HEIC's bounded intermediate PNG can be larger than the compressed source limit.
func Intermediate(b []byte) ([]byte, error) { return imageBytes(b, "png") }

func imageBytes(b []byte, format string) ([]byte, error) {
	c, actual, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil || actual != format {
		return nil, fmt.Errorf("corrupt image or format mismatch")
	}
	if c.Width < 1 || c.Height < 1 || c.Width > PixelMax/c.Height {
		return nil, fmt.Errorf("pixel limit")
	}
	if (actual == "png" && bytes.Contains(b, []byte("acTL"))) || (actual == "webp" && bytes.Contains(b, []byte("ANIM"))) {
		return nil, fmt.Errorf("animation is unsupported")
	}
	im, _, err := image.Decode(bytes.NewReader(b))
	if err != nil {
		return nil, fmt.Errorf("corrupt image")
	}
	if actual == "jpeg" {
		im = rotated{im, orientation(b)}
	}
	w, h := im.Bounds().Dx(), im.Bounds().Dy()
	if w > SideMax || h > SideMax {
		if w >= h {
			h = max(1, h*SideMax/w)
			w = SideMax
		} else {
			w = max(1, w*SideMax/h)
			h = SideMax
		}
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(dst, dst.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.ApproxBiLinear.Scale(dst, dst.Bounds(), im, im.Bounds(), draw.Over, nil)
	var out bytes.Buffer
	if err := jpeg.Encode(&out, dst, &jpeg.Options{Quality: 80}); err != nil {
		return nil, err
	}
	if out.Len() > OutputMax {
		return nil, fmt.Errorf("output limit")
	}
	return out.Bytes(), nil
}

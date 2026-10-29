package safeops

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
)

// Read only TIFF orientation (no metadata tree, offsets always within this APP1 segment).
func orientation(b []byte) int {
	if len(b) < 4 || b[0] != 255 || b[1] != 216 {
		return 1
	}
	for p := 2; p+4 <= len(b); {
		if b[p] != 255 {
			return 1
		}
		marker := b[p+1]
		if marker == 0xda || marker == 0xd9 {
			return 1
		}
		n := int(binary.BigEndian.Uint16(b[p+2:]))
		if n < 2 || p+2+n > len(b) {
			return 1
		}
		segment := b[p+4 : p+2+n]
		p += 2 + n
		if marker != 0xe1 || !bytes.HasPrefix(segment, []byte("Exif\x00\x00")) {
			continue
		}
		t := segment[6:]
		if len(t) < 8 {
			return 1
		}
		var order binary.ByteOrder
		if string(t[:2]) == "II" {
			order = binary.LittleEndian
		} else if string(t[:2]) == "MM" {
			order = binary.BigEndian
		} else {
			return 1
		}
		if order.Uint16(t[2:]) != 42 {
			return 1
		}
		off := uint64(order.Uint32(t[4:]))
		if off+2 > uint64(len(t)) {
			return 1
		}
		count := uint64(order.Uint16(t[off:]))
		if count > 1024 || off+2+count*12 > uint64(len(t)) {
			return 1
		}
		for i := uint64(0); i < count; i++ {
			e := t[off+2+i*12:]
			if order.Uint16(e) == 0x112 && order.Uint16(e[2:]) == 3 && order.Uint32(e[4:]) == 1 {
				v := int(order.Uint16(e[8:]))
				if v >= 1 && v <= 8 {
					return v
				}
			}
		}
	}
	return 1
}

type rotated struct {
	im image.Image
	o  int
}

func (r rotated) ColorModel() color.Model { return r.im.ColorModel() }
func (r rotated) Bounds() image.Rectangle {
	b := r.im.Bounds()
	if r.o >= 5 {
		return image.Rect(0, 0, b.Dy(), b.Dx())
	}
	return image.Rect(0, 0, b.Dx(), b.Dy())
}
func (r rotated) At(x, y int) color.Color {
	b := r.im.Bounds()
	w, h := b.Dx(), b.Dy()
	switch r.o {
	case 2:
		x = w - 1 - x
	case 3:
		x, y = w-1-x, h-1-y
	case 4:
		y = h - 1 - y
	case 5:
		x, y = y, x
	case 6:
		x, y = y, h-1-x
	case 7:
		x, y = w-1-y, h-1-x
	case 8:
		x, y = w-1-y, x
	}
	return r.im.At(b.Min.X+x, b.Min.Y+y)
}

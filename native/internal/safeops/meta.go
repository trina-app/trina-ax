package safeops

// Photo details of a resized copy (resize.go; docs/decisions/20261117-resize-photos.md, the owner's decision of
// 2026-11-17). By default the copy keeps its photo's EXIF (time taken, camera, location), XMP and ICC colour profile,
// with the orientation reset to 1 because the pixels are turned upright, the EXIF pixel size set to the copy's, and
// the EXIF thumbnail (IFD1: the old picture, not turned) left out. On request the location goes (the GPS IFD is
// zeroed and unlinked, and the XMP, which can hold GPS too, is left out), or every detail goes.
//
// Everything is edited in place inside the EXIF bytes: no entry moves except the removed GPS pointer, so offsets
// that a maker note keeps relative to the TIFF header stay right. Every offset is checked against the block; a
// block that is not a TIFF this code understands is left out rather than copied unchecked.

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"hash/crc32"
	"io"
	"regexp"
	"sort"
)

// ResizeDetails: what the copy keeps of its photo's details.
const (
	DetailsKeep       = 0
	DetailsNoLocation = 1
	DetailsNone       = 2
)

const (
	// metaICCMax: the largest colour profile carried (camera and display profiles are a few KB; 4 MiB is generous)
	metaICCMax = 4 << 20
	// a JPEG segment holds at most 65,533 bytes after its length
	jpegSegMax = 65533
	iccChunk   = jpegSegMax - 14
)

var (
	exifSig = []byte("Exif\x00\x00")
	xmpSig  = []byte("http://ns.adobe.com/xap/1.0/\x00")
	iccSig  = []byte("ICC_PROFILE\x00")
	// tiff:Orientation in XMP, as an attribute or an element: reset to 1 with the EXIF one
	xmpOrientAttr = regexp.MustCompile(`tiff:Orientation="[0-9]"`)
	xmpOrientElem = regexp.MustCompile(`<tiff:Orientation>[0-9]</tiff:Orientation>`)
	xmpGPS        = regexp.MustCompile(`GPS(Latitude|Longitude)`)
)

type photoMeta struct{ exif, xmp, icc []byte }

// ResizeInfo says what happened to the photo's details: "kept", "removed" or "none" (the photo had none).
type ResizeInfo struct{ Details, Location string }

func readMeta(b []byte, format string) photoMeta {
	switch format {
	case "jpeg":
		return jpegMeta(b)
	case "png":
		return pngMeta(b)
	case "webp":
		return webpMeta(b)
	}
	return photoMeta{}
}

func clone(b []byte) []byte { return append([]byte(nil), b...) }

func jpegMeta(b []byte) (m photoMeta) {
	if len(b) < 4 || b[0] != 0xff || b[1] != 0xd8 {
		return
	}
	type part struct {
		seq  int
		data []byte
	}
	var icc []part
	count := 0
	for p := 2; p+4 <= len(b); {
		if b[p] != 0xff {
			break
		}
		marker := b[p+1]
		if marker == 0xff {
			p++
			continue
		}
		if marker == 0xda || marker == 0xd9 {
			break
		}
		if (marker >= 0xd0 && marker <= 0xd7) || marker == 0x01 {
			p += 2
			continue
		}
		n := int(binary.BigEndian.Uint16(b[p+2:]))
		if n < 2 || p+2+n > len(b) {
			break
		}
		seg := b[p+4 : p+2+n]
		p += 2 + n
		switch {
		case marker == 0xe1 && m.exif == nil && bytes.HasPrefix(seg, exifSig):
			m.exif = clone(seg[len(exifSig):])
		case marker == 0xe1 && m.xmp == nil && bytes.HasPrefix(seg, xmpSig):
			m.xmp = clone(seg[len(xmpSig):])
		case marker == 0xe2 && bytes.HasPrefix(seg, iccSig) && len(seg) > 14 && count >= 0:
			seq, n := int(seg[12]), int(seg[13])
			if count == 0 {
				count = n
			}
			if n != count || seq < 1 || seq > n {
				count = -1
				continue
			}
			icc = append(icc, part{seq, seg[14:]})
		}
	}
	if count > 0 && len(icc) == count {
		sort.Slice(icc, func(i, j int) bool { return icc[i].seq < icc[j].seq })
		var all []byte
		for i, c := range icc {
			if c.seq != i+1 || len(all)+len(c.data) > metaICCMax {
				return
			}
			all = append(all, c.data...)
		}
		m.icc = all
	}
	return
}

func pngMeta(b []byte) (m photoMeta) {
	for p := 8; p+12 <= len(b); {
		n := uint64(binary.BigEndian.Uint32(b[p:]))
		if n > uint64(len(b)-p-12) {
			break
		}
		typ, data := string(b[p+4:p+8]), b[p+8:p+8+int(n)]
		p += 12 + int(n)
		switch typ {
		case "eXIf":
			if m.exif == nil {
				m.exif = clone(data)
			}
		case "iCCP":
			if i := bytes.IndexByte(data, 0); i > 0 && i < 80 && i+2 <= len(data) && data[i+1] == 0 && m.icc == nil {
				m.icc = inflate(data[i+2:], metaICCMax)
			}
		case "iTXt":
			const key = "XML:com.adobe.xmp\x00"
			if m.xmp != nil || !bytes.HasPrefix(data, []byte(key)) || len(data) < len(key)+2 {
				continue
			}
			comp, rest := data[len(key)], data[len(key)+2:]
			// language tag and translated keyword, each ended by a zero
			for k := 0; k < 2; k++ {
				i := bytes.IndexByte(rest, 0)
				if i < 0 {
					rest = nil
					break
				}
				rest = rest[i+1:]
			}
			if rest == nil {
				continue
			}
			if comp == 1 {
				m.xmp = inflate(rest, jpegSegMax)
			} else {
				m.xmp = clone(rest)
			}
		}
	}
	return
}

func webpMeta(b []byte) (m photoMeta) {
	if len(b) < 12 || string(b[:4]) != "RIFF" || string(b[8:12]) != "WEBP" {
		return
	}
	for p := 12; p+8 <= len(b); {
		n := uint64(binary.LittleEndian.Uint32(b[p+4:]))
		if n > uint64(len(b)-p-8) {
			break
		}
		typ, data := string(b[p:p+4]), b[p+8:p+8+int(n)]
		p += 8 + int(n) + int(n&1)
		switch typ {
		case "EXIF":
			if m.exif == nil {
				m.exif = clone(bytes.TrimPrefix(data, exifSig))
			}
		case "ICCP":
			if m.icc == nil && len(data) <= metaICCMax {
				m.icc = clone(data)
			}
		case "XMP ":
			if m.xmp == nil {
				m.xmp = clone(data)
			}
		}
	}
	return
}

// inflate: zlib data, at most max bytes, or nil
func inflate(b []byte, max int) []byte {
	r, err := zlib.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil
	}
	defer r.Close()
	out, err := io.ReadAll(io.LimitReader(r, int64(max)+1))
	if err != nil || len(out) > max {
		return nil
	}
	return out
}

// prepare: the details the copy (w x h, upright) carries under `mode`, and what happened to them.
func (m photoMeta) prepare(mode, w, h int) (photoMeta, ResizeInfo) {
	var exifGPS bool
	var exif []byte
	if m.exif != nil {
		exif = clone(m.exif)
		var ok bool
		exifGPS, ok = fixExif(exif, w, h, mode != DetailsKeep)
		if !ok {
			exif = nil
		}
	}
	hadGPS := exifGPS || (m.xmp != nil && xmpGPS.Match(m.xmp))
	had := exif != nil || m.xmp != nil
	info := ResizeInfo{Details: "none", Location: "none"}
	if had {
		info.Details = "kept"
	}
	if hadGPS {
		info.Location = "kept"
	}
	switch mode {
	case DetailsNone:
		if had {
			info.Details = "removed"
		}
		if hadGPS {
			info.Location = "removed"
		}
		return photoMeta{}, info
	case DetailsNoLocation:
		if hadGPS {
			info.Location = "removed"
		}
		// the XMP can hold the location too, in many spellings: it is left out
		return photoMeta{exif: exif, icc: m.icc}, info
	}
	xmp := m.xmp
	if xmp != nil {
		xmp = xmpOrientAttr.ReplaceAll(xmp, []byte(`tiff:Orientation="1"`))
		xmp = xmpOrientElem.ReplaceAll(xmp, []byte(`<tiff:Orientation>1</tiff:Orientation>`))
	}
	return photoMeta{exif: exif, xmp: xmp, icc: m.icc}, info
}

var tiffTypeSize = map[uint16]uint64{1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4}

type tiffBlock struct {
	b []byte
	o binary.ByteOrder
}

// ifd: the entry count of the IFD at off, when the whole IFD (count, entries, next pointer) is inside the block
func (t tiffBlock) ifd(off uint64) (int, bool) {
	if off < 8 || off+2 > uint64(len(t.b)) {
		return 0, false
	}
	n := uint64(t.o.Uint16(t.b[off:]))
	if n > 1024 || off+2+12*n+4 > uint64(len(t.b)) {
		return 0, false
	}
	return int(n), true
}

func (t tiffBlock) entry(off uint64, i int) []byte { return t.b[off+2+12*uint64(i):][:12] }

// blank zeroes an IFD: its out-of-line values (and a thumbnail it points to), then its table and next pointer.
func (t tiffBlock) blank(off uint64) {
	n, ok := t.ifd(off)
	if !ok {
		return
	}
	var thumbOff, thumbLen uint64
	for i := 0; i < n; i++ {
		e := t.entry(off, i)
		tag, typ, cnt := t.o.Uint16(e), t.o.Uint16(e[2:]), uint64(t.o.Uint32(e[4:]))
		switch tag {
		case 0x0201:
			thumbOff = uint64(t.o.Uint32(e[8:]))
		case 0x0202:
			thumbLen = uint64(t.o.Uint32(e[8:]))
		}
		size := tiffTypeSize[typ] * cnt
		if size > 4 {
			if v := uint64(t.o.Uint32(e[8:])); v+size <= uint64(len(t.b)) {
				clear(t.b[v : v+size])
			}
		}
	}
	if thumbOff > 0 && thumbOff+thumbLen <= uint64(len(t.b)) {
		clear(t.b[thumbOff : thumbOff+thumbLen])
	}
	clear(t.b[off : off+2+12*uint64(n)+4])
}

// fixExif edits a TIFF block in place: orientation 1, the copy's pixel size, no thumbnail and, with noGPS, no GPS IFD.
// hadGPS: the block held a location. ok false: not a TIFF block this code can edit safely (the caller leaves it out).
func fixExif(b []byte, w, h int, noGPS bool) (hadGPS, ok bool) {
	if len(b) < 8 {
		return false, false
	}
	t := tiffBlock{b: b}
	switch string(b[:2]) {
	case "II":
		t.o = binary.LittleEndian
	case "MM":
		t.o = binary.BigEndian
	default:
		return false, false
	}
	if t.o.Uint16(b[2:]) != 42 {
		return false, false
	}
	ifd0 := uint64(t.o.Uint32(b[4:]))
	n, good := t.ifd(ifd0)
	if !good {
		return false, false
	}
	gpsIdx, gpsOff, exifOff := -1, uint64(0), uint64(0)
	for i := 0; i < n; i++ {
		e := t.entry(ifd0, i)
		tag, typ, cnt := t.o.Uint16(e), t.o.Uint16(e[2:]), t.o.Uint32(e[4:])
		switch {
		case tag == 0x0112 && typ == 3 && cnt == 1:
			t.o.PutUint16(e[8:], 1)
		case tag == 0x8769 && cnt == 1:
			exifOff = uint64(t.o.Uint32(e[8:]))
		case tag == 0x8825 && cnt == 1:
			gpsIdx, gpsOff = i, uint64(t.o.Uint32(e[8:]))
		}
	}
	// the EXIF pixel size: the copy's
	if en, good := t.ifd(exifOff); good {
		for i := 0; i < en; i++ {
			e := t.entry(exifOff, i)
			tag, typ, cnt := t.o.Uint16(e), t.o.Uint16(e[2:]), t.o.Uint32(e[4:])
			if (tag != 0xa002 && tag != 0xa003) || cnt != 1 {
				continue
			}
			v := w
			if tag == 0xa003 {
				v = h
			}
			if typ == 3 && v <= 0xffff {
				t.o.PutUint16(e[8:], uint16(v))
				t.o.PutUint16(e[10:], 0)
			} else if typ == 4 {
				t.o.PutUint32(e[8:], uint32(v))
			}
		}
	}
	// the thumbnail (IFD1) shows the old picture, not turned: left out
	next := ifd0 + 2 + 12*uint64(n)
	if th := uint64(t.o.Uint32(b[next:])); th != 0 {
		t.blank(th)
		t.o.PutUint32(b[next:], 0)
	}
	if gpsIdx >= 0 {
		gn, good := t.ifd(gpsOff)
		hadGPS = good && gn > 0
		if noGPS {
			t.blank(gpsOff)
			// the pointer leaves IFD0: later entries and the next pointer move up one entry
			start := ifd0 + 2 + 12*uint64(gpsIdx)
			end := ifd0 + 2 + 12*uint64(n) + 4
			copy(b[start:], b[start+12:end])
			clear(b[end-12 : end])
			t.o.PutUint16(b[ifd0:], uint16(n-1))
		}
	}
	return hadGPS, true
}

// jpegSegments: APP1 Exif, APP1 XMP and APP2 ICC segments for a JPEG (each part that does not fit a segment is left out)
func (m photoMeta) jpegSegments() []byte {
	var out []byte
	seg := func(marker byte, parts ...[]byte) {
		n := 2
		for _, p := range parts {
			n += len(p)
		}
		out = append(out, 0xff, marker, byte(n>>8), byte(n))
		for _, p := range parts {
			out = append(out, p...)
		}
	}
	if m.exif != nil && len(exifSig)+len(m.exif) <= jpegSegMax {
		seg(0xe1, exifSig, m.exif)
	}
	if m.xmp != nil && len(xmpSig)+len(m.xmp) <= jpegSegMax {
		seg(0xe1, xmpSig, m.xmp)
	}
	if n := (len(m.icc) + iccChunk - 1) / iccChunk; n > 0 && n <= 255 {
		for i := 0; i < n; i++ {
			part := m.icc[i*iccChunk : min(len(m.icc), (i+1)*iccChunk)]
			seg(0xe2, iccSig, []byte{byte(i + 1), byte(n)}, part)
		}
	}
	return out
}

// pngChunks: eXIf, iCCP and an iTXt XMP chunk for a PNG
func (m photoMeta) pngChunks() []byte {
	var out []byte
	chunk := func(typ string, data []byte) {
		var l [4]byte
		binary.BigEndian.PutUint32(l[:], uint32(len(data)))
		out = append(out, l[:]...)
		start := len(out)
		out = append(out, typ...)
		out = append(out, data...)
		binary.BigEndian.PutUint32(l[:], crc32.ChecksumIEEE(out[start:]))
		out = append(out, l[:]...)
	}
	if m.icc != nil {
		var z bytes.Buffer
		w := zlib.NewWriter(&z)
		w.Write(m.icc)
		w.Close()
		chunk("iCCP", append([]byte("icc\x00\x00"), z.Bytes()...))
	}
	if m.exif != nil {
		chunk("eXIf", m.exif)
	}
	if m.xmp != nil {
		chunk("iTXt", append([]byte("XML:com.adobe.xmp\x00\x00\x00\x00\x00"), m.xmp...))
	}
	return out
}

// withMeta puts the details into an encoded copy: right after a JPEG's SOI, or right after a PNG's IHDR.
func withMeta(enc []byte, out string, m photoMeta) []byte {
	if out == "png" {
		c := m.pngChunks()
		if len(c) == 0 || len(enc) < 33 || string(enc[12:16]) != "IHDR" {
			return enc
		}
		return append(append(append(make([]byte, 0, len(enc)+len(c)), enc[:33]...), c...), enc[33:]...)
	}
	s := m.jpegSegments()
	if len(s) == 0 || len(enc) < 2 {
		return enc
	}
	return append(append(append(make([]byte, 0, len(enc)+len(s)), enc[:2]...), s...), enc[2:]...)
}

// metaSize: the bytes the details add to a copy in this format
func metaSize(out string, m photoMeta) int {
	if out == "png" {
		return len(m.pngChunks())
	}
	return len(m.jpegSegments())
}

package safeops

import (
	"bytes"
	"encoding/binary"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

// tiffEntry: one IFD entry; data longer than 4 bytes goes out of line
type tiffEntry struct {
	tag, typ uint16
	count    uint32
	data     []byte
	ifd      int // >0: a pointer to IFD number ifd (filled in by buildTiff)
}

// buildTiff lays out IFD0, its sub-IFDs and IFD1 (little-endian), each followed by its out-of-line values.
// ifds[0] is IFD0, ifds[1] the EXIF IFD, ifds[2] the GPS IFD, ifds[3] IFD1 (the thumbnail; linked from IFD0's next).
func buildTiff(ifds [][]tiffEntry, thumb []byte) []byte {
	le := binary.LittleEndian
	offs := make([]int, len(ifds))
	size := 8
	for i, ifd := range ifds {
		offs[i] = size
		size += 2 + 12*len(ifd) + 4
		for _, e := range ifd {
			if len(e.data) > 4 {
				size += len(e.data) + len(e.data)&1
			}
		}
	}
	thumbOff := size
	size += len(thumb)
	b := make([]byte, size)
	copy(b, "II\x2a\x00")
	le.PutUint32(b[4:], 8)
	for i, ifd := range ifds {
		p := offs[i]
		le.PutUint16(b[p:], uint16(len(ifd)))
		data := p + 2 + 12*len(ifd) + 4
		for j, e := range ifd {
			q := p + 2 + 12*j
			le.PutUint16(b[q:], e.tag)
			le.PutUint16(b[q+2:], e.typ)
			le.PutUint32(b[q+4:], e.count)
			switch {
			case e.ifd > 0:
				le.PutUint32(b[q+8:], uint32(offs[e.ifd]))
			case e.tag == 0x0201:
				le.PutUint32(b[q+8:], uint32(thumbOff))
			case len(e.data) > 4:
				le.PutUint32(b[q+8:], uint32(data))
				copy(b[data:], e.data)
				data += len(e.data) + len(e.data)&1
			default:
				copy(b[q+8:], e.data)
			}
		}
		if i == 0 && len(ifds) > 3 {
			le.PutUint32(b[p+2+12*len(ifd):], uint32(offs[3]))
		}
	}
	copy(b[thumbOff:], thumb)
	return b
}

func u16(v uint16) []byte { b := make([]byte, 2); binary.LittleEndian.PutUint16(b, v); return b }
func u32(v uint32) []byte { b := make([]byte, 4); binary.LittleEndian.PutUint32(b, v); return b }

// richExif: orientation, camera, time taken, pixel size, a location (with a recognisable value) and a thumbnail
func richExif(orient uint16) []byte {
	thumb := []byte("THUMB-OLD-PIXELS")
	return buildTiff([][]tiffEntry{
		{
			{tag: 0x010f, typ: 2, count: 13, data: []byte("CAMERA-MAKER\x00")},
			{tag: 0x0112, typ: 3, count: 1, data: u16(orient)},
			{tag: 0x8769, typ: 4, count: 1, ifd: 1},
			{tag: 0x8825, typ: 4, count: 1, ifd: 2},
		},
		{
			{tag: 0x9003, typ: 2, count: 20, data: []byte("2026:11:17 10:20:30\x00")},
			{tag: 0xa002, typ: 4, count: 1, data: u32(400)},
			{tag: 0xa003, typ: 3, count: 1, data: u16(200)},
		},
		{
			{tag: 0x0001, typ: 2, count: 2, data: []byte("N\x00")},
			{tag: 0x001c, typ: 7, count: 16, data: []byte("GPS-SECRET-PLACE")},
		},
		{
			{tag: 0x0201, typ: 4, count: 1},
			{tag: 0x0202, typ: 4, count: 1, data: u32(uint32(len(thumb)))},
		},
	}, thumb)
}

func jpegSegs(jpg []byte, segs ...[]byte) []byte {
	out := []byte{0xff, 0xd8}
	for _, s := range segs {
		out = append(out, s...)
	}
	return append(out, jpg[2:]...)
}

func app(marker byte, parts ...[]byte) []byte {
	var body []byte
	for _, p := range parts {
		body = append(body, p...)
	}
	return append([]byte{0xff, marker, byte((len(body) + 2) >> 8), byte(len(body) + 2)}, body...)
}

// exifTag reads one SHORT/LONG value of a tag in IFD0 (sub < 0) or in the IFD IFD0's tag `sub` points to
func exifTag(t *testing.T, out []byte, sub, tag uint16) (uint32, bool) {
	t.Helper()
	m := jpegMeta(out)
	if m.exif == nil {
		return 0, false
	}
	tb := tiffBlock{b: m.exif, o: binary.LittleEndian}
	if string(m.exif[:2]) == "MM" {
		tb.o = binary.BigEndian
	}
	off := uint64(tb.o.Uint32(m.exif[4:]))
	find := func(off uint64, tag uint16) ([]byte, bool) {
		n, ok := tb.ifd(off)
		if !ok {
			t.Fatal("bad IFD in the copy")
		}
		for i := 0; i < n; i++ {
			if e := tb.entry(off, i); tb.o.Uint16(e) == tag {
				return e, true
			}
		}
		return nil, false
	}
	if sub != 0 {
		e, ok := find(off, sub)
		if !ok {
			return 0, false
		}
		off = uint64(tb.o.Uint32(e[8:]))
	}
	e, ok := find(off, tag)
	if !ok {
		return 0, false
	}
	if tb.o.Uint16(e[2:]) == 3 {
		return uint32(tb.o.Uint16(e[8:])), true
	}
	return tb.o.Uint32(e[8:]), true
}

func TestResizeKeepsDetailsByDefault(t *testing.T) {
	xmp := []byte(`<x:xmpmeta><rdf:Description tiff:Orientation="6" exif:GPSLatitude="37,33.98N"/></x:xmpmeta>`)
	icc := bytes.Repeat([]byte("PROFILE!"), 9000) // 72 KB: two APP2 segments
	src := jpegSegs(encJPEG(t, photo(400, 200, 3), 90),
		app(0xe1, exifSig, richExif(6)), app(0xe1, xmpSig, xmp),
		app(0xe2, iccSig, []byte{1, 2}, icc[:60000]), app(0xe2, iccSig, []byte{2, 2}, icc[60000:]),
		app(0xfe, []byte("COMMENT-NOT-CARRIED")))
	out, info, err := ResizeWithInfo(src, ResizeSpec{Side: 100})
	if err != nil {
		t.Fatal(err)
	}
	if info != (ResizeInfo{Details: "kept", Location: "kept"}) {
		t.Fatalf("info %+v", info)
	}
	c, _ := config(t, out)
	if c.Width != 50 || c.Height != 100 {
		t.Fatalf("upright: %dx%d", c.Width, c.Height)
	}
	for _, want := range []string{"CAMERA-MAKER", "2026:11:17 10:20:30", "GPS-SECRET-PLACE"} {
		if !bytes.Contains(out, []byte(want)) {
			t.Fatalf("%s was not kept", want)
		}
	}
	if orientation(out) != 1 {
		t.Fatal("the orientation was not reset")
	}
	if w, _ := exifTag(t, out, 0x8769, 0xa002); w != 50 {
		t.Fatalf("EXIF width %d", w)
	}
	if h, _ := exifTag(t, out, 0x8769, 0xa003); h != 100 {
		t.Fatalf("EXIF height %d", h)
	}
	if bytes.Contains(out, []byte("THUMB-OLD-PIXELS")) || bytes.Contains(out, []byte("COMMENT-NOT-CARRIED")) {
		t.Fatal("the old thumbnail or a comment reached the copy")
	}
	m := jpegMeta(out)
	if !bytes.Equal(m.icc, icc) {
		t.Fatalf("ICC profile: %d bytes, want %d", len(m.icc), len(icc))
	}
	if !bytes.Contains(m.xmp, []byte(`tiff:Orientation="1"`)) || !bytes.Contains(m.xmp, []byte("GPSLatitude")) {
		t.Fatalf("XMP: %s", m.xmp)
	}
}

func TestResizeRemovesLocationOnRequest(t *testing.T) {
	xmp := []byte(`<x:xmpmeta exif:GPSLatitude="XMP-SECRET-PLACE"/>`)
	src := jpegSegs(encJPEG(t, photo(400, 200, 3), 90), app(0xe1, exifSig, richExif(1)), app(0xe1, xmpSig, xmp))
	out, info, err := ResizeWithInfo(src, ResizeSpec{Side: 200, Details: DetailsNoLocation})
	if err != nil {
		t.Fatal(err)
	}
	if info != (ResizeInfo{Details: "kept", Location: "removed"}) {
		t.Fatalf("info %+v", info)
	}
	if bytes.Contains(out, []byte("GPS-SECRET-PLACE")) || bytes.Contains(out, []byte("XMP-SECRET-PLACE")) {
		t.Fatal("the location reached the copy")
	}
	if _, ok := exifTag(t, out, 0, 0x8825); ok {
		t.Fatal("IFD0 still points to a GPS IFD")
	}
	// the rest stays, readable: camera, time taken, the EXIF IFD
	if !bytes.Contains(out, []byte("CAMERA-MAKER")) || !bytes.Contains(out, []byte("2026:11:17 10:20:30")) {
		t.Fatal("other details went too")
	}
	if w, ok := exifTag(t, out, 0x8769, 0xa002); !ok || w != 200 {
		t.Fatalf("EXIF IFD after the GPS pointer left: %d %v", w, ok)
	}
	if o, ok := exifTag(t, out, 0, 0x0112); !ok || o != 1 {
		t.Fatal("orientation lost")
	}

	// none: no EXIF, XMP or ICC at all
	none, info, err := ResizeWithInfo(src, ResizeSpec{Side: 200, Details: DetailsNone})
	if err != nil {
		t.Fatal(err)
	}
	if info != (ResizeInfo{Details: "removed", Location: "removed"}) {
		t.Fatalf("info %+v", info)
	}
	if m := jpegMeta(none); m.exif != nil || m.xmp != nil || m.icc != nil || bytes.Contains(none, []byte("SECRET")) {
		t.Fatal("details reached a copy that asked for none")
	}

	// a photo with no location: nothing to remove, and the AI is told so
	plain := jpegSegs(encJPEG(t, photo(400, 200, 3), 90), app(0xe1, exifSig, buildTiff([][]tiffEntry{{{tag: 0x0112, typ: 3, count: 1, data: u16(1)}}}, nil)))
	_, info, err = ResizeWithInfo(plain, ResizeSpec{Side: 200, Details: DetailsNoLocation})
	if err != nil || info != (ResizeInfo{Details: "kept", Location: "none"}) {
		t.Fatalf("no location: %+v %v", info, err)
	}
	_, info, err = ResizeWithInfo(encJPEG(t, photo(400, 200, 3), 90), ResizeSpec{Side: 200})
	if err != nil || info != (ResizeInfo{Details: "none", Location: "none"}) {
		t.Fatalf("no details: %+v %v", info, err)
	}
}

func TestResizeDetailsIntoPngAndFormat(t *testing.T) {
	src := jpegSegs(encJPEG(t, photo(400, 200, 3), 90), app(0xe1, exifSig, richExif(1)))
	out, err := Resize(src, ResizeSpec{Side: 200, Format: 2})
	if err != nil {
		t.Fatal(err)
	}
	if _, f := config(t, out); f != "png" {
		t.Fatalf("format %s", f)
	}
	if _, err := png.Decode(bytes.NewReader(out)); err != nil {
		t.Fatalf("the PNG with details does not decode: %v", err)
	}
	m := pngMeta(out)
	if m.exif == nil || !bytes.Contains(m.exif, []byte("GPS-SECRET-PLACE")) {
		t.Fatal("eXIf chunk missing")
	}
	// a format asked for: a copy even at the same size (a HEIC decoded to JPEG, "as PNG")
	same, err := Resize(src, ResizeSpec{Side: 400, Format: 1})
	if err != nil {
		t.Fatalf("same size, asked format: %v", err)
	}
	if c, f := config(t, same); f != "jpeg" || c.Width != 400 {
		t.Fatalf("%s %dx%d", f, c.Width, c.Height)
	}
	if _, err := Resize(src, ResizeSpec{Side: 400}); err != ErrResizeUnchanged {
		t.Fatalf("same size, same format: %v", err)
	}
}

func TestResizeUprightIgnoresTheTag(t *testing.T) {
	// a HEIC decoded by Debian 12's heif-convert: pixels already turned (200x400), the tag still says 6
	src := jpegSegs(encJPEG(t, photo(200, 400, 3), 90), app(0xe1, exifSig, richExif(6)))
	out, err := Resize(src, ResizeSpec{Side: 200, Upright: true, Format: 1})
	if err != nil {
		t.Fatal(err)
	}
	if c, _ := config(t, out); c.Width != 100 || c.Height != 200 {
		t.Fatalf("turned twice: %dx%d", c.Width, c.Height)
	}
	if orientation(out) != 1 {
		t.Fatal("tag not reset")
	}
	v, err := VisionUpright(src)
	if err != nil {
		t.Fatal(err)
	}
	if c, _ := config(t, v); c.Width >= c.Height {
		t.Fatalf("vision turned an upright picture: %dx%d", c.Width, c.Height)
	}
}

func TestResizeDetailsCountTowardTarget(t *testing.T) {
	big := bytes.Repeat([]byte("P"), 200_000)
	var segs [][]byte
	for i := 0; i < 4; i++ {
		segs = append(segs, app(0xe2, iccSig, []byte{byte(i + 1), 4}, big[i*50000:(i+1)*50000]))
	}
	src := jpegSegs(encJPEG(t, photo(1600, 1200, 3), 92), segs...)
	out, err := Resize(src, ResizeSpec{MaxBytes: 300_000})
	if err != nil {
		t.Fatal(err)
	}
	if len(out) > 300_000 {
		t.Fatalf("%d bytes over the target with the details", len(out))
	}
	if len(jpegMeta(out).icc) != len(big) {
		t.Fatal("profile not kept")
	}
	if _, err := Resize(src, ResizeSpec{MaxBytes: 150_000}); err != ErrResizeTarget {
		t.Fatalf("details larger than the target: %v", err)
	}
}

func TestMetaHostileBlocks(t *testing.T) {
	// offsets outside the block, a huge entry count, a loop, a truncated ICC set: no panic, unsafe parts left out
	bad := [][]byte{
		[]byte("II\x2a\x00\xff\xff\xff\x7f"),
		append([]byte("II\x2a\x00\x08\x00\x00\x00\xff\xff"), make([]byte, 40)...),
		[]byte("MM\x00\x2a\x00\x00\x00\x08\x00\x01\x88\x25\x00\x04\x00\x00\x00\x01\x00\x00\x00\x08\x00\x00\x00\x08"),
	}
	for i, x := range bad {
		src := jpegSegs(encJPEG(t, photo(64, 64, 1), 90), app(0xe1, exifSig, x), app(0xe2, iccSig, []byte{1, 3}, []byte("partial")))
		out, err := Resize(src, ResizeSpec{Side: 32, Details: DetailsNoLocation})
		if err != nil {
			t.Fatalf("%d: %v", i, err)
		}
		if m := jpegMeta(out); m.icc != nil {
			t.Fatalf("%d: an incomplete profile was carried", i)
		}
	}
	// webp and png readers on cut data
	for _, b := range [][]byte{[]byte("RIFF\xff\xff\xff\xffWEBPEXIF\xff\xff\xff\x7f"), []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\x10iCCPicc\x00\x00")} {
		_ = readMeta(b, "webp")
		_ = readMeta(b, "png")
	}
}

// the fixtures made on a Mac (tests/fixtures/exif/README): a camera JPEG with a location
func TestResizeRealPhotoDetails(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "tests", "fixtures", "exif", "photo-gps.jpg"))
	if err != nil {
		t.Skip(err)
	}
	out, info, err := ResizeWithInfo(b, ResizeSpec{Side: 100})
	if err != nil {
		t.Fatal(err)
	}
	if info.Location != "kept" || !bytes.Contains(out, []byte("iPhone 15 Pro")) || orientation(out) != 1 {
		t.Fatalf("%+v", info)
	}
	if c, _ := config(t, out); c.Width != 63 || c.Height != 100 {
		t.Fatalf("upright: %dx%d", c.Width, c.Height)
	}
	out, info, err = ResizeWithInfo(b, ResizeSpec{Side: 100, Details: DetailsNoLocation})
	if err != nil || info.Location != "removed" || !bytes.Contains(out, []byte("iPhone 15 Pro")) {
		t.Fatalf("%+v %v", info, err)
	}
	if _, ok := exifTag(t, out, 0, 0x8825); ok {
		t.Fatal("GPS pointer left")
	}
}

// review of feat/photos-heic-keep-meta: removing the location fails closed on unusual GPS layouts, and the report
// matches what is written
func TestRemoveLocationFailsClosed(t *testing.T) {
	secret := []byte("GPS-SECRET-PLACE")
	gps := []tiffEntry{{tag: 0x001c, typ: 7, count: 16, data: secret}}
	cases := map[string][]byte{
		// two GPS pointers in IFD0
		"two pointers": buildTiff([][]tiffEntry{{{tag: 0x8825, typ: 4, count: 1, ifd: 1}, {tag: 0x8825, typ: 4, count: 1, ifd: 2}}, gps, gps}, nil),
		// a GPS pointer inside the EXIF IFD
		"pointer in EXIF IFD": buildTiff([][]tiffEntry{{{tag: 0x8769, typ: 4, count: 1, ifd: 1}}, {{tag: 0x8825, typ: 4, count: 1, ifd: 2}}, gps}, nil),
	}
	for name, exif := range cases {
		src := jpegSegs(encJPEG(t, photo(200, 100, 3), 90), app(0xe1, exifSig, exif))
		out, info, err := ResizeWithInfo(src, ResizeSpec{Side: 100, Details: DetailsNoLocation})
		if err != nil {
			t.Fatal(name, err)
		}
		if bytes.Contains(out, secret) || info.Location != "removed" {
			t.Fatalf("%s: location left (%+v)", name, info)
		}
	}
	// the maker note is zeroed with the location (some cameras keep place names there)
	mk := buildTiff([][]tiffEntry{{{tag: 0x8769, typ: 4, count: 1, ifd: 1}, {tag: 0x8825, typ: 4, count: 1, ifd: 2}}, {{tag: 0x927c, typ: 7, count: 12, data: []byte("CITY-SEOUL!!")}}, gps}, nil)
	out, err := Resize(jpegSegs(encJPEG(t, photo(200, 100, 3), 90), app(0xe1, exifSig, mk)), ResizeSpec{Side: 100, Details: DetailsNoLocation})
	if err != nil || bytes.Contains(out, []byte("CITY-SEOUL")) {
		t.Fatalf("maker note kept: %v", err)
	}
}

func TestReportMatchesWhatIsWritten(t *testing.T) {
	// a PNG with an EXIF block too large for a JPEG segment, copied as JPEG: left out, and reported as none
	big := buildTiff([][]tiffEntry{{{tag: 0x010f, typ: 7, count: 70000, data: bytes.Repeat([]byte("M"), 70000)}, {tag: 0x8825, typ: 4, count: 1, ifd: 1}}, {{tag: 0x0001, typ: 2, count: 2, data: []byte("N\x00")}}}, nil)
	var pngBuf bytes.Buffer
	if err := png.Encode(&pngBuf, photo(200, 100, 3)); err != nil {
		t.Fatal(err)
	}
	p := pngBuf.Bytes()
	src := append(append(append([]byte{}, p[:33]...), (photoMeta{exif: big}).pngChunks()...), p[33:]...)
	out, info, err := ResizeWithInfo(src, ResizeSpec{Side: 100, Format: 1})
	if err != nil {
		t.Fatal(err)
	}
	if jpegMeta(out).exif != nil || info.Location != "none" || info.Details != "none" {
		t.Fatalf("report %+v, exif in copy %v", info, jpegMeta(out).exif != nil)
	}
}

func TestPngOrientationApplied(t *testing.T) {
	// a PNG whose EXIF says 6: turned like a JPEG, so the reset tag matches the pixels
	var pngBuf bytes.Buffer
	if err := png.Encode(&pngBuf, photo(400, 200, 3)); err != nil {
		t.Fatal(err)
	}
	p := pngBuf.Bytes()
	ex := buildTiff([][]tiffEntry{{{tag: 0x0112, typ: 3, count: 1, data: u16(6)}}}, nil)
	src := append(append(append([]byte{}, p[:33]...), (photoMeta{exif: ex}).pngChunks()...), p[33:]...)
	out, err := Resize(src, ResizeSpec{Side: 200})
	if err != nil {
		t.Fatal(err)
	}
	if c, _ := config(t, out); c.Width != 100 || c.Height != 200 {
		t.Fatalf("not turned: %dx%d", c.Width, c.Height)
	}
	if tiffOrientation(pngMeta(out).exif) != 1 {
		t.Fatal("tag not reset")
	}
}

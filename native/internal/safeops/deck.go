package safeops

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"path"
	"regexp"
	"strings"
)

type Slide struct {
	Title  string `json:"title"`
	Notes  bool   `json:"notes"`
	Layout string `json:"layout"`
}
type DeckInfo struct {
	Slides []Slide `json:"slides"`
	Notes  int     `json:"notes"`
}
type relation struct {
	ID     string `xml:"Id,attr"`
	Type   string `xml:"Type,attr"`
	Target string `xml:"Target,attr"`
	Mode   string `xml:"TargetMode,attr"`
}

var partName = regexp.MustCompile(`^(\[Content_Types\]\.xml|_rels/\.rels|docProps/(app|core|custom)\.xml|ppt/(presentation|presProps|viewProps|tableStyles)\.xml|ppt/_rels/presentation\.xml\.rels|ppt/(slides/slide|slideLayouts/slideLayout|slideMasters/slideMaster|notesSlides/notesSlide|notesMasters/notesMaster|theme/theme)[0-9]+\.xml|ppt/(slides/_rels/slide|slideLayouts/_rels/slideLayout|slideMasters/_rels/slideMaster|notesSlides/_rels/notesSlide|notesMasters/_rels/notesMaster)[0-9]+\.xml\.rels|ppt/media/[^/]+\.(jpeg|jpg|png))$`)
var relTypes = map[string]bool{"officeDocument": true, "core-properties": true, "extended-properties": true, "custom-properties": true, "slide": true, "slideLayout": true, "slideMaster": true, "notesSlide": true, "notesMaster": true, "theme": true, "presProps": true, "viewProps": true, "tableStyles": true, "image": true}

// No ZIP member is extracted. Claimed sizes are only early refusals: actual streamed bytes
// and CRCs must also pass before XML or image decoding. No recursive archives/active parts.
func Deck(b []byte) ([]byte, error) {
	bad := func() ([]byte, error) { return nil, fmt.Errorf("unsupported or over-limit presentation") }
	if len(b) > 32<<20 {
		return bad()
	}
	count, ok := zipHeaders(b)
	if !ok {
		return bad()
	}
	z, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil || len(z.File) != count {
		return bad()
	}
	parts := map[string][]byte{}
	seen := map[string]bool{}
	total := 0
	images := 0
	for _, f := range z.File {
		key := strings.ToLower(f.Name)
		if seen[key] || !partName.MatchString(f.Name) || f.Flags&1 != 0 || (f.Method != zip.Store && f.Method != zip.Deflate) || !f.Mode().IsRegular() || f.UncompressedSize64 > 8<<20 {
			return bad()
		}
		seen[key] = true
		if f.UncompressedSize64 > 1<<20 && f.UncompressedSize64 > 100*max(1, f.CompressedSize64) {
			return bad()
		}
		r, e := f.Open()
		if e != nil {
			return bad()
		}
		data, e := ReadBounded(r, 8<<20)
		r.Close()
		total += len(data)
		if e != nil || uint64(len(data)) != f.UncompressedSize64 || total > 48<<20 {
			return bad()
		}
		if strings.HasPrefix(f.Name, "ppt/media/") {
			images++
			if images > 20 {
				return bad()
			}
			format := "jpeg"
			if strings.HasSuffix(f.Name, ".png") {
				format = "png"
			}
			if _, e := Image(data, format); e != nil {
				return bad()
			}
		} else if err := boundedXML(data); err != nil {
			return bad()
		}
		parts[f.Name] = data
	}
	for name, data := range parts {
		if !strings.HasSuffix(name, ".rels") {
			continue
		}
		var rels struct {
			Items []relation `xml:"Relationship"`
		}
		if xml.Unmarshal(data, &rels) != nil {
			return bad()
		}
		ids := map[string]bool{}
		for _, r := range rels.Items {
			if ids[r.ID] || r.ID == "" || r.Mode != "" && r.Mode != "Internal" || !relTypes[path.Base(r.Type)] || strings.ContainsAny(r.Target, "\\:#?\x00") || strings.HasPrefix(r.Target, "/") {
				return bad()
			}
			ids[r.ID] = true
			if _, ok := parts[resolveTarget(name, r.Target)]; !ok {
				return bad()
			}
		}
	}
	// Presentation relationships, rather than orphan slideN.xml files, define the real deck order.
	var pres struct {
		IDs []struct {
			ID string `xml:"http://schemas.openxmlformats.org/officeDocument/2006/relationships id,attr"`
		} `xml:"sldIdLst>sldId"`
	}
	var rels struct {
		Items []relation `xml:"Relationship"`
	}
	if xml.Unmarshal(parts["ppt/presentation.xml"], &pres) != nil || xml.Unmarshal(parts["ppt/_rels/presentation.xml.rels"], &rels) != nil || len(pres.IDs) < 1 || len(pres.IDs) > 30 {
		return bad()
	}
	deck := DeckInfo{Slides: []Slide{}}
	used := map[string]bool{}
	for _, id := range pres.IDs {
		var slidePath string
		for _, r := range rels.Items {
			if r.ID == id.ID && path.Base(r.Type) == "slide" {
				slidePath = resolveTarget("ppt/_rels/presentation.xml.rels", r.Target)
			}
		}
		if slidePath == "" || used[slidePath] {
			return bad()
		}
		used[slidePath] = true
		title := placeholder(parts[slidePath], true)
		if len([]rune(title)) > 60 {
			title = string([]rune(title)[:60])
		}
		sr := path.Join(path.Dir(slidePath), "_rels", path.Base(slidePath)+".rels")
		var rs struct {
			Items []relation `xml:"Relationship"`
		}
		if xml.Unmarshal(parts[sr], &rs) != nil {
			return bad()
		}
		notes := false
		layout := ""
		for _, r := range rs.Items {
			if path.Base(r.Type) == "slideLayout" {
				var l struct {
					CSld struct {
						Name string `xml:"name,attr"`
					} `xml:"cSld"`
				}
				if xml.Unmarshal(parts[resolveTarget(sr, r.Target)], &l) != nil {
					return bad()
				}
				layout = l.CSld.Name
			}
			if path.Base(r.Type) == "notesSlide" {
				notes = placeholder(parts[resolveTarget(sr, r.Target)], false) != ""
			}
		}
		if !map[string]bool{"Title Slide": true, "Title and Content": true, "Section Header": true, "Two Content": true, "Comparison": true, "Content with Caption": true, "Blank": true}[layout] {
			return bad()
		}
		deck.Slides = append(deck.Slides, Slide{title, notes, layout})
		if notes {
			deck.Notes++
		}
	}
	return json.Marshal(deck)
}

// Bound central-directory metadata before archive/zip allocates its entries. Refuse
// ZIP64, split disks, trailing bytes, fabricated entry counts and oversized names.
func zipHeaders(b []byte) (int, bool) {
	if len(b) < 22 || !bytes.Equal(b[:4], []byte{'P', 'K', 3, 4}) {
		return 0, false
	}
	e := -1
	for i := len(b) - 22; i >= 0 && i >= len(b)-65557; i-- {
		if binary.LittleEndian.Uint32(b[i:]) == 0x06054b50 && i+22+int(binary.LittleEndian.Uint16(b[i+20:])) == len(b) {
			e = i
			break
		}
	}
	if e < 0 {
		return 0, false
	}
	u16 := func(o int) int { return int(binary.LittleEndian.Uint16(b[e+o:])) }
	if u16(4) != 0 || u16(6) != 0 || u16(8) != u16(10) {
		return 0, false
	}
	count := u16(10)
	size := uint64(binary.LittleEndian.Uint32(b[e+12:]))
	off := uint64(binary.LittleEndian.Uint32(b[e+16:]))
	if count < 1 || count > 512 || size > 1<<20 || off+size != uint64(e) {
		return 0, false
	}
	p := int(off)
	for i := 0; i < count; i++ {
		if p+46 > e || binary.LittleEndian.Uint32(b[p:]) != 0x02014b50 {
			return 0, false
		}
		name := int(binary.LittleEndian.Uint16(b[p+28:]))
		extra := int(binary.LittleEndian.Uint16(b[p+30:]))
		comment := int(binary.LittleEndian.Uint16(b[p+32:]))
		if name < 1 || name > 255 || extra > 4096 || comment > 4096 {
			return 0, false
		}
		p += 46 + name + extra + comment
		if p > e {
			return 0, false
		}
	}
	return count, p == e
}

func resolveTarget(rels, target string) string {
	base := path.Dir(path.Dir(rels))
	if rels == "_rels/.rels" {
		base = "."
	}
	return path.Clean(path.Join(base, target))
}

func boundedXML(b []byte) error {
	d := xml.NewDecoder(bytes.NewReader(b))
	depth, nodes := 0, 0
	for {
		t, e := d.Token()
		if e == io.EOF {
			if depth != 0 {
				return fmt.Errorf("depth")
			}
			return nil
		}
		if e != nil {
			return e
		}
		nodes++
		if nodes > 100_000 {
			return fmt.Errorf("nodes")
		}
		switch v := t.(type) {
		case xml.Directive:
			return fmt.Errorf("DTD forbidden")
		case xml.StartElement:
			depth++
			if depth > 64 || len(v.Attr) > 64 {
				return fmt.Errorf("depth")
			}
			if v.Name.Local == "oleObj" || v.Name.Local == "control" || v.Name.Local == "hlinkClick" || v.Name.Local == "hlinkHover" {
				return fmt.Errorf("active content")
			}
		case xml.EndElement:
			depth--
		}
	}
}

func placeholder(b []byte, title bool) string {
	var doc struct {
		Shapes []struct {
			NV struct {
				Props struct {
					PH struct {
						Type string `xml:"type,attr"`
					} `xml:"ph"`
				} `xml:"nvPr"`
			} `xml:"nvSpPr"`
			Body struct {
				P []struct {
					R []struct {
						T string `xml:"t"`
					} `xml:"r"`
				} `xml:"p"`
			} `xml:"txBody"`
		} `xml:"cSld>spTree>sp"`
	}
	if xml.Unmarshal(b, &doc) != nil {
		return ""
	}
	var out []string
	for _, s := range doc.Shapes {
		typ := s.NV.Props.PH.Type
		if title && typ != "title" && typ != "ctrTitle" || !title && typ != "body" {
			continue
		}
		for _, p := range s.Body.P {
			for _, r := range p.R {
				out = append(out, r.T)
			}
		}
	}
	return strings.TrimSpace(strings.Join(out, ""))
}

// A small terminal screen for the Claude sign-in (claudelogin.go): the launcher reads what `claude setup-token` shows
// the way a person would see it in a terminal, not as a byte stream. The program draws with cursor movements: a space
// is often a jump to a column (ESC [ n G) and a redraw writes only the cells that changed, so a word or the token can
// arrive in pieces with movements in between. Stripping escape sequences from the stream would glue neighbouring text
// together (a token followed by the next word) or split it; a grid of cells does neither.
//
// Interpreted: printable text (UTF-8, one cell per character), CR, LF, BS, TAB, the cursor movements and erasures of
// CSI (A B C D E F G H f d J K X S), save / restore cursor (ESC 7 / ESC 8), reverse index. Ignored: colours and
// attributes (SGR), modes, queries, character sets. OSC 8 hyperlinks are kept: their targets are the full addresses
// whatever the screen width. Lines that scroll off the top are kept in a short history. Nothing here is written
// anywhere: the screen holds the token for a moment, and wipe() clears it.
package main

import (
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	vtGround = iota
	vtEsc
	vtCSI
	vtOSC
	vtOSCEsc
	vtStr    // DCS / SOS / PM / APC: skipped up to ST
	vtStrEsc //
	vtSkip1  // ESC ( x and friends: one more byte
)

type vtScreen struct {
	rows, cols int
	cells      [][]rune
	r, c       int
	sr, sc     int
	state      int
	params     []byte
	osc        []byte
	pend       []byte // an incomplete UTF-8 sequence at the end of a chunk
	hist       []string
	links      []string
}

const (
	vtMaxHist  = 200
	vtMaxOSC   = 8 << 10
	vtMaxLinks = 32
)

func newScreen(cols, rows int) *vtScreen {
	s := &vtScreen{rows: rows, cols: cols}
	s.cells = make([][]rune, rows)
	for i := range s.cells {
		s.cells[i] = blankRow(cols)
	}
	return s
}

func blankRow(n int) []rune {
	r := make([]rune, n)
	for i := range r {
		r[i] = ' '
	}
	return r
}

func (s *vtScreen) clamp() {
	if s.r < 0 {
		s.r = 0
	}
	if s.r >= s.rows {
		s.r = s.rows - 1
	}
	if s.c < 0 {
		s.c = 0
	}
	if s.c > s.cols {
		s.c = s.cols
	}
}

// scrollUp moves every row up n times; the top row goes into the history.
func (s *vtScreen) scrollUp(n int) {
	for ; n > 0; n-- {
		s.hist = append(s.hist, strings.TrimRight(string(s.cells[0]), " "))
		if len(s.hist) > vtMaxHist {
			s.hist = s.hist[len(s.hist)-vtMaxHist:]
		}
		copy(s.cells, s.cells[1:])
		s.cells[s.rows-1] = blankRow(s.cols)
	}
}

func (s *vtScreen) lineFeed() {
	if s.r == s.rows-1 {
		s.scrollUp(1)
	} else {
		s.r++
	}
}

func (s *vtScreen) put(ch rune) {
	if s.c >= s.cols { // auto-wrap at the right margin
		s.c = 0
		s.lineFeed()
	}
	s.cells[s.r][s.c] = ch
	s.c++
}

func (s *vtScreen) eraseRow(r, from, to int) {
	if r < 0 || r >= s.rows {
		return
	}
	if from < 0 {
		from = 0
	}
	if to > s.cols {
		to = s.cols
	}
	for i := from; i < to; i++ {
		s.cells[r][i] = ' '
	}
}

// feed takes the next bytes the program wrote.
func (s *vtScreen) feed(b []byte) {
	if len(s.pend) > 0 {
		b = append(append([]byte{}, s.pend...), b...)
		s.pend = nil
	}
	for i := 0; i < len(b); {
		ch := b[i]
		switch s.state {
		case vtGround:
			switch {
			case ch == 0x1b:
				s.state = vtEsc
				i++
			case ch == '\r':
				s.c = 0
				i++
			case ch == '\n' || ch == 0x0b || ch == 0x0c:
				s.lineFeed()
				i++
			case ch == '\b':
				if s.c > 0 {
					s.c--
				}
				i++
			case ch == '\t':
				s.c = (s.c/8 + 1) * 8
				if s.c > s.cols-1 {
					s.c = s.cols - 1
				}
				i++
			case ch < 0x20 || ch == 0x7f:
				i++
			case ch < 0x80:
				s.put(rune(ch))
				i++
			default:
				if !utf8.FullRune(b[i:]) {
					if len(b)-i < utf8.UTFMax {
						s.pend = append(s.pend[:0], b[i:]...)
						return
					}
				}
				r, n := utf8.DecodeRune(b[i:])
				s.put(r)
				i += n
			}
		case vtEsc:
			i++
			s.state = vtGround
			switch ch {
			case '[':
				s.state, s.params = vtCSI, s.params[:0]
			case ']':
				s.state, s.osc = vtOSC, s.osc[:0]
			case 'P', 'X', '^', '_':
				s.state = vtStr
			case '(', ')', '*', '+', '-', '.', '/', '#', '%', ' ':
				s.state = vtSkip1
			case '7':
				s.sr, s.sc = s.r, s.c
			case '8':
				s.r, s.c = s.sr, s.sc
			case 'M':
				if s.r > 0 {
					s.r--
				}
			case 'D':
				s.lineFeed()
			case 'E':
				s.c = 0
				s.lineFeed()
			case 'c':
				for r := range s.cells {
					s.eraseRow(r, 0, s.cols)
				}
				s.r, s.c = 0, 0
			}
		case vtSkip1:
			i++
			s.state = vtGround
		case vtCSI:
			i++
			if ch >= 0x40 && ch <= 0x7e {
				s.csi(ch)
				s.state = vtGround
			} else if len(s.params) < 64 {
				s.params = append(s.params, ch)
			}
		case vtOSC:
			i++
			switch {
			case ch == 0x07:
				s.oscEnd()
				s.state = vtGround
			case ch == 0x1b:
				s.state = vtOSCEsc
			case len(s.osc) < vtMaxOSC:
				s.osc = append(s.osc, ch)
			}
		case vtOSCEsc:
			i++
			s.oscEnd() // ESC \ (or any ESC) ends the string
			s.state = vtGround
			if ch != '\\' {
				s.state = vtEsc
				i--
			}
		case vtStr:
			i++
			if ch == 0x1b {
				s.state = vtStrEsc
			} else if ch == 0x07 {
				s.state = vtGround
			}
		case vtStrEsc:
			i++
			s.state = vtGround
		}
	}
}

// csiNums: the numeric parameters (private prefixes such as ? > < = mean modes and queries: no numbers for those).
func (s *vtScreen) csiNums() ([]int, bool) {
	if len(s.params) > 0 && (s.params[0] == '?' || s.params[0] == '>' || s.params[0] == '<' || s.params[0] == '=') {
		return nil, false
	}
	var out []int
	for _, f := range strings.Split(string(s.params), ";") {
		f = strings.TrimSpace(strings.SplitN(f, ":", 2)[0])
		n, err := strconv.Atoi(f)
		if err != nil || n < 0 {
			n = 0
		}
		out = append(out, n)
	}
	return out, true
}

func (s *vtScreen) csi(final byte) {
	p, plain := s.csiNums()
	if !plain {
		return
	}
	arg := func(i, def int) int {
		if i < len(p) && p[i] > 0 {
			return p[i]
		}
		return def
	}
	switch final {
	case 'A':
		s.r -= arg(0, 1)
	case 'B', 'e':
		s.r += arg(0, 1)
	case 'C', 'a':
		s.c += arg(0, 1)
	case 'D':
		s.c -= arg(0, 1)
	case 'E':
		s.r += arg(0, 1)
		s.c = 0
	case 'F':
		s.r -= arg(0, 1)
		s.c = 0
	case 'G', '`':
		s.c = arg(0, 1) - 1
	case 'H', 'f':
		s.r, s.c = arg(0, 1)-1, arg(1, 1)-1
	case 'd':
		s.r = arg(0, 1) - 1
	case 'K':
		switch arg(0, 0) {
		case 0:
			s.eraseRow(s.r, s.c, s.cols)
		case 1:
			s.eraseRow(s.r, 0, s.c+1)
		case 2:
			s.eraseRow(s.r, 0, s.cols)
		}
	case 'J':
		switch arg(0, 0) {
		case 0:
			s.eraseRow(s.r, s.c, s.cols)
			for r := s.r + 1; r < s.rows; r++ {
				s.eraseRow(r, 0, s.cols)
			}
		case 1:
			for r := 0; r < s.r; r++ {
				s.eraseRow(r, 0, s.cols)
			}
			s.eraseRow(s.r, 0, s.c+1)
		default:
			for r := 0; r < s.rows; r++ {
				s.eraseRow(r, 0, s.cols)
			}
		}
	case 'X':
		s.eraseRow(s.r, s.c, s.c+arg(0, 1))
	case 'S':
		s.scrollUp(min(arg(0, 1), s.rows))
	}
	s.clamp()
}

// oscEnd keeps the target of an OSC 8 hyperlink ("8;params;URI"; an empty URI ends a link).
func (s *vtScreen) oscEnd() {
	o := string(s.osc)
	if !strings.HasPrefix(o, "8;") {
		return
	}
	parts := strings.SplitN(o, ";", 3)
	if len(parts) != 3 || parts[2] == "" {
		return
	}
	if n := len(s.links); n > 0 && s.links[n-1] == parts[2] {
		return
	}
	s.links = append(s.links, parts[2])
	if len(s.links) > vtMaxLinks {
		s.links = s.links[len(s.links)-vtMaxLinks:]
	}
}

// lines: the history, then every row of the screen, without trailing blanks.
func (s *vtScreen) lines() []string {
	out := make([]string, 0, len(s.hist)+s.rows)
	out = append(out, s.hist...)
	for _, row := range s.cells {
		out = append(out, strings.TrimRight(string(row), " "))
	}
	return out
}

// text: what the screen shows now (rows only, no history), one line per row.
func (s *vtScreen) text() string {
	var b strings.Builder
	for _, row := range s.cells {
		b.WriteString(strings.TrimRight(string(row), " "))
		b.WriteByte('\n')
	}
	return b.String()
}

// wipe forgets everything the screen saw (the token among it).
func (s *vtScreen) wipe() {
	for r := range s.cells {
		s.eraseRow(r, 0, s.cols)
	}
	for i := range s.hist {
		s.hist[i] = ""
	}
	s.hist, s.links, s.osc, s.pend = nil, nil, nil, nil
}

package main

import (
	"strconv"
	"strings"
	"testing"
)

// the shape of what `claude setup-token` 2.1.305 drew in a real run (docs/DECISIONS.md "Claude 구독 연결: 브라우저에서"),
// with made-up values: words placed with column jumps instead of spaces, the address as an OSC 8 hyperlink and as
// text, terminal queries, mode switches
const fakeAuthorize = "https://claude.com/cai/oauth/authorize?code=true&client_id=c1&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=ch&code_challenge_method=S256&state=st"

func setupTokenScreen(url string) string {
	return "\x1b7\x1b[r\x1b8\x1b[?25h\x1b[?25l\x1b[?2004h\x1b[?2031h\x1b[?1004h\x1b[38;5;174mWelcome\x1b[9Gto\x1b[12GClaude\x1b[19GCode\x1b[24G\x1b[38;5;246mv2.1.305\x1b[39m\r\r\n" +
		"\x1b[6G*\x1b[46G\u2588\u2588\u2588\u2588\u2588\u2593\u2593\u2591\r\r\n\r\r\n" +
		"\x1b[>0q\x1b[?u\x1b]7501;?\x07\x1b[c\x1b[2GThe\x1b[6Gbrowser\x1b[14Gcan't\x1b[20Greturn\r\r\n" +
		"\x1b[2G\x1b[38;5;246mUse\x1b[6Gthe\x1b[10GURL\x1b[14Gbelow\x1b[39m\r\r\n\r\r\n" +
		"\x1b]8;id=1i7bolk;" + url + "\x07\x1b[38;5;246m" + url + "\x1b[39m\x1b]8;;\x07\r\r\n\r\r\n" +
		"\x1b[2GPaste\x1b[8Gcode\x1b[13Ghere\x1b[18G>\r\r\n"
}

func TestScreenReadsTheSignInScreen(t *testing.T) {
	s := newScreen(500, 100)
	// in pieces, cut inside an escape sequence, a hyperlink and a multi-byte character
	b := []byte(setupTokenScreen(fakeAuthorize))
	for i := 0; i < len(b); i += 7 {
		s.feed(b[i:min(i+7, len(b))])
	}
	text := s.text()
	for _, want := range []string{"Welcome to Claude Code v2.1.305", "The browser can't return", "Use the URL below", "Paste code here >", fakeAuthorize} {
		if !strings.Contains(text, want) {
			t.Fatalf("screen lacks %q:\n%s", want, text)
		}
	}
	if !strings.Contains(text, "\u2588\u2588\u2588\u2588\u2588") {
		t.Fatalf("multi-byte text cut: %q", text)
	}
	if len(s.links) != 1 || s.links[0] != fakeAuthorize {
		t.Fatalf("links %q", s.links)
	}
	if got := claudeAuthorizeURL(s.links, s.lines()); got != fakeAuthorize {
		t.Fatalf("authorize URL %q", got)
	}
}

// jumps places words with column jumps, as Claude Code's renderer does
func jumps(text string, col int) string {
	var b strings.Builder
	for _, w := range strings.Split(text, " ") {
		b.WriteString("\x1b[" + strconv.Itoa(col) + "G" + w)
		col += len(w) + 1
	}
	return b.String()
}

const fakeToken = "sk-ant-oat01-" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEfGhIjKlMnOpQrS-AA"

// successScreen: the waiting screen with the masked code, then the success block of 2.1.305 drawn over it (the
// region moved up and cleared, rows with gaps, the token in the warning colour), padded like the real frame so the
// whole is well over 1 KB (macOS hands a 3000-byte write to the reader as 1024 + 1024 + 952)
func successScreen(token string) []byte {
	var b strings.Builder
	b.WriteString(setupTokenScreen(fakeAuthorize))
	b.WriteString("\x1b[1A\x1b[19G" + strings.Repeat("*", 60) + "\r\r\n")
	b.WriteString("\x1b[14A\r\x1b[J")
	// the whole frame again: the welcome header with its block-character art (multi-byte), then the success block
	b.WriteString("\x1b[38;5;174m" + jumps("Welcome to Claude Code", 1) + "\x1b[24G\x1b[38;5;246mv2.1.305\x1b[39m\r\r\n")
	for i := 0; i < 16; i++ {
		b.WriteString("\x1b[" + strconv.Itoa(4+i) + "G\x1b[38;5;174m" + strings.Repeat("\u2588\u2593\u2591", 18) + "\x1b[39m\r\r\n")
	}
	b.WriteString("\x1b[2G\x1b[38;5;114m\u2713" + jumps("Long-lived authentication token created successfully!", 4) + "\x1b[39m\r\r\n\r\r\n")
	b.WriteString(jumps("Your OAuth token (valid for 1 year):", 2) + "\r\r\n\r\r\n")
	b.WriteString("\x1b[2G\x1b[38;5;220m" + token + "\x1b[39m\r\r\n\r\r\n")
	b.WriteString("\x1b[2m" + jumps("Store this token securely. You won't be able to see it again.", 2) + "\x1b[22m\r\r\n")
	b.WriteString("\x1b[2m" + jumps("Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>", 2) + "\x1b[22m\r\r\n")
	b.WriteString("\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1004l\x1b[>4m\x1b[<u\x1b[?2031l\x1b[?2004l\x1b(B\x0f\x1b[?25h\x1b7\x1b[r\x1b8\x1b]0;\x07")
	return []byte(b.String())
}

func tokenOf(s *vtScreen) string { return claudeTokenFrom(s.lines(), s.text()) }

func TestScreenTokenNeverPartial(t *testing.T) {
	full := successScreen(fakeToken)
	if len(full) < 2048 {
		t.Fatalf("the success screen is only %d bytes", len(full))
	}
	// the way macOS hands it over: 1024-byte reads
	s := newScreen(claudeCols, claudeRows)
	for i := 0; i < len(full); i += 1024 {
		s.feed(full[i:min(i+1024, len(full))])
		if got := tokenOf(s); got != "" && got != fakeToken {
			t.Fatalf("after %d bytes: partial token %q", min(i+1024, len(full)), got)
		}
	}
	if got := tokenOf(s); got != fakeToken {
		t.Fatalf("whole screen: %q\n%s", got, s.text())
	}
	// every split point: before the "Store" row is in, nothing; after it, the whole token
	start := strings.Index(string(full), fakeToken)
	for k := 1; k < len(full); k++ {
		s := newScreen(claudeCols, claudeRows)
		s.feed(full[:k])
		got := tokenOf(s)
		if got != "" && got != fakeToken {
			t.Fatalf("split at %d (token starts at %d): partial token %q", k, start, got)
		}
		if k > start && k < start+len(fakeToken) && got != "" {
			t.Fatalf("split at %d inside the token gave %q", k, got)
		}
		s.feed(full[k:])
		if got := tokenOf(s); got != fakeToken {
			t.Fatalf("split at %d: whole screen gives %q", k, got)
		}
	}
}

func TestScreenTokenOnlyInItsBlock(t *testing.T) {
	code := "sk-ant-oat01-" + strings.Repeat("A", 40) + "#x"
	// the typed code echoed in the prompt: the prompt is up, nothing counts
	s := newScreen(claudeCols, claudeRows)
	s.feed([]byte(setupTokenScreen(fakeAuthorize) + "\x1b[1A\x1b[19G" + code + "\r\n"))
	if got := tokenOf(s); got != "" {
		t.Fatalf("the typed code read as the token: %q", got)
	}
	// token-shaped text outside the block (a message above the heading), and a block whose rows are not one token
	s = newScreen(claudeCols, claudeRows)
	s.feed([]byte("note: " + fakeToken + "\r\n\r\nYour OAuth token (valid for 1 year):\r\n\r\n" + fakeToken + " and more\r\n\r\nStore this token securely.\r\n"))
	if got := tokenOf(s); got != "" {
		t.Fatalf("not a whole token row, read as %q", got)
	}
	// a token wrapped over two rows (a narrow terminal) is joined
	s = newScreen(80, 20)
	s.feed([]byte("Your OAuth token (valid for 1 year):\r\n\r\n" + fakeToken + "\r\n\r\nStore this token securely.\r\n"))
	if got := tokenOf(s); got != fakeToken {
		t.Fatalf("wrapped token: %q", got)
	}
	// the heading without the row after the token yet: nothing
	s = newScreen(claudeCols, claudeRows)
	s.feed([]byte("Your OAuth token (valid for 1 year):\r\n\r\n" + fakeToken + "\r\n"))
	if got := tokenOf(s); got != "" {
		t.Fatalf("no Store row yet, read as %q", got)
	}
	s.wipe()
	if strings.Contains(s.text(), "sk-ant") || s.hist != nil || s.links != nil {
		t.Fatal("wipe left the screen")
	}
}

func TestScreenScrollKeepsHistoryAndErases(t *testing.T) {
	s := newScreen(40, 3)
	s.feed([]byte("one\r\ntwo\r\nthree\r\nfour\r\n"))
	if got := strings.Join(s.lines(), "|"); !strings.HasPrefix(got, "one|two|three|four") {
		t.Fatalf("lines %q", got)
	}
	s.feed([]byte("\x1b[H\x1b[2J\x1b[2;3Hxy\x1b[1;1Habc\x1b[1;2H\x1b[K"))
	if got := s.text(); got != "a\n  xy\n\n" {
		t.Fatalf("text %q", got)
	}
	// OSC ended by ST, a DCS string, a character set switch: none of them on the screen
	s.feed([]byte("\x1b[3;1H\x1b]8;;https://a.example/\x1b\\link\x1b]8;;\x1b\\\x1bPq#0\x1b\\\x1b(Bok"))
	if !strings.Contains(s.text(), "linkok") || len(s.links) != 1 || s.links[0] != "https://a.example/" {
		t.Fatalf("text %q links %q", s.text(), s.links)
	}
}

func TestClaudeAuthorizeURLOnlyAnthropicManualRedirect(t *testing.T) {
	for _, bad := range []string{
		strings.Replace(fakeAuthorize, "claude.com", "evil.example", 1),
		strings.Replace(fakeAuthorize, "https://", "http://", 1),
		strings.Replace(fakeAuthorize, "platform.claude.com%2Foauth%2Fcode%2Fcallback", "localhost%3A1234%2Fcallback", 1),
		strings.Replace(fakeAuthorize, "claude.com/", "claude.com:8443/", 1),
		strings.Replace(fakeAuthorize, "https://claude.com", "https://user@claude.com", 1),
	} {
		if got := claudeAuthorizeURL([]string{bad}, []string{bad}); got != "" {
			t.Errorf("accepted %q", bad)
		}
	}
	for _, good := range []string{fakeAuthorize, strings.Replace(fakeAuthorize, "claude.com/cai", "platform.claude.com", 1)} {
		if got := claudeAuthorizeURL(nil, []string{"  " + good + "  "}); got != good {
			t.Errorf("refused %q (got %q)", good, got)
		}
	}
}

func TestClaudeScreenFailure(t *testing.T) {
	cases := []struct {
		text     string
		codeSent bool
		want     string
	}{
		{"Paste code here >", false, ""},
		{"OAuth error: Authentication failed: Invalid authorization code\nPress Enter to retry.", true, "bad_code"},
		{"OAuth error: Failed to exchange authorization code for access token. Please try again.\nPress Enter to retry.", true, "exchange_failed"},
		{"OAuth error: Invalid code. Please make sure the full code was copied", true, "bad_code"},
		{"OAuth error: something\nPress Enter to retry.", false, "cli_error"},
	}
	for _, c := range cases {
		if got := claudeScreenFailure(c.text, c.codeSent); got != c.want {
			t.Errorf("%q codeSent=%v: %q, want %q", c.text, c.codeSent, got, c.want)
		}
	}
	for _, code := range []string{"abc#def", "A-b_c.9~#x"} {
		if !claudeCodeOK(code) {
			t.Errorf("code %q refused", code)
		}
	}
	for _, code := range []string{"abc", "#def", "abc#", "a b#c", "abc#d\r", "abc#d\x1b[A", "a#b#c", "abc#def\n", "sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAA#x", "x#SK-ANT-oat01-y"} {
		if claudeCodeOK(code) {
			t.Errorf("code %q accepted", code)
		}
	}
}

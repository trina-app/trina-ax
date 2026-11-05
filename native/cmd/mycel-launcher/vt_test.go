package main

import (
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

func TestScreenTokenIsWhatTheScreenShows(t *testing.T) {
	tok := "sk-ant-oat01-" + strings.Repeat("A", 40) + "_tail-" + strings.Repeat("z", 40)
	s := newScreen(200, 20)
	// first frame: the prompt row
	s.feed([]byte("\x1b[2GPaste\x1b[8Gcode\x1b[13Ghere\x1b[18G>\x1b[20G*********\r\n"))
	// second frame: the token drawn over the same row, cells that already match skipped with a column jump (a
	// renderer that writes only changed cells), the next word right after it with a jump: never glued to the token
	s.feed([]byte("\x1b[1A\r\x1b[2K\x1b[33m" + tok[:20] + "\x1b[" + "23G" + tok[22:] + "\x1b[39m\x1b[110GStore\x1b[116Gthis\r\n"))
	s.feed([]byte("\x1b[1A\x1b[21G" + tok[20:22]))
	m := claudeTokenRe.FindStringSubmatch(strings.Join(s.lines(), "\n"))
	if m == nil || m[1] != tok {
		t.Fatalf("token %q, screen:\n%s", m, s.text())
	}
	// a stream that only drops the escapes would have glued "Store" to it or cut it at the jump
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
		if !claudeCodeRe.MatchString(code) {
			t.Errorf("code %q refused", code)
		}
	}
	for _, code := range []string{"abc", "#def", "abc#", "a b#c", "abc#d\r", "abc#d\x1b[A", "a#b#c", "abc#def\n"} {
		if claudeCodeRe.MatchString(code) {
			t.Errorf("code %q accepted", code)
		}
	}
}

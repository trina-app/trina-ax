package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestPTYIsTheProgramsTerminal(t *testing.T) {
	pt, err := openPTY(500, 100)
	if err != nil {
		t.Fatal(err)
	}
	defer pt.close()
	cmd := exec.Command("/bin/sh", "-c", `test -t 0 && test -t 1 && test -t 2 && echo TTY; stty size; stty raw -echo && echo RAW; IFS= read -r x; echo "got:$x"`)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = pt.slave, pt.slave, pt.slave
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pt.closeSlave()
	var out strings.Builder
	buf := make([]byte, 4096)
	wrote := false
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		n, err := pt.read(buf, 100)
		out.Write(buf[:n])
		if !wrote && strings.Contains(out.String(), "RAW") {
			wrote = true
			// raw mode: the line ends at a newline we send ourselves
			_ = pt.write([]byte("hello\n"))
		}
		if err != nil {
			break
		}
	}
	_ = cmd.Wait()
	s := out.String()
	for _, want := range []string{"TTY", "100 500", "RAW", "got:hello"} {
		if !strings.Contains(s, want) {
			t.Fatalf("output lacks %q: %q", want, s)
		}
	}
	if _, err := pt.read(buf, 10); err != errPTYClosed {
		t.Fatalf("after the program: %v", err)
	}
}

// fakeClaude writes a stand-in for `claude setup-token` named claude: it refuses to run without a terminal, draws the
// address and the paste prompt like 2.1.305 (column jumps, hyperlink), reads a pasted code and prints a token for
// good#state, else the 401 error and waits for Enter. mode "slow" never prints the prompt; "linger" stays after the
// token; "ignore" ignores SIGTERM; "evil" shows another site's address; "die" ends before the prompt with a message;
// "hang" shows nothing after the code.
func fakeClaude(t *testing.T, mode string) string {
	dir := t.TempDir()
	p := filepath.Join(dir, "claude")
	trap := ""
	if mode == "ignore" {
		trap = "trap '' TERM\n"
	}
	prompt := `printf '\033[2GPaste\033[8Gcode\033[13Ghere\033[18G>\r\n'`
	if mode == "slow" {
		prompt = "sleep 60"
	}
	if mode == "die" {
		prompt = `printf 'bwrap: Can\047t find source path /x: No such file or directory\r\n'; exit 1`
	}
	addr := fakeAuthorize
	if mode == "evil" {
		addr = strings.Replace(fakeAuthorize, "claude.com", "claude.evil.example", 1)
	}
	after := "sleep 0.2; exit 0"
	if mode == "linger" {
		after = "sleep 60"
	}
	exchange := ""
	if mode == "hang" {
		exchange = "sleep 60"
	}
	script := `#!/bin/sh
` + trap + `[ "$1" = "setup-token" ] || { echo "fake claude: only setup-token" >&2; exit 2; }
[ -t 0 ] && [ -t 1 ] || { echo "fake claude: needs a terminal" >&2; exit 3; }
[ "$BROWSER" = "true" ] || { echo "fake claude: would open a browser" >&2; exit 4; }
stty -echo
U='` + addr + `'
printf '\033[?2004h\033[38;5;174mWelcome\033[9Gto\033[12GClaude\033[19GCode\033[39m\r\n\r\n'
printf '\033]8;id=1;%s\007\033[38;5;246m%s\033[39m\033]8;;\007\r\n\r\n' "$U" "$U"
` + prompt + `
IFS= read -r line
code=$(printf '%s' "$line" | tr -d '\033\r' | sed -e 's/\[200~//' -e 's/\[201~//')
` + exchange + `
if [ "$code" = "good#state" ]; then
  printf '\033[1A\r\033[J\033[32m\342\234\223 Long-lived authentication token created successfully!\033[39m\r\n\r\n'
  printf 'Your OAuth token (valid for 1 year):\r\n\r\n\033[33m%s\033[39m\r\n\r\n\033[2mStore\033[7Gthis\033[12Gtoken\033[18Gsecurely.\033[22m\r\n' "sk-ant-oat01-` + strings.Repeat("x", 80) + `fakeTOKEN"
  ` + after + `
fi
printf 'OAuth error: Authentication failed: Invalid authorization code\r\n\r\nPress Enter to retry.\r\n'
IFS= read -r x
exit 1
`
	if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

type signIn struct {
	t    *testing.T
	evs  chan map[string]any
	stop chan struct{}
	code chan string
	done chan error
}

// startSignIn runs claudeLogin as serve() would, with this test's launcher settings, and collects its events.
func startSignIn(t *testing.T, bin, loginID string, timeoutMs int64, extra ...map[string]any) *signIn {
	t.Helper()
	root := t.TempDir()
	oldRoot, oldAllow, oldPort := *agentRoot, allowCmd, *proxyPort
	*agentRoot, allowCmd, *proxyPort = root, multi{bin}, 47999
	t.Cleanup(func() { *agentRoot, allowCmd, *proxyPort = oldRoot, oldAllow, oldPort })
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	mine, theirs := os.NewFile(uintptr(fds[0]), "a"), os.NewFile(uintptr(fds[1]), "b")
	ca, _ := net.FileConn(mine)
	cb, _ := net.FileConn(theirs)
	mine.Close()
	theirs.Close()
	s := &signIn{t: t, evs: make(chan map[string]any, 64), stop: make(chan struct{}), code: make(chan string, 1), done: make(chan error, 1)}
	go func() {
		sc := bufio.NewScanner(cb)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		for sc.Scan() {
			var m map[string]any
			if json.Unmarshal(sc.Bytes(), &m) == nil {
				s.evs <- m
			}
		}
	}()
	m := map[string]any{"op": "claude-login", "cmd": bin, "proxy": "http://turn:" + strings.Repeat("t", 20) + "@127.0.0.1:47999", "loginId": loginID, "timeoutMs": timeoutMs}
	for _, e := range extra {
		for k, v := range e {
			m[k] = v
		}
	}
	req, _ := json.Marshal(m)
	go func() {
		err := claudeLogin(req, &out{c: ca.(*net.UnixConn)}, claudeControl{stop: s.stop, codes: s.code})
		ca.Close()
		s.done <- err
	}()
	t.Cleanup(func() { cb.Close() })
	return s
}

func (s *signIn) next(ev string) map[string]any {
	s.t.Helper()
	tm := time.After(20 * time.Second)
	for {
		select {
		case m := <-s.evs:
			switch m["ev"] {
			case ev:
				return m
			case "started", "claude_url", "claude_code", "claude_failed", "claude_token", "exit", "error":
			default:
				s.t.Fatalf("unexpected event %v (the program's output must never be forwarded)", m)
			}
			if m["ev"] == "exit" || m["ev"] == "error" {
				s.t.Fatalf("ended before %s: %v", ev, m)
			}
		case <-tm:
			s.t.Fatalf("no %s", ev)
		}
	}
}

// rest: every event up to and including exit
func (s *signIn) rest() []map[string]any {
	s.t.Helper()
	var all []map[string]any
	tm := time.After(30 * time.Second)
	for {
		select {
		case m := <-s.evs:
			all = append(all, m)
			if m["ev"] == "exit" || m["ev"] == "error" {
				return all
			}
		case <-tm:
			s.t.Fatalf("no exit; got %v", all)
		}
	}
}

func folderGone(t *testing.T) {
	t.Helper()
	ents, _ := os.ReadDir(filepath.Join(*agentRoot, claudeLoginDir))
	if len(ents) != 0 {
		t.Fatalf("sign-in folder left: %v", ents)
	}
}

func evOf(all []map[string]any, ev string) map[string]any {
	for _, m := range all {
		if m["ev"] == ev {
			return m
		}
	}
	return nil
}

func TestClaudeLoginHappyPath(t *testing.T) {
	s := startSignIn(t, fakeClaude(t, ""), "login-happy-0000001", 0)
	s.next("started")
	u := s.next("claude_url")
	if u["url"] != fakeAuthorize {
		t.Fatalf("url %v", u["url"])
	}
	// the folder exists while it runs, with the program's HOME and config inside
	if _, err := os.Stat(filepath.Join(*agentRoot, claudeLoginDir, "login-happy-0000001", "config")); err != nil {
		t.Fatal(err)
	}
	s.code <- " good#state "
	if c := s.next("claude_code"); c["ok"] != true {
		t.Fatalf("code %v", c)
	}
	all := s.rest()
	tok := evOf(all, "claude_token")
	if tok == nil {
		t.Fatalf("no token: %v", all)
	}
	b, _ := base64.StdEncoding.DecodeString(tok["b64"].(string))
	if string(b) != "sk-ant-oat01-"+strings.Repeat("x", 80)+"fakeTOKEN" {
		t.Fatalf("token %q", b)
	}
	if ex := all[len(all)-1]; ex["ev"] != "exit" || ex["code"] != float64(0) || ex["signal"] != nil {
		t.Fatalf("exit %v", ex)
	}
	if err := <-s.done; err != nil {
		t.Fatal(err)
	}
	folderGone(t)
}

func TestClaudeLoginWrongCode(t *testing.T) {
	s := startSignIn(t, fakeClaude(t, ""), "login-wrong-00000001", 0)
	s.next("claude_url")
	// not a code at all: refused before the program sees it, and the sign-in waits for a real one
	s.code <- "no-hash\x1b[A"
	if c := s.next("claude_code"); c["ok"] != false {
		t.Fatalf("code %v", c)
	}
	s.code <- "wrong#state"
	if c := s.next("claude_code"); c["ok"] != true {
		t.Fatalf("code %v", c)
	}
	all := s.rest()
	if f := evOf(all, "claude_failed"); f == nil || f["reason"] != "bad_code" {
		t.Fatalf("failed %v", all)
	}
	if evOf(all, "claude_token") != nil {
		t.Fatal("token after a wrong code")
	}
	if ex := all[len(all)-1]; ex["signal"] != "failed" {
		t.Fatalf("exit %v", ex)
	}
	<-s.done
	folderGone(t)
}

func TestClaudeLoginCancelAndTimeout(t *testing.T) {
	s := startSignIn(t, fakeClaude(t, "ignore"), "login-cancel-0000001", 0)
	s.next("claude_url")
	close(s.stop)
	all := s.rest()
	if ex := all[len(all)-1]; ex["ev"] != "exit" || ex["signal"] != "stopped" {
		t.Fatalf("exit %v", ex)
	}
	<-s.done
	folderGone(t)

	s2 := startSignIn(t, fakeClaude(t, "slow"), "login-timeout-000001", 1500)
	s2.next("started")
	all = s2.rest()
	if ex := all[len(all)-1]; ex["signal"] != "timeout" || evOf(all, "claude_url") != nil {
		t.Fatalf("events %v", all)
	}
	<-s2.done
	folderGone(t)
}

func TestClaudeLoginOnlyAnthropicsAddress(t *testing.T) {
	s := startSignIn(t, fakeClaude(t, "evil"), "login-evil-000000001", 0)
	s.next("started")
	all := s.rest()
	if evOf(all, "claude_url") != nil {
		t.Fatalf("another site's address was passed on: %v", all)
	}
	if f := evOf(all, "claude_failed"); f == nil || f["reason"] != "unexpected_url" {
		t.Fatalf("events %v", all)
	}
	<-s.done
	folderGone(t)
}

func TestClaudeLoginTokenShapedCodeIsNotTyped(t *testing.T) {
	s := startSignIn(t, fakeClaude(t, ""), "login-shape-00000001", 0)
	s.next("claude_url")
	s.code <- "sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAA#x"
	if c := s.next("claude_code"); c["ok"] != false {
		t.Fatalf("code %v", c)
	}
	close(s.stop)
	all := s.rest()
	if evOf(all, "claude_token") != nil {
		t.Fatalf("a token: %v", all)
	}
	<-s.done
}

func TestClaudeLoginExchangeDeadline(t *testing.T) {
	s := startSignIn(t, fakeClaude(t, "hang"), "login-hang-000000001", 0, map[string]any{"exchangeTimeoutMs": 1500})
	s.next("claude_url")
	t0 := time.Now()
	s.code <- "good#state"
	s.next("claude_code")
	all := s.rest()
	if f := evOf(all, "claude_failed"); f == nil || f["reason"] != "exchange_failed" || evOf(all, "claude_token") != nil {
		t.Fatalf("events %v", all)
	}
	if d := time.Since(t0); d > 10*time.Second {
		t.Fatalf("took %v", d)
	}
	<-s.done
	folderGone(t)
}

func TestClearSignInLeftovers(t *testing.T) {
	root := t.TempDir()
	old := *agentRoot
	*agentRoot = root
	defer func() { *agentRoot = old }()
	for _, p := range []string{".claude-login/abc/config", ".codex-login/def", "chat-1/.home"} {
		if err := os.MkdirAll(filepath.Join(root, p), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	_ = os.WriteFile(filepath.Join(root, ".codex-login/def/auth.json"), []byte("{}"), 0o600)
	clearSignInLeftovers()
	for _, gone := range []string{".claude-login", ".codex-login"} {
		if _, err := os.Lstat(filepath.Join(root, gone)); !os.IsNotExist(err) {
			t.Errorf("%s left: %v", gone, err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "chat-1/.home")); err != nil {
		t.Errorf("a chat folder went too: %v", err)
	}
}

func TestClaudeLoginSaysWhyWhenTheProgramCannotStart(t *testing.T) {
	s := startSignIn(t, fakeClaude(t, "die"), "login-die-0000000001", 0)
	s.next("started")
	all := s.rest()
	f := evOf(all, "claude_failed")
	if f == nil || f["reason"] != "cli_exit" || !strings.Contains(f["detail"].(string), "Can't find source path /x") {
		t.Fatalf("events %v", all)
	}
	if ex := all[len(all)-1]; ex["code"] != float64(1) {
		t.Fatalf("exit %v", ex)
	}
	<-s.done
	folderGone(t)
}

func TestClaudeLoginLingeringProgramStillHandsTheToken(t *testing.T) {
	if testing.Short() {
		t.Skip("waits for the token grace period")
	}
	s := startSignIn(t, fakeClaude(t, "linger"), "login-linger-0000001", 0)
	s.next("claude_url")
	s.code <- "good#state"
	all := s.rest()
	if evOf(all, "claude_token") == nil {
		t.Fatalf("no token: %v", all)
	}
	<-s.done
	folderGone(t)
}

func TestClaudeLoginRefusals(t *testing.T) {
	bin := fakeClaude(t, "")
	other := filepath.Join(filepath.Dir(bin), "codex")
	_ = os.WriteFile(other, []byte("#!/bin/sh\nexit 0\n"), 0o755)
	root := t.TempDir()
	oldRoot, oldAllow, oldPort := *agentRoot, allowCmd, *proxyPort
	*agentRoot, allowCmd, *proxyPort = root, multi{bin, other}, 47999
	defer func() { *agentRoot, allowCmd, *proxyPort = oldRoot, oldAllow, oldPort }()
	good := map[string]any{"op": "claude-login", "cmd": bin, "proxy": "http://turn:" + strings.Repeat("t", 20) + "@127.0.0.1:47999", "loginId": "login-refused-000001"}
	for name, change := range map[string]map[string]any{
		"not allowed":     {"cmd": "/bin/sh"},
		"not claude":      {"cmd": other},
		"proxy elsewhere": {"proxy": "http://turn:" + strings.Repeat("t", 20) + "@127.0.0.1:48000"},
		"proxy host":      {"proxy": "http://turn:" + strings.Repeat("t", 20) + "@10.0.0.1:47999"},
		"bad login id":    {"loginId": "../x"},
	} {
		req := map[string]any{}
		for k, v := range good {
			req[k] = v
		}
		for k, v := range change {
			req[k] = v
		}
		line, _ := json.Marshal(req)
		if err := claudeLogin(line, nil, claudeControl{}); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	*proxyPort = 0
	line, _ := json.Marshal(good)
	if err := claudeLogin(line, nil, claudeControl{}); err == nil {
		t.Error("no model proxy: accepted")
	}
}

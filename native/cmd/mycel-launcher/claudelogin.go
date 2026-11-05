// Claude sign-in for an AI connection (docs/DECISIONS.md "Claude 구독 연결: 브라우저에서"): the server asks the launcher
// to run the official, unmodified `claude setup-token` as the engine account, the way codex-login v2 runs
// `codex login --device-auth` (codex.go codexSignIn):
//
//	{"op":"claude-login","cmd":<allowed claude>,"proxy":"http://turn:<one-time token>@127.0.0.1:<--proxy-port>",
//	 "loginId":<id>,"timeoutMs":N}
//	later on the same connection: {"op":"code","code":"<code>#<state>"} (once) and {"op":"kill"}
//
// It runs in a fresh folder <agent root>/.claude-login/<loginId> (HOME, CLAUDE_CONFIG_DIR, TMPDIR inside it, relative
// to the working folder as for a turn), under the engine sandbox (macOS sandbox-exec with LOGIN_TTY and never the
// account's own login; Linux bwrap + its cgroup), with network only through the model proxy (HTTPS_PROXY, a token the
// proxy accepts only from this process and only towards platform.claude.com:443). setup-token is a full-screen
// program that needs a terminal: the launcher opens a pseudo-terminal (pty.go) and reads the screen (vt.go).
//
// Answers: {"ev":"started","pid"} (the server binds the proxy token to it), {"ev":"claude_url","url"} once the
// authorize address and the paste prompt are on the screen, {"ev":"claude_code","ok"} after a code was typed (or
// refused), {"ev":"claude_failed","reason"} when the program shows an error, {"ev":"claude_token","b64"} when it
// printed the token, then {"ev":"exit","code","signal"} or {"ev":"error","message"}. Nothing the program prints is
// forwarded: the screen holds the token, so only these events leave the launcher, and the token only on this socket
// (never a log line, never an error message). The folder is removed in every case before "exit".
package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	claudeLoginDir = ".claude-login"
	// a wide terminal: the authorize address (about 330 characters) and the token stay on one row
	claudeCols, claudeRows = 500, 100
	// the program exits on its own half a second after it shows the token; one that lingers is stopped
	claudeTokenGrace = 15 * time.Second
	// a code goes in as a terminal paste, Enter after a pause (one keystroke the program reads on its own)
	claudeEnterDelay = 300 * time.Millisecond
)

var (
	// what `claude setup-token` 2.1.305 prints (sk-ant-oat01-…), as the paste path accepts it
	// (server/src/credentials/validate.ts CLAUDE_TOKEN_RE)
	claudeTokenRe = regexp.MustCompile(`(?:^|[^A-Za-z0-9_-])(sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20,1000})(?:$|[^A-Za-z0-9_-])`)
	// the code the browser page shows after approval: <authorization code>#<state>. Nothing else can be typed into
	// the program (no control keys, no spaces, no second line).
	claudeCodeRe = regexp.MustCompile(`^[A-Za-z0-9._~-]{1,512}#[A-Za-z0-9._~-]{1,512}$`)
	claudeURLRe  = regexp.MustCompile(`https://[A-Za-z0-9.-]+/[^\s"'<>]*oauth/authorize\?[^\s"'<>]+`)
)

// claudeLoginEnv: the program's whole environment (the server sends none). No browser is ever opened: BROWSER is a
// program that does nothing (and inside the sandbox it cannot be started at all; neither can the callback listener,
// so setup-token falls back to the address and the paste prompt). Telemetry, error reports, updates, feature flags
// and the other background requests are off, so the exchange is the only network use.
func claudeLoginEnv(proxy string) []string {
	return []string{"PATH=/usr/bin:/bin", "HOME=./home", "CLAUDE_CONFIG_DIR=./config", "TMPDIR=./tmp", "CLAUDE_CODE_TMPDIR=./tmp",
		"LANG=en_US.UTF-8", "TERM=xterm-256color", "BROWSER=true", "SSL_CERT_FILE=/etc/ssl/cert.pem", "HTTPS_PROXY=" + proxy,
		"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1", "DISABLE_TELEMETRY=1", "DISABLE_ERROR_REPORTING=1", "DISABLE_AUTOUPDATER=1",
		"DISABLE_GROWTHBOOK=1", "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1", "DISABLE_INSTALLATION_CHECKS=1",
		"CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1"}
}

// claudeAuthorizeURL: the sign-in address setup-token shows, only Anthropic's own authorize page with the manual
// redirect (the page that shows the code to paste). The hyperlink target first (the whole address whatever the
// terminal width), then the screen text.
func claudeAuthorizeURL(links, lines []string) string {
	ok := func(s string) bool {
		u, err := url.Parse(s)
		if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || !strings.HasSuffix(u.Path, "/oauth/authorize") {
			return false
		}
		switch u.Host {
		case "claude.com", "claude.ai", "platform.claude.com":
		default:
			return false
		}
		return u.Query().Get("redirect_uri") == "https://platform.claude.com/oauth/code/callback"
	}
	for i := len(links) - 1; i >= 0; i-- {
		if ok(links[i]) {
			return links[i]
		}
	}
	for i := len(lines) - 1; i >= 0; i-- {
		if m := claudeURLRe.FindString(lines[i]); m != "" && ok(m) {
			return m
		}
	}
	return ""
}

// claudeScreenFailure: the program shows an error on its screen (setup-token waits for Enter to retry then). Before
// a code: it could not start the sign-in; after: Anthropic refused the code, or the exchange failed.
func claudeScreenFailure(text string, codeSent bool) string {
	if !strings.Contains(text, "OAuth error") && !strings.Contains(text, "Press Enter to retry") && !strings.Contains(text, "Invalid code") {
		return ""
	}
	if !codeSent {
		return "cli_error"
	}
	if strings.Contains(text, "Invalid authorization code") || strings.Contains(text, "Invalid code") {
		return "bad_code"
	}
	return "exchange_failed"
}

type claudeLoginRequest struct {
	Op        string `json:"op"`
	Cmd       string `json:"cmd"`
	Proxy     string `json:"proxy"`
	LoginID   string `json:"loginId"`
	TimeoutMs int64  `json:"timeoutMs"`
}

// claudeControl: what the server sends after the request (codes, kill / hang-up)
type claudeControl struct {
	stop  <-chan struct{}
	codes <-chan string
}

// claudeLogin validates the request and runs the sign-in.
func claudeLogin(line []byte, o *out, ctl claudeControl) error {
	var req claudeLoginRequest
	if err := json.Unmarshal(line, &req); err != nil {
		return fmt.Errorf("bad request")
	}
	if !allowedCmd(req.Cmd) || filepath.Base(req.Cmd) != "claude" {
		return fmt.Errorf("engine %q is not allowed", req.Cmd)
	}
	m := proxyURLRe.FindStringSubmatch(req.Proxy)
	if m == nil || m[1] != strconv.Itoa(*proxyPort) || *proxyPort == 0 {
		return fmt.Errorf("bad proxy (the sign-in goes through the model proxy on port %d)", *proxyPort)
	}
	if !loginIDRe.MatchString(req.LoginID) {
		return fmt.Errorf("bad login id")
	}
	// one sign-in at a time, ChatGPT or Claude (both run in the launcher's login slot)
	select {
	case codexLoginSem <- struct{}{}:
	case <-ctl.stop:
		return fmt.Errorf("stopped")
	}
	defer func() { <-codexLoginSem }()
	parent := filepath.Join(filepath.Clean(*agentRoot), claudeLoginDir)
	// whatever an earlier sign-in left (a launcher killed mid-way): nothing else runs here now
	_ = os.RemoveAll(parent)
	if err := os.Mkdir(parent, 0o700); err != nil {
		return err
	}
	if st, err := os.Lstat(parent); err != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("bad sign-in folder")
	}
	dir := filepath.Join(parent, req.LoginID)
	defer os.RemoveAll(dir)
	if err := freshDir(dir); err != nil {
		return err
	}
	for _, d := range []string{"home", "config", "tmp"} {
		if err := freshDir(filepath.Join(dir, d)); err != nil {
			return err
		}
	}
	pt, err := openPTY(claudeCols, claudeRows)
	if err != nil {
		return fmt.Errorf("terminal: %v", err)
	}
	defer pt.close()
	te, err := beginLoginAs(dir, "claude-login")
	if err != nil {
		return err
	}
	defer te.cleanup()
	// macOS: the profile opens this one terminal (LOGIN_TTY) and never the account's own login (LOCAL_LOGIN=0)
	te.sb = sbOpts{tty: pt.name, noLocalLogin: true}
	cmd, cleanup, err := te.command(req.Cmd, []string{"setup-token"}, dir, dir)
	if err != nil {
		return err
	}
	defer cleanup()
	cmd.Dir = dir
	cmd.Env = claudeLoginEnv(req.Proxy)
	timeout := time.Duration(req.TimeoutMs) * time.Millisecond
	if timeout <= 0 || timeout > 20*time.Minute {
		timeout = 16 * time.Minute
	}
	r := runClaudeLogin(cmd, pt, te, o, ctl, timeout)
	if r.token != "" {
		o.send(map[string]any{"ev": "claude_token", "b64": base64.StdEncoding.EncodeToString([]byte(r.token))})
		r.token = ""
	}
	_ = os.RemoveAll(dir) // before "exit": nothing of the sign-in stays on the engine account
	ev := map[string]any{"ev": "exit", "code": r.code}
	if r.sig != "" {
		ev["signal"] = r.sig
	}
	o.send(ev)
	return nil
}

type claudeResult struct {
	code  int
	sig   string
	token string
}

// runClaudeLogin starts the program on the terminal (new session, the terminal as its controlling terminal), reads
// its screen until it ends and types the code once. The terminal is read until the program is gone (also while it is
// being stopped): a process that exits with output still queued for the terminal waits until it is read.
func runClaudeLogin(cmd *exec.Cmd, pt *ptyPair, te *turnEnv, o *out, ctl claudeControl, timeout time.Duration) claudeResult {
	cmd.Stdin, cmd.Stdout, cmd.Stderr = pt.slave, pt.slave, pt.slave
	attr := te.procAttr()
	attr.Setsid, attr.Setctty, attr.Ctty = true, true, 0
	cmd.SysProcAttr = attr
	if err := cmd.Start(); err != nil {
		o.send(map[string]any{"ev": "error", "message": err.Error()})
		return claudeResult{code: -1, sig: "error"}
	}
	pt.closeSlave()
	pid := cmd.Process.Pid
	live.add(pid)
	defer live.del(pid)
	o.send(map[string]any{"ev": "started", "pid": pid, "pgid": pid})

	chunks := make(chan []byte, 16)
	quit := make(chan struct{})
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		defer close(chunks)
		buf := make([]byte, 32<<10)
		for {
			n, err := pt.read(buf, 200)
			if n > 0 {
				c := append([]byte(nil), buf[:n]...)
				select {
				case chunks <- c:
				case <-quit:
					return
				}
			}
			if err != nil {
				return
			}
			select {
			case <-quit:
				return
			default:
			}
		}
	}()
	// the reader is gone before the terminal is closed (claudeLogin): a closed descriptor number can be reused
	defer func() { close(quit); <-readerDone }()
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()

	scr := newScreen(claudeCols, claudeRows)
	defer scr.wipe()
	var (
		res                claudeResult
		urlSent, failed    string
		codeSent, stopping bool
		werr               error
		enter, grace       <-chan time.Time
		killHard, giveUp   <-chan time.Time
		noURL              <-chan time.Time
		deadline           = time.After(timeout)
		stopChan, codeChan = ctl.stop, ctl.codes
	)
	stop := func(why string) {
		if stopping {
			return
		}
		stopping = true
		res.sig = why
		_ = syscall.Kill(-pid, syscall.SIGTERM)
		killHard = time.After(5 * time.Second)
	}
	look := func() {
		lines := scr.lines()
		text := strings.Join(lines, "\n")
		if urlSent == "" && !codeSent && strings.Contains(text, "Paste code here") {
			if u := claudeAuthorizeURL(scr.links, lines); u != "" {
				urlSent, noURL = u, nil
				o.send(map[string]any{"ev": "claude_url", "url": u})
			} else if noURL == nil && !stopping {
				// the prompt without Anthropic's address (a changed CLI, another page): a moment for the rest of the
				// screen, then the sign-in ends; another address is never shown to the person
				noURL = time.After(2 * time.Second)
			}
		}
		if codeSent && res.token == "" && failed == "" {
			if m := claudeTokenRe.FindStringSubmatch(text); m != nil {
				res.token = m[1]
				grace = time.After(claudeTokenGrace)
			}
		}
		if res.token == "" && failed == "" && !stopping {
			if f := claudeScreenFailure(text, codeSent); f != "" {
				failed = f
				o.send(map[string]any{"ev": "claude_failed", "reason": f})
				stop("failed")
			}
		}
	}
	for exited != nil || chunks != nil {
		select {
		case c, ok := <-chunks:
			if !ok {
				chunks = nil
				continue
			}
			scr.feed(c)
			look()
		case code := <-codeChan:
			code = strings.TrimSpace(code)
			if urlSent == "" || codeSent || stopping || !claudeCodeRe.MatchString(code) {
				o.send(map[string]any{"ev": "claude_code", "ok": false})
				continue
			}
			codeSent = true
			// a terminal paste (setup-token turns bracketed paste on), then Enter on its own
			_ = pt.write([]byte("\x1b[200~" + code + "\x1b[201~"))
			enter = time.After(claudeEnterDelay)
			o.send(map[string]any{"ev": "claude_code", "ok": true})
		case <-enter:
			enter = nil
			_ = pt.write([]byte("\r"))
		case <-stopChan:
			stopChan = nil
			stop("stopped")
		case <-deadline:
			stop("timeout")
		case <-grace:
			grace = nil
			stop("") // the token is on the screen; the program did not end by itself
		case <-killHard:
			killHard = nil
			_ = syscall.Kill(-pid, syscall.SIGKILL)
		case werr = <-exited:
			exited = nil
			_ = syscall.Kill(-pid, syscall.SIGKILL) // nothing of the sign-in survives it
			giveUp = time.After(2 * time.Second)    // the rest of the screen (the token may be in it), then go on
		case <-giveUp:
			chunks = nil
		case <-noURL:
			noURL = nil
			if urlSent == "" && failed == "" {
				failed = "unexpected_url"
				o.send(map[string]any{"ev": "claude_failed", "reason": failed})
				stop("failed")
			}
		}
	}
	res.sig = te.finish(res.sig)
	if ee, ok := werr.(*exec.ExitError); ok {
		res.code = ee.ExitCode()
	}
	// the token counts only when the program printed it after our code and was not stopped before (a cancel or the
	// time limit wins over a token that came too late)
	if res.token != "" && res.sig != "" {
		res.token = ""
	}
	return res
}

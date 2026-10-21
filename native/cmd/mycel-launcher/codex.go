// Codex CLI as the engine account (design tab 2 "엔진 잠금 (Codex CLI)" 로그인 파일, tab 3 "Codex 실행 환경" 인증,
// v1 "대체 구성"). The engine account's own ChatGPT login (`codex login --device-auth`) lives in ONE folder,
// --codex-auth-dir (agent/codex-auth/auth.json, engine account 600). The engine sandbox never sees that folder:
//
//   - a Codex turn (request "codexAuth": true) gets a COPY in <chat>/.codex/auth.json. After the turn the copy goes
//     back only when it is a plain file (no link, link count 1), parses, and names the same ChatGPT account
//     (tokens.account_id); then <chat>/.codex is removed. One Codex turn at a time (the refresh token rotates, two
//     turns would overwrite each other's), and a logout in between wins (the turn's copy is not written back).
//   - codex-login runs `codex login --device-auth` with CODEX_HOME = the auth folder, under the same sandbox and the
//     same model proxy (HTTPS_PROXY with a proxy token the server issued); the server prints the URL and code.
//   - codex-status reads the login without returning any token; codex-logout deletes it.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"syscall"
	"time"
)

var codexAuthDir = flag.String("codex-auth-dir", "", "the engine account's Codex login folder (auth.json); enables codexAuth turns and codex-login/-status/-logout")

// one Codex turn (or login) at a time
var codexTurnSem = make(chan struct{}, 1)

// authMu guards auth.json in the auth folder; authGen changes on logout and login so a turn that started before
// does not write its (now stale) copy back.
var (
	authMu  sync.Mutex
	authGen int
)

const maxAuthBytes = 256 << 10

type codexAuthFile struct {
	Tokens *struct {
		AccountID    string `json:"account_id"`
		RefreshToken string `json:"refresh_token"`
	} `json:"tokens"`
	LastRefresh string `json:"last_refresh"`
}

// readPlain opens p without following links and returns its bytes when it is a regular file with one link and at
// most maxAuthBytes; ENOENT is returned as os.ErrNotExist.
func readPlain(p string) ([]byte, error) {
	f, err := os.OpenFile(p, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var st syscall.Stat_t
	if err := syscall.Fstat(int(f.Fd()), &st); err != nil {
		return nil, err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Nlink != 1 || st.Size > maxAuthBytes {
		return nil, fmt.Errorf("%s is not a plain file", filepath.Base(p))
	}
	return io.ReadAll(io.LimitReader(f, maxAuthBytes+1))
}

func parseAuth(b []byte) (*codexAuthFile, error) {
	var a codexAuthFile
	if err := json.Unmarshal(b, &a); err != nil {
		return nil, err
	}
	if a.Tokens == nil || a.Tokens.AccountID == "" || a.Tokens.RefreshToken == "" {
		return nil, fmt.Errorf("no ChatGPT tokens")
	}
	return &a, nil
}

// writeAtomic writes b to dir/name through a fresh temp file (O_EXCL, no links) and rename: a link planted in place
// of the target is replaced, never followed.
func writeAtomic(dir, name string, b []byte) error {
	tmp := filepath.Join(dir, fmt.Sprintf(".%s.%d.tmp", name, time.Now().UnixNano()))
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, filepath.Join(dir, name)); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// freshDir removes p (a link is unlinked, not followed) and creates it empty, 0700.
func freshDir(p string) error {
	if err := os.RemoveAll(p); err != nil {
		return err
	}
	return os.Mkdir(p, 0o700)
}

// isCodexAuthDir: a chat folder may never be the login folder (its turn would get the real auth.json as CHAT_DIR).
func isCodexAuthDir(chat string) bool {
	return *codexAuthDir != "" && filepath.Clean(chat) == filepath.Clean(*codexAuthDir)
}

type codexTurn struct {
	chat  string
	orig  []byte
	acct  string
	gen   int
	held  bool
	notes []string
}

// codexBegin waits for the Codex slot (or a stop), then puts a copy of the login into <chat>/.codex and an empty
// HOME into <chat>/.home.
func codexBegin(chat string, stopping <-chan struct{}) (*codexTurn, error) {
	if *codexAuthDir == "" {
		return nil, fmt.Errorf("codex_not_configured: the launcher has no --codex-auth-dir")
	}
	select {
	case codexTurnSem <- struct{}{}:
	case <-stopping:
		return nil, fmt.Errorf("stopped before the engine started")
	}
	ct := &codexTurn{chat: chat, held: true}
	fail := func(err error) (*codexTurn, error) { ct.release(); return nil, err }
	authMu.Lock()
	b, err := readPlain(filepath.Join(*codexAuthDir, "auth.json"))
	ct.gen = authGen
	authMu.Unlock()
	if os.IsNotExist(err) {
		return fail(fmt.Errorf("codex_not_signed_in: the engine account has no Codex login (run the codex-login command)"))
	}
	if err != nil {
		return fail(fmt.Errorf("codex_not_signed_in: %v", err))
	}
	a, err := parseAuth(b)
	if err != nil {
		return fail(fmt.Errorf("codex_not_signed_in: auth.json: %v", err))
	}
	ct.orig, ct.acct = b, a.Tokens.AccountID
	home := filepath.Join(chat, ".codex")
	if err := freshDir(home); err != nil {
		return fail(err)
	}
	if err := freshDir(filepath.Join(chat, ".home")); err != nil {
		return fail(err)
	}
	f, err := os.OpenFile(filepath.Join(home, "auth.json"), os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return fail(err)
	}
	_, werr := f.Write(b)
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		return fail(werr)
	}
	return ct, nil
}

func (ct *codexTurn) release() {
	if ct.held {
		ct.held = false
		<-codexTurnSem
	}
}

// end writes a refreshed login back (same account, plain file) and removes the turn's Codex folders. Returns notes
// for the server (audit): why a changed login was not written back.
func (ct *codexTurn) end() []string {
	defer ct.release()
	home := filepath.Join(ct.chat, ".codex")
	defer os.RemoveAll(filepath.Join(ct.chat, ".home"))
	defer os.RemoveAll(home)
	b, err := readPlain(filepath.Join(home, "auth.json"))
	if err != nil {
		if !os.IsNotExist(err) {
			ct.notes = append(ct.notes, "codex_auth_writeback_refused: "+err.Error())
		}
		return ct.notes
	}
	if bytes.Equal(b, ct.orig) {
		return ct.notes
	}
	a, err := parseAuth(b)
	if err != nil {
		return append(ct.notes, "codex_auth_writeback_refused: "+err.Error())
	}
	if a.Tokens.AccountID != ct.acct {
		return append(ct.notes, "codex_auth_writeback_refused: another ChatGPT account")
	}
	authMu.Lock()
	defer authMu.Unlock()
	if authGen != ct.gen {
		return append(ct.notes, "codex_auth_writeback_skipped: signed out or in again during the turn")
	}
	if err := writeAtomic(*codexAuthDir, "auth.json", b); err != nil {
		return append(ct.notes, "codex_auth_writeback_failed: "+err.Error())
	}
	return ct.notes
}

// ---------------- codex-status / codex-logout / codex-login ----------------

func codexStatus(o *out) {
	if *codexAuthDir == "" {
		o.send(map[string]any{"ev": "error", "message": "codex_not_configured"})
		return
	}
	authMu.Lock()
	b, err := readPlain(filepath.Join(*codexAuthDir, "auth.json"))
	authMu.Unlock()
	ev := map[string]any{"ev": "codex_state", "loggedIn": false}
	if err == nil {
		if a, perr := parseAuth(b); perr == nil {
			ev["loggedIn"] = true
			ev["accountId"] = a.Tokens.AccountID
			if a.LastRefresh != "" {
				ev["lastRefresh"] = a.LastRefresh
			}
		} else {
			ev["problem"] = "unreadable login"
		}
	} else if !os.IsNotExist(err) {
		ev["problem"] = err.Error()
	}
	o.send(ev)
}

func codexLogout(o *out) {
	if *codexAuthDir == "" {
		o.send(map[string]any{"ev": "error", "message": "codex_not_configured"})
		return
	}
	authMu.Lock()
	authGen++
	p := filepath.Join(*codexAuthDir, "auth.json")
	st, err := os.Lstat(p)
	if err == nil && !st.Mode().IsRegular() && st.Mode()&os.ModeSymlink == 0 {
		err = fmt.Errorf("auth.json is not a file")
	} else if err == nil {
		err = os.Remove(p) // a link is removed, not followed
	} else if os.IsNotExist(err) {
		err = nil
	}
	authMu.Unlock()
	if err != nil {
		o.send(map[string]any{"ev": "logout_done", "ok": false, "message": err.Error()})
		return
	}
	o.send(map[string]any{"ev": "logout_done", "ok": true})
}

var proxyURLRe = regexp.MustCompile(`^http://turn:[A-Za-z0-9_-]{16,128}@127\.0\.0\.1:(\d{1,5})$`)

type loginRequest struct {
	Op        string `json:"op"`
	Cmd       string `json:"cmd"`
	Proxy     string `json:"proxy"`
	TimeoutMs int64  `json:"timeoutMs"`
}

// codexLogin runs `<codex> login --device-auth` as this account with CODEX_HOME = the auth folder: under the engine
// sandbox (CHAT_DIR = the auth folder) and through the model proxy, like a turn. stdout/stderr are streamed; the
// server extracts the URL and the one-time code. Holds the Codex slot, so no turn uses the login while it changes.
func codexLogin(line []byte, o *out, stop <-chan struct{}) error {
	var req loginRequest
	if err := json.Unmarshal(line, &req); err != nil {
		return fmt.Errorf("bad request")
	}
	if *codexAuthDir == "" {
		return fmt.Errorf("codex_not_configured")
	}
	if !allowedCmd(req.Cmd) || filepath.Base(req.Cmd) != "codex" {
		return fmt.Errorf("engine %q is not allowed", req.Cmd)
	}
	m := proxyURLRe.FindStringSubmatch(req.Proxy)
	if m == nil || m[1] != strconv.Itoa(*proxyPort) || *proxyPort == 0 {
		return fmt.Errorf("bad proxy (the login goes through the model proxy on port %d)", *proxyPort)
	}
	select {
	case codexTurnSem <- struct{}{}:
	case <-stop:
		return fmt.Errorf("stopped")
	}
	defer func() { <-codexTurnSem }()
	dir := filepath.Clean(*codexAuthDir)
	if st, err := os.Lstat(dir); err != nil || !st.IsDir() {
		return fmt.Errorf("codex auth folder missing")
	}
	for _, d := range []string{"home", "tmp"} {
		if err := freshDir(filepath.Join(dir, d)); err != nil {
			return err
		}
	}
	authMu.Lock()
	authGen++ // a turn that started before this login must not write its copy over the new login
	authMu.Unlock()
	args := []string{"login", "--device-auth", "-c", `cli_auth_credentials_store="file"`}
	cmd, err := engineCommand(req.Cmd, args, dir, dir)
	if err != nil {
		return err
	}
	cmd.Dir = dir
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + filepath.Join(dir, "home"), "CODEX_HOME=" + dir, "TMPDIR=" + filepath.Join(dir, "tmp"),
		"LANG=en_US.UTF-8", "NO_COLOR=1", "SSL_CERT_FILE=/etc/ssl/cert.pem", "HTTPS_PROXY=" + req.Proxy}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	timeout := time.Duration(req.TimeoutMs) * time.Millisecond
	if timeout <= 0 || timeout > 20*time.Minute {
		timeout = 16 * time.Minute // the device code expires after 15 minutes
	}
	code, sig := runStreaming(cmd, o, stop, timeout)
	authMu.Lock()
	authGen++
	authMu.Unlock()
	_ = os.RemoveAll(filepath.Join(dir, "tmp"))
	ev := map[string]any{"ev": "exit", "code": code}
	if sig != "" {
		ev["signal"] = sig
	}
	o.send(ev)
	return nil
}

func allowedCmd(c string) bool {
	for _, a := range allowCmd {
		if a == c {
			return true
		}
	}
	return false
}

// runStreaming starts cmd (setsid), streams its stdout/stderr as events, and stops its process group on stop or
// timeout (SIGTERM, SIGKILL after 5 s). Returns the exit code and "stopped"/"timeout" or "".
func runStreaming(cmd *exec.Cmd, o *out, stop <-chan struct{}, timeout time.Duration) (int, string) {
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	cmd.Stdin = nil
	if err := cmd.Start(); err != nil {
		o.send(map[string]any{"ev": "error", "message": err.Error()})
		return -1, "error"
	}
	pid := cmd.Process.Pid
	live.add(pid)
	defer live.del(pid)
	o.send(map[string]any{"ev": "started", "pid": pid, "pgid": pid})
	var wg sync.WaitGroup
	pump := func(name string, f io.Reader) {
		defer wg.Done()
		buf := make([]byte, 16<<10)
		for {
			n, err := f.Read(buf)
			if n > 0 {
				o.send(map[string]any{"ev": name, "b64": b64(buf[:n])})
			}
			if err != nil {
				return
			}
		}
	}
	wg.Add(2)
	go pump("stdout", stdout)
	go pump("stderr", stderr)
	done := make(chan error, 1)
	go func() { wg.Wait(); done <- cmd.Wait() }()
	sig := ""
	var werr error
	select {
	case werr = <-done:
	case <-stop:
		sig = "stopped"
	case <-time.After(timeout):
		sig = "timeout"
	}
	if sig != "" {
		_ = syscall.Kill(-pid, syscall.SIGTERM)
		select {
		case werr = <-done:
		case <-time.After(5 * time.Second):
			_ = syscall.Kill(-pid, syscall.SIGKILL)
			werr = <-done
		}
	}
	_ = syscall.Kill(-pid, syscall.SIGKILL)
	code := 0
	if ee, ok := werr.(*exec.ExitError); ok {
		code = ee.ExitCode()
	}
	return code, sig
}

// Codex CLI as the engine account (design tab 2 "엔진 잠금 (Codex CLI)" 로그인 파일, tab 3 "Codex 실행 환경" 인증,
// v1 "대체 구성"). The engine account's own ChatGPT login (`codex login --device-auth`) lives in ONE folder,
// --codex-auth-dir (agent/codex-auth/auth.json, engine account 600). The engine sandbox never sees that folder:
//
//   - a Codex turn (request "codexAuth": true) gets a COPY in <chat>/.codex/auth.json (written and removed through the
//     chat folder's no-follow root, safepath.go). After the turn the copy goes
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
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

var codexAuthDir = flag.String("codex-auth-dir", "", "the engine account's Codex login folder (auth.json); enables codexAuth turns and codex-login/-status/-logout")

// one agent-own Codex turn (or legacy login) at a time; managed turns never take it (the server refreshes tokens)
var codexTurnSem = make(chan struct{}, 1)

// one ChatGPT sign-in for an AI connection (codex-login v2) at a time
var codexLoginSem = make(chan struct{}, 1)

const (
	placeholderRefresh = "teamax-no-refresh"
	maxManagedAuth     = 16 << 10
)

var (
	turnTokenRe    = regexp.MustCompile(`^mpx_[A-Za-z0-9_-]{43}$`)
	accountAliasRe = regexp.MustCompile(`^teamax-[0-9a-f]{12}$`)
	loginIDRe      = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)
)

// codexManagedBegin writes the placeholder login of a managed Codex turn (docs/DECISIONS.md "AI 연결" D9) into a fresh
// <chat>/.codex (0600, no links followed) and an empty <chat>/.home. It refuses anything that could be a real login
// (security T1: a server bug must not put a real token where the engine reads it): the access token / API key must be
// this turn's proxy token (mpx_ + 43), the refresh token the fixed placeholder, the account id our alias.
func codexManagedBegin(chat, authJSON string) error {
	if len(authJSON) == 0 || len(authJSON) > maxManagedAuth {
		return fmt.Errorf("managed Codex login: bad size")
	}
	var a struct {
		AuthMode string  `json:"auth_mode"`
		APIKey   *string `json:"OPENAI_API_KEY"`
		Tokens   *struct {
			IDToken      string `json:"id_token"`
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			AccountID    string `json:"account_id"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal([]byte(authJSON), &a); err != nil {
		return fmt.Errorf("managed Codex login: not JSON")
	}
	switch a.AuthMode {
	case "chatgpt":
		if a.Tokens == nil || !turnTokenRe.MatchString(a.Tokens.AccessToken) || a.Tokens.RefreshToken != placeholderRefresh ||
			!accountAliasRe.MatchString(a.Tokens.AccountID) || (a.APIKey != nil && *a.APIKey != "") || strings.Count(a.Tokens.IDToken, ".") != 2 {
			return fmt.Errorf("managed Codex login: refused (it does not look like a placeholder)")
		}
	case "apikey":
		if a.APIKey == nil || !turnTokenRe.MatchString(*a.APIKey) || a.Tokens != nil {
			return fmt.Errorf("managed Codex login: refused (it does not look like a placeholder)")
		}
	default:
		return fmt.Errorf("managed Codex login: unknown auth_mode")
	}
	return writeChatCodexHome(chat, []byte(authJSON))
}

// writeChatCodexHome replaces <chat>/.codex and <chat>/.home with fresh empty folders and writes .codex/auth.json
// (0600), all below the chat folder's open root without following any link (safepath.go, D27): a link the engine
// planted AT .codex / .home or INSIDE them (auth.json, config.toml, ...) is removed as a link, never written through,
// and every component is resolved from the root's descriptor, so a swap after the check cannot redirect the write.
func writeChatCodexHome(chat string, auth []byte) error {
	d, err := openRoot(chat)
	if err != nil {
		return err
	}
	defer d.close()
	for _, n := range []string{".codex", ".home"} {
		if err := d.removeAll(n); err != nil {
			return err
		}
		if err := d.mkdirAll(n, 0o700); err != nil {
			return err
		}
	}
	return d.writeNew(".codex/auth.json", auth, 0o600)
}

// removeChatCodexHome removes <chat>/.codex and <chat>/.home without following links (a link is unlinked itself).
func removeChatCodexHome(chat string) {
	d, err := openRoot(chat)
	if err != nil {
		return
	}
	defer d.close()
	_ = d.removeAll(".codex")
	_ = d.removeAll(".home")
}

// codexManagedEnd removes a managed turn's Codex folders (nothing is written back: the server refreshes tokens).
func codexManagedEnd(chat string) { removeChatCodexHome(chat) }

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

// readChatPlain reads rel below the chat folder like readPlain, without following a link in any component.
func readChatPlain(chat, rel string) ([]byte, error) {
	d, err := openRoot(chat)
	if err != nil {
		return nil, err
	}
	defer d.close()
	b, err := d.readFile(rel, maxAuthBytes)
	var pe *os.PathError
	if errors.As(err, &pe) && errors.Is(pe.Err, syscall.ENOENT) {
		return nil, os.ErrNotExist
	}
	return b, err
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

// freshDir removes p (a link is unlinked, not followed) and creates it empty, 0700. Only for the launcher's own folders
// (the Codex login folder, a ChatGPT sign-in folder); below a chat folder use writeChatCodexHome / dirRoot.
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
	if err := writeChatCodexHome(chat, b); err != nil {
		return fail(err)
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
	defer removeChatCodexHome(ct.chat)
	// <chat>/.codex may have become a link during the turn: read below the chat folder without following (D27)
	b, err := readChatPlain(ct.chat, ".codex/auth.json")
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
	// v2 (ChatGPT sign-in for an AI connection): a one-off folder <agent root>/.codex-login/<loginId>; the result goes
	// to the server ({ev:'codex_auth'}), never into --codex-auth-dir
	LoginID string `json:"loginId"`
}

// codexExport hands the engine account's old Codex login (--codex-auth-dir) to the server once (the migration into an
// AI connection, credentials/migrate.ts); the server then removes it with codex-logout. Removed next release.
func codexExport(o *out) {
	if *codexAuthDir == "" {
		o.send(map[string]any{"ev": "codex_export", "none": true})
		return
	}
	authMu.Lock()
	b, err := readPlain(filepath.Join(*codexAuthDir, "auth.json"))
	authMu.Unlock()
	if os.IsNotExist(err) {
		o.send(map[string]any{"ev": "codex_export", "none": true})
		return
	}
	if err != nil {
		o.send(map[string]any{"ev": "error", "message": err.Error()})
		return
	}
	if _, perr := parseAuth(b); perr != nil {
		o.send(map[string]any{"ev": "codex_export", "none": true})
		return
	}
	o.send(map[string]any{"ev": "codex_export", "b64": b64(b)})
}

// codexSignIn (codex-login v2) runs `<codex> login --device-auth` as this account in a fresh folder
// <agent root>/.codex-login/<loginId> (CODEX_HOME and the sandbox's CHAT_DIR), through the model proxy like a turn.
// When it ends with a login, the auth.json goes to the server ({ev:'codex_auth', b64}); the folder is removed in every
// case (success, failure, cancel, timeout). Does not touch --codex-auth-dir or the turns' semaphore.
func codexSignIn(req loginRequest, o *out, stop <-chan struct{}) error {
	if !loginIDRe.MatchString(req.LoginID) {
		return fmt.Errorf("bad login id")
	}
	select {
	case codexLoginSem <- struct{}{}:
	case <-stop:
		return fmt.Errorf("stopped")
	}
	defer func() { <-codexLoginSem }()
	parent := filepath.Join(filepath.Clean(*agentRoot), ".codex-login")
	if err := os.MkdirAll(parent, 0o700); err != nil {
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
	for _, d := range []string{"home", "tmp"} {
		if err := freshDir(filepath.Join(dir, d)); err != nil {
			return err
		}
	}
	args := []string{"login", "--device-auth", "-c", `cli_auth_credentials_store="file"`}
	// under the engine sandbox like a turn and like the engine-account login below: sandbox-exec on macOS, bwrap +
	// the login cgroup on Linux (engineCommand alone is the macOS profile: on Linux it ran Codex unsandboxed)
	te, err := beginLogin(dir)
	if err != nil {
		return err
	}
	defer te.cleanup()
	cmd, cleanup, err := te.command(req.Cmd, args, dir, dir)
	if err != nil {
		return err
	}
	defer cleanup()
	cmd.Dir = dir
	// relative to the working folder, as for a turn: the macOS profile closes the metadata of the agent root, so Codex
	// cannot canonicalize an absolute CODEX_HOME under it (the engine-account login's fix, 5ff9676, applies here too)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=./home", "CODEX_HOME=.", "TMPDIR=./tmp",
		"LANG=en_US.UTF-8", "NO_COLOR=1", "SSL_CERT_FILE=/etc/ssl/cert.pem", "HTTPS_PROXY=" + req.Proxy}
	cmd.SysProcAttr = te.procAttr()
	timeout := time.Duration(req.TimeoutMs) * time.Millisecond
	if timeout <= 0 || timeout > 20*time.Minute {
		timeout = 16 * time.Minute // the device code expires after 15 minutes
	}
	code, sig := runStreaming(cmd, o, stop, timeout)
	sig = te.finish(sig)
	if code == 0 && sig == "" {
		if b, err := readPlain(filepath.Join(dir, "auth.json")); err == nil {
			if _, perr := parseAuth(b); perr == nil {
				o.send(map[string]any{"ev": "codex_auth", "b64": b64(b)})
			}
		}
	}
	_ = os.RemoveAll(dir) // before "exit": nothing of the login stays on the engine account
	ev := map[string]any{"ev": "exit", "code": code}
	if sig != "" {
		ev["signal"] = sig
	}
	o.send(ev)
	return nil
}

// codexLogin runs `<codex> login --device-auth` as this account with CODEX_HOME = the auth folder: under the engine
// sandbox (CHAT_DIR = the auth folder) and through the model proxy, like a turn. stdout/stderr are streamed; the
// server extracts the URL and the one-time code. Holds the Codex slot, so no turn uses the login while it changes.
func codexLogin(line []byte, o *out, stop <-chan struct{}) error {
	var req loginRequest
	if err := json.Unmarshal(line, &req); err != nil {
		return fmt.Errorf("bad request")
	}
	if req.LoginID == "" && *codexAuthDir == "" {
		return fmt.Errorf("codex_not_configured")
	}
	if !allowedCmd(req.Cmd) || filepath.Base(req.Cmd) != "codex" {
		return fmt.Errorf("engine %q is not allowed", req.Cmd)
	}
	m := proxyURLRe.FindStringSubmatch(req.Proxy)
	if m == nil || m[1] != strconv.Itoa(*proxyPort) || *proxyPort == 0 {
		return fmt.Errorf("bad proxy (the login goes through the model proxy on port %d)", *proxyPort)
	}
	if req.LoginID != "" {
		return codexSignIn(req, o, stop)
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
	te, err := beginLogin(dir) // sandbox.go (Linux: bwrap, cgroup turns/login)
	if err != nil {
		return err
	}
	defer te.cleanup()
	cmd, cleanup, err := te.command(req.Cmd, args, dir, dir)
	if err != nil {
		return err
	}
	defer cleanup()
	cmd.Dir = dir
	// relative to the working folder, as for a turn: the profile closes the metadata of the agent root, so Codex could
	// not canonicalize an absolute CODEX_HOME under it ("Operation not permitted", staging 2026-10-22)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=./home", "CODEX_HOME=.", "TMPDIR=./tmp",
		"LANG=en_US.UTF-8", "NO_COLOR=1", "SSL_CERT_FILE=/etc/ssl/cert.pem", "HTTPS_PROXY=" + req.Proxy}
	cmd.SysProcAttr = te.procAttr()
	timeout := time.Duration(req.TimeoutMs) * time.Millisecond
	if timeout <= 0 || timeout > 20*time.Minute {
		timeout = 16 * time.Minute // the device code expires after 15 minutes
	}
	code, sig := runStreaming(cmd, o, stop, timeout)
	sig = te.finish(sig)
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

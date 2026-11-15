// The Claude login broker of local-login engines (TC-358, office mode and dev on a Mac).
//
// Claude Code on macOS keeps its login in the login keychain and reaches it only by running `security` (found through
// PATH): `security find-generic-password -a <user> -w -s "Claude Code-credentials"` to read it, `security -i` with
// `add-generic-password -U -a <user> -s <service> -X <hex>` on stdin to save a refreshed login, `show-keychain-info`
// to tell a locked keychain. Before this broker the engine sandbox let a turn run /usr/bin/security itself and opened
// the keychain files and the Security services: a turn whose tool lockdown failed could read EVERY item that
// `security` made without a prompt (other command-line tools keep their tokens there too), list ~/Library/Keychains
// and read ~/.claude/.credentials.json. Now the sandbox denies all of that (scripts/macos/engine.sb) and the first
// `security` in the engine's PATH is a link to mycel-bridge (security.go there), which hands its arguments and stdin
// to this broker over <kc>/sock. The broker, outside the sandbox, answers exactly what Claude Code needs:
//   - find-generic-password -a <this account> -s "Claude Code-credentials" -w: the login, cut down to its
//     claudeAiOauth part (the rest of the item, such as MCP servers' sign-ins, never reaches a turn). Where the login
//     lives in ~/.claude/.credentials.json instead (no keychain item, or a locked keychain), that file's login.
//   - find-generic-password -a <this account> -s "Claude Code" -w: a Console API key login (read only).
//   - add-generic-password -U -a <this account> -s "Claude Code-credentials" (-X <hex> | -w <value>): a refreshed
//     login. Only its claudeAiOauth part is taken, merged into the item as it is now, and written back where the
//     login lives (keychain item or the file). Claude Code rotates the refresh token on every refresh, so the broker
//     reads the live item on every request (no copy per turn: another turn or the Mac user's own `claude` may have
//     refreshed it a moment ago).
//   - show-keychain-info: only the exit code (36 = locked).
//
// Everything else (other services or accounts, other keychains, -g, dump-keychain, delete-generic-password, export,
// unlock ...) is refused. Only processes of a running local-login Claude turn of this launcher may connect (peer
// uid + session).
package main

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"mycel/native/internal/peer"
)

const (
	kcLoginService = "Claude Code-credentials"
	kcKeyService   = "Claude Code"
	// exit codes of /usr/bin/security that Claude Code reads
	kcNotFound = 44
	kcLocked   = 36
	// a request (argv + stdin) larger than this is refused; Claude Code's login is a few hundred bytes
	kcMaxRequest = 64 << 10
	// `security -i` reads one line of at most this many bytes (Claude Code uses argv above it, and so do we)
	kcStdinLine = 4000
)

// kcStore is where the Mac user's Claude login really lives (the login keychain through /usr/bin/security; tests: a
// map). find answers like `security find-generic-password -w`: the value and exit code 0, or 44 / 36 / other.
type kcStore interface {
	find(service string) (string, int)
	add(service, value string) int
	info() int
}

// kcBroker answers the requests of the engines' `security` shim.
type kcBroker struct {
	mu      sync.Mutex
	store   kcStore
	account string
	// ~/.claude/.credentials.json of the Mac user (Claude Code's plaintext login when the keychain cannot hold it)
	credFile string
	log      func(string)
}

type kcRequest struct {
	Args  []string `json:"args"`
	Stdin string   `json:"stdin"`
}

type kcResponse struct {
	Code   int    `json:"code"`
	Stdout string `json:"stdout,omitempty"`
	Stderr string `json:"stderr,omitempty"`
}

func kcRefused(what string) kcResponse {
	return kcResponse{Code: 1, Stderr: "security: refused by the team server: " + what + "\n"}
}

// handle runs one request: argv form (one command) or `security -i` (commands on stdin, one per line).
func (b *kcBroker) handle(req kcRequest) kcResponse {
	if len(req.Stdin) > kcMaxRequest || len(req.Args) > 32 {
		return kcRefused("request too large")
	}
	if len(req.Args) == 1 && req.Args[0] == "-i" {
		var out kcResponse
		for _, line := range strings.Split(req.Stdin, "\n") {
			if strings.TrimSpace(line) == "" {
				continue
			}
			args, err := kcSplit(line)
			if err != nil {
				return kcRefused(err.Error())
			}
			r := b.command(args)
			out.Stdout += r.Stdout
			out.Stderr += r.Stderr
			if r.Code != 0 { // `security -i` stops at the first failure and exits with its code
				out.Code = r.Code
				return out
			}
		}
		return out
	}
	return b.command(req.Args) // stdin is read only by -i
}

// command runs one `security` command after checking it against the list above.
func (b *kcBroker) command(args []string) kcResponse {
	if len(args) == 0 {
		return kcRefused("no command")
	}
	cmd, opts := args[0], args[1:]
	switch cmd {
	case "show-keychain-info":
		if len(opts) != 0 {
			return kcRefused("show-keychain-info names a keychain")
		}
		b.mu.Lock()
		defer b.mu.Unlock()
		return kcResponse{Code: b.store.info()}
	case "find-generic-password":
		o, err := kcOptions(opts, map[string]bool{"a": true, "s": true}, map[string]bool{"w": true})
		if err != nil {
			return kcRefused(err.Error())
		}
		if !o.flags["w"] {
			return kcRefused("only the password (-w) of the Claude login is answered")
		}
		if o.vals["a"] != b.account {
			return kcRefused("another account")
		}
		switch o.vals["s"] {
		case kcLoginService:
			return b.findLogin()
		case kcKeyService:
			b.mu.Lock()
			defer b.mu.Unlock()
			v, code := b.store.find(kcKeyService)
			if code != 0 {
				return kcResponse{Code: code}
			}
			return kcResponse{Stdout: v + "\n"}
		}
		return kcRefused("not the Claude login")
	case "add-generic-password":
		o, err := kcOptions(opts, map[string]bool{"a": true, "s": true, "X": true, "w": true}, map[string]bool{"U": true})
		if err != nil {
			return kcRefused(err.Error())
		}
		if !o.flags["U"] || o.vals["a"] != b.account || o.vals["s"] != kcLoginService {
			return kcRefused("only an update (-U) of the Claude login is accepted")
		}
		_, hasX := o.vals["X"]
		_, hasW := o.vals["w"]
		if hasX == hasW {
			return kcRefused("exactly one of -X and -w")
		}
		value := o.vals["w"]
		if hasX {
			raw, err := hex.DecodeString(o.vals["X"])
			if err != nil {
				return kcRefused("-X is not hex")
			}
			value = string(raw)
		}
		return b.saveLogin(value)
	}
	return kcRefused(fmt.Sprintf("%q is not allowed", cmd))
}

type kcOpts struct {
	vals  map[string]string
	flags map[string]bool
}

// kcOptions reads `-a value -s value -w` style options: each option at most once, values only for `withValue`,
// nothing positional (a keychain path would name another keychain), no other option.
func kcOptions(args []string, withValue, flags map[string]bool) (kcOpts, error) {
	o := kcOpts{vals: map[string]string{}, flags: map[string]bool{}}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if len(a) != 2 || a[0] != '-' {
			return o, fmt.Errorf("unexpected argument")
		}
		k := a[1:]
		_, seenV := o.vals[k]
		if seenV || o.flags[k] {
			return o, fmt.Errorf("option -%s given twice", k)
		}
		switch {
		case withValue[k] && flags[k]:
			// -w is a flag for find (password only) and a value for add: never both in one table
			return o, fmt.Errorf("option -%s", k)
		case withValue[k]:
			if i+1 >= len(args) {
				return o, fmt.Errorf("option -%s needs a value", k)
			}
			o.vals[k] = args[i+1]
			i++
		case flags[k]:
			o.flags[k] = true
		default:
			return o, fmt.Errorf("option -%s is not allowed", k)
		}
	}
	return o, nil
}

// kcSplit splits one `security -i` line the way its command reader does for what Claude Code writes: words separated
// by spaces, "double" or 'single' quoted words, backslash escapes inside double quotes.
func kcSplit(line string) ([]string, error) {
	var out []string
	var cur strings.Builder
	in := false
	for i := 0; i < len(line); {
		c := line[i]
		switch {
		case c == ' ' || c == '\t' || c == '\r':
			if in {
				out = append(out, cur.String())
				cur.Reset()
				in = false
			}
			i++
		case c == '"' || c == '\'':
			in = true
			j := i + 1
			for ; j < len(line) && line[j] != c; j++ {
				if c == '"' && line[j] == '\\' && j+1 < len(line) {
					j++
				}
				cur.WriteByte(line[j])
			}
			if j >= len(line) {
				return nil, fmt.Errorf("unterminated quote")
			}
			i = j + 1
		default:
			in = true
			cur.WriteByte(c)
			i++
		}
	}
	if in {
		out = append(out, cur.String())
	}
	return out, nil
}

// where the login lives now: the keychain item, or (no item / a locked keychain) the plaintext file
type kcLogin struct {
	item    map[string]json.RawMessage
	inFile  bool
	code    int // the keychain's answer when neither holds a login
	present bool
}

func (b *kcBroker) current() kcLogin {
	v, code := b.store.find(kcLoginService)
	if code == 0 {
		if item := kcParse(v); item != nil {
			return kcLogin{item: item, present: true}
		}
		return kcLogin{code: 1}
	}
	if code == kcNotFound || code == kcLocked {
		if raw, err := os.ReadFile(b.credFile); err == nil {
			if item := kcParse(string(raw)); item != nil {
				if _, ok := item["claudeAiOauth"]; ok {
					return kcLogin{item: item, inFile: true, present: true}
				}
			}
		}
	}
	return kcLogin{code: code}
}

func kcParse(s string) map[string]json.RawMessage {
	var m map[string]json.RawMessage
	if json.Unmarshal([]byte(strings.TrimSpace(s)), &m) != nil || m == nil {
		return nil
	}
	return m
}

func (b *kcBroker) findLogin() kcResponse {
	b.mu.Lock()
	defer b.mu.Unlock()
	cur := b.current()
	if !cur.present {
		return kcResponse{Code: cur.code}
	}
	oauth, ok := cur.item["claudeAiOauth"]
	if !ok {
		return kcResponse{Code: kcNotFound}
	}
	view, _ := json.Marshal(map[string]json.RawMessage{"claudeAiOauth": oauth})
	return kcResponse{Stdout: string(view) + "\n"}
}

// saveLogin takes the claudeAiOauth part of what the engine saves and writes it into the login where it lives.
func (b *kcBroker) saveLogin(value string) kcResponse {
	in := kcParse(value)
	oauth, ok := in["claudeAiOauth"]
	if in == nil || !ok || !kcOAuthOK(oauth) {
		return kcRefused("not a Claude login")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	cur := b.current()
	item := cur.item
	if !cur.present {
		if cur.code != kcNotFound {
			// a keychain that answered something else (locked without a file login, an error): do not create a
			// second login next to one we could not read
			return kcResponse{Code: cur.code}
		}
		item = map[string]json.RawMessage{}
	}
	item["claudeAiOauth"] = oauth
	out, err := json.Marshal(item)
	if err != nil {
		return kcResponse{Code: 1}
	}
	if cur.inFile {
		if err := writeFileAtomic(b.credFile, out, 0o600); err != nil {
			if b.log != nil {
				b.log("keychain broker: could not save the refreshed Claude login file: " + err.Error())
			}
			return kcResponse{Code: 1}
		}
		return kcResponse{}
	}
	return kcResponse{Code: b.store.add(kcLoginService, string(out))}
}

// kcOAuthOK: the shape of Claude Code's claudeAiOauth (an object with a non-empty access token string)
func kcOAuthOK(raw json.RawMessage) bool {
	var o map[string]json.RawMessage
	if json.Unmarshal(raw, &o) != nil || o == nil {
		return false
	}
	var tok string
	return json.Unmarshal(o["accessToken"], &tok) == nil && tok != ""
}

func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	if st, err := os.Lstat(path); err == nil && !st.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file", path)
	}
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	if _, err := f.Write(data); err == nil {
		err = f.Chmod(mode)
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		_ = os.Remove(tmp)
	}
	return err
}

// securityStore: the Mac user's login keychain through /usr/bin/security, run by the launcher (outside the sandbox).
type securityStore struct{ account string }

const securityBin = "/usr/bin/security"

func (s securityStore) find(service string) (string, int) {
	out, err := exec.Command(securityBin, "find-generic-password", "-a", s.account, "-w", "-s", service).Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return "", ee.ExitCode()
		}
		return "", 1
	}
	return strings.TrimRight(string(out), "\n"), 0
}

func (s securityStore) add(service, value string) int {
	hx := hex.EncodeToString([]byte(value))
	line := fmt.Sprintf("add-generic-password -U -a %q -s %q -X %q\n", s.account, service, hx)
	var cmd *exec.Cmd
	if len(line) <= kcStdinLine {
		cmd = exec.Command(securityBin, "-i") // the secret on stdin, not in argv (other processes can read argv)
		cmd.Stdin = strings.NewReader(line)
	} else {
		cmd = exec.Command(securityBin, "add-generic-password", "-U", "-a", s.account, "-s", service, "-X", hx)
	}
	if err := cmd.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode()
		}
		return 1
	}
	return 0
}

func (s securityStore) info() int {
	if err := exec.Command(securityBin, "show-keychain-info").Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode()
		}
		return 1
	}
	return 0
}

// fileStore: tests only (--keychain-test-store): a JSON object {service: value} stands in for the login keychain,
// so the broker can be tried with a fake login and the real keychain is never opened.
type fileStore struct{ path string }

func (f fileStore) load() map[string]string {
	m := map[string]string{}
	if b, err := os.ReadFile(f.path); err == nil {
		_ = json.Unmarshal(b, &m)
	}
	return m
}
func (f fileStore) find(service string) (string, int) {
	if v, ok := f.load()[service]; ok {
		return v, 0
	}
	return "", kcNotFound
}
func (f fileStore) add(service, value string) int {
	m := f.load()
	m[service] = value
	b, _ := json.Marshal(m)
	if writeFileAtomic(f.path, b, 0o600) != nil {
		return 1
	}
	return 0
}
func (f fileStore) info() int { return 0 }

// --- the socket ------------------------------------------------------------------------------------------------

// kcTurns: sessions (engine pid = sid) of running Claude turns that may use the broker
var kcTurns = &liveSet{m: map[int]bool{}}

// kcDir is the broker's folder (<kc>/sock and the <kc>/security link); "" = no broker (not a local-login sandbox)
var kcDir string

// kcAccount: the account name Claude Code passes as -a (its USER), looked up like accountHome
func kcAccount() string {
	if u, err := user.LookupId(strconv.Itoa(os.Getuid())); err == nil && u.Username != "" {
		return u.Username
	}
	return os.Getenv("USER")
}

// startKeychainBroker makes <dir>/security (a link to the bridge, which acts as the shim under that name) and
// listens on <dir>/sock. Called once at start, with --local-login and a sandbox profile.
func startKeychainBroker(dir, bridge string, store kcStore) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if st, err := os.Lstat(dir); err != nil || !st.IsDir() {
		return fmt.Errorf("keychain broker folder %s is not a folder", dir)
	}
	_ = os.Chmod(dir, 0o700)
	link := filepath.Join(dir, "security")
	_ = os.Remove(link)
	if err := os.Symlink(bridge, link); err != nil {
		return err
	}
	sock := filepath.Join(dir, "sock")
	_ = os.Remove(sock)
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		return err
	}
	_ = os.Chmod(sock, 0o600)
	acct := kcAccount()
	b := &kcBroker{store: store, account: acct, credFile: filepath.Join(accountHome, ".claude", ".credentials.json"),
		log: func(s string) { fmt.Fprintln(os.Stderr, "mycel-launcher:", s) }}
	if store == nil {
		b.store = securityStore{account: acct}
	}
	go func() {
		for {
			c, err := ln.AcceptUnix()
			if err != nil {
				continue
			}
			go b.serve(c)
		}
	}()
	return nil
}

func (b *kcBroker) serve(c *net.UnixConn) {
	defer c.Close()
	reply := func(r kcResponse) {
		j, _ := json.Marshal(r)
		_, _ = c.Write(append(j, '\n'))
	}
	cr, err := peer.Of(c)
	// the engine may ask before run() has noted its session (it reads its login right at start): wait a moment
	for i := 0; err == nil && cr.Uid == os.Getuid() && !kcTurns.has(cr.Sid) && i < 40; i++ {
		time.Sleep(50 * time.Millisecond)
	}
	if err != nil || cr.Uid != os.Getuid() || !kcTurns.has(cr.Sid) {
		reply(kcRefused("not a running Claude turn"))
		return
	}
	_ = c.SetDeadline(time.Now().Add(10 * time.Second))
	// one line, bounded (argv of a hex value is twice its size; JSON escapes add a little)
	line, err := bufio.NewReader(io.LimitReader(c, 4*kcMaxRequest)).ReadBytes('\n')
	if err != nil && len(line) == 0 {
		return
	}
	var req kcRequest
	if json.Unmarshal(line, &req) != nil {
		reply(kcRefused("bad request"))
		return
	}
	reply(b.handle(req))
}

// kcEnv: the engine environment of a turn that uses the broker: the shim's folder first in PATH and its socket
func kcEnv(env []string) []string {
	out := make([]string, 0, len(env)+2)
	path := "/usr/bin:/bin:/usr/sbin:/sbin"
	for _, e := range env {
		if strings.HasPrefix(e, "PATH=") {
			path = strings.TrimPrefix(e, "PATH=")
			continue
		}
		if strings.HasPrefix(e, "MYCEL_KEYCHAIN_SOCK=") {
			continue
		}
		out = append(out, e)
	}
	return append(out, "PATH="+kcDir+":"+path, "MYCEL_KEYCHAIN_SOCK="+filepath.Join(kcDir, "sock"))
}

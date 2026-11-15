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
// Office mode (a model proxy, hideRefresh): the engine sees a placeholder refresh token and a save must carry it; the
// real one goes only to the proxy's refresh terminator over the launcher socket (kcRefreshOp), which also saves the
// rotated one. A taken-over turn then holds an access token that runs out, never the lasting part of the login.
//
// Everything else (other services or accounts, other keychains, -g, dump-keychain, delete-generic-password, export,
// unlock ...) is refused. Only processes of a running local-login Claude turn of this launcher may connect (peer
// uid + session).
package main

import (
	"bufio"
	"context"
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
	del(service string) int
	info() int
}

// kcTooLong: add's answer for an item too long for one `security -i` line (written to the login file instead)
const kcTooLong = -2

// kcBroker answers the requests of the engines' `security` shim.
type kcBroker struct {
	mu      sync.Mutex
	store   kcStore
	account string
	// ~/.claude/.credentials.json of the Mac user (Claude Code's plaintext login when the keychain cannot hold it)
	credFile string
	log      func(string)
	// office mode (the model proxy and its refresh terminator): the engine sees a placeholder refresh token
	hideRefresh bool
	// a rotated login whose save failed: kept here and saved again at the next request, never dropped
	pending *kcOAuth
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
	cur := b.read()
	if b.pending != nil && cur.present {
		// a rotated login that could not be saved yet: it wins over the stored one (whose refresh token is used up) and
		// is saved again now
		if r := b.writeOAuth(cur, *b.pending); r.Code == 0 {
			b.pending = nil
			return b.read()
		}
		oj, _ := json.Marshal(*b.pending)
		cur.item["claudeAiOauth"] = oj
	}
	return cur
}

func (b *kcBroker) read() kcLogin {
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

// kcRefreshPlaceholder is the refresh token a turn sees in office mode (the broker has `hideRefresh`): the real one
// never reaches the engine, so a taken-over turn cannot keep the Mac user's Claude subscription after its access token
// runs out. The proxy's refresh terminator (server/src/proxy/refresh-terminator.ts) puts the real one on the refresh
// and takes the new one out of the answer (op claude-refresh-token / claude-refresh-rotated of the launcher socket).
const kcRefreshPlaceholder = "mycel-refresh-held-by-the-team-server"

// the claudeAiOauth fields Claude Code writes (2.1.325), each bounded; anything else in a save is dropped
type kcOAuth struct {
	AccessToken      string   `json:"accessToken"`
	RefreshToken     string   `json:"refreshToken,omitempty"`
	ExpiresAt        *int64   `json:"expiresAt,omitempty"`
	Scopes           []string `json:"scopes,omitempty"`
	SubscriptionType *string  `json:"subscriptionType,omitempty"`
	RateLimitTier    *string  `json:"rateLimitTier,omitempty"`
}

func kcOAuthParse(raw json.RawMessage) (kcOAuth, bool) {
	var o kcOAuth
	if len(raw) > 4096 || json.Unmarshal(raw, &o) != nil || o.AccessToken == "" || len(o.AccessToken) > 1024 ||
		len(o.RefreshToken) > 1024 || len(o.Scopes) > 16 {
		return o, false
	}
	for _, sc := range o.Scopes {
		if len(sc) > 64 {
			return o, false
		}
	}
	for _, p := range []*string{o.SubscriptionType, o.RateLimitTier} {
		if p != nil && len(*p) > 64 {
			return o, false
		}
	}
	return o, true
}

// the real refresh token of an item ("" when there is none)
func kcRealRefresh(item map[string]json.RawMessage) string {
	var o struct {
		RefreshToken string `json:"refreshToken"`
	}
	_ = json.Unmarshal(item["claudeAiOauth"], &o)
	return o.RefreshToken
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
	if b.hideRefresh {
		var m map[string]json.RawMessage
		if json.Unmarshal(oauth, &m) != nil || m == nil {
			return kcResponse{Code: 1}
		}
		if _, has := m["refreshToken"]; has {
			m["refreshToken"], _ = json.Marshal(kcRefreshPlaceholder)
		}
		oauth, _ = json.Marshal(m)
	}
	view, _ := json.Marshal(map[string]json.RawMessage{"claudeAiOauth": oauth})
	return kcResponse{Stdout: string(view) + "\n"}
}

// saveLogin takes the claudeAiOauth part of what the engine saves (known fields only) and writes it into the login
// where it lives. In office mode (hideRefresh) the engine only ever holds the placeholder: a save must carry it (or
// none) and the real refresh token of the item stays; any other refresh token is refused, so a turn cannot wipe the
// login's refresh token or put another account's in its place.
func (b *kcBroker) saveLogin(value string) kcResponse {
	in := kcParse(value)
	raw, ok := in["claudeAiOauth"]
	o, good := kcOAuthParse(raw)
	if in == nil || !ok || !good {
		return kcRefused("not a Claude login")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	cur := b.current()
	if !cur.present && cur.code != kcNotFound && cur.code != kcLocked {
		// a keychain that answered something else (an error): do not create a second login next to one we could not read
		return kcResponse{Code: cur.code}
	}
	if b.hideRefresh {
		// office: the refresh terminator already saved what the refresh brought (rotated); a save from the engine changes
		// nothing (it could only roll a newer login back, plant another account's access token or pad the item until
		// the next save fails). Answered as done, so Claude Code goes on.
		if o.RefreshToken != "" && o.RefreshToken != kcRefreshPlaceholder {
			return kcRefused("a refresh token the team server did not hand out")
		}
		return kcResponse{}
	}
	return b.writeOAuth(cur, o)
}

// writeOAuth puts o as the item's claudeAiOauth (the rest of the item as it is) where the login lives. A keychain that
// is locked (no GUI session) gets the plaintext file instead, as Claude Code itself does.
func (b *kcBroker) writeOAuth(cur kcLogin, o kcOAuth) kcResponse {
	item := cur.item
	if item == nil {
		item = map[string]json.RawMessage{}
	}
	oj, _ := json.Marshal(o)
	item["claudeAiOauth"] = oj
	out, err := json.Marshal(item)
	if err != nil {
		return kcResponse{Code: 1}
	}
	toFile := func() kcResponse {
		if err := writeFileAtomic(b.credFile, out, 0o600); err != nil {
			b.warn("could not save the Claude login file: " + err.Error())
			return kcResponse{Code: 1}
		}
		return kcResponse{}
	}
	if cur.inFile || (!cur.present && cur.code == kcLocked) {
		return toFile()
	}
	code := b.store.add(kcLoginService, string(out))
	if code == kcLocked {
		return toFile()
	}
	if code == kcTooLong {
		// too long for `security -i` (an item with MCP sign-ins): the login file, as Claude Code's own fallback does, and
		// the keychain item goes so that the file is what every reader finds (never the item in a command line)
		if r := toFile(); r.Code != 0 {
			return r
		}
		if d := b.store.del(kcLoginService); d != 0 && d != kcNotFound {
			// the old item would still be read first, with its used-up refresh token: not done (rotated keeps the login
			// in memory and this runs again at the next request)
			b.warn(fmt.Sprintf("the Claude login moved to the login file but the old keychain item stayed (security exited %d)", d))
			return kcResponse{Code: 1}
		}
		return kcResponse{}
	}
	if code != 0 {
		b.warn(fmt.Sprintf("could not save the Claude login in the keychain (security exited %d)", code))
	}
	return kcResponse{Code: code}
}

func (b *kcBroker) warn(s string) {
	if b.log != nil {
		b.log("keychain broker: " + s)
	}
}

// refreshToken: the real refresh token, for the refresh terminator (launcher socket, server only)
func (b *kcBroker) refreshToken() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	cur := b.current()
	if !cur.present {
		return ""
	}
	return kcRealRefresh(cur.item)
}

// rotated: the refresh terminator saw a new refresh token (and access token) come back: keep them, the engine gets
// the placeholder
func (b *kcBroker) rotated(access, refresh string, expiresAt int64) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	cur := b.current()
	if !cur.present {
		return fmt.Errorf("no Claude login to update")
	}
	o, ok := kcOAuthParse(cur.item["claudeAiOauth"])
	if !ok {
		return fmt.Errorf("the stored Claude login is not readable")
	}
	if refresh == "" || len(refresh) > 1024 || len(access) > 1024 {
		return fmt.Errorf("bad token")
	}
	o.RefreshToken = refresh
	if access != "" {
		o.AccessToken = access
		if expiresAt > 0 {
			o.ExpiresAt = &expiresAt
		}
	}
	if r := b.writeOAuth(cur, o); r.Code != 0 {
		b.pending = &o
		b.warn(fmt.Sprintf("could not save the renewed Claude login (%d); kept in memory and tried again", r.Code))
	}
	return nil
}

func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	// a link at the file's place (a dotfiles setup) is followed to a regular file in the same home, never elsewhere
	if st, err := os.Lstat(path); err == nil && st.Mode()&os.ModeSymlink != 0 {
		real, err := filepath.EvalSymlinks(path)
		if err != nil {
			return err
		}
		if accountHome == "" || !inside(resolvePath(accountHome), real) {
			return fmt.Errorf("%s links outside the home folder", path)
		}
		path = real
	}
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
// Every call has a time limit: a keychain that waits for an unlock dialog must not hold every turn's login.
type securityStore struct{ account string }

const securityBin = "/usr/bin/security"

func securityRun(stdin string, args ...string) ([]byte, int) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, securityBin, args...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	out, err := cmd.Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok && ctx.Err() == nil {
			return nil, ee.ExitCode()
		}
		return nil, 1
	}
	return out, 0
}

func (s securityStore) find(service string) (string, int) {
	out, code := securityRun("", "find-generic-password", "-a", s.account, "-w", "-s", service)
	return strings.TrimRight(string(out), "\n"), code
}

// add saves the item on the stdin of `security -i`, never in argv (every process of the account can read another's
// argv, a turn too). An item too long for one `security -i` line is not saved (logged): Claude Code itself would put
// it in argv.
func (s securityStore) add(service, value string) int {
	hx := hex.EncodeToString([]byte(value))
	line := fmt.Sprintf("add-generic-password -U -a %q -s %q -X %q\n", s.account, service, hx)
	if len(line) > kcStdinLine {
		return kcTooLong // never in argv: writeOAuth uses the login file
	}
	_, code := securityRun(line, "-i")
	return code
}

func (s securityStore) del(service string) int {
	_, code := securityRun("", "delete-generic-password", "-a", s.account, "-s", service)
	return code
}

func (s securityStore) info() int {
	_, code := securityRun("", "show-keychain-info")
	return code
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
	if len(hex.EncodeToString([]byte(value)))+100 > kcStdinLine { // as securityStore
		return kcTooLong
	}
	m := f.load()
	m[service] = value
	b, _ := json.Marshal(m)
	if writeFileAtomic(f.path, b, 0o600) != nil {
		return 1
	}
	return 0
}
func (f fileStore) del(service string) int {
	m := f.load()
	if _, ok := m[service]; !ok {
		return kcNotFound
	}
	delete(m, service)
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
// kcB: the running broker (launcher socket ops claude-refresh-token / claude-refresh-rotated); nil = none
var kcB *kcBroker

func startKeychainBroker(dir, bridge string, store kcStore, hideRefresh bool) error {
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
		log: func(s string) { fmt.Fprintln(os.Stderr, "mycel-launcher:", s) }, hideRefresh: hideRefresh}
	if store == nil {
		b.store = securityStore{account: acct}
	}
	slots := make(chan struct{}, 32) // at most this many requests at once (each waits up to 2 s for its turn)
	go func() {
		for {
			c, err := ln.AcceptUnix()
			if err != nil {
				time.Sleep(100 * time.Millisecond) // out of descriptors: no busy loop
				continue
			}
			select {
			case slots <- struct{}{}:
				go func() { defer func() { <-slots }(); b.serve(c) }()
			default:
				_ = c.Close()
			}
		}
	}()
	kcB = b
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

// kcRefreshOp answers the refresh terminator on the launcher socket (only the server uid reaches it): the real
// refresh token for an engine's refresh with the placeholder, and the rotated tokens of the answer.
func kcRefreshOp(op string, line []byte, o *out) {
	if kcB == nil || !kcB.hideRefresh {
		o.send(map[string]any{"ev": "error", "message": "no Claude login broker"})
		return
	}
	if op == "claude-refresh-token" {
		t := kcB.refreshToken()
		if t == "" {
			o.send(map[string]any{"ev": "error", "message": "no Claude login on this Mac"})
			return
		}
		o.send(map[string]any{"ev": "refresh-token", "value": t})
		return
	}
	var m struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		ExpiresAt    int64  `json:"expiresAt"`
	}
	if json.Unmarshal(line, &m) != nil {
		o.send(map[string]any{"ev": "error", "message": "bad request"})
		return
	}
	if err := kcB.rotated(m.AccessToken, m.RefreshToken, m.ExpiresAt); err != nil {
		o.send(map[string]any{"ev": "error", "message": err.Error()})
		return
	}
	o.send(map[string]any{"ev": "ok"})
}

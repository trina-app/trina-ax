// mycel-launcher: runs AI engine turns on behalf of the server, as the engine account (_axagent in
// production, started by a LaunchDaemon; the current user in stage 1). The server cannot start processes as
// another account without root, so it asks this program over launcher.sock (only the server uid may connect).
//
// Protocol (JSON lines): server sends one LaunchRequest (see shared/src/engine.ts) and may later send
// {"op":"kill"}; closing the connection before the exit event counts as kill. The launcher answers {"ev":"started","pid","pgid"}, then {"ev":"stdout"|"stderr","b64"} chunks,
// then {"ev":"exit","code","signal","session"}. The engine runs in a new session (setsid) so its process group
// id = session id = engine pid; the whole group is killed when the turn ends.
//
// Per-turn files (all 0600 in <chatDir>/.turn, 0700): token (the bridge reads and deletes it), system.md
// (deleted after the engine's first output), mcp.json (bridge path + turn dir only, no secrets).
//
// No argv or environment of a process this launcher starts names the chat folder (security audit r2, os-layer #1):
// every process of the engine account can read every other one's argv and environment (KERN_PROCARGS2, only the uid
// is checked; the sandbox cannot filter it), so a turn whose tool lockdown failed could otherwise learn which chats
// exist and are answering. The engine runs with the chat folder as its working folder and every mention of it in
// argv and env is rewritten to a relative path ("./.turn/mcp.json", "."); the bridge gets "--turn-dir ."; the
// sandbox parameters go into a profile file with a random name instead of sandbox-exec -D arguments.
//
// Model proxy token (subscription / company-key mode, design tab 3 "실행기가 만드는 명령" ④): the request's modelToken
// goes to the engine on a pipe inherited as fd 3 (CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3, Claude Code reads it once
// and drops the variable), never in argv or the environment: every process of the engine account can read another's
// environment (KERN_PROCARGS2, not filterable by the sandbox). ANTHROPIC_BASE_URL is set from --proxy-port (the
// root-owned LaunchDaemon arguments), not from the server's request, and credential variables in the request's
// environment are dropped.
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
	"mycel/native/internal/peer"
)

// live turn sessions (engine pid = pgid = sid)
type liveSet struct {
	mu sync.Mutex
	m  map[int]bool
}

func (l *liveSet) add(p int)      { l.mu.Lock(); l.m[p] = true; l.mu.Unlock() }
func (l *liveSet) del(p int)      { l.mu.Lock(); delete(l.m, p); l.mu.Unlock() }
func (l *liveSet) has(p int) bool { l.mu.Lock(); defer l.mu.Unlock(); return l.m[p] }

var live = &liveSet{m: map[int]bool{}}

// checkDedicated refuses reaping when the launcher runs as root or as a person (stage 1 runs as the owner!).
func checkDedicated() error {
	uid := os.Getuid()
	if uid == 0 || uid == *serverUID {
		return fmt.Errorf("--dedicated-account refused: uid %d is root or the server account", uid)
	}
	if runtime.GOOS == "darwin" && (uid < 450 || uid > 499) {
		return fmt.Errorf("--dedicated-account refused: macOS role accounts use uid 450-499, this is %d", uid)
	}
	if runtime.GOOS == "linux" && uid >= 1000 && os.Getenv("MYCEL_ALLOW_REGULAR_UID_REAP") != "1" {
		return fmt.Errorf("--dedicated-account refused: uid %d looks like a person", uid)
	}
	return nil
}

// killLeftovers kills every other process of this uid at start. Not kill(-1, SIGKILL): on macOS that also kills the
// caller, so the LaunchDaemon died at every start (found by the install test, tests/install/g-macos-install.ts).
func killLeftovers() {
	me := os.Getpid()
	for round := 0; round < 3; round++ {
		ps, err := peer.OwnProcs(os.Getuid())
		if err != nil {
			return // no process list: the reaper catches orphans between turns
		}
		n := 0
		for _, p := range ps {
			if p.Pid != me {
				_ = syscall.Kill(p.Pid, syscall.SIGKILL)
				n++
			}
		}
		if n == 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// reaper kills processes of this uid that were orphaned (ppid 1) and are not in a live turn session.
func reaper() {
	me, myPpid := os.Getpid(), os.Getppid()
	mySid, _ := unix.Getsid(me)
	for {
		time.Sleep(5 * time.Second)
		reapOnce(me, myPpid, mySid)
	}
}

func reapOnce(me, myPpid, mySid int) {
	ps, err := peer.OwnProcs(os.Getuid())
	if err != nil {
		return
	}
	for _, p := range ps {
		if p.Pid == me || p.Pid == myPpid || p.Sid == mySid || live.has(p.Sid) || p.Ppid != 1 {
			continue
		}
		_ = syscall.Kill(p.Pid, syscall.SIGKILL)
	}
}

type fileSpec struct {
	Rel     string `json:"rel"`
	Content string `json:"content"`
}
type sessRestore struct{ Dir, Name, B64 string }
type sessCollect struct {
	Dir       string `json:"dir"`
	Name      string `json:"name"`
	RemoveDir bool   `json:"removeDir"`
}
type request struct {
	Op             string            `json:"op"`
	TurnID         string            `json:"turnId"`
	ChatDir        string            `json:"chatDir"`
	Cmd            string            `json:"cmd"`
	Args           []string          `json:"args"`
	Env            map[string]string `json:"env"`
	Token          string            `json:"token"`
	SystemPrompt   string            `json:"systemPrompt"`
	SessionRestore *struct {
		Dir  string `json:"dir"`
		Name string `json:"name"`
		B64  string `json:"b64"`
	} `json:"sessionRestore"`
	SessionCollect *sessCollect `json:"sessionCollect"`
	TimeoutMs      int64        `json:"timeoutMs"`
	Stdin          string       `json:"stdin"`
	Files          []fileSpec   `json:"files"`
	ModelToken     *struct {
		Kind  string `json:"kind"`
		Value string `json:"value"`
	} `json:"modelToken"`
	// Codex turn as the engine account: copy the account's Codex login into <chat>/.codex for this turn and write a
	// refreshed one back afterwards (codex.go). Needs --codex-auth-dir. Older setup / F1 fallback only.
	CodexAuth bool `json:"codexAuth"`
	// managed Codex turn (docs/DECISIONS.md "AI 연결" D9): a placeholder auth.json carrying only this turn's proxy
	// token, written into a fresh <chat>/.codex and removed after the turn (codexManagedBegin, codex.go)
	CodexHome *struct {
		AuthJSON string `json:"authJson"`
	} `json:"codexHome"`
	// F1 only: the AI connection of the turn's real Codex login (unused by managed turns)
	CredentialID string `json:"credentialId"`
}

// credential variables an engine must never get through its environment (other processes of the engine account
// can read it); the model proxy token travels on fd 3 instead
var secretEnv = map[string]bool{
	"CLAUDE_CODE_OAUTH_TOKEN": true, "ANTHROPIC_API_KEY": true, "ANTHROPIC_AUTH_TOKEN": true,
	"CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR": true, "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR": true,
	"CLAUDE_CODE_OAUTH_REFRESH_TOKEN": true,
	// Codex: an API key or access token in the environment would win over auth.json (C15); the refresh address is set
	// by the launcher itself (managed turns: the proxy, which refuses)
	"CODEX_API_KEY": true, "OPENAI_API_KEY": true, "CODEX_ACCESS_TOKEN": true, "CODEX_REFRESH_TOKEN_URL_OVERRIDE": true,
}

// tokenFdVar is the variable that tells Claude Code which inherited descriptor holds its credential
var tokenFdVar = map[string]string{"oauth": "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "api-key": "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR"}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

type multi []string

func (m *multi) String() string     { return strings.Join(*m, ",") }
func (m *multi) Set(v string) error { *m = append(*m, v); return nil }

var (
	agentRoot  = flag.String("agent-root", "", "chat folders must be directly under this folder")
	bridgePath = flag.String("bridge", "", "path of mycel-bridge")
	toolsSock  = flag.String("tools-sock", "", "path of tools.sock (gate)")
	serverUID  = flag.Int("server-uid", os.Getuid(), "only this uid may send requests")
	dedicated  = flag.Bool("dedicated-account", false, "this launcher runs as the dedicated engine account: kill every other process of this uid at start and reap orphans between turns (refused for human/root uids)")
	sessRoots  multi
	allowCmd   multi
	// macOS: run every engine inside sandbox-exec with this profile (root/engine.sb, design tab 2 "기본 ② 샌드박스").
	// The profile gets the turn's chat folder, the agent root, the engine's folder, the bridge, the tools socket and the
	// model proxy port as parameters. Empty = no sandbox (stage-1 tests, Linux).
	sandboxProfile = flag.String("sandbox-profile", "", "macOS: sandbox-exec profile every engine runs under")
	proxyPort      = flag.Int("proxy-port", 0, "model proxy port the sandbox allows (127.0.0.1)")
	localLogin     = flag.Bool("local-login", false, "sandbox: also allow the account's own ~/.claude, login keychain and direct HTTPS (dev / owner login mode)")
	// with --local-login: also the account's ~/.codex login and CLI (only when a Codex binary is configured; office
	// mode turns Codex off and its engines must not read the Mac user's Codex login, security round 4)
	localCodex = flag.Bool("local-codex", false, "sandbox, with --local-login: also allow the account's ~/.codex/auth.json and ~/.codex/packages")
	// the server starts this launcher itself (dev / local-login) and holds our stdin open: when the server dies, even
	// by kill -9, the pipe closes and we stop every turn and exit instead of staying behind as an orphan
	exitWithParent = flag.Bool("exit-with-parent", false, "stop all turns and exit when stdin closes (the starting server is gone)")
)

// stopAllAndExit ends every live turn (SIGTERM to its process group, SIGKILL after 5 s) and exits.
func stopAllAndExit() {
	groups := func() []int {
		live.mu.Lock()
		defer live.mu.Unlock()
		out := make([]int, 0, len(live.m))
		for p := range live.m {
			out = append(out, p)
		}
		return out
	}
	for _, p := range groups() {
		_ = syscall.Kill(-p, syscall.SIGTERM)
	}
	for deadline := time.Now().Add(5 * time.Second); len(groups()) > 0 && time.Now().Before(deadline); {
		time.Sleep(50 * time.Millisecond)
	}
	for _, p := range groups() {
		_ = syscall.Kill(-p, syscall.SIGKILL)
	}
	os.Exit(0)
}

const sandboxExec = "/usr/bin/sandbox-exec"

// accountHome is the home folder of the account the launcher runs as (USER_HOME of the profile). Looked up in the
// account database, not $HOME: the server starts the launcher with an empty environment, where os.UserHomeDir()
// was "" and every LOCAL_LOGIN rule of the profile pointed at "/.claude" (no login, found in security audit r1).
var accountHome string

func lookupHome() string {
	if u, err := user.LookupId(strconv.Itoa(os.Getuid())); err == nil && filepath.IsAbs(u.HomeDir) {
		return u.HomeDir
	}
	if h, err := os.UserHomeDir(); err == nil && filepath.IsAbs(h) {
		return h
	}
	return ""
}

// engineCommand wraps the engine in sandbox-exec when a profile is configured. sandbox-exec applies the profile and
// then exec()s the engine, so the pid (= session id = process group the server checks) stays the same.
// sessDir is the folder the engine keeps this turn's session transcript in: the chat folder itself, or (local login)
// the already validated --session-root folder of this chat; with --local-login the profile opens it and nothing
// else of the CLI's projects folder.
// The profile's parameters are written into a copy of the profile (renderProfile) with a random name in the
// launcher's temp folder (/tmp or /private/var/folders, closed to every engine by the profile), never passed as
// `-D CHAT_DIR=…`: sandbox-exec's argv is readable by every process of the account until it exec()s the engine. The
// returned cleanup removes that copy; call it when the engine has exited.
func engineCommand(cmdPath string, args []string, chat, sessDir string) (*exec.Cmd, func(), error) {
	if *sandboxProfile == "" {
		return exec.Command(cmdPath, args...), func() {}, nil
	}
	real, err := filepath.EvalSymlinks(cmdPath)
	if err != nil {
		return nil, nil, fmt.Errorf("engine: %v", err)
	}
	ll, lc := "0", "0"
	if *localLogin {
		ll = "1"
		if *localCodex {
			lc = "1"
		}
	}
	params := map[string]string{
		"CHAT_DIR":    resolvePath(chat),
		"AGENT_ROOT":  resolvePath(filepath.Clean(*agentRoot)),
		"ENGINE_DIR":  filepath.Dir(real),
		"BRIDGE":      resolvePath(*bridgePath),
		"TOOLS_SOCK":  resolvePath(*toolsSock),
		"PROXY_PORT":  strconv.Itoa(*proxyPort),
		"LOCAL_LOGIN": ll,
		"LOCAL_CODEX": lc,
		"USER_HOME":   resolvePath(accountHome),
		"SESSION_DIR": resolvePath(filepath.Clean(sessDir)),
	}
	text, err := os.ReadFile(*sandboxProfile)
	if err != nil {
		return nil, nil, fmt.Errorf("sandbox profile: %v", err)
	}
	prof, err := renderProfile(string(text), params)
	if err != nil {
		return nil, nil, err
	}
	tmpDir := resolvePath(os.TempDir())
	if tmpDir == params["AGENT_ROOT"] || inside(params["AGENT_ROOT"], tmpDir) {
		return nil, nil, fmt.Errorf("sandbox profile: the launcher's temp folder is inside the agent root")
	}
	f, err := os.CreateTemp(tmpDir, "mycel-sb-*.sb") // 0600, O_EXCL, random name
	if err != nil {
		return nil, nil, fmt.Errorf("sandbox profile: %v", err)
	}
	cleanup := func() { _ = os.Remove(f.Name()) }
	if _, err := f.WriteString(prof); err != nil {
		f.Close()
		cleanup()
		return nil, nil, fmt.Errorf("sandbox profile: %v", err)
	}
	if err := f.Close(); err != nil {
		cleanup()
		return nil, nil, fmt.Errorf("sandbox profile: %v", err)
	}
	return exec.Command(sandboxExec, append([]string{"-f", f.Name(), real}, args...)...), cleanup, nil
}

// resolvePath: the kernel matches sandbox paths after resolving symlinks (/tmp -> /private/tmp, /var -> /private/var).
func resolvePath(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	if r, err := filepath.EvalSymlinks(filepath.Dir(p)); err == nil {
		return filepath.Join(r, filepath.Base(p))
	}
	return p
}

var profileParam = regexp.MustCompile(`\(param "([A-Za-z_][A-Za-z0-9_]*)"\)`)

// baseURLArg: a Codex `-c` option that names an address the engine sends requests to (model_providers.<id>.base_url,
// chatgpt_base_url, openai_base_url)
var baseURLArg = regexp.MustCompile(`^[A-Za-z0-9_.]*base_url\s*=\s*(.*)$`)

// renderProfile replaces every (param "NAME") of the SBPL profile with the value as an SBPL string literal. A
// parameter the launcher does not know, or a value with a control character, refuses the turn (fail closed).
func renderProfile(text string, params map[string]string) (string, error) {
	for k, v := range params {
		for _, c := range v {
			if c < 0x20 || c == 0x7f {
				return "", fmt.Errorf("sandbox profile: parameter %s has a control character", k)
			}
		}
	}
	quote := strings.NewReplacer(`\`, `\\`, `"`, `\"`)
	var missing []string
	out := profileParam.ReplaceAllStringFunc(text, func(m string) string {
		k := profileParam.FindStringSubmatch(m)[1]
		v, ok := params[k]
		if !ok {
			missing = append(missing, k)
			return m
		}
		return `"` + quote.Replace(v) + `"`
	})
	if len(missing) > 0 {
		return "", fmt.Errorf("sandbox profile: unknown parameter %s", strings.Join(missing, ", "))
	}
	return out, nil
}

// chatRelative rewrites every mention of the chat folder (as given and as resolved) in s to a path relative to the
// engine's working folder, which is the chat folder: "<chat>/.turn/mcp.json" -> "./.turn/mcp.json", "<chat>" -> ".".
// A longer name that only starts with the chat folder's ("<agent>/c1x" for "<agent>/c1") is left alone.
func chatRelative(chatForms []string) func(string) string {
	res := make([]*regexp.Regexp, 0, len(chatForms))
	for _, c := range chatForms {
		res = append(res, regexp.MustCompile(regexp.QuoteMeta(c)+`([^A-Za-z0-9._-]|$)`))
	}
	return func(s string) string {
		for _, re := range res {
			s = re.ReplaceAllString(s, ".$1")
		}
		return s
	}
}

func main() {
	listen := flag.String("listen", "", "launcher.sock path")
	mode := flag.String("mode", "0600", "socket mode")
	flag.Var(&allowCmd, "allow-cmd", "engine executable that may be started (repeatable)")
	flag.Var(&sessRoots, "session-root", "extra folder under which session files may be restored/collected (repeatable)")
	flag.Parse()
	if err := checkPlatformFlags(); err != nil { // sandbox.go: Linux sandbox setup (spec 3.3.2), exit 2 when wrong
		exitf("%v", err)
	}
	if *listen == "" || *agentRoot == "" || *bridgePath == "" || *toolsSock == "" || len(allowCmd) == 0 {
		fmt.Fprintln(os.Stderr, "usage: mycel-launcher --listen <sock> --agent-root <dir> --bridge <path> --tools-sock <path> --allow-cmd <engine> [--server-uid N]")
		os.Exit(2)
	}
	if *sandboxProfile != "" {
		if runtime.GOOS != "darwin" {
			fmt.Fprintln(os.Stderr, "mycel-launcher: --sandbox-profile is macOS only (on Linux use --sandbox bwrap)")
			os.Exit(2)
		}
		if _, err := os.Stat(*sandboxProfile); err != nil {
			fmt.Fprintln(os.Stderr, "mycel-launcher: sandbox profile:", err)
			os.Exit(2)
		}
		if _, err := os.Stat(sandboxExec); err != nil {
			fmt.Fprintln(os.Stderr, "mycel-launcher: sandbox-exec missing:", err)
			os.Exit(2)
		}
		if accountHome = lookupHome(); accountHome == "" && *localLogin {
			fmt.Fprintln(os.Stderr, "mycel-launcher: --local-login: no home folder for this account")
			os.Exit(2)
		}
	}
	if *dedicated {
		if err := checkDedicated(); err != nil {
			fmt.Fprintln(os.Stderr, "mycel-launcher:", err)
			os.Exit(2)
		}
		killLeftovers() // leftovers of a previous launcher (setsid escapees, crashed turns)
		go reaper()
		go dailySweep() // ops.go: chat folders unused for 30 days
	}
	if *exitWithParent {
		go func() { _, _ = io.Copy(io.Discard, os.Stdin); stopAllAndExit() }()
	}
	_ = os.Remove(*listen)
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: *listen, Net: "unix"})
	if err != nil {
		fmt.Fprintln(os.Stderr, "mycel-launcher:", err)
		os.Exit(1)
	}
	var m uint32
	fmt.Sscanf(*mode, "%o", &m)
	_ = os.Chmod(*listen, os.FileMode(m))
	fmt.Println("ready")
	for {
		c, err := ln.AcceptUnix()
		if err != nil {
			continue
		}
		go serve(c)
	}
}

type out struct {
	mu sync.Mutex
	c  *net.UnixConn
}

func (o *out) send(v any) {
	b, _ := json.Marshal(v)
	o.mu.Lock()
	defer o.mu.Unlock()
	_, _ = o.c.Write(append(b, '\n'))
}

func inside(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != "." && !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel)
}

func serve(c *net.UnixConn) {
	defer c.Close()
	o := &out{c: c}
	cr, err := peer.Of(c)
	if err != nil || cr.Uid != *serverUID {
		o.send(map[string]any{"ev": "error", "message": "only the server may use the launcher"})
		return
	}
	r := bufio.NewReaderSize(c, 64<<20)
	line, err := r.ReadBytes('\n')
	if err != nil {
		return
	}
	var probe struct {
		Op         string `json:"op"`
		ClientPort int    `json:"clientPort"`
		ServerPort int    `json:"serverPort"`
	}
	_ = json.Unmarshal(line, &probe)
	switch probe.Op {
	case "status", "forget": // ops.go
		if probe.Op == "status" {
			o.send(statusEvent())
		} else {
			forgetChat(line, o)
		}
		return
	case "codex-status":
		codexStatus(o)
		return
	case "codex-logout":
		codexLogout(o)
		return
	case "codex-export":
		codexExport(o)
		return
	case "codex-login":
		stop := make(chan struct{})
		go func() { // the server closed the connection or sent kill: stop the login
			for {
				l, err := r.ReadBytes('\n')
				var m map[string]any
				if err != nil || (json.Unmarshal(l, &m) == nil && m["op"] == "kill") {
					close(stop)
					return
				}
			}
		}()
		if err := codexLogin(line, o, stop); err != nil {
			o.send(map[string]any{"ev": "error", "message": err.Error()})
		}
		return
	}
	if probe.Op == "tcp-peer" { // model proxy: which engine process owns this loopback connection? (only this uid can see it)
		pid, err := peer.TCPOwner(probe.ClientPort, probe.ServerPort)
		if err != nil {
			o.send(map[string]any{"ev": "error", "message": err.Error()})
			return
		}
		pg, _ := unix.Getpgid(pid)
		sid, _ := unix.Getsid(pid)
		o.send(map[string]any{"ev": "peer", "pid": pid, "pgid": pg, "sid": sid})
		return
	}
	var req request
	if err := json.Unmarshal(line, &req); err != nil || req.Op != "run" {
		o.send(map[string]any{"ev": "error", "message": "bad request"})
		return
	}
	if err := run(&req, o, r); err != nil {
		o.send(map[string]any{"ev": "error", "message": err.Error()})
	}
}

func allowedSessionDir(chatDir, dir string) bool {
	if inside(chatDir, dir) {
		return true
	}
	for _, s := range sessRoots {
		if inside(s, dir) {
			return true
		}
	}
	return false
}

func run(req *request, o *out, r *bufio.Reader) error {
	ok := false
	for _, a := range allowCmd {
		if a == req.Cmd {
			ok = true
		}
	}
	if !ok {
		return fmt.Errorf("engine %q is not allowed", req.Cmd)
	}
	chat := filepath.Clean(req.ChatDir)
	if !inside(*agentRoot, chat) || filepath.Dir(chat) != filepath.Clean(*agentRoot) {
		return fmt.Errorf("chat folder must be directly under the agent root")
	}
	if isCodexAuthDir(chat) {
		return fmt.Errorf("the Codex login folder is not a chat folder")
	}
	// chat ids are uuids: a name starting with "." (the ChatGPT sign-in folders .codex-login, anything hidden) is never
	// a chat folder
	if strings.HasPrefix(filepath.Base(chat), ".") {
		return fmt.Errorf("a hidden folder is not a chat folder")
	}
	if err := os.MkdirAll(chat, 0o700); err != nil {
		return err
	}
	if st, err := os.Lstat(chat); err != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("bad chat folder")
	}
	// every file operation below the chat folder goes through its open root, never through a link the engine planted
	// (safepath.go, D27, spec 3.3.8): .codex, .home, .tmp, .turn, the request's files and the session transcript
	chatRoot, err := openRoot(chat)
	if err != nil {
		return err
	}
	defer chatRoot.close()
	if !req.CodexAuth {
		// a Codex turn's <chat>/.codex (a login copy or a placeholder login) is removed when that turn ends; after a
		// launcher crash or kill it stays. Every other turn here (Claude with its tools, the next Codex turn) must not
		// find it: remove the folder before any other turn starts (a managed Codex turn makes a fresh one below).
		if err := chatRoot.removeAll(".codex"); err != nil {
			return fmt.Errorf("could not clear a left-over Codex folder: %v", err)
		}
	}
	if req.CodexHome != nil && req.CodexAuth {
		return fmt.Errorf("a turn is either managed or agent-own Codex, not both")
	}
	// sandbox.go hooks (Linux: fail-closed checks, turn cgroup, fresh .tmp; macOS: bookkeeping only)
	te, err := beginTurn(req, chat)
	if err != nil {
		return err
	}
	defer te.cleanup()
	_ = chatRoot.mkdirAll(".tmp", 0o700)  // TMPDIR / CLAUDE_CODE_TMPDIR of the engine
	_ = chatRoot.mkdirAll(".home", 0o700) // HOME of the engine in proxy modes (inside the sandbox)
	turn := filepath.Join(chat, ".turn")
	if err := chatRoot.removeAll(".turn"); err != nil {
		return err
	}
	if err := chatRoot.mkdirAll(".turn", 0o700); err != nil {
		return err
	}
	defer chatRoot.removeAll(".turn") // early-error paths; the normal path removes it before reporting "exit" (below)
	write := func(name, s string) error { return chatRoot.writeNew(filepath.Join(".turn", name), []byte(s), 0o600) }
	if err := write("token", req.Token); err != nil {
		return err
	}
	req.Token = ""
	sysFile := filepath.Join(turn, "system.md")
	if err := write("system.md", req.SystemPrompt); err != nil {
		return err
	}
	// the engine starts the bridge by its resolved path, the one the sandbox profile allows (BRIDGE): an installed
	// --bridge goes through app/current, a link the sandboxed engine may not read, and the team tools failed with EPERM
	bridge, sock := resolvePath(*bridgePath), resolvePath(*toolsSock)
	mcpFile := filepath.Join(turn, "mcp.json")
	mcp, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{"team": map[string]any{
		"type": "stdio", "command": bridge, "args": []string{"--turn-dir", ".", "--sock", sock}}}})
	if err := write("mcp.json", string(mcp)); err != nil {
		return err
	}
	subst := strings.NewReplacer("{MCP_CONFIG}", mcpFile, "{SYSTEM_PROMPT_FILE}", sysFile, "{TURN_DIR}", turn,
		"{CHAT_DIR}", chat, "{BRIDGE}", bridge, "{TOOLS_SOCK}", sock)
	// files and the session transcript go below the chat folder (or a --session-root) through safepath.go
	for _, f := range req.Files {
		p := filepath.Join(chat, filepath.Clean(subst.Replace(f.Rel)))
		if !inside(chat, p) {
			return fmt.Errorf("file outside chat folder")
		}
		rel, _ := filepath.Rel(chat, p)
		if err := chatRoot.writeNew(rel, []byte(subst.Replace(f.Content)), 0o600); err != nil {
			return err
		}
	}
	if s := req.SessionRestore; s != nil {
		if !allowedSessionDir(chat, s.Dir) || strings.ContainsAny(s.Name, "/\\") {
			return fmt.Errorf("bad session restore path")
		}
		b, err := base64.StdEncoding.DecodeString(s.B64)
		if err != nil {
			return err
		}
		if err := restoreSession(chat, s.Dir, s.Name, b); err != nil {
			return fmt.Errorf("session restore: %v", err)
		}
	}
	if s := req.SessionCollect; s != nil && (!allowedSessionDir(chat, s.Dir) || strings.ContainsAny(s.Name, "/\\")) {
		return fmt.Errorf("bad session collect path")
	}

	stopping := make(chan struct{}, 1)
	stop := func() {
		select {
		case stopping <- struct{}{}:
		default:
		}
	}
	go func() { // control messages from the server
		for {
			l, err := r.ReadBytes('\n')
			if err != nil {
				// the server's end of this connection is gone (crash, kill -9, restart): nobody can read the answer
				// or stop the turn any more, and the turn's token died with the server. Stop the engine now instead
				// of letting it run (and spend the subscription) until the backstop timeout.
				stop()
				return
			}
			var m map[string]any
			if json.Unmarshal(l, &m) == nil && m["op"] == "kill" {
				stop()
			}
		}
	}()
	managedCleared := false
	if req.CodexHome != nil {
		// managed Codex turn: a placeholder login only (refused if it looks like a real one, security T1); the folders
		// go when the turn ends, whatever happens
		if *proxyPort <= 0 {
			return fmt.Errorf("a managed Codex turn needs the model proxy (--proxy-port)")
		}
		if err := codexManagedBegin(chat, req.CodexHome.AuthJSON); err != nil {
			return err
		}
		req.CodexHome.AuthJSON = ""
		defer func() { // early-error paths; the normal path removes them before reporting "exit" (below)
			if !managedCleared {
				codexManagedEnd(chat)
			}
		}()
	}
	var ct *codexTurn
	codexEnded := false
	if req.CodexAuth {
		var err error
		if ct, err = codexBegin(chat, stopping); err != nil {
			return err
		}
		defer func() { // early-error paths; the normal path ends it before reporting "exit" (below)
			if !codexEnded {
				ct.end()
			}
		}()
	}

	// nothing of the chat folder in argv or env (see the top of this file): relative to the working folder
	chatForms := []string{chat}
	if r := resolvePath(chat); r != chat {
		chatForms = append(chatForms, r)
	}
	rel := chatRelative(chatForms)
	names := func(s string) bool {
		for _, c := range chatForms {
			if strings.Contains(s, c) {
				return true
			}
		}
		return false
	}
	args := make([]string, len(req.Args))
	for i, a := range req.Args {
		args[i] = rel(subst.Replace(a))
		if names(args[i]) {
			return fmt.Errorf("an engine argument names the chat folder")
		}
		// a model provider / ChatGPT address in the engine's options may only be the model proxy (like
		// ANTHROPIC_BASE_URL, which the launcher sets itself): the engine account's credentials never go elsewhere
		if m := baseURLArg.FindStringSubmatch(args[i]); m != nil {
			if *proxyPort <= 0 || !strings.HasPrefix(strings.Trim(m[1], `"' `), fmt.Sprintf("http://127.0.0.1:%d/", *proxyPort)) {
				return fmt.Errorf("an engine address that is not the model proxy")
			}
		}
	}
	env := make([]string, 0, len(req.Env)+3)
	if req.CodexHome != nil {
		// Codex's own refresh goes to the proxy, which refuses it (the server refreshes; credentials D10)
		env = append(env, fmt.Sprintf("CODEX_REFRESH_TOKEN_URL_OVERRIDE=http://127.0.0.1:%d/codex/oauth/token", *proxyPort))
	}
	for k, v := range req.Env {
		if secretEnv[k] || (*proxyPort > 0 && k == "ANTHROPIC_BASE_URL") {
			continue
		}
		v = rel(subst.Replace(v))
		if names(k) || names(v) {
			return fmt.Errorf("an engine environment variable names the chat folder")
		}
		env = append(env, k+"="+v)
	}
	// the model proxy token: a pipe that holds the token, inherited as fd 3 (see the header comment)
	var tokenRead *os.File
	if mt := req.ModelToken; mt != nil {
		fdVar, ok := tokenFdVar[mt.Kind]
		if !ok || mt.Value == "" || strings.ContainsAny(mt.Value, "\r\n") || len(mt.Value) > 512 {
			return fmt.Errorf("bad model token")
		}
		pr, pw, err := os.Pipe()
		if err != nil {
			return err
		}
		// far below the pipe buffer: the write never blocks, and the engine sees end-of-file after the token
		_, werr := pw.WriteString(mt.Value + "\n")
		_ = pw.Close()
		if werr != nil {
			_ = pr.Close()
			return werr
		}
		tokenRead = pr
		req.ModelToken = nil
		env = append(env, fdVar+"=3")
		if *proxyPort > 0 {
			env = append(env, fmt.Sprintf("ANTHROPIC_BASE_URL=http://127.0.0.1:%d", *proxyPort))
		}
	}
	closeToken := func() {
		if tokenRead != nil {
			_ = tokenRead.Close()
			tokenRead = nil
		}
	}
	defer closeToken()
	sessDir := chat
	if s := req.SessionCollect; s != nil { // validated above (allowedSessionDir)
		sessDir = s.Dir
	} else if s := req.SessionRestore; s != nil {
		sessDir = s.Dir
	}
	cmd, cleanup, err := te.command(req.Cmd, args, chat, sessDir) // sandbox-exec (macOS) / bwrap (Linux) / none
	if err != nil {
		return err
	}
	defer cleanup()
	cmd.Dir = chat
	cmd.Env = env
	if tokenRead != nil {
		cmd.ExtraFiles = []*os.File{tokenRead} // fd 3 in the engine
	}
	cmd.SysProcAttr = te.procAttr() // new session (+ Linux: parent-death signal, turn cgroup)
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		return err
	}
	closeToken() // only the engine holds the token pipe now
	pid := cmd.Process.Pid
	live.add(pid)
	defer live.del(pid)
	o.send(map[string]any{"ev": "started", "pid": pid, "pgid": pid})
	te.started(pid, stop) // Linux: disk watch
	killGroup := func(sig syscall.Signal) { _ = syscall.Kill(-pid, sig) }

	go func() { _, _ = stdin.Write([]byte(req.Stdin)); _ = stdin.Close() }()
	var once sync.Once
	var wg sync.WaitGroup
	pump := func(name string, f interface{ Read([]byte) (int, error) }) {
		defer wg.Done()
		buf := make([]byte, 64<<10)
		for {
			n, err := f.Read(buf)
			if n > 0 {
				if name == "stdout" {
					// the engine runs now and may have swapped .turn for a link: unlink below the chat root only
					once.Do(func() { _ = chatRoot.remove(filepath.Join(".turn", "system.md")) })
				} else {
					te.stderr(buf[:n])
				}
				o.send(map[string]any{"ev": name, "b64": base64.StdEncoding.EncodeToString(buf[:n])})
			}
			if err != nil {
				return
			}
		}
	}
	wg.Add(2)
	go pump("stdout", stdout)
	go pump("stderr", stderr)

	timeout := time.Duration(req.TimeoutMs) * time.Millisecond
	waitDone := make(chan error, 1)
	go func() { wg.Wait(); waitDone <- cmd.Wait() }()
	var sigName string
	var werr error
	select {
	case werr = <-waitDone:
	case <-stopping:
		sigName = "stopped"
		killGroup(syscall.SIGTERM)
		select {
		case werr = <-waitDone:
		case <-time.After(5 * time.Second):
			killGroup(syscall.SIGKILL)
			werr = <-waitDone
		}
	case <-time.After(timeout):
		sigName = "timeout"
		killGroup(syscall.SIGTERM)
		select {
		case werr = <-waitDone:
		case <-time.After(5 * time.Second):
			killGroup(syscall.SIGKILL)
			werr = <-waitDone
		}
	}
	killGroup(syscall.SIGKILL)   // nothing of this turn survives (bridge, stray children)
	sigName = te.finish(sigName) // Linux: cgroup.kill; "oom" / "disk_limit"
	if *dedicated {
		live.del(pid)
		me := os.Getpid()
		sid, _ := unix.Getsid(me)
		reapOnce(me, os.Getppid(), sid) // setsid escapees of this turn are orphans now
	}
	code := 0
	if ee, ok := werr.(*exec.ExitError); ok {
		code = ee.ExitCode()
	}
	ev := map[string]any{"ev": "exit", "code": code}
	if sigName != "" {
		ev["signal"] = sigName
	}
	if s := req.SessionCollect; s != nil {
		// never through a link (safepath.go): <dir>/x/<sid>.jsonl -> codex-auth/auth.json leaked the Codex login
		if b, err := collectSession(chat, s.Dir, s.Name, s.RemoveDir); err == nil && b != nil {
			ev["session"] = map[string]string{"b64": base64.StdEncoding.EncodeToString(b)}
		}
	}
	if ct != nil {
		codexEnded = true
		for _, n := range ct.end() {
			o.send(map[string]any{"ev": "note", "message": n})
		}
	}
	if req.CodexHome != nil {
		managedCleared = true
		codexManagedEnd(chat)
	}
	// Remove the per-turn files BEFORE reporting the exit: the server treats "exit" as "turn over" and may start
	// the next turn in the same chat folder (or check that nothing is left). A deferred removal ran after the
	// event was sent, so .turn was still there for a moment (flaky unit test, 1 in ~10 runs).
	_ = chatRoot.removeAll(".turn")
	te.cleanup()
	o.send(te.report(ev, code)) // Linux: a sandbox that could not start is an error, not an engine exit
	return nil
}

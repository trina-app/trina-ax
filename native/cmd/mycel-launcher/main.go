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
}

// credential variables an engine must never get through its environment (other processes of the engine account
// can read it); the model proxy token travels on fd 3 instead
var secretEnv = map[string]bool{
	"CLAUDE_CODE_OAUTH_TOKEN": true, "ANTHROPIC_API_KEY": true, "ANTHROPIC_AUTH_TOKEN": true,
	"CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR": true, "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR": true,
	"CLAUDE_CODE_OAUTH_REFRESH_TOKEN": true,
}

// tokenFdVar is the variable that tells Claude Code which inherited descriptor holds its credential
var tokenFdVar = map[string]string{"oauth": "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "api-key": "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR"}

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
	localLogin     = flag.Bool("local-login", false, "sandbox: also allow the account's own ~/.claude, ~/.codex, login keychain and direct HTTPS (dev / owner login mode)")
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
	ll := "0"
	if *localLogin {
		ll = "1"
	}
	params := map[string]string{
		"CHAT_DIR":    resolvePath(chat),
		"AGENT_ROOT":  resolvePath(filepath.Clean(*agentRoot)),
		"ENGINE_DIR":  filepath.Dir(real),
		"BRIDGE":      resolvePath(*bridgePath),
		"TOOLS_SOCK":  resolvePath(*toolsSock),
		"PROXY_PORT":  strconv.Itoa(*proxyPort),
		"LOCAL_LOGIN": ll,
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
	if *listen == "" || *agentRoot == "" || *bridgePath == "" || *toolsSock == "" || len(allowCmd) == 0 {
		fmt.Fprintln(os.Stderr, "usage: mycel-launcher --listen <sock> --agent-root <dir> --bridge <path> --tools-sock <path> --allow-cmd <engine> [--server-uid N]")
		os.Exit(2)
	}
	if *sandboxProfile != "" {
		if runtime.GOOS != "darwin" {
			fmt.Fprintln(os.Stderr, "mycel-launcher: --sandbox-profile is macOS only")
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
	if err := os.MkdirAll(chat, 0o700); err != nil {
		return err
	}
	if st, err := os.Lstat(chat); err != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("bad chat folder")
	}
	_ = os.MkdirAll(filepath.Join(chat, ".tmp"), 0o700)  // TMPDIR / CLAUDE_CODE_TMPDIR of the engine
	_ = os.MkdirAll(filepath.Join(chat, ".home"), 0o700) // HOME of the engine in proxy modes (inside the sandbox)
	turn := filepath.Join(chat, ".turn")
	_ = os.RemoveAll(turn)
	if err := os.Mkdir(turn, 0o700); err != nil {
		return err
	}
	defer os.RemoveAll(turn) // early-error paths; the normal path removes it before reporting "exit" (below)
	write := func(p, s string) error {
		f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = f.WriteString(s)
		return err
	}
	if err := write(filepath.Join(turn, "token"), req.Token); err != nil {
		return err
	}
	req.Token = ""
	sysFile := filepath.Join(turn, "system.md")
	if err := write(sysFile, req.SystemPrompt); err != nil {
		return err
	}
	mcpFile := filepath.Join(turn, "mcp.json")
	mcp, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{"team": map[string]any{
		"type": "stdio", "command": *bridgePath, "args": []string{"--turn-dir", ".", "--sock", *toolsSock}}}})
	if err := write(mcpFile, string(mcp)); err != nil {
		return err
	}
	subst := strings.NewReplacer("{MCP_CONFIG}", mcpFile, "{SYSTEM_PROMPT_FILE}", sysFile, "{TURN_DIR}", turn,
		"{CHAT_DIR}", chat, "{BRIDGE}", *bridgePath, "{TOOLS_SOCK}", *toolsSock)
	for _, f := range req.Files {
		p := filepath.Join(chat, filepath.Clean(subst.Replace(f.Rel)))
		if !inside(chat, p) {
			return fmt.Errorf("file outside chat folder")
		}
		_ = os.MkdirAll(filepath.Dir(p), 0o700)
		_ = os.Remove(p)
		if err := write(p, subst.Replace(f.Content)); err != nil {
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
		_ = os.MkdirAll(s.Dir, 0o700)
		p := filepath.Join(s.Dir, s.Name)
		_ = os.Remove(p)
		if err := write(p, string(b)); err != nil {
			return err
		}
	}
	if s := req.SessionCollect; s != nil && (!allowedSessionDir(chat, s.Dir) || strings.ContainsAny(s.Name, "/\\")) {
		return fmt.Errorf("bad session collect path")
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
	}
	env := make([]string, 0, len(req.Env)+2)
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
	cmd, cleanup, err := engineCommand(req.Cmd, args, chat, sessDir)
	if err != nil {
		return err
	}
	defer cleanup()
	cmd.Dir = chat
	cmd.Env = env
	if tokenRead != nil {
		cmd.ExtraFiles = []*os.File{tokenRead} // fd 3 in the engine
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
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
					once.Do(func() { _ = os.Remove(sysFile) })
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
	killGroup(syscall.SIGKILL) // nothing of this turn survives (bridge, stray children)
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
		var found string
		if st, err := os.Lstat(filepath.Join(s.Dir, s.Name)); err == nil && st.Mode().IsRegular() {
			found = filepath.Join(s.Dir, s.Name)
		} else if ms, _ := filepath.Glob(filepath.Join(s.Dir, "*", s.Name)); len(ms) > 0 {
			found = ms[0]
		}
		if found != "" {
			if b, err := os.ReadFile(found); err == nil {
				ev["session"] = map[string]string{"b64": base64.StdEncoding.EncodeToString(b)}
			}
			_ = os.Remove(found)
		}
		if s.RemoveDir {
			_ = os.RemoveAll(s.Dir)
		}
	}
	// Remove the per-turn files BEFORE reporting the exit: the server treats "exit" as "turn over" and may start
	// the next turn in the same chat folder (or check that nothing is left). A deferred removal ran after the
	// event was sent, so .turn was still there for a moment (flaky unit test, 1 in ~10 runs).
	_ = os.RemoveAll(turn)
	o.send(ev)
	return nil
}

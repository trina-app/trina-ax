// mycel-launcher: runs AI engine turns on behalf of the server, as the engine account (_axagent in
// production, started by a LaunchDaemon; the current user in stage 1). The server cannot start processes as
// another account without root, so it asks this program over launcher.sock (only the server uid may connect).
//
// Protocol (JSON lines): server sends one LaunchRequest (see shared/src/engine.ts) and may later send
// {"op":"kill"}. The launcher answers {"ev":"started","pid","pgid"}, then {"ev":"stdout"|"stderr","b64"} chunks,
// then {"ev":"exit","code","signal","session"}. The engine runs in a new session (setsid) so its process group
// id = session id = engine pid; the whole group is killed when the turn ends.
//
// Per-turn files (all 0600 in <chatDir>/.turn, 0700): token (the bridge reads and deletes it), system.md
// (deleted after the engine's first output), mcp.json (bridge path + turn dir only, no secrets).
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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

func (l *liveSet) add(p int) { l.mu.Lock(); l.m[p] = true; l.mu.Unlock() }
func (l *liveSet) del(p int) { l.mu.Lock(); delete(l.m, p); l.mu.Unlock() }
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
}

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
)

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
	if *dedicated {
		if err := checkDedicated(); err != nil {
			fmt.Fprintln(os.Stderr, "mycel-launcher:", err)
			os.Exit(2)
		}
		_ = syscall.Kill(-1, syscall.SIGKILL) // leftovers of a previous launcher (setsid escapees, crashed turns)
		go reaper()
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
	_ = os.MkdirAll(filepath.Join(chat, ".tmp"), 0o700) // TMPDIR / CLAUDE_CODE_TMPDIR of the engine
	turn := filepath.Join(chat, ".turn")
	_ = os.RemoveAll(turn)
	if err := os.Mkdir(turn, 0o700); err != nil {
		return err
	}
	defer os.RemoveAll(turn)
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
		"type": "stdio", "command": *bridgePath, "args": []string{"--turn-dir", chat, "--sock", *toolsSock}}}})
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

	args := make([]string, len(req.Args))
	for i, a := range req.Args {
		args[i] = subst.Replace(a)
	}
	env := make([]string, 0, len(req.Env))
	for k, v := range req.Env {
		env = append(env, k+"="+subst.Replace(v))
	}
	cmd := exec.Command(req.Cmd, args...)
	cmd.Dir = chat
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		return err
	}
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
	go func() { // control messages from the server
		for {
			l, err := r.ReadBytes('\n')
			if err != nil {
				return
			}
			var m map[string]any
			if json.Unmarshal(l, &m) == nil && m["op"] == "kill" {
				select {
				case stopping <- struct{}{}:
				default:
				}
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
	o.send(ev)
	return nil
}

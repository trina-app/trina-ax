// Linux engine sandbox (linux-runtime spec 3.3, D6/D7): every turn runs as
//
//	setsid bwrap <namespaces, an empty read-only root with only what the engine needs bound in>
//	  -- /.sbx/mycel-sandbox exec --landlock MODE --exec-allow <engine dir> --exec-allow <bridge> [--exec-allow <ld.so>]
//	  -- <engine> <args>
//
// bwrap gets NO --new-session: the launcher already starts it in a new session (Setsid), and without the option bwrap
// never calls setsid/setpgid, so the monitor, the namespace's init and every engine process keep session = process
// group = the monitor's pid, the pid the "started" event reports. The gate's "peer sid == turn pgid" check
// (server/src/turns.ts) and the model proxy's tcp-peer check work unchanged (spike S2, docs/DECISIONS.md). The
// TIOCSTI risk --new-session addresses is covered by "no controlling terminal" (setsid) + the seccomp filter.
//
// Fail closed (spec 3.3.9): a turn is refused when the firewall status is missing, stale or for another uid/port, when
// the sandbox files changed owner or mode, when the plan's concurrent-turn limit is reached, when the turn cgroup is
// required but unavailable, or when an engine-account process listens on the model proxy port (squatting, 3.4.4).
package main

import (
	"bufio"
	"bytes"
	"debug/elf"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
	"mycel/native/internal/fwstatus"
	"mycel/native/internal/plan"
)

// lx is what setupLinux found at start.
var lx struct {
	bwrap        bool
	bwrapVersion string
	landlockAbi  int
	seccomp      bool
	kernel       string
	ldso         map[string]string // allowed engine path -> real path of its ELF interpreter ("" = static)
	bridgeReal   string
	libs         []libMount
	usrLib64     bool
	plans        *plan.Cache
	cg           *cgRoot
	cgState      string // "delegated" | "none" | "off"
	cgFdOK       bool   // clone3 CLONE_INTO_CGROUP works here (else mycel-sandbox cgexec puts the turn in its cgroup)
	sbxFiles     []string
	diskDefault  int64
}

// libMount: how /lib, /lib64, /lib32, /libx32 appear in the sandbox (same as on the host: a link or a folder).
type libMount struct {
	path   string
	link   string // non-empty: --symlink link path
	isDir  bool
	exists bool
}

var bwrapVersionRe = regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)`)

// setupLinux checks the Linux sandbox configuration at start (spec 3.3.2); an error exits 2.
func setupLinux() error {
	switch *sandboxKind {
	case "none", "bwrap":
	default:
		return fmt.Errorf("--sandbox takes none or bwrap, not %q", *sandboxKind)
	}
	switch *landlockMode {
	case "off", "best-effort", "required", "required-scoped":
	default:
		return fmt.Errorf("--landlock takes off, best-effort, required or required-scoped, not %q", *landlockMode)
	}
	switch *cgroupMode {
	case "off", "auto", "required":
	default:
		return fmt.Errorf("--cgroup takes off, auto or required, not %q", *cgroupMode)
	}
	var uts unix.Utsname
	if unix.Uname(&uts) == nil {
		lx.kernel = unix.ByteSliceToString(uts.Release[:])
	}
	if *planFile != "" {
		if !filepath.IsAbs(*planFile) {
			return fmt.Errorf("--plan-file must be an absolute path")
		}
		lx.plans = &plan.Cache{Path: *planFile}
		if _, _, err := lx.plans.Get(); err != nil {
			return fmt.Errorf("--plan-file: %v", err)
		}
	}
	lx.diskDefault = *turnDiskMax
	if *sandboxKind == "bwrap" {
		if err := setupBwrap(); err != nil {
			return err
		}
	}
	if err := setupCgroupsAtStart(); err != nil {
		return err
	}
	return nil
}

func setupBwrap() error {
	lx.bwrap = true
	if *localLogin {
		return fmt.Errorf("--sandbox bwrap does not run local-login engines (no such mode on Linux)")
	}
	if *sandboxProfile != "" {
		return fmt.Errorf("--sandbox bwrap and --sandbox-profile exclude each other")
	}
	for name, v := range map[string]string{"--bwrap": *bwrapBin, "--sandbox-helper": *sandboxHelper, "--sandbox-etc": *sandboxEtc, "--ca-bundle": *caBundle, "--firewall-status": *firewallStatus} {
		if v == "" || !filepath.IsAbs(v) || strings.ContainsAny(v, "\x00\n") {
			return fmt.Errorf("--sandbox bwrap needs %s as an absolute path", name)
		}
	}
	if *proxyPort <= 0 || *proxyPort > 65535 {
		return fmt.Errorf("--sandbox bwrap needs --proxy-port (the only network the engine firewall allows)")
	}
	// the files every turn trusts must be root's and not writable by anyone else, all the way up
	lx.sbxFiles = []string{*bwrapBin, *sandboxHelper, *sandboxEtc}
	for _, n := range []string{"passwd", "group", "hosts", "nsswitch.conf", "empty", "empty.d"} {
		lx.sbxFiles = append(lx.sbxFiles, filepath.Join(*sandboxEtc, n))
	}
	ca, err := filepath.EvalSymlinks(*caBundle)
	if err != nil {
		return fmt.Errorf("--ca-bundle: %v", err)
	}
	lx.sbxFiles = append(lx.sbxFiles, ca)
	for _, p := range lx.sbxFiles {
		if err := rootOwnedPath(p); err != nil {
			return err
		}
	}
	out, err := exec.Command(*bwrapBin, "--version").Output()
	if err != nil {
		return fmt.Errorf("%s --version: %v", *bwrapBin, err)
	}
	m := bwrapVersionRe.FindStringSubmatch(string(out))
	if m == nil {
		return fmt.Errorf("bwrap --version: unexpected output %q", strings.TrimSpace(string(out)))
	}
	maj, _ := strconv.Atoi(m[1])
	min, _ := strconv.Atoi(m[2])
	if maj == 0 && min < 8 {
		return fmt.Errorf("bwrap %s is too old: 0.8.0 or newer is needed (--disable-userns)", m[0])
	}
	lx.bwrapVersion = m[0]
	pout, err := exec.Command(*sandboxHelper, "probe").Output()
	if err != nil {
		return fmt.Errorf("%s probe: %v", *sandboxHelper, err)
	}
	var probe struct {
		LandlockAbi int    `json:"landlockAbi"`
		Seccomp     bool   `json:"seccomp"`
		Kernel      string `json:"kernel"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(pout), &probe); err != nil {
		return fmt.Errorf("mycel-sandbox probe: %v", err)
	}
	lx.landlockAbi, lx.seccomp = probe.LandlockAbi, probe.Seccomp
	if !probe.Seccomp {
		return fmt.Errorf("this kernel has no seccomp filters; the engine sandbox needs them")
	}
	switch {
	case *landlockMode == "required" && probe.LandlockAbi < 1:
		return fmt.Errorf("--landlock required: this kernel has no Landlock (enable the landlock LSM)")
	case *landlockMode == "required-scoped" && probe.LandlockAbi < 6:
		return fmt.Errorf("--landlock required-scoped: Landlock ABI %d, 6 (Linux 6.12) or newer is needed", probe.LandlockAbi)
	}
	if lx.bridgeReal, err = filepath.EvalSymlinks(*bridgePath); err != nil {
		return fmt.Errorf("--bridge: %v", err)
	}
	lx.ldso = map[string]string{}
	for _, c := range allowCmd {
		interp, err := elfInterpreter(c)
		if err != nil {
			return fmt.Errorf("--allow-cmd %s: %v", c, err)
		}
		lx.ldso[c] = interp
		real, _ := filepath.EvalSymlinks(c)
		if inside(filepath.Clean(*agentRoot), real) || real == filepath.Clean(*agentRoot) {
			return fmt.Errorf("--allow-cmd %s lives in the agent root", c)
		}
	}
	for _, p := range []string{"/lib", "/lib64", "/lib32", "/libx32"} {
		lm := libMount{path: p}
		if st, err := os.Lstat(p); err == nil {
			lm.exists = true
			if st.Mode()&os.ModeSymlink != 0 {
				lm.link, _ = os.Readlink(p)
			} else {
				lm.isDir = st.IsDir()
			}
		}
		lx.libs = append(lx.libs, lm)
	}
	if st, err := os.Stat("/usr/lib64"); err == nil && st.IsDir() {
		lx.usrLib64 = true
	}
	return nil
}

// rootOwnedPath: p and every folder above it belong to root and are not writable by group or others.
func rootOwnedPath(p string) error {
	for cur := filepath.Clean(p); ; cur = filepath.Dir(cur) {
		var st unix.Stat_t
		if err := unix.Lstat(cur, &st); err != nil {
			return fmt.Errorf("sandbox file %s: %v", cur, err)
		}
		if st.Uid != 0 || st.Mode&0o022 != 0 {
			return fmt.Errorf("sandbox file %s must belong to root and not be writable by group or others", cur)
		}
		if cur == "/" {
			return nil
		}
	}
}

// elfInterpreter returns the real path of the program's ELF interpreter (PT_INTERP), "" for a static program.
// Landlock checks the interpreter's execute right too, so a dynamically linked engine (Claude Code: glibc) needs it
// on the allow list; Codex and the bridge are static.
func elfInterpreter(p string) (string, error) {
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		return "", err
	}
	f, err := elf.Open(real)
	if err != nil {
		return "", fmt.Errorf("not an ELF program (shell scripts and Node wrappers cannot run in the sandbox): %v", err)
	}
	defer f.Close()
	for _, pr := range f.Progs {
		if pr.Type != elf.PT_INTERP {
			continue
		}
		b := make([]byte, pr.Filesz)
		if _, err := pr.ReadAt(b, 0); err != nil {
			return "", err
		}
		interp := string(bytes.TrimRight(b, "\x00"))
		r, err := filepath.EvalSymlinks(interp)
		if err != nil {
			return "", fmt.Errorf("ELF interpreter %s: %v", interp, err)
		}
		return r, nil
	}
	return "", nil
}

// bwrapParams are the per-turn values of the argv (spec 3.3.3).
type bwrapParams struct {
	EngineDir, EngineReal, Bridge, BridgeReal, Helper, ToolsSock, ToolsSockReal, Chat, EtcDir, CA, Landlock, Ldso string
	Codex, AllowListen                                                                                            bool
	Libs                                                                                                          []libMount
	UsrLib64                                                                                                      bool
	Args                                                                                                          []string
}

func checkArgPath(name, p string) error {
	if !filepath.IsAbs(p) || filepath.Clean(p) != p {
		return fmt.Errorf("sandbox_failed: %s is not a clean absolute path", name)
	}
	for _, c := range p {
		if c < 0x20 || c == 0x7f {
			return fmt.Errorf("sandbox_failed: %s has a control character", name)
		}
	}
	return nil
}

// codexLockFiles are bound as empty read-only files (and folders) over CODEX_HOME's files that change what Codex may
// do (engine.sb:193-200 on macOS).
var codexLockFiles = []string{"config.toml", "models_cache.json", "catalog.json", "AGENTS.md", "hooks.json"}
var codexLockDirs = []string{"skills", "plugins"}

// buildBwrapArgs is the exact argv after the bwrap program name (golden-tested in sandbox_linux_test.go).
func buildBwrapArgs(p bwrapParams) ([]string, error) {
	for n, v := range map[string]string{"engine folder": p.EngineDir, "engine": p.EngineReal, "bridge": p.Bridge, "bridge (real)": p.BridgeReal,
		"helper": p.Helper, "tools socket": p.ToolsSock, "chat folder": p.Chat, "sandbox-etc": p.EtcDir, "CA file": p.CA} {
		if err := checkArgPath(n, v); err != nil {
			return nil, err
		}
	}
	if p.Ldso != "" {
		if err := checkArgPath("ELF interpreter", p.Ldso); err != nil {
			return nil, err
		}
	}
	a := []string{
		"--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try",
		"--disable-userns",
		"--die-with-parent",
		"--cap-drop", "ALL",
		"--hostname", "mycel-turn",
		"--ro-bind", "/usr/lib", "/usr/lib",
	}
	if p.UsrLib64 {
		a = append(a, "--ro-bind-try", "/usr/lib64", "/usr/lib64")
	}
	for _, l := range p.Libs {
		switch {
		case !l.exists:
		case l.link != "":
			a = append(a, "--symlink", l.link, l.path)
		case l.isDir:
			a = append(a, "--ro-bind-try", l.path, l.path)
		}
	}
	a = append(a,
		"--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache",
		"--ro-bind", filepath.Join(p.EtcDir, "passwd"), "/etc/passwd",
		"--ro-bind", filepath.Join(p.EtcDir, "group"), "/etc/group",
		"--ro-bind", filepath.Join(p.EtcDir, "hosts"), "/etc/hosts",
		"--ro-bind", filepath.Join(p.EtcDir, "nsswitch.conf"), "/etc/nsswitch.conf",
		"--ro-bind", p.CA, "/etc/ssl/cert.pem",
		"--ro-bind-try", "/usr/share/zoneinfo", "/usr/share/zoneinfo",
		"--proc", "/proc",
		"--dev", "/dev",
		"--size", "67108864", "--tmpfs", "/dev/shm",
		"--ro-bind", p.EngineDir, p.EngineDir,
		"--ro-bind", p.BridgeReal, p.Bridge,
		"--ro-bind", p.Helper, "/.sbx/mycel-sandbox",
		"--ro-bind", p.ToolsSock, p.ToolsSock,
		"--bind", p.Chat, p.Chat,
	)
	// the engine starts the bridge and reaches the tools socket by their resolved paths (main.go run(): mcp.json, the
	// {BRIDGE} / {TOOLS_SOCK} placeholders), which differ from the configured ones behind an install's app/current link:
	// those paths have to exist inside the sandbox too
	if p.BridgeReal != p.Bridge {
		a = append(a, "--ro-bind", p.BridgeReal, p.BridgeReal)
	}
	if p.ToolsSockReal != "" && p.ToolsSockReal != p.ToolsSock {
		a = append(a, "--ro-bind", p.ToolsSockReal, p.ToolsSockReal)
	}
	if p.Codex {
		for _, f := range codexLockFiles {
			a = append(a, "--ro-bind", filepath.Join(p.EtcDir, "empty"), filepath.Join(p.Chat, ".codex", f))
		}
		for _, d := range codexLockDirs {
			a = append(a, "--ro-bind", filepath.Join(p.EtcDir, "empty.d"), filepath.Join(p.Chat, ".codex", d))
		}
	}
	a = append(a, "--remount-ro", "/", "--chdir", p.Chat, "--",
		"/.sbx/mycel-sandbox", "exec", "--landlock", p.Landlock, "--exec-allow", p.EngineDir, "--exec-allow", p.Bridge)
	if p.BridgeReal != p.Bridge {
		a = append(a, "--exec-allow", p.BridgeReal)
	}
	if p.Ldso != "" {
		a = append(a, "--exec-allow", p.Ldso)
	}
	if p.AllowListen {
		a = append(a, "--allow-listen")
	}
	a = append(a, "--", p.EngineReal)
	return append(a, p.Args...), nil
}

// ---------------- per turn ----------------

type turnEnv struct {
	chat     string
	login    bool
	codex    bool
	limits   plan.Limits
	cg       *turnCg
	diskMax  int64
	diskHit  bool
	watchEnd chan struct{}
	errs     stderrTail
	mu       sync.Mutex
	done     bool
	slot     bool
	marked   bool
	// bridge: the real path of --bridge for this turn, the one mcp.json names (main.go). An update switches
	// app/current under a running launcher, so the path seen at start can be an older version.
	bridge string
}

// bridgeReal is this turn's bridge (main.go sets it before the engine starts); the path from the start is only the
// fallback for callers that run no turn.
func (t *turnEnv) bridgeReal() string {
	if t.bridge != "" {
		return t.bridge
	}
	return lx.bridgeReal
}

func currentLimits() (plan.Limits, error) {
	if lx.plans == nil {
		return plan.Defaults(plan.MachineMemoryMiB(), numCPU()), nil
	}
	l, _, err := lx.plans.Get()
	return l, err
}

// beginTurn runs the fail-closed checks and prepares the turn's cgroup and .tmp (spec 3.3.7 steps 1–3).
func beginTurn(req *request, chat string) (*turnEnv, error) {
	t := &turnEnv{chat: chat, codex: req.CodexAuth || filepath.Base(req.Cmd) == "codex"}
	if !chatIDRe.MatchString(req.TurnID) {
		return nil, fmt.Errorf("bad turn id")
	}
	if err := t.begin("t-" + req.TurnID); err != nil {
		t.cleanup()
		return nil, err
	}
	if lx.bwrap {
		if err := resetChatTmp(chat); err != nil {
			t.cleanup()
			return nil, err
		}
	}
	return t, nil
}

// beginLogin is beginTurn for codex-login (its folder is the Codex login folder; cgroup turns/login).
func beginLogin(dir string) (*turnEnv, error) {
	t := &turnEnv{chat: dir, login: true}
	if err := t.begin("login"); err != nil {
		t.cleanup()
		return nil, err
	}
	return t, nil
}

func (t *turnEnv) begin(cgName string) error {
	l, err := currentLimits()
	if err != nil {
		return fmt.Errorf("plan_unreadable: %v", err)
	}
	t.limits = l
	markChat(t.chat, 1)
	t.marked = true
	// one more than the plan's concurrent turns: the Codex login may run beside them
	if !takeSlot(l.MaxConcurrency + 1) {
		return fmt.Errorf("busy: %d engine turns are running (plan limit %d)", liveTurnCount(), l.MaxConcurrency)
	}
	t.slot = true
	if *firewallStatus != "" {
		st, err := fwstatus.Read(*firewallStatus, 0)
		if err == nil {
			err = st.Check(time.Now(), os.Getuid(), *proxyPort)
		}
		if err != nil {
			return fmt.Errorf("firewall_not_loaded: %v", err)
		}
	}
	if lx.bwrap {
		for _, p := range lx.sbxFiles {
			if err := rootOwnedPath(p); err != nil {
				return fmt.Errorf("sandbox_failed: %v", err)
			}
		}
		if err := proxyPortSquat(*proxyPort); err != nil {
			return err
		}
	}
	t.diskMax = lx.diskDefault
	if t.diskMax <= 0 {
		t.diskMax = int64(l.TurnDiskMaxMiB) << 20
	}
	if lx.cg != nil {
		lx.cg.applyTurnsLimits(l)
		cg, err := lx.cg.newTurn(cgName, l)
		if err != nil {
			if *cgroupMode == "required" {
				return fmt.Errorf("cgroup_unavailable: %v", err)
			}
			fmt.Fprintln(os.Stderr, "mycel-launcher: turn cgroup:", err)
		} else {
			t.cg = cg
		}
	} else if *cgroupMode == "required" {
		return fmt.Errorf("cgroup_unavailable: no delegated cgroup")
	}
	return nil
}

// command builds the engine's process: bubblewrap + mycel-sandbox with --sandbox bwrap, else as before.
func (t *turnEnv) command(cmdPath string, args []string, chat, sessDir string) (*exec.Cmd, func(), error) {
	if !lx.bwrap {
		cmd, cleanup, err := engineCommand(cmdPath, args, chat, sessDir)
		if err == nil && t.cg != nil && !lx.cgFdOK && *sandboxHelper != "" {
			cmd = t.cgexecWrap(cmd)
		}
		return cmd, cleanup, err
	}
	real, err := filepath.EvalSymlinks(cmdPath)
	if err != nil {
		return nil, nil, fmt.Errorf("engine: %v", err)
	}
	ldso, ok := lx.ldso[cmdPath]
	if !ok {
		if ldso, err = elfInterpreter(cmdPath); err != nil {
			return nil, nil, fmt.Errorf("engine: %v", err)
		}
	}
	argv, err := buildBwrapArgs(bwrapParams{
		EngineDir: filepath.Dir(real), EngineReal: real, Bridge: filepath.Clean(*bridgePath), BridgeReal: t.bridgeReal(),
		Helper: *sandboxHelper, ToolsSock: filepath.Clean(*toolsSock), ToolsSockReal: resolvePath(*toolsSock), Chat: filepath.Clean(chat), EtcDir: filepath.Clean(*sandboxEtc),
		CA: filepath.Clean(*caBundle), Landlock: *landlockMode, Ldso: ldso, Codex: t.codex && !t.login, AllowListen: *allowListen,
		Libs: lx.libs, UsrLib64: lx.usrLib64, Args: args,
	})
	if err != nil {
		return nil, nil, err
	}
	cmd := exec.Command(*bwrapBin, argv...)
	if t.cg != nil && !lx.cgFdOK {
		cmd = t.cgexecWrap(cmd)
	}
	return cmd, func() {}, nil
}

// cgexecWrap starts cmd through `mycel-sandbox cgexec --cgroup <turn cgroup>` when clone3 CLONE_INTO_CGROUP is not
// available (an older container seccomp profile): the helper joins the cgroup and execs, so the pid and every child
// are in the turn cgroup from the first instruction.
func (t *turnEnv) cgexecWrap(cmd *exec.Cmd) *exec.Cmd {
	argv := append([]string{"cgexec", "--cgroup", t.cg.dir, "--"}, cmd.Path)
	argv = append(argv, cmd.Args[1:]...)
	return exec.Command(*sandboxHelper, argv...)
}

func (t *turnEnv) procAttr() *syscall.SysProcAttr {
	a := &syscall.SysProcAttr{Setsid: true, Pdeathsig: syscall.SIGKILL}
	if t.cg != nil && lx.cgFdOK {
		a.UseCgroupFD, a.CgroupFD = true, t.cg.fd
	}
	return a
}

// started begins the disk watch (spec 3.3.7 step 5): every 2 s the chat folder's size in blocks (at most 50 000
// entries counted); over the limit the turn is stopped and its folder emptied afterwards.
func (t *turnEnv) started(pid int, stop func()) {
	if !lx.bwrap || t.diskMax <= 0 || t.login {
		return
	}
	t.watchEnd = make(chan struct{})
	go func() {
		tk := time.NewTicker(2 * time.Second)
		defer tk.Stop()
		for {
			select {
			case <-t.watchEnd:
				return
			case <-tk.C:
				if folderBytes(t.chat, 50000) > t.diskMax {
					t.mu.Lock()
					t.diskHit = true
					t.mu.Unlock()
					stop()
					return
				}
			}
		}
	}()
}

func (t *turnEnv) stderr(p []byte) { t.errs.add(p) }

// finish runs right after the engine's process group was killed: the turn cgroup is killed (escapees included),
// an OOM kill or the disk limit becomes the exit event's signal.
func (t *turnEnv) finish(sig string) string {
	if t.watchEnd != nil {
		select {
		case <-t.watchEnd:
		default:
			close(t.watchEnd)
		}
	}
	oom := false
	if t.cg != nil {
		oom = t.cg.kill()
	}
	t.mu.Lock()
	hit := t.diskHit
	t.mu.Unlock()
	switch {
	case hit:
		return "disk_limit"
	case oom && sig == "":
		return "oom"
	}
	return sig
}

var sandboxErrRe = regexp.MustCompile(`(?m)^mycel-sandbox: (.+)$`)

// report turns an exit 70 of the sandbox helper into an error event (the engine never started).
func (t *turnEnv) report(ev map[string]any, code int) map[string]any {
	if !lx.bwrap || code != 70 {
		return ev
	}
	if m := sandboxErrRe.FindStringSubmatch(t.errs.String()); m != nil {
		return map[string]any{"ev": "error", "message": "sandbox_failed: " + strings.TrimSpace(m[1])}
	}
	if strings.HasPrefix(strings.TrimSpace(t.errs.String()), "bwrap:") {
		return map[string]any{"ev": "error", "message": "sandbox_failed: " + strings.TrimSpace(strings.SplitN(t.errs.String(), "\n", 2)[0])}
	}
	return ev
}

// cleanup removes the turn cgroup and .tmp, empties the chat folder after a disk-limit stop, and frees the slot.
// Safe to call more than once.
func (t *turnEnv) cleanup() {
	t.mu.Lock()
	if t.done {
		t.mu.Unlock()
		return
	}
	t.done = true
	hit := t.diskHit
	t.mu.Unlock()
	if t.watchEnd != nil {
		select {
		case <-t.watchEnd:
		default:
			close(t.watchEnd)
		}
	}
	if t.cg != nil {
		t.cg.kill()
		t.cg.remove()
	}
	if lx.bwrap && !t.login {
		if d, err := openRoot(t.chat); err == nil {
			if hit {
				_ = d.removeAll(".") // the session is with the server already; nothing here is needed again
			} else {
				_ = d.removeAll(".tmp")
			}
			d.close()
		}
	}
	if t.slot {
		releaseSlot()
	}
	if t.marked {
		markChat(t.chat, -1)
	}
}

// folderBytes sums the allocated size of everything under dir (links not followed), stopping after max entries.
func folderBytes(dir string, max int) int64 {
	var total int64
	n := 0
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		n++
		if n > max {
			return filepath.SkipAll
		}
		var st unix.Stat_t
		if unix.Lstat(p, &st) == nil {
			total += st.Blocks * 512
		}
		return nil
	})
	return total
}

// proxyPortSquat (spec 3.4.4): a process of the engine account listening on the model proxy port (taken while the
// server was down) would receive the next turn's proxy token. The launcher kills it and refuses this turn.
func proxyPortSquat(port int) error {
	if port <= 0 {
		return nil
	}
	inodes := listenInodes(port, os.Getuid())
	if len(inodes) == 0 {
		return nil
	}
	for _, pid := range socketOwners(inodes) {
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}
	return fmt.Errorf("proxy_port_taken: an engine-account process was listening on 127.0.0.1:%d (killed)", port)
}

// listenInodes returns the socket inodes of TCP sockets in LISTEN state on port owned by uid (/proc/net/tcp{,6}).
func listenInodes(port, uid int) map[string]bool {
	out := map[string]bool{}
	for _, f := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(bytes.NewReader(b))
		sc.Scan() // header
		for sc.Scan() {
			c := strings.Fields(sc.Text())
			if len(c) < 10 || c[3] != "0A" {
				continue
			}
			i := strings.LastIndexByte(c[1], ':')
			if i < 0 {
				continue
			}
			p, err := strconv.ParseInt(c[1][i+1:], 16, 32)
			if err != nil || int(p) != port {
				continue
			}
			if u, err := strconv.Atoi(c[7]); err == nil && u == uid {
				out[c[9]] = true
			}
		}
	}
	return out
}

func socketOwners(inodes map[string]bool) []int {
	var pids []int
	ents, _ := os.ReadDir("/proc")
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == os.Getpid() {
			continue
		}
		fds, _ := os.ReadDir(fmt.Sprintf("/proc/%d/fd", pid))
		for _, fd := range fds {
			l, _ := os.Readlink(fmt.Sprintf("/proc/%d/fd/%s", pid, fd.Name()))
			if strings.HasPrefix(l, "socket:[") && inodes[strings.TrimSuffix(strings.TrimPrefix(l, "socket:["), "]")] {
				pids = append(pids, pid)
				break
			}
		}
	}
	return pids
}

// platformStatus fills the Linux part of the status answer (spec 3.3.2, used by the diagnostics).
func platformStatus(ev map[string]any) {
	ev["os"] = "linux"
	ev["sandbox"] = "none"
	if lx.bwrap {
		ev["sandbox"] = "bwrap"
		ev["bwrapVersion"] = lx.bwrapVersion
		ev["landlockAbi"] = lx.landlockAbi
		ev["landlockMode"] = *landlockMode
		ev["scoped"] = lx.landlockAbi >= 6 && *landlockMode != "off"
		ev["seccomp"] = lx.seccomp
		ev["listen"] = map[bool]string{true: "allowed", false: "denied"}[*allowListen]
	}
	ev["kernel"] = lx.kernel
	ev["cgroup"] = lx.cgState
	if l, err := currentLimits(); err == nil {
		ev["maxLiveTurns"] = l.MaxConcurrency + 1
		ev["plan"] = l.Plan
		ev["turnMemoryMaxMiB"] = l.TurnMaxMiB
	} else {
		ev["planError"] = err.Error()
	}
	if *firewallStatus != "" {
		fw := map[string]any{"loaded": false}
		if st, err := fwstatus.Read(*firewallStatus, 0); err == nil {
			fw["loaded"], fw["at"], fw["rules"] = st.Loaded, st.At, st.Rules
			if cerr := st.Check(time.Now(), os.Getuid(), *proxyPort); cerr != nil {
				fw["problem"] = cerr.Error()
			}
		} else {
			fw["problem"] = err.Error()
		}
		ev["firewall"] = fw
	}
}

func isENOSYS(err error) bool { return errors.Is(err, syscall.ENOSYS) }

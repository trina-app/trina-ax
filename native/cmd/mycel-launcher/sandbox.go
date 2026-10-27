// Per-turn OS sandbox hooks shared by macOS and Linux (linux-runtime spec 3.3).
//
// main.go's turn flow calls a turnEnv at fixed points: beginTurn (fail-closed checks, the turn's cgroup, a fresh
// .tmp), command (the engine wrapped in the platform sandbox), procAttr (new session; Linux: parent-death signal and
// the turn cgroup), started, finish (cgroup kill, oom / disk_limit), cleanup. On macOS the hooks keep today's
// behaviour (sandbox-exec through engineCommand in main.go); the Linux bubblewrap path is in sandbox_linux.go. The
// split keeps main.go's own edits to a few delimited lines.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sync"
)

// Linux sandbox flags (spec 3.3.2). They mean nothing on macOS: giving one there is a configuration error (exit 2).
var (
	sandboxKind    = flag.String("sandbox", "none", "Linux: none | bwrap (every engine turn in bubblewrap + mycel-sandbox)")
	bwrapBin       = flag.String("bwrap", "", "Linux --sandbox bwrap: absolute path of bwrap (root-owned)")
	sandboxHelper  = flag.String("sandbox-helper", "", "Linux --sandbox bwrap: absolute path of mycel-sandbox (root-owned)")
	sandboxEtc     = flag.String("sandbox-etc", "", "Linux --sandbox bwrap: folder with the sandbox's passwd, group, hosts, nsswitch.conf, empty, empty.d (root-owned)")
	caBundle       = flag.String("ca-bundle", "", "Linux --sandbox bwrap: CA file bound read-only at /etc/ssl/cert.pem in the sandbox")
	landlockMode   = flag.String("landlock", "required", "Linux --sandbox bwrap: off | best-effort | required | required-scoped")
	firewallStatus = flag.String("firewall-status", "", "Linux --sandbox bwrap: <base>/run/firewall.json; every turn is refused unless it is fresh and loaded")
	planFile       = flag.String("plan-file", "", "Linux: <base>/root/plan.json (turn limits, concurrent turns); missing file = machine defaults")
	cgroupMode     = flag.String("cgroup", "off", "Linux: off | auto | required (one cgroup v2 per turn under the delegated unit cgroup)")
	turnDiskMax    = flag.Int64("turn-disk-max", 0, "Linux: bytes a chat folder may hold while its turn runs (0 = plan value, 1 GiB without a plan)")
	allowListen    = flag.Bool("allow-listen", false, "Linux: let engines call listen() (spike S4 fallback; default: denied by seccomp)")
)

// linuxOnlyFlags are refused on other systems.
var linuxOnlyFlags = map[string]bool{"sandbox": true, "bwrap": true, "sandbox-helper": true, "sandbox-etc": true, "ca-bundle": true,
	"landlock": true, "firewall-status": true, "plan-file": true, "cgroup": true, "turn-disk-max": true, "allow-listen": true}

// checkPlatformFlags runs right after flag.Parse.
func checkPlatformFlags() error {
	var bad []string
	if runtime.GOOS != "linux" {
		flag.Visit(func(f *flag.Flag) {
			if linuxOnlyFlags[f.Name] {
				bad = append(bad, "--"+f.Name)
			}
		})
		if len(bad) > 0 {
			return fmt.Errorf("%v: Linux only", bad)
		}
		return nil
	}
	return setupLinux()
}

// chat ids the launcher may name below the agent root (shared/src/engine.ts turnId rule; chat ids are UUIDs or c_…)
var chatIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// reserved names directly under the agent root that are never chat folders
var reservedAgentNames = map[string]bool{"codex-auth": true, "home": true}

// liveChats: chat folders with a turn running now (forget refuses them, the daily sweep skips them).
var liveChats = struct {
	mu sync.Mutex
	m  map[string]int
}{m: map[string]int{}}

func chatBusy(chat string) bool {
	liveChats.mu.Lock()
	defer liveChats.mu.Unlock()
	return liveChats.m[filepath.Clean(chat)] > 0
}

func markChat(chat string, d int) {
	liveChats.mu.Lock()
	defer liveChats.mu.Unlock()
	k := filepath.Clean(chat)
	liveChats.m[k] += d
	if liveChats.m[k] <= 0 {
		delete(liveChats.m, k)
	}
}

// turnSlots counts turns between beginTurn and cleanup (the concurrent-turn limit is checked and taken atomically).
var turnSlots = struct {
	mu sync.Mutex
	n  int
}{}

func takeSlot(max int) bool {
	turnSlots.mu.Lock()
	defer turnSlots.mu.Unlock()
	if max > 0 && turnSlots.n >= max {
		return false
	}
	turnSlots.n++
	return true
}

func releaseSlot() {
	turnSlots.mu.Lock()
	turnSlots.n--
	turnSlots.mu.Unlock()
}

func liveTurnCount() int {
	turnSlots.mu.Lock()
	defer turnSlots.mu.Unlock()
	return turnSlots.n
}

// removeChatTmp clears <chat>/.tmp (the engine's TMPDIR) and makes it again, without following links.
func resetChatTmp(chat string) error {
	d, err := openRoot(chat)
	if err != nil {
		return err
	}
	defer d.close()
	if err := d.removeAll(".tmp"); err != nil {
		return err
	}
	return d.mkdirAll(".tmp", 0o700)
}

// stderrTail keeps the first bytes of an engine's stderr (the sandbox helper's "mycel-sandbox: …" reason).
type stderrTail struct {
	mu sync.Mutex
	b  []byte
}

func (s *stderrTail) add(p []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if room := 4096 - len(s.b); room > 0 {
		if len(p) > room {
			p = p[:room]
		}
		s.b = append(s.b, p...)
	}
}

func (s *stderrTail) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return string(s.b)
}

func exitf(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "mycel-launcher: "+format+"\n", a...)
	os.Exit(2)
}

// macOS: the turn hooks keep today's behaviour (sandbox-exec through engineCommand in main.go, a new session per
// turn). Only the bookkeeping shared with Linux (live chats for forget and the daily sweep) is added.
package main

import (
	"os/exec"
	"sync"
	"syscall"
)

type turnEnv struct {
	chat   string
	once   sync.Once
	bridge string // the real path of --bridge for this turn (see sandbox_linux.go)
	sb     sbOpts // a sign-in's terminal and no own login (claudelogin.go); zero for turns
}

func setupLinux() error { return nil }

func beginTurn(req *request, chat string) (*turnEnv, error) {
	markChat(chat, 1)
	takeSlot(0)
	return &turnEnv{chat: chat}, nil
}

func beginLogin(dir string) (*turnEnv, error) { return beginTurn(&request{}, dir) }

// beginLoginAs: a sign-in in its own folder (the cgroup name only matters on Linux)
func beginLoginAs(dir, cgName string) (*turnEnv, error) { return beginLogin(dir) }

func (t *turnEnv) command(cmdPath string, args []string, chat, sessDir string) (*exec.Cmd, func(), error) {
	return engineCommandWith(cmdPath, args, chat, sessDir, t.sb)
}

func (t *turnEnv) procAttr() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setsid: true} }

func (t *turnEnv) started(pid int, stop func()) {}

func (t *turnEnv) stderr(p []byte) {}

func (t *turnEnv) finish(sig string) string { return sig }

func (t *turnEnv) report(ev map[string]any, code int) map[string]any { return ev }

func (t *turnEnv) cleanup() {
	t.once.Do(func() {
		releaseSlot()
		markChat(t.chat, -1)
	})
}

func platformStatus(ev map[string]any) {
	ev["os"] = "darwin"
	if *sandboxProfile != "" {
		ev["sandbox"] = "sandbox-exec"
	} else {
		ev["sandbox"] = "none"
	}
}

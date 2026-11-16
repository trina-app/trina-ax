// Engine check after an update (QA TC-3523, docs/decisions/20261116-post-update-engine-check.md), only from the server
// uid like every request:
//
//	{"op":"sandbox-check"} -> {"ev":"sandbox-check","ok":true}
//	                          {"ev":"sandbox-check","ok":true,"skipped":"<why nothing was run>"}
//	                          {"ev":"sandbox-check","ok":true,"skipped":"<what failed>","hostProblem":true}
//	                          {"ev":"sandbox-check","ok":false,"error":"<what failed>"}
//
// ok:false only when the failure is about the version's own files (versionFault): the bootstrap rolls back only then.
// A fault of this machine (bwrap, the sandbox helper, sandbox-etc, Landlock) breaks the version before as well, so it is
// "hostProblem" (kept, shown as a warning); a launch that does not end in time is skipped (a loaded machine).
//
// The bootstrap asks this when a new version answers /api/health, before it keeps the version: on 2026-11-16 an update
// left the new version folder 0750/0640, the engine account could not reach native/mycel-bridge, and every answer
// failed ("bwrap: Can't find source path …: Permission denied") while /api/health said ok. The check starts the engine's
// launch exactly as a turn does (turnEnv.command: on Linux the bubblewrap argv of buildBwrapArgs and mycel-sandbox
// exec), as this account, with the bridge of the version app/current points to now as the program and "-h" as its
// argument: every bridge version prints its usage and exits 0 on it (Go's flag package), so the check also holds for a
// switch back to an older version. No turn slot, cgroup or firewall check is taken: what an update can break is the
// version's files, and a turn runs those checks itself.
package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// checkFolderName: the working folder of the check, directly under the agent root (never a chat id: reservedAgentNames)
const checkFolderName = "sandbox-check"

// engineCheckTimeout: a launch that does not end within this time fails the check (tests make it short)
var engineCheckTimeout = 15 * time.Second

// one check at a time: they share the check folder
var engineCheckMu sync.Mutex

func sandboxCheckOp(o *out) {
	skipped, err := engineCheck()
	o.send(checkAnswer(skipped, err))
}

// checkAnswer is the request's answer for engineCheck's result
func checkAnswer(skipped string, err error) map[string]any {
	var ve versionError
	var to timeoutError
	switch {
	case errors.As(err, &ve):
		// the version's own files: the only answer that makes the bootstrap roll back
		return map[string]any{"ev": "sandbox-check", "ok": false, "error": ve.Error()}
	case errors.As(err, &to):
		// a loaded machine: no proof against the version, and nothing for an administrator to fix
		return map[string]any{"ev": "sandbox-check", "ok": true, "skipped": to.Error()}
	case err != nil:
		// this machine's problem (bwrap after an OS upgrade or AppArmor, root/mycel-sandbox, sandbox-etc, Landlock
		// gone, the agent root): the version before has it too, so going back would not help and the update would
		// be tried again and again. Kept, and the bootstrap records it for Admin › System as a warning.
		return map[string]any{"ev": "sandbox-check", "ok": true, "skipped": err.Error(), "hostProblem": true}
	case skipped != "":
		return map[string]any{"ev": "sandbox-check", "ok": true, "skipped": skipped}
	default:
		return map[string]any{"ev": "sandbox-check", "ok": true}
	}
}

// runEngineCheck starts the bridge of app/current through the turn's launch code in a fresh check folder and waits for
// it. The error names what failed in the words of the program that failed (bwrap, mycel-sandbox or the bridge); it is a
// versionError only when that is about the version's own files (versionFault), a timeoutError when the launch did not
// end in time, else the machine's problem.
func runEngineCheck() error {
	engineCheckMu.Lock()
	defer engineCheckMu.Unlock()
	// resolved now, like a turn: an app-only update switches app/current under a running launcher
	bridge, err := filepath.EvalSymlinks(*bridgePath)
	if err != nil {
		// app/current or a folder of the version the engine account cannot enter (2026-11-16: 0750)
		return versionError{fmt.Sprintf("the engine account cannot reach %s: %v", *bridgePath, err)}
	}
	dir := filepath.Join(filepath.Clean(*agentRoot), checkFolderName)
	if err := os.RemoveAll(dir); err != nil {
		return folderError{err}
	}
	if err := os.Mkdir(dir, 0o700); err != nil {
		return folderError{err}
	}
	defer os.RemoveAll(dir)
	t := checkTurnEnv(dir, bridge)
	cmd, cleanup, err := t.command(bridge, []string{"-h"}, dir, dir)
	if err != nil {
		return classify(err.Error(), bridge)
	}
	defer cleanup()
	cmd.Dir = dir
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + dir, "LANG=C.UTF-8"}
	cmd.SysProcAttr = t.procAttr()
	var outBuf tailBuffer
	cmd.Stdout, cmd.Stderr = &outBuf, &outBuf
	if err := cmd.Start(); err != nil {
		return classify(fmt.Sprintf("cannot start %s: %v", cmd.Path, err), bridge)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err = <-done:
	case <-time.After(engineCheckTimeout):
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		<-done
		return timeoutError{engineCheckTimeout}
	}
	if err != nil {
		msg := err.Error()
		if last := outBuf.last(); last != "" {
			msg = fmt.Sprintf("%s (%v)", last, err)
		}
		// the whole output decides, not only its last line
		if versionFault(outBuf.all()+"\n"+msg, bridge) {
			return versionError{msg}
		}
		return errors.New(msg)
	}
	return nil
}

func classify(msg, bridge string) error {
	if versionFault(msg, bridge) {
		return versionError{msg}
	}
	return errors.New(msg)
}

// versionFault: the failure names the version's own files, app/current/… (the configured bridge path) or
// app/versions/<v>/… (where it resolves). bwrap ("Can't find source path …/native/mycel-bridge: Permission denied"),
// mycel-sandbox ("exec …/mycel-bridge: permission denied") and the ELF check name the path they failed on; a host
// fault (bwrap itself, the helper, sandbox-etc, the CA file, Landlock or seccomp missing) names none of these.
func versionFault(text, bridge string) bool {
	for _, p := range versionPaths(bridge) {
		if strings.Contains(text, p) {
			return true
		}
	}
	return false
}

// versionPaths: the version folder the bridge resolves to (…/versions/<v>, two levels above native/mycel-bridge) and
// the folder app/current names (two levels above the configured bridge path), each with a trailing separator
func versionPaths(bridge string) []string {
	var out []string
	for _, b := range []string{filepath.Clean(bridge), filepath.Clean(*bridgePath)} {
		if v := filepath.Dir(filepath.Dir(b)); v != "/" && v != "." {
			out = append(out, v+string(filepath.Separator))
		}
	}
	return out
}

// versionError: the engine account cannot use the version's own files; the version must not stay
type versionError struct{ msg string }

func (v versionError) Error() string { return v.msg }

// timeoutError: the launch did not end in time (a loaded machine); no proof against the version
type timeoutError struct{ d time.Duration }

func (t timeoutError) Error() string {
	return fmt.Sprintf("the engine sandbox did not end within %v", t.d)
}

// folderError: the check folder could not be made (the agent root's problem, not the version's)
type folderError struct{ err error }

func (f folderError) Error() string { return "the check folder could not be made: " + f.err.Error() }

// tailBuffer keeps the last 2 KiB written (the check's output: bwrap's or mycel-sandbox's message, the bridge's usage)
type tailBuffer struct {
	mu sync.Mutex
	b  []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.b = append(t.b, p...)
	if len(t.b) > 2048 {
		t.b = t.b[len(t.b)-2048:]
	}
	return len(p), nil
}

// all: everything kept
func (t *tailBuffer) all() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.b)
}

// last: the last non-empty line, at most 300 bytes
func (t *tailBuffer) last() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	lines := strings.Split(string(bytes.TrimSpace(t.b)), "\n")
	s := strings.TrimSpace(lines[len(lines)-1])
	if len(s) > 300 {
		s = s[:300]
	}
	return s
}

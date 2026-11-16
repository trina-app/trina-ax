// Engine check after an update (QA TC-3523, docs/decisions/20261116-post-update-engine-check.md), only from the server
// uid like every request:
//
//	{"op":"sandbox-check"} -> {"ev":"sandbox-check","ok":true}
//	                          {"ev":"sandbox-check","ok":true,"skipped":"<why nothing was run>"}
//	                          {"ev":"sandbox-check","ok":false,"error":"<what failed>"}
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
	var fe folderError
	if errors.As(err, &fe) {
		// the check's own folder, not the version: no proof against it
		skipped, err = fe.Error(), nil
	}
	switch {
	case err != nil:
		o.send(map[string]any{"ev": "sandbox-check", "ok": false, "error": err.Error()})
	case skipped != "":
		o.send(map[string]any{"ev": "sandbox-check", "ok": true, "skipped": skipped})
	default:
		o.send(map[string]any{"ev": "sandbox-check", "ok": true})
	}
}

// runEngineCheck starts the bridge of app/current through the turn's launch code in a fresh check folder and waits for
// it. The error names what failed in the words of the program that failed (bwrap, mycel-sandbox or the bridge).
func runEngineCheck() error {
	engineCheckMu.Lock()
	defer engineCheckMu.Unlock()
	// resolved now, like a turn: an app-only update switches app/current under a running launcher
	bridge, err := filepath.EvalSymlinks(*bridgePath)
	if err != nil {
		return fmt.Errorf("the engine account cannot reach %s: %v", *bridgePath, err)
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
		return err
	}
	defer cleanup()
	cmd.Dir = dir
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + dir, "LANG=C.UTF-8"}
	cmd.SysProcAttr = t.procAttr()
	var outBuf tailBuffer
	cmd.Stdout, cmd.Stderr = &outBuf, &outBuf
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("cannot start %s: %v", filepath.Base(cmd.Path), err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err = <-done:
	case <-time.After(engineCheckTimeout):
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		<-done
		return fmt.Errorf("the engine sandbox did not end within %v", engineCheckTimeout)
	}
	if err != nil {
		if msg := outBuf.last(); msg != "" {
			return fmt.Errorf("%s (%v)", msg, err)
		}
		return err
	}
	return nil
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

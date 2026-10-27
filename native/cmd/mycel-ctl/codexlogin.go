package main

import (
	"errors"
	"flag"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

// cmdCodexLogin signs the engine account in to Codex (spec 3.5.3; macOS: docs/INSTALL.md 2.5): the running version's
// admin.js codex-login as the server account (it asks the launcher, which runs `codex login --device-auth` as the
// engine account under the sandbox and the model proxy). The terminal stays attached: the command prints the link and
// the one-time code and waits. --status / --logout run codex-status / codex-logout the same way.
func cmdCodexLogin(e *env, args []string) (int, error) {
	fs := flag.NewFlagSet("codex-login", flag.ContinueOnError)
	e.flags(fs)
	status := fs.Bool("status", false, "only show whether the engine account is signed in")
	logout := fs.Bool("logout", false, "sign the engine account out")
	if err := fs.Parse(args); err != nil {
		return 2, usageError{err.Error()}
	}
	if err := requireRoot(); err != nil {
		return 2, err
	}
	if err := checkBase(e.base); err != nil {
		return 1, err
	}
	in, err := loadInstall(e)
	if err != nil {
		return 1, err
	}
	sub := "codex-login"
	if *status {
		sub = "codex-status"
	} else if *logout {
		sub = "codex-logout"
	}
	cmd := codexLoginCmd(in, sub)
	srv, err := lookupAccount(in.ServerUser)
	if err != nil {
		return 1, err
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(srv.uid), Gid: uint32(srv.gid), Groups: []uint32{}}}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return ee.ExitCode(), nil
		}
		return 1, err
	}
	return 0, nil
}

// codexLoginCmd: `cd / && env -i … bun admin.js codex-login` (the server account cannot enter root's home; bun
// started in a folder it cannot enter fails, docs/INSTALL.md 2.5).
func codexLoginCmd(in *Install, sub string) *exec.Cmd {
	b := in.Base
	cmd := exec.Command(filepath.Join(b, "app", "current", "bin", "bun"), filepath.Join(b, "app", "current", "server", "src", "admin.js"), sub)
	cmd.Dir = "/"
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + filepath.Join(b, "data"), "LANG=C.UTF-8", "MYCEL_MODE=prod",
		"MYCEL_CONFIG=" + filepath.Join(b, "config", "server.json"), "MYCEL_INSTALL_BASE=" + b, "MYCEL_LABEL=" + in.ID}
	return cmd
}
